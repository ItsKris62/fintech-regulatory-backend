import { BillingMetric } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export interface ReconcileOptions {
  staleThresholdMs?: number;
  batchSize?: number;
}

export interface ReconcileSummary {
  scanned: number;
  reconciled: number;
  settledCleaned: number;
  refundedUnits: number;
  errors: number;
}

interface StoredReservation {
  reservationId: string;
  orgId: string;
  userId?: string | null;
  operationId: string;
  metric: BillingMetric;
  units: number;
  periodKey: string;
  createdAt: string;
}

export class OrphanedCreditReconciliationService {
  /**
   * Scans for dangling usage reservations in Redis and reconciles orphaned credits.
   */
  async reconcileOrphanedCredits(options: ReconcileOptions = {}): Promise<ReconcileSummary> {
    const staleThresholdMs = options.staleThresholdMs ?? 15 * 60 * 1000;
    const now = Date.now();

    const summary: ReconcileSummary = {
      scanned: 0,
      reconciled: 0,
      settledCleaned: 0,
      refundedUnits: 0,
      errors: 0,
    };

    let cursor = '0';
    const reservationKeys: string[] = [];

    try {
      do {
        const res = await (redis as any).scan(cursor, 'MATCH', 'sheriabot:reservation:*', 'COUNT', options.batchSize ?? 100);
        if (!res || !Array.isArray(res)) break;
        const [nextCursor, keys] = res;
        cursor = String(nextCursor);
        if (Array.isArray(keys)) {
          reservationKeys.push(...keys);
        }
      } while (cursor !== '0' && cursor !== 'undefined');
    } catch (err: unknown) {
      logger.error({
        type: 'orphaned_credit_scan_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;
      return summary;
    }

    summary.scanned = reservationKeys.length;

    for (const key of reservationKeys) {
      try {
        const raw = await redis.get<string>(key);
        if (!raw) continue;

        let parsed: StoredReservation;
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          continue;
        }

        const createdAtMs = new Date(parsed.createdAt).getTime();
        const ageMs = now - createdAtMs;

        if (ageMs < staleThresholdMs) {
          // Still within active execution window; do not touch
          continue;
        }

        // Check if settled
        const settledKey = `sheriabot:settled:${parsed.orgId}:${parsed.operationId}`;
        const isSettled = await redis.get(settledKey);

        if (isSettled) {
          // Already settled; just cleanup leftover reservation key
          await redis.del(key);
          summary.settledCleaned++;
        } else {
          // Orphaned reservation! Roll back reserved quota
          const usageKey = `sheriabot:usage:${parsed.orgId}:${parsed.metric}:${parsed.periodKey}`;
          await redis.decrby(usageKey, parsed.units);
          await redis.del(key);

          summary.reconciled++;
          summary.refundedUnits += parsed.units;

          logger.info({
            type: 'orphaned_credit_reconciled',
            orgId: parsed.orgId,
            operationId: parsed.operationId,
            metric: parsed.metric,
            units: parsed.units,
            ageMs,
          });
        }
      } catch (err: unknown) {
        logger.error({
          type: 'orphaned_credit_reconciliation_item_failed',
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        summary.errors++;
      }
    }

    return summary;
  }
}

export const orphanedCreditReconciliationService = new OrphanedCreditReconciliationService();
