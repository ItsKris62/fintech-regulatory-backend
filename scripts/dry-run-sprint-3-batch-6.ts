/**
 * Sprint 3 Batch 6 — CC-C-039 Phase 2 Row classification + backfill (Dry Run)
 * Gitignored; run with: pnpm tsx scripts/dry-run-sprint-3-batch-6.ts
 */

import { SubscriptionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';

async function main() {
  console.log('=== Sprint 3 Batch 6: CANCELLED Row Classification Dry-Run ===\n');

  try {
    const cancelledOrgs = await prisma.organization.findMany({
      where: { subscriptionStatus: SubscriptionStatus.CANCELLED },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    console.log(`Found ${cancelledOrgs.length} organization(s) with subscriptionStatus = 'CANCELLED'.\n`);

    if (cancelledOrgs.length > 0) {
      console.table(cancelledOrgs);
      console.log('\n[!] Operator Action:');
      console.log('These rows require manual classification (Stripe cancellation vs Admin suspension) before backfill.');
    } else {
      console.log('[PASS] Zero CANCELLED rows found in the database.');
      console.log('       Phase A audit finding confirmed. Batch 6 is a verified no-op.');
    }
  } catch (error) {
    console.error('[FAIL] Error during dry-run query:', error);
    process.exit(1);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());