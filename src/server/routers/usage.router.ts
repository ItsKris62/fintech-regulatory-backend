/**
 * Usage Router
 *
 * tRPC procedures for per-organisation usage data.
 * All business logic is delegated to UsageTrackingService  -  this router
 * only handles input validation, calls the service, and formats errors.
 *
 * Procedures:
 *   usage.current       -  Current period summary (dashboard card)
 *   usage.history       -  Last N completed months (for period selector)
 *   usage.compare       -  Side-by-side comparison with a past period
 *   usage.periodDetail  -  Full breakdown for any single period (drill-down)
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc/trpc';
import { withPlanContext } from '../trpc/middleware';
import { usageTrackingService } from '@/services/usage-tracking.service';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import type { UsagePeriod } from '@prisma/client';

// -- Local helper --------------------------------------------------------------

/** Mirror the service's category builder for direct DB records in periodDetail. */
function periodRecordToCategories(
  rec: UsagePeriod,
): z.infer<typeof categorySummarySchema>[] {
  const pct = (count: number, limit: number): number =>
    limit > 0 && limit !== -1 ? Math.min(100, Math.round((count / limit) * 100)) : 0;

  return [
    { key: 'complianceQueries',    label: 'Compliance Queries',    current: rec.complianceQueries,    limit: rec.complianceQueryLimit,     available: rec.complianceQueryLimit     !== 0, percentUsed: pct(rec.complianceQueries,    rec.complianceQueryLimit) },
    { key: 'checklistGenerations', label: 'Checklist Generations', current: rec.checklistGenerations, limit: rec.checklistGenerationLimit, available: rec.checklistGenerationLimit !== 0, percentUsed: pct(rec.checklistGenerations, rec.checklistGenerationLimit) },
    { key: 'apiCalls',             label: 'API Calls',             current: rec.apiCalls,             limit: rec.apiCallLimit,             available: rec.apiCallLimit             !== 0, percentUsed: pct(rec.apiCalls,             rec.apiCallLimit) },
    { key: 'documentStorageMb',    label: 'Document Storage (MB)', current: rec.documentStorageMb,    limit: rec.documentStorageMbLimit,   available: rec.documentStorageMbLimit   !== 0, percentUsed: pct(rec.documentStorageMb,    rec.documentStorageMbLimit) },
    { key: 'gapAnalyses',          label: 'Gap Analyses',          current: rec.gapAnalyses,          limit: rec.gapAnalysisLimit,         available: rec.gapAnalysisLimit         !== 0, percentUsed: 0 },
    { key: 'policyGenerations',    label: 'Policy Generations',    current: rec.policyGenerations,    limit: rec.policyGenerationLimit,    available: rec.policyGenerationLimit    !== 0, percentUsed: 0 },
  ];
}

// -- Zod output schemas --------------------------------------------------------

const categorySummarySchema = z.object({
  /** Field name on UsagePeriod (e.g. "complianceQueries") */
  key:         z.string(),
  label:       z.string(),
  current:     z.number(),
  /**
   * Monthly cap from the plan snapshot.
   * -1 = unlimited,  0 = feature not available on this plan,  n = monthly cap
   */
  limit:       z.number(),
  available:   z.boolean(),
  /** 0-100; 0 when unlimited or unavailable */
  percentUsed: z.number(),
});

const usageSummarySchema = z.object({
  period: z.object({
    start:         z.date(),
    end:           z.date(),
    daysRemaining: z.number().int().nonnegative(),
    daysTotal:     z.number().int().positive(),
  }),
  planTier:   z.string(),
  categories: z.array(categorySummarySchema),
});

const usagePeriodSummarySchema = z.object({
  periodId:    z.string(),
  periodStart: z.date(),
  periodEnd:   z.date(),
  planTier:    z.string(),
  categories:  z.array(categorySummarySchema),
});

const usageChangeItemSchema = z.object({
  key:           z.string(),
  label:         z.string(),
  currentCount:  z.number(),
  previousCount: z.number(),
  /** Positive = increase, negative = decrease */
  changePercent: z.number(),
  direction:     z.enum(['up', 'down', 'same']),
});

const usageComparisonSchema = z.object({
  current:  usagePeriodSummarySchema,
  previous: usagePeriodSummarySchema,
  changes:  z.array(usageChangeItemSchema),
});

// -- Router --------------------------------------------------------------------

export const usageRouter = router({
  /**
   * Get the current billing period's usage summary.
   *
   * Returns period boundaries, days remaining, plan tier, and a per-category
   * breakdown (current / limit / percentUsed / available).
   *
   * Hot path: reads live Redis counters and triggers a non-blocking DB sync.
   * Frontend should set staleTime to ~60 s  -  usage changes infrequently per session.
   *
   * @protected  -  requires authentication + withPlanContext
   */
  current: protectedProcedure
    .use(withPlanContext)
    .output(usageSummarySchema)
    .query(async ({ ctx }) => {
      const orgId = ctx.user.organizationId;
      if (!orgId) {
        // Users without an org get REGULATOR defaults with zero usage
        return {
          period: {
            start:         new Date(),
            end:           new Date(),
            daysRemaining: 0,
            daysTotal:     31,
          },
          planTier:   'REGULATOR',
          categories: [],
        };
      }

      try {
        const summary = await usageTrackingService.getCurrentUsageSummary(orgId);

        logger.info({
          type:   'usage_current_fetched',
          userId: ctx.user.id,
          orgId,
        });

        return summary;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ type: 'usage_current_error', userId: ctx.user.id, orgId, error: message });
        throw new TRPCError({
          code:    'INTERNAL_SERVER_ERROR',
          message: 'Failed to load current usage data.',
          cause:   error,
        });
      }
    }),

  /**
   * Get usage summaries for the last N completed months.
   *
   * "Completed" = any billing period before the current EAT calendar month.
   * Results are ordered newest -> oldest.
   * Reads entirely from the UsagePeriod DB table  -  no Redis access.
   *
   * Used to populate the comparison month selector in the UI.
   *
   * @protected  -  requires authentication
   */
  history: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        /** Number of past months to return. Defaults to 6. Max 24. */
        months: z.number().int().min(1).max(24).default(6),
      }),
    )
    .output(z.array(usagePeriodSummarySchema))
    .query(async ({ input, ctx }) => {
      const orgId = ctx.user.organizationId;
      if (!orgId) return [];

      try {
        const history = await usageTrackingService.getUsageHistory(orgId, input.months);

        logger.info({
          type:         'usage_history_fetched',
          userId:       ctx.user.id,
          orgId,
          monthsBack:   input.months,
          periodsFound: history.length,
        });

        return history;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ type: 'usage_history_error', userId: ctx.user.id, orgId, error: message });
        throw new TRPCError({
          code:    'INTERNAL_SERVER_ERROR',
          message: 'Failed to load usage history.',
          cause:   error,
        });
      }
    }),

  /**
   * Compare the current period against a specific past period.
   *
   * `comparePeriodStart` must be the exact `periodStart` Date from a UsagePeriod
   * record (as returned by `usage.history`). Pass it as an ISO-8601 string;
   * Zod coerces it to Date.
   *
   * Returns current + previous summaries and a per-category change breakdown
   * with direction ("up" | "down" | "same") and change percentage.
   *
   * @protected  -  requires authentication
   */
  compare: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        /**
         * The `periodStart` of the period to compare against.
         * Must be an ISO-8601 string (e.g. "2026-02-28T21:00:00.000Z").
         * Zod coerces this to a Date for the service call.
         */
        comparePeriodStart: z.string().datetime(),
      }),
    )
    .output(usageComparisonSchema)
    .query(async ({ input, ctx }) => {
      const orgId = ctx.user.organizationId;
      if (!orgId) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'Usage comparison requires an active organisation.',
        });
      }

      const comparePeriodStart = new Date(input.comparePeriodStart);

      try {
        const comparison = await usageTrackingService.compareUsage(orgId, comparePeriodStart);

        logger.info({
          type:               'usage_compare_fetched',
          userId:             ctx.user.id,
          orgId,
          comparePeriodStart: input.comparePeriodStart,
        });

        return comparison;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        // Surface "not found" as a 404 rather than a 500
        if (message.includes('No usage period found')) {
          throw new TRPCError({
            code:    'NOT_FOUND',
            message: `No usage data found for the selected period. It may not exist yet.`,
          });
        }

        logger.error({ type: 'usage_compare_error', userId: ctx.user.id, orgId, error: message });
        throw new TRPCError({
          code:    'INTERNAL_SERVER_ERROR',
          message: 'Failed to load usage comparison.',
          cause:   error,
        });
      }
    }),

  /**
   * Get the full usage breakdown for a specific period by its DB record ID.
   *
   * Useful for drill-down views. Always reads from the DB snapshot  -  not Redis.
   * The current period's live counters are NOT reflected here; use `usage.current`
   * for the live view.
   *
   * @protected  -  requires authentication; org-scoped (cannot access another org's data)
   */
  periodDetail: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        periodId: z.string().min(1),
      }),
    )
    .output(usagePeriodSummarySchema)
    .query(async ({ input, ctx }) => {
      const orgId = ctx.user.organizationId;
      if (!orgId) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'Usage detail requires an active organisation.',
        });
      }

      try {
        const record = await prisma.usagePeriod.findFirst({
          where: {
            id:             input.periodId,
            organizationId: orgId, // org-scope: users cannot access other orgs' data
          },
        });

        if (!record) {
          throw new TRPCError({
            code:    'NOT_FOUND',
            message: 'Usage period not found.',
          });
        }

        logger.info({
          type:     'usage_period_detail_fetched',
          userId:   ctx.user.id,
          orgId,
          periodId: input.periodId,
        });

        return {
          periodId:    record.id,
          periodStart: record.periodStart,
          periodEnd:   record.periodEnd,
          planTier:    record.planTier,
          categories:  periodRecordToCategories(record),
        };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ type: 'usage_period_detail_error', userId: ctx.user.id, orgId, error: message });
        throw new TRPCError({
          code:    'INTERNAL_SERVER_ERROR',
          message: 'Failed to load usage period detail.',
          cause:   error,
        });
      }
    }),
});
