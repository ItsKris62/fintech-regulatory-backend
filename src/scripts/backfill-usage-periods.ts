/**
 * One-time backfill script: reconstruct historical UsagePeriod records from
 * existing timestamped records (ComplianceQuery, Checklist, GapAnalysis, Policy).
 *
 * Run manually AFTER running the add_usage_period.sql migration:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-usage-periods.ts
 *
 * Safe to run multiple times  -  uses upserts (createMany with skipDuplicates).
 *
 * Caveats:
 * - Plan limits are snapshotted from each org's CURRENT plan (imperfect for
 *   orgs that have upgraded/downgraded, but best available without plan history).
 * - documentStorageMb is left at 0 for all historical periods (no size data
 *   on existing records; the live system will track this going forward).
 * - apiCalls are left at 0 (the feature was never metered in existing code).
 */

import 'dotenv/config';
import { SubscriptionPlan } from '@prisma/client';
import { prisma } from '../lib/prisma/client';
import { PLAN_ENTITLEMENTS } from '../config/entitlements.config';


// EAT offset: UTC+3
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Convert a UTC timestamp to the EAT (UTC+3) calendar month key "YYYY-MM".
 * Used to group records by the month they occurred in (from the user's POV).
 */
function toEATMonthKey(utcDate: Date): string {
  const eatMs = utcDate.getTime() + EAT_OFFSET_MS;
  const eatDate = new Date(eatMs);
  const y = eatDate.getUTCFullYear();
  const m = String(eatDate.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Compute the UTC timestamps for the boundaries of a calendar month in EAT.
 * e.g. "2026-03" -> { start: 2026-02-28T21:00:00.000Z, end: 2026-03-31T20:59:59.999Z }
 */
function eatMonthBoundaries(monthKey: string): { start: Date; end: Date } {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10); // 1-based

  // EAT midnight on the 1st = UTC midnight on the 1st MINUS 3 hours
  const startUTC = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - EAT_OFFSET_MS);

  // EAT 23:59:59.999 on last day = UTC 20:59:59.999 on same last day
  const lastDayUTC = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
  const lastDay = lastDayUTC.getUTCDate();
  const endUTC = new Date(Date.UTC(year, month - 1, lastDay, 23, 59, 59, 999) - EAT_OFFSET_MS);

  return { start: startUTC, end: endUTC };
}

/**
 * Resolve the limit snapshot for a given plan.
 * Boolean features (gapAnalysis, policyGeneration) -> -1 if enabled, 0 if not.
 */
function resolveLimits(plan: SubscriptionPlan): {
  planTier: string;
  complianceQueryLimit: number;
  checklistGenerationLimit: number;
  apiCallLimit: number;
  documentStorageMbLimit: number;
  gapAnalysisLimit: number;
  policyGenerationLimit: number;
} {
  const e = PLAN_ENTITLEMENTS[plan];

  const apiCallLimit = e.apiAccess === false ? 0 : e.apiAccess.limit;

  return {
    planTier: plan,
    complianceQueryLimit: e.complianceQueries.limit,
    checklistGenerationLimit: e.checklistGenerations.limit,
    apiCallLimit,
    documentStorageMbLimit: e.documentRepository.limitMB,
    gapAnalysisLimit: e.gapAnalysis ? -1 : 0,
    policyGenerationLimit: e.policyGeneration ? -1 : 0,
  };
}

/** Accumulator shape for building period records before upsert */
interface PeriodAccumulator {
  complianceQueries: number;
  checklistGenerations: number;
  gapAnalyses: number;
  policyGenerations: number;
}

type OrgPeriodMap = Map<string, PeriodAccumulator>; // key = "YYYY-MM"

async function main(): Promise<void> {
  console.log('🔁 Starting UsagePeriod backfill...\n');

  // -- 1. Load all organizations ----------------------------------------------
  const orgs = await prisma.organization.findMany({
    select: { id: true, plan: true, name: true },
  });
  console.log(`Found ${orgs.length} organization(s).\n`);

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const org of orgs) {
    const periodMap: OrgPeriodMap = new Map();

    const ensure = (key: string): PeriodAccumulator => {
      if (!periodMap.has(key)) {
        periodMap.set(key, {
          complianceQueries: 0,
          checklistGenerations: 0,
          gapAnalyses: 0,
          policyGenerations: 0,
        });
      }
      return periodMap.get(key)!;
    };

    // -- 2a. Compliance Queries ---------------------------------------------
    const queries = await prisma.complianceQuery.findMany({
      where: { organizationId: org.id },
      select: { createdAt: true },
    });
    for (const q of queries) {
      const key = toEATMonthKey(q.createdAt);
      ensure(key).complianceQueries += 1;
    }

    // -- 2b. Checklist Generations ------------------------------------------
    // Only count checklists that were actually generated (not in GENERATING state)
    const checklists = await prisma.checklist.findMany({
      where: {
        organizationId: org.id,
        deletedAt: null,
        status: { not: 'GENERATING' },
      },
      select: { createdAt: true },
    });
    for (const c of checklists) {
      const key = toEATMonthKey(c.createdAt);
      ensure(key).checklistGenerations += 1;
    }

    // -- 2c. Gap Analyses ---------------------------------------------------
    const gapAnalyses = await prisma.gapAnalysis.findMany({
      where: { organizationId: org.id },
      select: { createdAt: true },
    });
    for (const g of gapAnalyses) {
      const key = toEATMonthKey(g.createdAt);
      ensure(key).gapAnalyses += 1;
    }

    // -- 2d. Policy Generations ---------------------------------------------
    // Policies are scoped by userId on the Policy model, not organizationId.
    // Join via user.organizationId.
    const policies = await prisma.policy.findMany({
      where: {
        user: { organizationId: org.id },
        status: { not: 'DRAFT' }, // only count actually generated ones
      },
      select: { createdAt: true },
    });
    for (const p of policies) {
      const key = toEATMonthKey(p.createdAt);
      ensure(key).policyGenerations += 1;
    }

    if (periodMap.size === 0) {
      console.log(`  ${org.name}: no historical activity  -  skipping.`);
      totalSkipped += 1;
      continue;
    }

    // -- 3. Resolve plan limits snapshot -----------------------------------
    const limits = resolveLimits(org.plan);

    // -- 4. Build upsert data ----------------------------------------------
    const periodsToCreate = Array.from(periodMap.entries()).map(([monthKey, counts]) => {
      const { start, end } = eatMonthBoundaries(monthKey);
      return {
        id: `backfill-${org.id}-${monthKey}`, // deterministic ID for idempotency
        organizationId: org.id,
        periodStart: start,
        periodEnd: end,
        complianceQueries: counts.complianceQueries,
        checklistGenerations: counts.checklistGenerations,
        apiCalls: 0, // not metered historically
        documentStorageMb: 0, // not tracked historically
        gapAnalyses: counts.gapAnalyses,
        policyGenerations: counts.policyGenerations,
        ...limits,
        syncedFromRedisAt: null, // backfilled from DB, not from Redis
      };
    });

    // -- 5. Upsert (createMany with skipDuplicates for idempotency) ---------
    const result = await prisma.usagePeriod.createMany({
      data: periodsToCreate,
      skipDuplicates: true,
    });

    const skippedForOrg = periodsToCreate.length - result.count;
    console.log(
      `  ${org.name} (${org.plan}): ` +
      `${periodMap.size} period(s) found  -  ` +
      `${result.count} created, ${skippedForOrg} already existed.`,
    );
    totalCreated += result.count;
    totalSkipped += skippedForOrg;
  }

  console.log(`\n✅ Backfill complete.`);
  console.log(`   Created: ${totalCreated} UsagePeriod records`);
  console.log(`   Skipped (already existed): ${totalSkipped}`);
}

main()
  .catch((err: unknown) => {
    console.error('❌ Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
