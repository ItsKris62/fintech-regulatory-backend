/**
 * Soft-Bounce 3-Strikes Auto-Suppression Cron Job
 *
 * Queries contacts with 3+ soft-bounce events in the last 30 days and
 * adds them to the suppression list automatically.
 *
 * Render Cron Job config:
 *   Command:  pnpm softbounce:cron
 *   Schedule: 0 6 * * *   (09:00 EAT / 06:00 UTC, daily)
 *   Region:   Same region as the API service
 *
 * Design invariants:
 *   - Acquires a Redis distributed lock (NX + EX) before any work.
 *     If the lock is already held (duplicate cron fire), exits immediately.
 *   - Idempotency: skips contacts already in SuppressionList.
 *   - Per-contact errors are caught and logged — one failure does not abort
 *     the rest of the batch.
 *   - Lock is always released in a finally block.
 *   - Exits 0 on full success or partial failure (logged).
 *   - Exits 1 only if the top-level DB query itself fails.
 */

import 'dotenv/config';
import { SuppressionReason } from '@prisma/client';
import { redis } from '@/lib/redis/client';
import { prisma } from '@/lib/prisma/client';
import { suppress } from '@/modules/marketing/suppression.service';
import { logger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOFT_BOUNCE_THRESHOLD  = 3;
const SOFT_BOUNCE_WINDOW_DAYS = 30;

const LOCK_KEY     = 'sheriabot:cron:soft-bounce:lock';
const LOCK_TTL_SEC = 600; // 10 minutes — max expected run time

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
      data: { action, entityType: 'Contact', entityId, metadata: metadata as object },
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
// Main
// ---------------------------------------------------------------------------

async function runSoftBounceCron(): Promise<void> {
  logger.info({ type: 'soft_bounce_cron_start' });

  // ── Acquire distributed lock ─────────────────────────────────────────────
  const lockAcquired = await redis.set(LOCK_KEY, '1', { ex: LOCK_TTL_SEC, nx: true });
  if (lockAcquired === null) {
    logger.info({ type: 'soft_bounce_cron_lock_held', message: 'Another instance is running. Exiting.' });
    process.exit(0);
  }

  try {
    const windowStart = new Date(Date.now() - SOFT_BOUNCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // ── Find contacts with 3+ soft bounces in the window ─────────────────
    // Group EmailEvent by messageId → CampaignSend → contactId
    // We use a raw groupBy approach via Prisma's groupBy on EmailEvent
    const softBounceGroups = await prisma.emailEvent.groupBy({
      by:    ['sendId'],
      where: {
        eventType: 'BOUNCED',
        eventData: {
          path:   ['bounce', 'type'],
          equals: 'soft',
        },
        occurredAt: { gte: windowStart },
        sendId:     { not: null },
      },
      _count: { sendId: true },
      having: {
        sendId: {
          _count: { gte: SOFT_BOUNCE_THRESHOLD },
        },
      },
    });

    if (softBounceGroups.length === 0) {
      logger.info({ type: 'soft_bounce_cron_no_candidates' });
      return;
    }

    // Collect sendIds that meet the threshold
    const sendIds = softBounceGroups
      .filter((g) => g.sendId !== null)
      .map((g) => g.sendId as string);

    // Resolve to unique contactIds + emails via CampaignSend
    const sends = await prisma.campaignSend.findMany({
      where: { id: { in: sendIds } },
      select: {
        contactId: true,
        contact: {
          select: { email: true, suppressedAt: true },
        },
      },
    });

    // Deduplicate by contactId
    const seen = new Set<string>();
    const candidates: Array<{ contactId: string; email: string; strikeCount: number }> = [];

    for (const send of sends) {
      if (seen.has(send.contactId)) continue;
      seen.add(send.contactId);

      // Find the strike count for this contact
      const group = softBounceGroups.find((g) => g.sendId === send.contactId);
      const strikeCount = group?._count.sendId ?? SOFT_BOUNCE_THRESHOLD;

      candidates.push({
        contactId:   send.contactId,
        email:       send.contact.email,
        strikeCount,
      });
    }

    logger.info({
      type:            'soft_bounce_cron_candidates',
      candidateCount:  candidates.length,
      windowDays:      SOFT_BOUNCE_WINDOW_DAYS,
      threshold:       SOFT_BOUNCE_THRESHOLD,
    });

    let suppressedCount = 0;
    let skippedCount    = 0;
    let errorCount      = 0;

    for (const candidate of candidates) {
      try {
        // Idempotency: skip if already suppressed
        const existing = await prisma.suppressionList.findUnique({
          where:  { email: candidate.email.trim().toLowerCase() },
          select: { id: true },
        });

        if (existing) {
          skippedCount++;
          continue;
        }

        // Suppress the contact
        await suppress(
          candidate.email,
          SuppressionReason.BOUNCED,
          undefined, // addedById = null (system action)
          {
            source:      'soft_bounce_cron',
            strikeCount: candidate.strikeCount,
            lookbackDays: SOFT_BOUNCE_WINDOW_DAYS,
          },
        );

        await writeAuditLog(
          'MARKETING_AUTO_SUPPRESSED',
          candidate.contactId,
          {
            email:       candidate.email,
            reason:      SuppressionReason.BOUNCED,
            source:      'soft_bounce_cron',
            strikeCount: candidate.strikeCount,
            lookbackDays: SOFT_BOUNCE_WINDOW_DAYS,
          },
        );

        suppressedCount++;
        logger.info({
          type:        'soft_bounce_auto_suppressed',
          contactId:   candidate.contactId,
          strikeCount: candidate.strikeCount,
          // NOTE: email intentionally omitted from info-level log (PII)
        });

      } catch (err: unknown) {
        errorCount++;
        logger.error({
          type:      'soft_bounce_suppress_error',
          contactId: candidate.contactId,
          error:     err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      type:           'soft_bounce_cron_complete',
      suppressedCount,
      skippedCount,
      errorCount,
      totalCandidates: candidates.length,
    });

  } finally {
    // Always release the lock
    await redis.del(LOCK_KEY);
    logger.info({ type: 'soft_bounce_cron_lock_released' });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runSoftBounceCron()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    logger.error({
      type:  'soft_bounce_cron_fatal',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
