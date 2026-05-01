/**
 * Send Queue Service — Async Bulk Send Infrastructure (Phase B3)
 *
 * Provides a Redis-backed queue for sending marketing campaigns to large
 * contact lists (>25 recipients) without blocking the HTTP request.
 *
 * Architecture:
 *   - enqueue()    — Creates a CampaignSendJob row + pushes contactIds to Redis list
 *   - drainBatch() — Atomically pops N contactIds, sends each, updates job counters
 *   - cancelJob()  — Clears the Redis list + marks job CANCELLED
 *
 * Redis keys:
 *   sheriabot:marketing:sendqueue:{campaignId}       — RPUSH list of contactIds
 *   sheriabot:marketing:sendqueue:lock:{campaignId}  — per-campaign distributed lock
 *
 * TTL: 48 hours (campaigns should complete well within this window)
 *
 * Distributed lock pattern:
 *   Per-campaign lock prevents two cron runs from draining the same campaign
 *   simultaneously. Lock TTL = 120s (generous for a 50-contact batch).
 */

import { CampaignSendJobStatus, MarketingCampaignStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { NotFoundError } from '@/utils/error';
import { sendService } from './send.service';
import { CampaignSendStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_TTL_SEC   = 48 * 60 * 60; // 48 hours
const LOCK_TTL_SEC    = 120;           // 2 minutes per batch

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function queueKey(campaignId: string): string {
  return `sheriabot:marketing:sendqueue:${campaignId}`;
}

function lockKey(campaignId: string): string {
  return `sheriabot:marketing:sendqueue:lock:${campaignId}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed:    number;
  skipped:   number;
  remaining: number;
  jobStatus: CampaignSendJobStatus;
}

// ---------------------------------------------------------------------------
// Audit log helper (non-fatal)
// ---------------------------------------------------------------------------

async function writeAuditLog(
  action:    string,
  entityId:  string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { action, entityType: 'CampaignSendJob', entityId, metadata: metadata as object },
    });
  } catch (err: unknown) {
    logger.error({
      type:     'audit_log_write_failed',
      action,
      entityId,
      error:    err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// SendQueueService
// ---------------------------------------------------------------------------

export class SendQueueService {
  /**
   * Enqueue a campaign for async bulk send.
   * Creates a CampaignSendJob row and pushes contactIds to Redis list.
   * Sets campaign status to SENDING.
   */
  async enqueue(
    campaignId:  string,
    contactIds:  string[],
  ): Promise<{ jobId: string; queued: number }> {
    if (contactIds.length === 0) {
      throw new Error('Cannot enqueue a campaign with 0 contacts');
    }

    // Create the job row
    const job = await prisma.campaignSendJob.create({
      data: {
        campaignId,
        status:        CampaignSendJobStatus.QUEUED,
        totalContacts: contactIds.length,
      },
    });

    // Push all contactIds to Redis list (RPUSH = append to tail)
    const key = queueKey(campaignId);
    await redis.rpush(key, ...contactIds);
    // Set TTL on the list
    await redis.expire(key, QUEUE_TTL_SEC);

    // Transition campaign to SENDING
    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: {
        status:          MarketingCampaignStatus.SENDING,
        totalRecipients: contactIds.length,
        sentAt:          new Date(),
      },
    });

    await writeAuditLog('MARKETING_BULK_SEND_QUEUED', job.id, {
      campaignId,
      totalContacts: contactIds.length,
    });

    logger.info({
      type:          'marketing_bulk_send_queued',
      campaignId,
      jobId:         job.id,
      totalContacts: contactIds.length,
    });

    return { jobId: job.id, queued: contactIds.length };
  }

  /**
   * Drain up to `batchSize` contacts from the queue and send them.
   * Called by the cron job. Returns counts for this batch.
   *
   * Uses LPOP (atomic, safe for concurrent cron runs with distributed lock).
   * Acquires per-campaign lock before draining.
   */
  async drainBatch(
    campaignId: string,
    batchSize:  number,
  ): Promise<DrainResult> {
    // Find the active job for this campaign
    const job = await prisma.campaignSendJob.findFirst({
      where: {
        campaignId,
        status: { in: [CampaignSendJobStatus.QUEUED, CampaignSendJobStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!job) {
      throw new NotFoundError(`No active CampaignSendJob found for campaign ${campaignId}`);
    }

    // Acquire per-campaign lock
    const lock = lockKey(campaignId);
    const acquired = await redis.set(lock, '1', { ex: LOCK_TTL_SEC, nx: true });
    if (acquired === null) {
      logger.info({ type: 'marketing_bulk_send_lock_held', campaignId });
      return {
        processed: 0,
        succeeded: 0,
        failed:    0,
        skipped:   0,
        remaining: await this.getQueueDepth(campaignId),
        jobStatus: job.status,
      };
    }

    try {
      // Mark job as RUNNING if it was QUEUED
      if (job.status === CampaignSendJobStatus.QUEUED) {
        await prisma.campaignSendJob.update({
          where: { id: job.id },
          data:  { status: CampaignSendJobStatus.RUNNING, startedAt: new Date() },
        });
      }

      // Atomically pop up to batchSize contactIds from the queue
      const key = queueKey(campaignId);
      const popped = await redis.lpop(key, batchSize);
      const contactIds: string[] = Array.isArray(popped)
        ? popped
        : popped
          ? [popped]
          : [];

      if (contactIds.length === 0) {
        // Queue is empty — finalize the job
        return await this.finalizeJob(job.id, campaignId);
      }

      // Fetch campaign for template info
      const campaign = await prisma.marketingCampaign.findUnique({
        where: { id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundError(`Campaign ${campaignId} not found`);
      }

      const templateVariables = campaign.templateVariables as Record<string, unknown>;

      let succeeded = 0;
      let failed    = 0;
      let skipped   = 0;

      // Send to each contact in this batch
      for (const contactId of contactIds) {
        try {
          const contact = await prisma.contact.findUnique({
            where:   { id: contactId },
            include: { company: true },
          });

          if (!contact || contact.deletedAt) {
            skipped++;
            continue;
          }

          const result = await sendService.sendToContact({
            campaignId,
            contact,
            templateKey:       campaign.templateKey,
            templateVariables,
            campaignName:      campaign.name,
            subject:           campaign.subject,
          });

          switch (result.status) {
            case CampaignSendStatus.SENT:
              succeeded++;
              break;
            case CampaignSendStatus.SUPPRESSED_SKIPPED:
            case CampaignSendStatus.NO_CONSENT_SKIPPED:
              skipped++;
              break;
            default:
              failed++;
          }
        } catch (err: unknown) {
          failed++;
          logger.error({
            type:      'marketing_bulk_send_contact_error',
            campaignId,
            contactId,
            error:     err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Update job counters atomically
      await prisma.campaignSendJob.update({
        where: { id: job.id },
        data: {
          processed: { increment: contactIds.length },
          succeeded: { increment: succeeded },
          failed:    { increment: failed },
          skipped:   { increment: skipped },
        },
      });

      // Check remaining queue depth
      const remaining = await this.getQueueDepth(campaignId);

      if (remaining === 0) {
        return await this.finalizeJob(job.id, campaignId);
      }

      logger.info({
        type:       'marketing_bulk_send_batch_complete',
        campaignId,
        jobId:      job.id,
        processed:  contactIds.length,
        succeeded,
        failed,
        skipped,
        remaining,
      });

      return {
        processed: contactIds.length,
        succeeded,
        failed,
        skipped,
        remaining,
        jobStatus: CampaignSendJobStatus.RUNNING,
      };

    } finally {
      // Always release the per-campaign lock
      await redis.del(lock);
    }
  }

  /**
   * Get the number of contacts remaining in the queue.
   */
  async getQueueDepth(campaignId: string): Promise<number> {
    const len = await redis.llen(queueKey(campaignId));
    return len ?? 0;
  }

  /**
   * Cancel a queued/running job. Clears the Redis list and marks job CANCELLED.
   */
  async cancelJob(jobId: string): Promise<void> {
    const job = await prisma.campaignSendJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError(`CampaignSendJob ${jobId} not found`);

    // Clear the Redis queue
    await redis.del(queueKey(job.campaignId));

    await prisma.campaignSendJob.update({
      where: { id: jobId },
      data: {
        status:      CampaignSendJobStatus.CANCELLED,
        completedAt: new Date(),
      },
    });

    await writeAuditLog('MARKETING_BULK_SEND_CANCELLED', jobId, {
      campaignId: job.campaignId,
    });

    logger.info({ type: 'marketing_bulk_send_cancelled', jobId, campaignId: job.campaignId });
  }

  /**
   * Get the latest CampaignSendJob for a campaign.
   */
  async getLatestJob(campaignId: string) {
    return prisma.campaignSendJob.findFirst({
      where:   { campaignId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async finalizeJob(
    jobId:      string,
    campaignId: string,
  ): Promise<DrainResult> {
    // Re-fetch the job to get final counters
    const job = await prisma.campaignSendJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError(`CampaignSendJob ${jobId} not found`);

    const finalJobStatus = job.failed === 0
      ? CampaignSendJobStatus.COMPLETED
      : job.succeeded > 0
        ? CampaignSendJobStatus.PARTIALLY_COMPLETED
        : CampaignSendJobStatus.FAILED;

    await prisma.campaignSendJob.update({
      where: { id: jobId },
      data: {
        status:      finalJobStatus,
        completedAt: new Date(),
      },
    });

    // Update campaign final status
    const finalCampaignStatus =
      finalJobStatus === CampaignSendJobStatus.COMPLETED
        ? MarketingCampaignStatus.SENT
        : finalJobStatus === CampaignSendJobStatus.PARTIALLY_COMPLETED
          ? MarketingCampaignStatus.PARTIALLY_SENT
          : MarketingCampaignStatus.FAILED;

    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: {
        status:       finalCampaignStatus,
        errorMessage: finalJobStatus === CampaignSendJobStatus.FAILED
          ? 'All sends failed during async bulk send'
          : null,
      },
    });

    await writeAuditLog('MARKETING_BULK_SEND_COMPLETED', jobId, {
      campaignId,
      finalJobStatus,
      finalCampaignStatus,
      succeeded: job.succeeded,
      failed:    job.failed,
      skipped:   job.skipped,
    });

    logger.info({
      type:               'marketing_bulk_send_finalized',
      campaignId,
      jobId,
      finalJobStatus,
      finalCampaignStatus,
      succeeded:          job.succeeded,
      failed:             job.failed,
      skipped:            job.skipped,
    });

    return {
      processed: 0,
      succeeded: 0,
      failed:    0,
      skipped:   0,
      remaining: 0,
      jobStatus: finalJobStatus,
    };
  }
}

export const sendQueueService = new SendQueueService();
