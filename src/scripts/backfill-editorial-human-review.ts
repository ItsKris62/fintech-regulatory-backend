/**
 * Pack 1 Editorial Intelligence - requiresHumanReview backfill.
 *
 * Recomputes the requiresHumanReview policy (src/modules/blog-automation/
 * human-review-policy.ts) against existing BlogArticleSuggestion rows and
 * persists an explicit value where it differs from what's currently stored.
 * See docs/editorial-intelligence/human-review-backfill-runbook.md for the
 * required rollout order - this script must be reviewed in dry-run before
 * --write is ever used, and the enforcement flag
 * (EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED) must not be enabled until this
 * has run in write mode.
 *
 * Dry run (default, and explicit):
 *   pnpm tsx src/scripts/backfill-editorial-human-review.ts --dry-run
 *
 * Write (updates only rows whose computed value differs from what's stored):
 *   pnpm tsx src/scripts/backfill-editorial-human-review.ts --write
 *
 * Write mode against a database identifying itself as production is refused
 * unless --allow-production is also passed - see validateEnvironmentSafety
 * (src/utils/schema-verifier.ts), reused here rather than reimplemented.
 *
 * This script never runs automatically - it has no import side effects other
 * than a `require.main === module` guard, matching every other backfill
 * script in this repo (see backfill-pilot-access.ts, backfill-compliance-snapshots.ts).
 */

import 'dotenv/config';
import { BlogSuggestionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { validateEnvironmentSafety } from '@/utils/schema-verifier';
import {
  computeRequiresHumanReviewAtCreation,
  type HumanReviewReason,
} from '@/modules/blog-automation/human-review-policy';

const BATCH_SIZE = 200;

// Only non-terminal-status suggestions are recomputed. A suggestion whose
// draft was already created (or that was dismissed/marked duplicate) can't be
// retroactively un-promoted by recomputing a value after the fact - see
// phase-b-foundations.md Foundation E, "Backfill plan for existing suggestions."
const NON_TERMINAL_STATUSES: BlogSuggestionStatus[] = [
  BlogSuggestionStatus.PENDING_REVIEW,
  BlogSuggestionStatus.NEEDS_MORE_SOURCES,
];

interface ChangedRow {
  id: string;
  reasons: HumanReviewReason[];
}

async function main(): Promise<void> {
  // Computed fresh from process.argv on every call (not frozen module-level
  // constants) so this function behaves correctly regardless of when it's
  // invoked relative to module load - matters for tests, and is simply more
  // correct in general.
  const WRITE = process.argv.includes('--write');
  const DRY_RUN = !WRITE || process.argv.includes('--dry-run');
  const ALLOW_PRODUCTION = process.argv.includes('--allow-production');

  if (!DRY_RUN) {
    const safety = validateEnvironmentSafety({
      appEnv: process.env.APP_ENV || process.env.NODE_ENV,
      databaseEnv: process.env.DATABASE_ENVIRONMENT,
      databaseUrl: process.env.DATABASE_URL,
    });

    if (!safety.safe && !ALLOW_PRODUCTION) {
      console.error(
        `Refusing to run in write mode: environment check failed (${safety.environmentName}: ${safety.reason ?? 'unsafe target'}). ` +
          `Target: ${safety.redactedUrl}. Pass --allow-production to override if this is genuinely intended.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!safety.safe && ALLOW_PRODUCTION) {
      console.warn(`--allow-production supplied: proceeding against ${safety.environmentName} (${safety.redactedUrl}) despite failed safety check.`);
    }
  }

  console.log(`\n=== backfill-editorial-human-review ${DRY_RUN ? '[DRY RUN]' : '[WRITE]'} ===\n`);

  let totalEvaluated = 0;
  let currentTrue = 0;
  let currentFalse = 0;
  let computedTrue = 0;
  let computedFalse = 0;
  const changedTrueToFalse: ChangedRow[] = [];
  const changedFalseToTrue: ChangedRow[] = [];
  const uncomputable: Array<{ id: string; reason: string }> = [];
  const failures: Array<{ id: string; error: string }> = [];
  const reasonCounts = new Map<HumanReviewReason, number>();

  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.blogArticleSuggestion.findMany({
      where: { status: { in: NON_TERMINAL_STATUSES }, deletedAt: null },
      select: {
        id: true,
        category: true,
        requiresOfficialSource: true,
        sourceQuality: true,
        priority: true,
        jurisdiction: true,
        requiresHumanReview: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (batch.length === 0) break;

    for (const row of batch) {
      totalEvaluated++;
      if (row.requiresHumanReview) currentTrue++;
      else currentFalse++;

      let evaluation: { required: boolean; reasons: HumanReviewReason[] };
      try {
        evaluation = computeRequiresHumanReviewAtCreation({
          category: row.category,
          requiresOfficialSource: row.requiresOfficialSource,
          sourceQuality: row.sourceQuality,
          priority: row.priority,
          jurisdiction: row.jurisdiction,
        });
      } catch (error: unknown) {
        uncomputable.push({ id: row.id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      if (evaluation.required) computedTrue++;
      else computedFalse++;
      for (const reason of evaluation.reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }

      if (row.requiresHumanReview !== evaluation.required) {
        const changed: ChangedRow = { id: row.id, reasons: evaluation.reasons };
        if (row.requiresHumanReview && !evaluation.required) changedTrueToFalse.push(changed);
        else changedFalseToTrue.push(changed);

        if (!DRY_RUN) {
          try {
            await prisma.blogArticleSuggestion.update({
              where: { id: row.id },
              data: { requiresHumanReview: evaluation.required },
            });
          } catch (error: unknown) {
            // Reported, never silently skipped - see requirement.
            failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
  }

  console.log(`Total suggestions evaluated        : ${totalEvaluated}`);
  console.log(`Current requiresHumanReview=true   : ${currentTrue}`);
  console.log(`Current requiresHumanReview=false  : ${currentFalse}`);
  console.log(`Computed requiresHumanReview=true  : ${computedTrue}`);
  console.log(`Computed requiresHumanReview=false : ${computedFalse}`);
  console.log(`Rows changing true -> false        : ${changedTrueToFalse.length}`);
  console.log(`Rows changing false -> true        : ${changedFalseToTrue.length}`);
  console.log(`Rows that could not be evaluated    : ${uncomputable.length}`);

  if (uncomputable.length > 0) {
    console.log('\nUncomputable rows:');
    for (const row of uncomputable) console.log(`  [uncomputable] ${row.id}: ${row.reason}`);
  }

  console.log('\nReasons across all evaluated rows (grouped by count):');
  const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedReasons.length === 0) {
    console.log('  (none)');
  }
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${reason}: ${count}`);
  }

  if (!DRY_RUN) {
    const updated = changedTrueToFalse.length + changedFalseToTrue.length - failures.length;
    console.log(`\nRows updated  : ${updated}`);
    console.log(`Failures      : ${failures.length}`);
    if (failures.length > 0) {
      for (const failure of failures) console.log(`  [failed] ${failure.id}: ${failure.error}`);
    }
  } else {
    console.log('\n(dry run - no rows were written)');
  }

  await prisma.$disconnect();

  if (!DRY_RUN && failures.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('backfill-editorial-human-review failed:', error);
    prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}

export { main as runEditorialHumanReviewBackfill };
