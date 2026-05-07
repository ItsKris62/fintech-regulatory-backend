/**
 * Compliance Snapshot Retention Cleanup Cron Job
 *
 * Deletes ComplianceScoreSnapshot rows older than 90 days.
 * The trend window only needs 30 days; 90 days provides a 3× buffer for any
 * future "quarterly review" features without significant storage growth.
 *
 * Design:
 *   - Single deleteMany — no per-row iteration, no N+1.
 *   - Exits 0 on success, 1 on failure (Render treats non-zero as cron failure).
 *   - Structured Pino logs on both success and failure paths.
 *
 * Render Cron Job config (paste into render.yaml or configure in the Render dashboard):
 *   type:     cron
 *   name:     cleanup-compliance-snapshots
 *   schedule: "0 2 * * *"   # 02:00 UTC daily (low-traffic window)
 *   command:  pnpm cron:cleanup-snapshots
 *
 * Run manually:
 *   pnpm cron:cleanup-snapshots
 */

import 'dotenv/config';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

const RETENTION_DAYS = 90;

async function cleanupComplianceSnapshots(): Promise<void> {
  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  logger.info({
    type: 'cron.compliance_snapshot_cleanup.started',
    retentionDays: RETENTION_DAYS,
    cutoffDate: cutoff.toISOString(),
  });

  const result = await prisma.complianceScoreSnapshot.deleteMany({
    where: { calculatedAt: { lt: cutoff } },
  });

  logger.info({
    type: 'cron.compliance_snapshot_cleanup.success',
    deletedCount: result.count,
    cutoffDate: cutoff.toISOString(),
    durationMs: Date.now() - startedAt,
  });
}

cleanupComplianceSnapshots()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error({
      type: 'cron.compliance_snapshot_cleanup.failure',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
