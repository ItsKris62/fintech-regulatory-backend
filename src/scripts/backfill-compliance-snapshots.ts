/**
 * One-time backfill: seed an initial ComplianceScoreSnapshot for every
 * organization that has ComplianceItem rows but no snapshot yet.
 *
 * Without this, the trend indicator shows "insufficient_history" for all
 * existing organizations for the next 30 days after the Batch 3 deployment.
 * Running this backfill immediately after deployment gives the trend logic
 * a baseline to compare against.
 *
 * Safety:
 *   - Idempotent: skips orgs that already have at least one snapshot.
 *   - Skips orgs with zero compliance items (nothing to compute).
 *   - Per-org errors are caught and logged without aborting the run.
 *
 * Run once after deploying Batch 3:
 *   pnpm backfill:compliance-snapshots
 */

import 'dotenv/config';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

async function backfillComplianceSnapshots(): Promise<void> {
  const startedAt = Date.now();

  // Find orgs that have compliance items but no snapshot yet
  const orgsWithItems = await prisma.organization.findMany({
    where: {
      complianceItems: { some: {} },
      complianceSnapshots: { none: {} },
    },
    select: { id: true },
  });

  logger.info({
    type: 'backfill.compliance_snapshots.started',
    orgsToProcess: orgsWithItems.length,
  });

  if (orgsWithItems.length === 0) {
    logger.info({ type: 'backfill.compliance_snapshots.nothing_to_do' });
    return;
  }

  const WEIGHT: Record<string, number> = {
    DATA_PROTECTION: 0.25,
    AML_KYC: 0.25,
    CONSUMER_PROTECTION: 0.15,
    CBK_LICENSING: 0.20,
    CYBERSECURITY: 0.15,
  };

  let succeeded = 0;
  let failed = 0;

  for (const { id: orgId } of orgsWithItems) {
    try {
      const items = await prisma.complianceItem.findMany({
        where: { organizationId: orgId },
        select: { category: true, isCompleted: true },
      });

      // Group by category and compute per-category float scores
      const byCat: Record<string, { total: number; completed: number }> = {};
      for (const item of items) {
        const k = item.category as string;
        if (!byCat[k]) byCat[k] = { total: 0, completed: 0 };
        byCat[k].total++;
        if (item.isCompleted) byCat[k].completed++;
      }

      const catScores: Record<string, number> = {};
      for (const [k, v] of Object.entries(byCat)) {
        catScores[k] = v.total > 0 ? (v.completed / v.total) * 100 : 0;
      }

      const overallScore = Math.round(
        Object.entries(WEIGHT).reduce((sum, [k, w]) => sum + (catScores[k] ?? 0) * w, 0)
      );

      await prisma.complianceScoreSnapshot.create({
        data: {
          organizationId: orgId,
          overallScore,
          dataProtectionScore: catScores['DATA_PROTECTION'] ?? 0,
          amlKycScore: catScores['AML_KYC'] ?? 0,
          consumerProtectionScore: catScores['CONSUMER_PROTECTION'] ?? 0,
          cbkLicensingScore: catScores['CBK_LICENSING'] ?? 0,
          cybersecurityScore: catScores['CYBERSECURITY'] ?? 0,
        },
      });

      succeeded++;
      logger.info({ type: 'backfill.compliance_snapshots.org_done', orgId, overallScore });
    } catch (error: unknown) {
      failed++;
      logger.error({
        type: 'backfill.compliance_snapshots.org_error',
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info({
    type: 'backfill.compliance_snapshots.complete',
    succeeded,
    failed,
    durationMs: Date.now() - startedAt,
  });
}

backfillComplianceSnapshots()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error({
      type: 'backfill.compliance_snapshots.fatal',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
