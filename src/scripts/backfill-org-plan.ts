/**
 * Backfill script: sync Organization.plan from Organization.subscriptionTier
 *
 * Background
 * ----------
 * The Organization model has two subscription-related fields:
 *   - subscriptionTier (String, legacy) — written by the admin module and,
 *     historically, by any billing code that predates the enum migration.
 *   - plan (SubscriptionPlan enum, authoritative) — read by withPlanContext
 *     to gate features. Defaults to REGULATOR.
 *
 * Any org whose subscriptionTier indicates a paid tier but whose plan column
 * is still REGULATOR (the schema default) has been wrongly blocked from paid
 * features. This script identifies those orgs and corrects plan.
 *
 * Usage
 * -----
 *   # Dry run (default — safe to run at any time):
 *   npx tsx src/scripts/backfill-org-plan.ts
 *
 *   # Targeted dry run for a single org:
 *   npx tsx src/scripts/backfill-org-plan.ts --single <orgId>
 *
 *   # Execute the fix:
 *   npx tsx src/scripts/backfill-org-plan.ts --execute
 *
 *   # Execute for a single org:
 *   npx tsx src/scripts/backfill-org-plan.ts --execute --single <orgId>
 */

import { SubscriptionPlan } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { subscriptionTierToPlan } from '@/utils/plan-mapping';
import { planCtxCacheKey } from '@/modules/trial';

// ── CLI flag parsing ──────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const singleIdx = args.indexOf('--single');
const singleOrgId: string | null = singleIdx !== -1 ? (args[singleIdx + 1] ?? null) : null;

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({
    type:        'backfill_start',
    dryRun:      DRY_RUN,
    singleOrgId: singleOrgId ?? 'all',
  });

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — no database writes will occur.');
    console.log('    Pass --execute to apply changes.\n');
  } else {
    console.log('\n🚀 EXECUTE MODE — database will be updated.\n');
  }

  // ── Fetch candidate orgs ───────────────────────────────────────────────────
  //
  // Scope: orgs whose plan is still REGULATOR but whose subscriptionTier
  // indicates a paid tier.  We intentionally exclude orgs where
  // subscriptionTier is 'starter', 'REGULATOR', or any value that correctly
  // maps to REGULATOR — those orgs are already accurate.

  const where = singleOrgId
    ? { id: singleOrgId }
    : { plan: SubscriptionPlan.REGULATOR };   // only mismatched rows

  const orgs = await prisma.organization.findMany({
    where,
    select: {
      id:               true,
      name:             true,
      subscriptionTier: true,
      plan:             true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // ── Classify orgs ─────────────────────────────────────────────────────────

  type Row = {
    id:               string;
    name:             string;
    subscriptionTier: string;
    plan:             SubscriptionPlan;
    mappedPlan:       SubscriptionPlan | null;
    willUpdate:       boolean;
  };

  const rows: Row[] = orgs.map((org) => {
    const mappedPlan = subscriptionTierToPlan(org.subscriptionTier);
    return {
      ...org,
      mappedPlan,
      // Only update when the mapped plan is a real paid tier and differs from current
      willUpdate: mappedPlan !== null && mappedPlan !== SubscriptionPlan.REGULATOR && mappedPlan !== org.plan,
    };
  });

  const toUpdate   = rows.filter((r) => r.willUpdate);
  const unrecognised = rows.filter((r) => r.mappedPlan === null);
  const alreadyCorrect = rows.filter((r) => !r.willUpdate && r.mappedPlan !== null);

  // ── Print summary ──────────────────────────────────────────────────────────

  console.log(`Total orgs scanned:    ${rows.length}`);
  console.log(`Will be updated:       ${toUpdate.length}`);
  console.log(`Already correct:       ${alreadyCorrect.length}`);
  console.log(`Unrecognised tier:     ${unrecognised.length}`);

  if (unrecognised.length > 0) {
    console.log('\n⚠️  Orgs with unrecognised subscriptionTier values (manual review needed):');
    for (const r of unrecognised) {
      console.log(`    ${r.id}  name="${r.name}"  tier="${r.subscriptionTier}"`);
    }
  }

  if (toUpdate.length === 0) {
    console.log('\n✅ Nothing to update. All plans are in sync.');
    return;
  }

  console.log('\nOrgs that will be updated:');
  for (const r of toUpdate) {
    console.log(
      `    ${r.id}  name="${r.name}"  ` +
      `tier="${r.subscriptionTier}"  ` +
      `plan: ${r.plan} → ${r.mappedPlan!}`
    );
  }

  // ── Apply updates (when --execute is passed) ───────────────────────────────

  if (DRY_RUN) {
    console.log('\n✋ Dry run complete — no changes made. Pass --execute to apply.\n');
    return;
  }

  let successCount = 0;
  let failCount    = 0;

  for (const row of toUpdate) {
    try {
      // Wrap each org update in a transaction so audit trail and plan are atomic
      await prisma.$transaction(async (tx) => {
        await tx.organization.update({
          where: { id: row.id },
          data:  { plan: row.mappedPlan! },
        });
      });

      logger.info({
        type:             'plan_backfill',
        orgId:            row.id,
        orgName:          row.name,
        subscriptionTier: row.subscriptionTier,
        oldPlan:          row.plan,
        newPlan:          row.mappedPlan,
      });

      // Invalidate user-scoped plan context cache for all org members
      const users = await prisma.user.findMany({
        where:  { organizationId: row.id },
        select: { id: true },
      });

      await Promise.all(
        users.map((u) => redis.del(planCtxCacheKey(u.id)).catch(() => { /* non-fatal */ }))
      );

      logger.info({
        type:      'plan_cache_invalidated',
        orgId:     row.id,
        userCount: users.length,
        source:    'backfill',
      });

      console.log(`    ✅ ${row.id}  ${row.plan} → ${row.mappedPlan}`);
      successCount++;
    } catch (err) {
      logger.error({ type: 'plan_backfill_error', orgId: row.id, err: String(err) });
      console.error(`    ❌ ${row.id}  FAILED: ${String(err)}`);
      failCount++;
    }
  }

  console.log(`\n✅ Backfill complete — updated: ${successCount}, failed: ${failCount}\n`);
}

main()
  .catch((err) => {
    logger.error({ type: 'backfill_fatal', err: String(err) });
    console.error('\nFatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
