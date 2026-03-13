/**
 * Billing Module
 *
 * Owns usage metering for plan entitlements:
 *  - Fast-path increments/reads via Upstash Redis (sheriabot:usage:{scope}:{metric}:{YYYY-MM})
 *  - Periodic sync of Redis counters to the Postgres UsageRecord table for
 *    auditing, analytics, and durability across Redis evictions.
 *
 * The sync method is designed to be called by a scheduled job (e.g. nightly cron
 * or a Fastify plugin using node-cron / @fastify/schedule). It is idempotent and
 * safe to call multiple times per period.
 *
 * Key naming convention:
 *   sheriabot:usage:{scopeId}:{BillingMetric}:{YYYY-MM}
 *   where scopeId = organizationId ?? userId
 */

import { BillingMetric } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

// ============================================================================
// Constants
// ============================================================================

/** Redis key prefix for usage counters. */
const USAGE_PREFIX = 'sheriabot:usage:';

/** TTL for usage counter keys: 35 days (covers end-of-month billing edge cases). */
const USAGE_TTL_SECONDS = 35 * 24 * 60 * 60;

// ============================================================================
// Helpers
// ============================================================================

function usageKey(scopeId: string, metric: BillingMetric, period: string): string {
  return `${USAGE_PREFIX}${scopeId}:${metric}:${period}`;
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

function periodToDates(period: string): { start: Date; end: Date } {
  // period = 'YYYY-MM'
  const [year, month] = period.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 0, 23, 59, 59, 999); // last day of month
  return { start, end };
}

async function readRedisCount(key: string): Promise<number> {
  try {
    const raw = await redis.get<number>(key);
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') return Number(raw) || 0;
    return 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// BillingModule
// ============================================================================

class BillingModule {
  // --------------------------------------------------------------------------
  // Increment
  // --------------------------------------------------------------------------

  /**
   * Atomically increments the Redis usage counter for a given scope + metric.
   *
   * This is the hot-path call; it does NOT write to Postgres.
   * The sync() method writes to Postgres on a schedule.
   *
   * @param scopeId  organizationId ?? userId
   * @param metric   BillingMetric enum value
   * @param amount   Default 1
   * @returns        New counter value after increment
   */
  async increment(
    scopeId: string,
    metric:  BillingMetric,
    amount = 1,
  ): Promise<number> {
    const period = currentPeriod();
    const key    = usageKey(scopeId, metric, period);

    try {
      let newCount: number;
      if (amount === 1) {
        newCount = await redis.incr(key);
      } else {
        newCount = await redis.incrby(key, amount);
      }

      // Set TTL on first write (key created this period)
      if (newCount <= amount) {
        await redis.expire(key, USAGE_TTL_SECONDS);
      }

      logger.debug({
        type:    'usage_incremented',
        scopeId,
        metric,
        period,
        newCount,
        amount,
      });

      return newCount;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ type: 'usage_increment_error', scopeId, metric, error: message });
      // Return 0 rather than crashing the request — the limit check middleware
      // will re-read the key independently, so this is a safe degraded path.
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // Read (Redis fast path)
  // --------------------------------------------------------------------------

  /**
   * Returns the current-month usage count from Redis for a given scope + metric.
   * Falls back to 0 on Redis error.
   */
  async getCurrentUsage(scopeId: string, metric: BillingMetric): Promise<number> {
    return readRedisCount(usageKey(scopeId, metric, currentPeriod()));
  }

  /**
   * Returns usage counts for all BillingMetrics for a given scope in the
   * current period, fetched in parallel.
   */
  async getAllCurrentUsage(
    scopeId: string,
  ): Promise<Record<BillingMetric, number>> {
    const metrics = Object.values(BillingMetric);
    const period  = currentPeriod();

    const counts = await Promise.all(
      metrics.map((m) => readRedisCount(usageKey(scopeId, m, period))),
    );

    return Object.fromEntries(
      metrics.map((m, i) => [m, counts[i]]),
    ) as Record<BillingMetric, number>;
  }

  // --------------------------------------------------------------------------
  // Read (Postgres audit path)
  // --------------------------------------------------------------------------

  /**
   * Returns the stored UsageRecord for an organization + metric + period.
   * Returns null if no record exists (i.e. the period hasn't been synced yet).
   *
   * @param period  Optional 'YYYY-MM' string; defaults to current period.
   */
  async getStoredUsage(
    organizationId: string,
    metric:         BillingMetric,
    period?:        string,
  ) {
    const p = period ?? currentPeriod();
    const { start } = periodToDates(p);

    return prisma.usageRecord.findUnique({
      where: {
        organizationId_metric_periodStart: {
          organizationId,
          metric,
          periodStart: start,
        },
      },
    });
  }

  // --------------------------------------------------------------------------
  // Sync (Redis → Postgres)
  // --------------------------------------------------------------------------

  /**
   * Scans all `sheriabot:usage:*` Redis keys and upserts their current counts
   * into the Postgres UsageRecord table.
   *
   * This method is idempotent and safe to call multiple times per period.
   * It should be invoked by a scheduled job (e.g. nightly at 01:00 UTC).
   *
   * Key format: sheriabot:usage:{scopeId}:{BillingMetric}:{YYYY-MM}
   *
   * IMPORTANT: This method only syncs keys belonging to organizations (it
   * filters by checking whether the scopeId is a valid organizationId in
   * Postgres). Usage keys scoped to individual users (no org) are not
   * persisted — they are ephemeral and only enforced via Redis.
   *
   * @returns Number of UsageRecord rows upserted.
   */
  async syncToDatabase(): Promise<number> {
    logger.info({ type: 'usage_sync_start' });

    // Scan all usage keys — Upstash supports KEYS with wildcards
    let allKeys: string[];
    try {
      allKeys = await redis.keys(`${USAGE_PREFIX}*`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ type: 'usage_sync_keys_error', error: msg });
      return 0;
    }

    if (allKeys.length === 0) {
      logger.info({ type: 'usage_sync_complete', upserted: 0, reason: 'no_keys' });
      return 0;
    }

    // Parse keys into structured records
    const validMetrics = new Set<string>(Object.values(BillingMetric));

    type ParsedKey = {
      key:    string;
      scopeId: string;
      metric: BillingMetric;
      period: string;
    };

    const parsed: ParsedKey[] = [];

    for (const key of allKeys) {
      // Strip prefix, e.g. "sheriabot:usage:clXXX:COMPLIANCE_QUERIES:2026-03"
      const body  = key.slice(USAGE_PREFIX.length);
      // body = "{scopeId}:{metric}:{YYYY-MM}"
      // scopeId itself is a cuid (no colons), so we split from the right
      const parts = body.split(':');
      if (parts.length < 3) continue;

      const period = parts[parts.length - 1];  // 'YYYY-MM'
      const metric = parts[parts.length - 2];  // BillingMetric
      const scopeId = parts.slice(0, parts.length - 2).join(':');

      if (!validMetrics.has(metric)) continue;
      // Validate period format YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(period)) continue;

      parsed.push({ key, scopeId, metric: metric as BillingMetric, period });
    }

    if (parsed.length === 0) {
      logger.info({ type: 'usage_sync_complete', upserted: 0, reason: 'no_valid_keys' });
      return 0;
    }

    // Fetch all unique scopeIds that are valid organization IDs from Postgres
    const uniqueScopeIds = [...new Set(parsed.map((p) => p.scopeId))];

    const orgs = await prisma.organization.findMany({
      where: { id: { in: uniqueScopeIds } },
      select: { id: true },
    });

    const orgIdSet = new Set(orgs.map((o) => o.id));

    // Filter to org-scoped keys only
    const orgParsed = parsed.filter((p) => orgIdSet.has(p.scopeId));

    if (orgParsed.length === 0) {
      logger.info({ type: 'usage_sync_complete', upserted: 0, reason: 'no_org_keys' });
      return 0;
    }

    // Read all counts in parallel
    const counts = await Promise.all(orgParsed.map((p) => readRedisCount(p.key)));

    // Upsert in batches of 50 to avoid huge transaction sizes
    const BATCH_SIZE = 50;
    let totalUpserted = 0;

    for (let i = 0; i < orgParsed.length; i += BATCH_SIZE) {
      const batch = orgParsed.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (entry, j) => {
          const count = counts[i + j];
          if (count <= 0) return;

          const { start, end } = periodToDates(entry.period);

          try {
            await prisma.usageRecord.upsert({
              where: {
                organizationId_metric_periodStart: {
                  organizationId: entry.scopeId,
                  metric:         entry.metric,
                  periodStart:    start,
                },
              },
              update: {
                count:     count,
                updatedAt: new Date(),
              },
              create: {
                organizationId: entry.scopeId,
                metric:         entry.metric,
                count:          count,
                periodStart:    start,
                periodEnd:      end,
              },
            });
            totalUpserted++;
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error({
              type:    'usage_sync_upsert_error',
              orgId:   entry.scopeId,
              metric:  entry.metric,
              period:  entry.period,
              error:   msg,
            });
          }
        }),
      );
    }

    logger.info({
      type:      'usage_sync_complete',
      scanned:   allKeys.length,
      upserted:  totalUpserted,
      orgKeys:   orgParsed.length,
    });

    return totalUpserted;
  }

  // --------------------------------------------------------------------------
  // Reset (test / admin utility)
  // --------------------------------------------------------------------------

  /**
   * Deletes the Redis usage key for a given scope + metric + period.
   * Only for use in tests or admin reset flows — does NOT touch Postgres.
   */
  async resetRedisCounter(
    scopeId: string,
    metric:  BillingMetric,
    period?: string,
  ): Promise<void> {
    const key = usageKey(scopeId, metric, period ?? currentPeriod());
    try {
      await redis.del(key);
      logger.info({ type: 'usage_counter_reset', scopeId, metric, key });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ type: 'usage_counter_reset_error', key, error: msg });
    }
  }
}

// ============================================================================
// Singleton export
// ============================================================================

export const billingModule = new BillingModule();
export { BillingModule };
