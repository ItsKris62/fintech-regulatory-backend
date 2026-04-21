/**
 * UsageTrackingService
 *
 * Handles all usage tracking business logic:
 *   - Period management (get/create current EAT calendar-month UsagePeriod)
 *   - Lazy sync of Redis counters -> UsagePeriod DB record
 *   - Dashboard summary (current usage with period context)
 *   - Usage history (last N completed months from DB)
 *   - Usage comparison (current vs a past period)
 *   - Document storage increment (float-safe Redis INCRBYFLOAT)
 *   - Plan limit snapshotting on plan change
 *
 * Design principles:
 *   - Redis is the real-time enforcement source of truth (read by checkUsageLimit middleware).
 *   - UsagePeriod DB records are the durable history store, synced lazily on reads.
 *   - Period boundaries use EAT (UTC+3) calendar months, stored as UTC equivalents.
 *   - Redis key format matches checkUsageLimit middleware exactly (UTC YYYY-MM month key).
 */

import { BillingMetric, SubscriptionPlan, type UsagePeriod } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';

// -- Constants ------------------------------------------------------------------

/** EAT = UTC+3 in milliseconds */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * TTL for document storage Redis keys: 35 days.
 * Matches the TTL used by checkUsageLimit middleware for integer counters.
 */
const USAGE_TTL_SECONDS = 35 * 24 * 60 * 60;

// -- Internal types -------------------------------------------------------------

interface PeriodCounters {
  complianceQueries:    number;
  checklistGenerations: number;
  apiCalls:             number;
  documentStorageMb:    number;
  gapAnalyses:          number;
  policyGenerations:    number;
}

interface PeriodLimits {
  planTier:                 string;
  complianceQueryLimit:     number;
  checklistGenerationLimit: number;
  apiCallLimit:             number;
  documentStorageMbLimit:   number;
  gapAnalysisLimit:         number;
  policyGenerationLimit:    number;
}

// -- Public types ---------------------------------------------------------------

export interface CategorySummary {
  /** Field name on UsagePeriod (e.g. "complianceQueries") */
  key:         string;
  label:       string;
  /** Current usage count this period */
  current:     number;
  /**
   * Monthly cap from the plan snapshot.
   * -1 = unlimited,  0 = feature not available on this plan,  n = cap
   */
  limit:       number;
  /** false when limit === 0 (feature not in plan) */
  available:   boolean;
  /** 0-100; 0 when unlimited or unavailable */
  percentUsed: number;
}

export interface UsageSummary {
  period: {
    start:        Date;
    end:          Date;
    daysRemaining: number;
    daysTotal:    number;
  };
  planTier:   string;
  categories: CategorySummary[];
}

export interface UsagePeriodSummary {
  periodId:    string;
  periodStart: Date;
  periodEnd:   Date;
  planTier:    string;
  categories:  CategorySummary[];
}

export interface UsageChangeItem {
  key:           string;
  label:         string;
  currentCount:  number;
  previousCount: number;
  /** Positive = increase, negative = decrease */
  changePercent: number;
  direction:     'up' | 'down' | 'same';
}

export interface UsageComparison {
  current:  UsagePeriodSummary;
  previous: UsagePeriodSummary;
  changes:  UsageChangeItem[];
}

// -- Category metadata ----------------------------------------------------------

/**
 * Ordered list of trackable usage categories.
 * `key` must match PeriodCounters field names.
 * `limitKey` must match PeriodLimits field names.
 */
const CATEGORIES: ReadonlyArray<{
  key:      keyof PeriodCounters;
  limitKey: keyof Omit<PeriodLimits, 'planTier'>;
  label:    string;
}> = [
  { key: 'complianceQueries',    limitKey: 'complianceQueryLimit',     label: 'Compliance Queries' },
  { key: 'checklistGenerations', limitKey: 'checklistGenerationLimit', label: 'Checklist Generations' },
  { key: 'apiCalls',             limitKey: 'apiCallLimit',             label: 'API Calls' },
  { key: 'documentStorageMb',    limitKey: 'documentStorageMbLimit',   label: 'Document Storage (MB)' },
  { key: 'gapAnalyses',          limitKey: 'gapAnalysisLimit',         label: 'Gap Analyses' },
  { key: 'policyGenerations',    limitKey: 'policyGenerationLimit',    label: 'Policy Generations' },
] as const;

// -- Period helpers -------------------------------------------------------------

/** Return the current year and 1-based month in EAT (UTC+3). */
function getCurrentEATMonth(): { year: number; month: number } {
  const eatDate = new Date(Date.now() + EAT_OFFSET_MS);
  return {
    year:  eatDate.getUTCFullYear(),
    month: eatDate.getUTCMonth() + 1, // 1-based
  };
}

/**
 * Compute UTC Date boundaries for a calendar month expressed in EAT.
 *
 * Example  -  March 2026:
 *   start: 2026-02-28T21:00:00.000Z  (= 2026-03-01 00:00:00 EAT)
 *   end:   2026-03-31T20:59:59.999Z  (= 2026-03-31 23:59:59.999 EAT)
 */
function eatMonthBoundaries(year: number, month: number): { start: Date; end: Date } {
  const start   = new Date(Date.UTC(year, month - 1, 1) - EAT_OFFSET_MS);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day-0 trick
  const end     = new Date(Date.UTC(year, month - 1, lastDay, 23, 59, 59, 999) - EAT_OFFSET_MS);
  return { start, end };
}

/** Total days in an EAT calendar month. */
function eatMonthTotalDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Days remaining in the period (inclusive of today in EAT).
 * Returns 0 when the period has already ended.
 */
function daysRemainingInPeriod(periodEnd: Date): number {
  const msRemaining = (periodEnd.getTime() + EAT_OFFSET_MS) - (Date.now() + EAT_OFFSET_MS);
  return Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
}

/**
 * Redis key for a usage metric  -  matches the key format used by checkUsageLimit
 * middleware exactly (UTC-based YYYY-MM month suffix).
 */
function redisUsageKey(orgId: string, metric: BillingMetric): string {
  const period = new Date().toISOString().slice(0, 7); // 'YYYY-MM' UTC
  return `sheriabot:usage:${orgId}:${metric}:${period}`;
}

// -- Plan limits helper --------------------------------------------------------

/**
 * Derive the UsagePeriod limit snapshot fields from PLAN_ENTITLEMENTS.
 *
 * Convention (same as PLAN_ENTITLEMENTS and checkUsageLimit):
 *   -1 = unlimited,  0 = feature not in plan,  n = monthly cap
 * Boolean features (gapAnalysis, policyGeneration) are stored as -1 (enabled) or 0 (disabled).
 */
function resolvePlanLimits(plan: SubscriptionPlan): PeriodLimits {
  const e = PLAN_ENTITLEMENTS[plan];
  return {
    planTier:                 plan,
    complianceQueryLimit:     e.complianceQueries.limit,
    checklistGenerationLimit: e.checklistGenerations.limit,
    apiCallLimit:             e.apiAccess === false ? 0 : e.apiAccess.limit,
    documentStorageMbLimit:   e.documentRepository.limitMB,
    gapAnalysisLimit:         e.gapAnalysis    ? -1 : 0,
    policyGenerationLimit:    e.policyGeneration ? -1 : 0,
  };
}

// -- Category builder ----------------------------------------------------------

function buildCategorySummary(
  meta:     (typeof CATEGORIES)[number],
  counters: PeriodCounters,
  limits:   PeriodLimits,
): CategorySummary {
  const current   = counters[meta.key];
  const limit     = limits[meta.limitKey] as number;
  const available = limit !== 0;
  const unlimited = limit === -1;

  const percentUsed =
    unlimited || !available || limit <= 0
      ? 0
      : Math.min(100, Math.round((current / limit) * 100));

  return { key: meta.key, label: meta.label, current, limit, available, percentUsed };
}

function buildCategories(counters: PeriodCounters, limits: PeriodLimits): CategorySummary[] {
  return CATEGORIES.map((meta) => buildCategorySummary(meta, counters, limits));
}

// -- Service class -------------------------------------------------------------

class UsageTrackingService {
  // -- Period management -----------------------------------------------------

  /**
   * Get or create the UsagePeriod record for the current EAT calendar month.
   *
   * On first access for this org + month:
   *   - Fetches the org's plan from DB
   *   - Creates the UsagePeriod with zeroed counters and snapshotted limits
   *
   * On subsequent calls: returns the existing record without modification.
   */
  async getCurrentPeriod(organizationId: string): Promise<UsagePeriod> {
    const { year, month } = getCurrentEATMonth();
    const { start, end }  = eatMonthBoundaries(year, month);

    // Fetch current plan for limit snapshot (used only in `create` path of upsert)
    const org  = await prisma.organization.findUnique({
      where:  { id: organizationId },
      select: { plan: true },
    });
    const limits = resolvePlanLimits(org?.plan ?? SubscriptionPlan.REGULATOR);

    const period = await prisma.usagePeriod.upsert({
      where:  { organizationId_periodStart: { organizationId, periodStart: start } },
      create: {
        organizationId,
        periodStart: start,
        periodEnd:   end,
        ...limits,
      },
      // Never overwrite existing counters on read  -  sync is a separate step
      update: {},
    });

    return period;
  }

  /**
   * Re-snapshot the current plan's limits into the active UsagePeriod record.
   *
   * Call this after an org's plan changes (upgrade/downgrade) so the current
   * period reflects the correct limits. Historical periods are not modified.
   */
  async snapshotPlanLimits(organizationId: string): Promise<void> {
    const [period, org] = await Promise.all([
      this.getCurrentPeriod(organizationId),
      prisma.organization.findUnique({
        where:  { id: organizationId },
        select: { plan: true },
      }),
    ]);

    if (!org) return;

    const limits = resolvePlanLimits(org.plan);
    await prisma.usagePeriod.update({
      where: { id: period.id },
      data:  limits,
    });

    logger.info({
      type:           'usage_period_limits_snapshotted',
      organizationId,
      plan:            org.plan,
      periodStart:     period.periodStart.toISOString(),
    });
  }

  // -- Redis reads -----------------------------------------------------------

  /**
   * Read all six usage counters from Redis for the current UTC month.
   * Key format matches checkUsageLimit middleware exactly.
   * Any missing or unreadable key falls back to 0.
   */
  private async readRedisCounters(orgId: string): Promise<PeriodCounters> {
    const readOne = async (metric: BillingMetric): Promise<number> => {
      try {
        const raw = await redis.get<number>(redisUsageKey(orgId, metric));
        if (typeof raw === 'number') return raw;
        if (typeof raw === 'string') {
          const parsed = parseFloat(raw);
          return isNaN(parsed) ? 0 : parsed;
        }
        return 0;
      } catch {
        return 0;
      }
    };

    const [
      complianceQueries,
      checklistGenerations,
      apiCalls,
      documentStorageMb,
      gapAnalyses,
      policyGenerations,
    ] = await Promise.all([
      readOne(BillingMetric.COMPLIANCE_QUERIES),
      readOne(BillingMetric.CHECKLIST_GENERATIONS),
      readOne(BillingMetric.API_CALLS),
      readOne(BillingMetric.DOCUMENT_STORAGE_MB),
      readOne(BillingMetric.GAP_ANALYSES),
      readOne(BillingMetric.POLICY_GENERATIONS),
    ]);

    return {
      complianceQueries,
      checklistGenerations,
      apiCalls,
      documentStorageMb,
      gapAnalyses,
      policyGenerations,
    };
  }

  // -- Lazy sync -------------------------------------------------------------

  /**
   * Write the current Redis counter values into the UsagePeriod DB record.
   *
   * Called as a non-blocking side effect on each dashboard read.
   * This ensures the DB always has a recent snapshot before the 35-day
   * Redis key expiry deletes the live data.
   */
  private async syncRedisToDb(
    periodId: string,
    counters: PeriodCounters,
  ): Promise<void> {
    await prisma.usagePeriod.update({
      where: { id: periodId },
      data:  {
        complianceQueries:    counters.complianceQueries,
        checklistGenerations: counters.checklistGenerations,
        apiCalls:             counters.apiCalls,
        documentStorageMb:    counters.documentStorageMb,
        gapAnalyses:          counters.gapAnalyses,
        policyGenerations:    counters.policyGenerations,
        syncedFromRedisAt:    new Date(),
      },
    });
  }

  // -- Document storage increment --------------------------------------------

  /**
   * Atomically add to the document storage usage counter for an org.
   *
   * Uses Redis INCRBYFLOAT to accumulate fractional MB values.
   * `fileSizeBytes` is the raw byte count from VaultDocument.fileSize (Int).
   *
   * Non-fatal: errors are logged and swallowed so upload flow is never blocked.
   */
  async incrementDocumentStorage(
    organizationId: string,
    fileSizeBytes:  number,
  ): Promise<void> {
    const fileSizeMb = fileSizeBytes / (1024 * 1024);
    const key = redisUsageKey(organizationId, BillingMetric.DOCUMENT_STORAGE_MB);

    try {
      const newTotal = await redis.incrbyfloat(key, fileSizeMb);

      // Set TTL on first write (newTotal ≈ fileSizeMb when key was just created)
      if (newTotal <= fileSizeMb + 0.001) {
        await redis.expire(key, USAGE_TTL_SECONDS);
      }

      logger.info({
        type:           'document_storage_incremented',
        organizationId,
        fileSizeMb,
        totalStorageMb: newTotal,
      });
    } catch (error: unknown) {
      logger.warn({
        type:           'document_storage_increment_failed',
        organizationId,
        fileSizeMb,
        error:          error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -- Dashboard summary ------------------------------------------------------

  /**
   * Return the current period's usage summary for the dashboard card.
   *
   * Flow:
   *   1. Parallel: get/create UsagePeriod + read Redis counters
   *   2. Fire non-blocking DB sync (preserves data before Redis expiry)
   *   3. Return formatted summary with period dates and category breakdown
   */
  async getCurrentUsageSummary(organizationId: string): Promise<UsageSummary> {
    const [period, counters] = await Promise.all([
      this.getCurrentPeriod(organizationId),
      this.readRedisCounters(organizationId),
    ]);

    // Non-blocking lazy sync to DB  -  failures are logged but never propagated
    void this.syncRedisToDb(period.id, counters).catch((err: unknown) => {
      logger.warn({
        type:           'usage_redis_sync_failed',
        organizationId,
        error:          err instanceof Error ? err.message : String(err),
      });
    });

    const { year, month } = getCurrentEATMonth();
    const daysTotal       = eatMonthTotalDays(year, month);
    const daysRemaining   = daysRemainingInPeriod(period.periodEnd);

    const limits: PeriodLimits = {
      planTier:                 period.planTier,
      complianceQueryLimit:     period.complianceQueryLimit,
      checklistGenerationLimit: period.checklistGenerationLimit,
      apiCallLimit:             period.apiCallLimit,
      documentStorageMbLimit:   period.documentStorageMbLimit,
      gapAnalysisLimit:         period.gapAnalysisLimit,
      policyGenerationLimit:    period.policyGenerationLimit,
    };

    return {
      period: {
        start:         period.periodStart,
        end:           period.periodEnd,
        daysRemaining,
        daysTotal,
      },
      planTier:   period.planTier,
      categories: buildCategories(counters, limits),
    };
  }

  // -- Usage history ---------------------------------------------------------

  /**
   * Return summaries for the last N completed billing periods.
   *
   * "Completed" means any UsagePeriod with a periodStart before the current
   * EAT month. The current period is always excluded.
   *
   * Results are ordered newest -> oldest.
   * Reads entirely from DB  -  no Redis access.
   */
  async getUsageHistory(
    organizationId: string,
    months = 6,
  ): Promise<UsagePeriodSummary[]> {
    const { year, month }             = getCurrentEATMonth();
    const { start: currentPeriodStart } = eatMonthBoundaries(year, month);

    const records = await prisma.usagePeriod.findMany({
      where:   { organizationId, periodStart: { lt: currentPeriodStart } },
      orderBy: { periodStart: 'desc' },
      take:    months,
    });

    return records.map((rec) => {
      const counters: PeriodCounters = {
        complianceQueries:    rec.complianceQueries,
        checklistGenerations: rec.checklistGenerations,
        apiCalls:             rec.apiCalls,
        documentStorageMb:    rec.documentStorageMb,
        gapAnalyses:          rec.gapAnalyses,
        policyGenerations:    rec.policyGenerations,
      };
      const limits: PeriodLimits = {
        planTier:                 rec.planTier,
        complianceQueryLimit:     rec.complianceQueryLimit,
        checklistGenerationLimit: rec.checklistGenerationLimit,
        apiCallLimit:             rec.apiCallLimit,
        documentStorageMbLimit:   rec.documentStorageMbLimit,
        gapAnalysisLimit:         rec.gapAnalysisLimit,
        policyGenerationLimit:    rec.policyGenerationLimit,
      };
      return {
        periodId:    rec.id,
        periodStart: rec.periodStart,
        periodEnd:   rec.periodEnd,
        planTier:    rec.planTier,
        categories:  buildCategories(counters, limits),
      };
    });
  }

  // -- Usage comparison ------------------------------------------------------

  /**
   * Compare current period usage against a specific past period.
   *
   * `comparePeriodStart` must match the exact `periodStart` Date stored in a
   * UsagePeriod record (as returned by `getUsageHistory`).
   *
   * Throws a descriptive error if the comparison period is not found.
   */
  async compareUsage(
    organizationId:     string,
    comparePeriodStart: Date,
  ): Promise<UsageComparison> {
    // Fetch current period + live counters in parallel
    const [currentPeriod, currentCounters, prevRecord] = await Promise.all([
      this.getCurrentPeriod(organizationId),
      this.readRedisCounters(organizationId),
      prisma.usagePeriod.findFirst({
        where: { organizationId, periodStart: comparePeriodStart },
      }),
    ]);

    if (!prevRecord) {
      throw new Error(
        `No usage period found for org ${organizationId} starting at ${comparePeriodStart.toISOString()}`,
      );
    }

    // Build current summary
    const currentLimits: PeriodLimits = {
      planTier:                 currentPeriod.planTier,
      complianceQueryLimit:     currentPeriod.complianceQueryLimit,
      checklistGenerationLimit: currentPeriod.checklistGenerationLimit,
      apiCallLimit:             currentPeriod.apiCallLimit,
      documentStorageMbLimit:   currentPeriod.documentStorageMbLimit,
      gapAnalysisLimit:         currentPeriod.gapAnalysisLimit,
      policyGenerationLimit:    currentPeriod.policyGenerationLimit,
    };

    const currentSummary: UsagePeriodSummary = {
      periodId:    currentPeriod.id,
      periodStart: currentPeriod.periodStart,
      periodEnd:   currentPeriod.periodEnd,
      planTier:    currentPeriod.planTier,
      categories:  buildCategories(currentCounters, currentLimits),
    };

    // Build previous summary
    const prevCounters: PeriodCounters = {
      complianceQueries:    prevRecord.complianceQueries,
      checklistGenerations: prevRecord.checklistGenerations,
      apiCalls:             prevRecord.apiCalls,
      documentStorageMb:    prevRecord.documentStorageMb,
      gapAnalyses:          prevRecord.gapAnalyses,
      policyGenerations:    prevRecord.policyGenerations,
    };
    const prevLimits: PeriodLimits = {
      planTier:                 prevRecord.planTier,
      complianceQueryLimit:     prevRecord.complianceQueryLimit,
      checklistGenerationLimit: prevRecord.checklistGenerationLimit,
      apiCallLimit:             prevRecord.apiCallLimit,
      documentStorageMbLimit:   prevRecord.documentStorageMbLimit,
      gapAnalysisLimit:         prevRecord.gapAnalysisLimit,
      policyGenerationLimit:    prevRecord.policyGenerationLimit,
    };

    const previousSummary: UsagePeriodSummary = {
      periodId:    prevRecord.id,
      periodStart: prevRecord.periodStart,
      periodEnd:   prevRecord.periodEnd,
      planTier:    prevRecord.planTier,
      categories:  buildCategories(prevCounters, prevLimits),
    };

    // Compute per-category change items
    const changes: UsageChangeItem[] = CATEGORIES.map((meta) => {
      const curr  = currentCounters[meta.key];
      const prev  = prevCounters[meta.key];
      const delta = curr - prev;

      let changePercent: number;
      if (prev > 0) {
        changePercent = Math.round((delta / prev) * 100);
      } else if (curr > 0) {
        changePercent = 100; // 0 -> n = 100% increase
      } else {
        changePercent = 0;
      }

      const direction: 'up' | 'down' | 'same' =
        delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';

      return {
        key:           meta.key,
        label:         meta.label,
        currentCount:  curr,
        previousCount: prev,
        changePercent,
        direction,
      };
    });

    return { current: currentSummary, previous: previousSummary, changes };
  }
}

// -- Singleton export -----------------------------------------------------------

export const usageTrackingService = new UsageTrackingService();
export { UsageTrackingService };
