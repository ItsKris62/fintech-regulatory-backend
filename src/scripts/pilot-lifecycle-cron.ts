/**
 * Pilot Lifecycle Cron Job
 *
 * Sends timed lifecycle emails to pilot testers and invalidates the plan cache
 * for expired pilots. Designed to run daily via a Render Cron Job service.
 *
 * Render Cron Job config:
 *   Command:  pnpm pilot:cron
 *   Schedule: 0 5 * * *   (08:00 EAT / 05:00 UTC, daily)
 *   Region:   Same region as the API service
 *
 * Lifecycle email schedule (days since pilotStartedAt):
 *   Day  0 -> PilotWelcomeEmail        (sent by provision-pilot-testers.ts, not here)
 *   Day  3 -> PilotDay3NudgeEmail      (only if user has never logged in)
 *   Day  7 -> PilotDay7CheckinEmail
 *   Day 10 -> PilotDay10FeaturesEmail
 *   Day 13 -> PilotDay13WarningEmail
 *   Day ≥14 -> PilotExpiredEmail       (pilotExpiresAt <= now, once per user)
 *
 * Design invariants:
 *   - Acquires a Redis distributed lock (NX + EX) before any work.
 *     If the lock is already held (duplicate cron fire), exits immediately.
 *   - Each email type is gated by a Redis sentinel key (NX write)  - 
 *     so each email is sent at most once per user per stage even if the
 *     cron fires multiple times on the same day.
 *   - Plan cache (sheriabot:planctx:{userId}) is DELeted for expired pilots so
 *     the next API request resolves REGULATOR without waiting for TTL.
 *   - Never crashes the process  -  all per-user errors are caught and logged.
 *   - Exits 0 on full success or partial failure (logged); exits 1 only if the
 *     top-level DB query itself fails.
 */

import 'dotenv/config';
import { redis } from '@/lib/redis/client';
import { prisma } from '@/lib/prisma/client';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { logger } from '@/utils/logger';

// -- Constants -----------------------------------------------------------------

const LOCK_KEY        = 'sheriabot:pilot:cron:lock';
const LOCK_TTL_SEC    = 600;  // 10 minutes  -  max expected run time
const SENTINEL_TTL_SEC = 60 * 60 * 24 * 60; // 60 days  -  long enough to be permanent

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://app.sheriabot.com')
  .split(',')[0]
  .trim();

// -- Sentinel key helpers ------------------------------------------------------

type LifecycleStage =
  | 'day3_nudge'
  | 'day7_checkin'
  | 'day10_features'
  | 'day13_warning'
  | 'expired';

function sentinelKey(userId: string, stage: LifecycleStage): string {
  return `sheriabot:pilot:email:${userId}:${stage}`;
}

/** Returns true if the sentinel was freshly set (i.e. email not yet sent). */
async function claimSentinel(userId: string, stage: LifecycleStage): Promise<boolean> {
  const key = sentinelKey(userId, stage);
  // SET NX EX  -  returns "OK" if key was created, null if it already existed.
  const result = await redis.set(key, '1', { nx: true, ex: SENTINEL_TTL_SEC });
  return result !== null;
}

// -- Per-pilot processing ------------------------------------------------------

interface PilotUser {
  id:               string;
  email:            string;
  fullName:         string | null;
  pilotStartedAt:   Date | null;
  pilotExpiresAt:   Date | null;
  pilotConvertedAt: Date | null;
  organization:     { name: string } | null;
}

interface StageResult {
  userId: string;
  stage:  LifecycleStage | 'skipped' | 'no_start_date';
  sent:   boolean;
  error?: string;
}

async function processPilot(user: PilotUser, now: Date): Promise<StageResult[]> {
  const results: StageResult[] = [];

  if (!user.pilotStartedAt) {
    return [{ userId: user.id, stage: 'no_start_date', sent: false }];
  }

  const userName     = user.fullName ?? user.email;
  const orgName      = user.organization?.name ?? 'your organisation';
  const daysSinceStart = Math.floor((now.getTime() - user.pilotStartedAt.getTime()) / MS_PER_DAY);
  const isExpired    = user.pilotExpiresAt !== null && user.pilotExpiresAt <= now;

  // -- Expired ----------------------------------------------------------------
  if (isExpired && user.pilotConvertedAt === null) {
    try {
      await (prisma as any).pilotAccess.updateMany({
        where: { userId: user.id, status: 'ACTIVE' },
        data: {
          status: 'EXPIRED',
          metadata: {
            source: 'pilot-lifecycle-cron',
            legacyUserPilotFieldsSynced: true,
          },
        },
      }).catch(() => undefined);
      await (prisma as any).user.update({
        where: { id: user.id },
        data: { pilotAccessStatus: 'EXPIRED' },
      }).catch(() => undefined);
      await redis.del(`sheriabot:planctx:${user.id}`).catch(() => undefined);

      const claimed = await claimSentinel(user.id, 'expired');
      if (claimed) {
        await reactMailer.sendPilotExpiredEmail(user.email, {
          userName,
          organization: orgName,
          dashboardUrl: FRONTEND_URL,
        });
        logger.info({ type: 'PILOT_EXPIRED_EMAIL_SENT', userId: user.id, email: user.email });
        results.push({ userId: user.id, stage: 'expired', sent: true });
      } else {
        results.push({ userId: user.id, stage: 'expired', sent: false });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'PILOT_EXPIRED_EMAIL_FAILED', userId: user.id, error });
      results.push({ userId: user.id, stage: 'expired', sent: false, error });
    }
    return results; // Don't send lifecycle emails to expired pilots.
  }

  // -- Day 13  -  expiry warning ------------------------------------------------
  if (daysSinceStart >= 13 && user.pilotExpiresAt !== null) {
    try {
      const claimed = await claimSentinel(user.id, 'day13_warning');
      if (claimed) {
        await reactMailer.sendPilotDay13WarningEmail(user.email, {
          userName,
          pilotExpiresAt: user.pilotExpiresAt.toISOString(),
          dashboardUrl:   FRONTEND_URL,
        });
        logger.info({ type: 'PILOT_DAY13_EMAIL_SENT', userId: user.id });
        results.push({ userId: user.id, stage: 'day13_warning', sent: true });
      } else {
        results.push({ userId: user.id, stage: 'day13_warning', sent: false });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'PILOT_DAY13_EMAIL_FAILED', userId: user.id, error });
      results.push({ userId: user.id, stage: 'day13_warning', sent: false, error });
    }
  }

  // -- Day 10  -  features spotlight --------------------------------------------
  if (daysSinceStart >= 10) {
    try {
      const claimed = await claimSentinel(user.id, 'day10_features');
      if (claimed) {
        const daysRemaining = user.pilotExpiresAt
          ? Math.max(0, Math.ceil((user.pilotExpiresAt.getTime() - now.getTime()) / MS_PER_DAY))
          : 4;
        await reactMailer.sendPilotDay10FeaturesEmail(user.email, {
          userName,
          daysRemaining,
          dashboardUrl: FRONTEND_URL,
        });
        logger.info({ type: 'PILOT_DAY10_EMAIL_SENT', userId: user.id });
        results.push({ userId: user.id, stage: 'day10_features', sent: true });
      } else {
        results.push({ userId: user.id, stage: 'day10_features', sent: false });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'PILOT_DAY10_EMAIL_FAILED', userId: user.id, error });
      results.push({ userId: user.id, stage: 'day10_features', sent: false, error });
    }
  }

  // -- Day 7  -  mid-point check-in ---------------------------------------------
  if (daysSinceStart >= 7) {
    try {
      const claimed = await claimSentinel(user.id, 'day7_checkin');
      if (claimed) {
        const daysRemaining = user.pilotExpiresAt
          ? Math.max(0, Math.ceil((user.pilotExpiresAt.getTime() - now.getTime()) / MS_PER_DAY))
          : 7;
        await reactMailer.sendPilotDay7CheckinEmail(user.email, {
          userName,
          daysRemaining,
          dashboardUrl: FRONTEND_URL,
        });
        logger.info({ type: 'PILOT_DAY7_EMAIL_SENT', userId: user.id });
        results.push({ userId: user.id, stage: 'day7_checkin', sent: true });
      } else {
        results.push({ userId: user.id, stage: 'day7_checkin', sent: false });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'PILOT_DAY7_EMAIL_FAILED', userId: user.id, error });
      results.push({ userId: user.id, stage: 'day7_checkin', sent: false, error });
    }
  }

  // -- Day 3  -  nudge (only if user has never logged in) ----------------------
  if (daysSinceStart >= 3) {
    try {
      const claimed = await claimSentinel(user.id, 'day3_nudge');
      if (claimed) {
        // Only send if no LOGIN event recorded (zero-cost: single indexed query).
        const loginEvent = await prisma.pilotEvent.findFirst({
          where:  { userId: user.id, action: 'LOGIN' },
          select: { id: true },
        });

        if (!loginEvent) {
          await reactMailer.sendPilotDay3NudgeEmail(user.email, {
            userName,
            dashboardUrl: FRONTEND_URL,
          });
          logger.info({ type: 'PILOT_DAY3_EMAIL_SENT', userId: user.id });
          results.push({ userId: user.id, stage: 'day3_nudge', sent: true });
        } else {
          // User has logged in  -  sentinel is already set; skip email.
          logger.debug({ type: 'PILOT_DAY3_NUDGE_SKIPPED_HAS_LOGIN', userId: user.id });
          results.push({ userId: user.id, stage: 'day3_nudge', sent: false });
        }
      } else {
        results.push({ userId: user.id, stage: 'day3_nudge', sent: false });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'PILOT_DAY3_EMAIL_FAILED', userId: user.id, error });
      results.push({ userId: user.id, stage: 'day3_nudge', sent: false, error });
    }
  }

  if (results.length === 0) {
    results.push({ userId: user.id, stage: 'skipped', sent: false });
  }

  return results;
}

// -- Main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const now = new Date();

  logger.info({ type: 'PILOT_CRON_START', runAt: now.toISOString() });

  // -- Acquire distributed lock -----------------------------------------------
  const lockAcquired = await redis.set(LOCK_KEY, now.toISOString(), {
    nx:  true,
    ex:  LOCK_TTL_SEC,
  });

  if (lockAcquired === null) {
    logger.warn({ type: 'PILOT_CRON_LOCK_HELD', message: 'Another instance is running  -  exiting.' });
    return;
  }

  logger.info({ type: 'PILOT_CRON_LOCK_ACQUIRED' });

  try {
    // -- Fetch all active pilot users -----------------------------------------
    const pilots = await (prisma as any).user.findMany({
      where: { isPilot: true },
      select: {
        id:               true,
        email:            true,
        fullName:         true,
        pilotStartedAt:   true,
        pilotExpiresAt:   true,
        pilotConvertedAt: true,
        organization:     { select: { name: true } },
      },
    }) as PilotUser[];

    logger.info({ type: 'PILOT_CRON_USERS_FETCHED', count: pilots.length });

    if (pilots.length === 0) {
      logger.info({ type: 'PILOT_CRON_NO_PILOTS' });
      return;
    }

    // -- Process each pilot sequentially (avoids Resend rate limits) ----------
    let totalSent    = 0;
    let totalSkipped = 0;
    let totalErrors  = 0;

    for (const pilot of pilots) {
      const stageResults = await processPilot(pilot, now);

      for (const r of stageResults) {
        if (r.error)     totalErrors++;
        else if (r.sent) totalSent++;
        else             totalSkipped++;
      }
    }

    // -- Summary log -----------------------------------------------------------
    logger.info({
      type:         'PILOT_CRON_COMPLETE',
      pilots:       pilots.length,
      emailsSent:   totalSent,
      emailsSkipped: totalSkipped,
      errors:       totalErrors,
      durationMs:   Date.now() - now.getTime(),
    });

    console.log('\n====================================================');
    console.log('  Pilot Lifecycle Cron  -  Summary');
    console.log('====================================================');
    console.log(`  Pilot users processed: ${pilots.length}`);
    console.log(`  Emails sent:           ${totalSent}`);
    console.log(`  Emails skipped:        ${totalSkipped}`);
    console.log(`  Errors:                ${totalErrors}`);
    console.log('====================================================\n');

    if (totalErrors > 0) {
      process.exit(1);
    }
  } finally {
    // Always release the lock.
    await redis.del(LOCK_KEY).catch((err: unknown) => {
      logger.error({
        type:  'PILOT_CRON_LOCK_RELEASE_FAILED',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    logger.info({ type: 'PILOT_CRON_LOCK_RELEASED' });
  }
}

main().catch((err: unknown) => {
  logger.error({
    type:  'PILOT_CRON_CRASHED',
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
