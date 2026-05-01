/**
 * Bulk Send Cron Job — Async Marketing Campaign Drain (Phase B3)
 *
 * Drains the Redis send queue for all active CampaignSendJob rows.
 * Processes 50 contacts per campaign per run.
 *
 * Render Cron Job config:
 *   Command:  pnpm bulksend:cron
 *   Schedule: *\/5 * * * *   (every 5 minutes)
 *   Region:   Same region as the API service
 *
 * Design invariants:
 *   - Acquires a global Redis distributed lock (NX + EX) before any work.
 *     If the lock is already held (duplicate cron fire), exits immediately.
 *   - Per-campaign lock inside drainBatch() prevents concurrent drains.
 *   - Per-campaign errors are caught and logged — one failure does not abort
 *     the rest of the batch.
 *   - Lock is always released in a finally block.
 *   - Exits 0 on full success or partial failure (logged).
 *   - Exits 1 only if the top-level DB query itself fails.
 */

import 'dotenv/config';
import { CampaignSendJobStatus } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { prisma } from '@/lib/prisma/client';
import { sendQueueService } from '@/modules/marketing/send-queue.service';
import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_KEY     = 'sheriabot:cron:bulk-send:lock';
const LOCK_TTL_SEC = 300; // 5 minutes — max expected run time
const BATCH_SIZE   = 50;  // contacts per campaign per cron run

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runBulkSendCron(): Promise<void> {
  logger.info({ type: 'bulk_send_cron_start' });

  // ── Acquire global distributed lock ─────────────────────────────────────
  const lockAcquired = await redis.set(LOCK_KEY, '1', { ex: LOCK_TTL_SEC, nx: true });
  if (lockAcquired === null) {
    logger.info({ type: 'bulk_send_cron_lock_held', message: 'Another instance is running. Exiting.' });
    process.exit(0);
  }

  try {
    // ── Find all active jobs ─────────────────────────────────────────────
    const activeJobs = await prisma.campaignSendJob.findMany({
      where: {
        status: { in: [CampaignSendJobStatus.QUEUED, CampaignSendJobStatus.RUNNING] },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (activeJobs.length === 0) {
      logger.info({ type: 'bulk_send_cron_no_active_jobs' });
      return;
    }

    logger.info({ type: 'bulk_send_cron_active_jobs', count: activeJobs.length });

    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed    = 0;
    let totalSkipped   = 0;
    let errorCount     = 0;

    for (const job of activeJobs) {
      try {
        const result = await sendQueueService.drainBatch(job.campaignId, BATCH_SIZE);

        totalProcessed += result.processed;
        totalSucceeded += result.succeeded;
        totalFailed    += result.failed;
        totalSkipped   += result.skipped;

        logger.info({
          type:       'bulk_send_cron_job_drained',
          campaignId: job.campaignId,
          jobId:      job.id,
          processed:  result.processed,
          succeeded:  result.succeeded,
          failed:     result.failed,
          skipped:    result.skipped,
          remaining:  result.remaining,
          jobStatus:  result.jobStatus,
        });

      } catch (err: unknown) {
        errorCount++;
        logger.error({
          type:       'bulk_send_cron_job_error',
          campaignId: job.campaignId,
          jobId:      job.id,
          error:      err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      type:           'bulk_send_cron_complete',
      jobsProcessed:  activeJobs.length,
      totalProcessed,
      totalSucceeded,
      totalFailed,
      totalSkipped,
      errorCount,
    });

  } finally {
    // Always release the global lock
    await redis.del(LOCK_KEY);
    logger.info({ type: 'bulk_send_cron_lock_released' });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runBulkSendCron()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    logger.error({
      type:  'bulk_send_cron_fatal',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
