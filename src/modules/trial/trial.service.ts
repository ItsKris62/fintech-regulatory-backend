import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { FREE_TRIAL_LIMITS, type TrialFeature } from '@/types/plan.types';
import {
  TrialUsageSchema,
  EMPTY_TRIAL_USAGE,
  type TrialStatus,
  type TrialUsage,
} from './trial.types';

// ============================================================================
// Redis sentinel keys
// ============================================================================

/** Plan+trial context cache for a user. TTL: 5 minutes. */
export const planCtxCacheKey = (userId: string) => `sheriabot:planctx:${userId}`;

/** Prevents the "trial expiring soon" email from firing more than once. TTL: 48 hours. */
const trialExpiringNotifiedKey = (userId: string) =>
  `sheriabot:trial:expiring_notified:${userId}`;

/** Prevents the "trial expired" email from firing more than once. TTL: 30 days. */
const trialExpiredNotifiedKey = (userId: string) =>
  `sheriabot:trial:expired_notified:${userId}`;

// ============================================================================
// Internal helpers
// ============================================================================

/** Parse the freeTrialUsage JSON safely, returning EMPTY_TRIAL_USAGE on failure. */
function parseUsage(raw: unknown): TrialUsage {
  const result = TrialUsageSchema.safeParse(raw);
  return result.success ? result.data : { ...EMPTY_TRIAL_USAGE };
}

/** Compute the number of full calendar days remaining until expiresAt. */
function computeDaysRemaining(expiresAt: Date): number {
  const msRemaining = expiresAt.getTime() - Date.now();
  return Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));
}

// ============================================================================
// activateTrial
// ============================================================================

/**
 * Activates the free trial for a user.
 *
 * - One-time only. Throws CONFLICT if already used.
 * - Sets freeTrialActivatedAt, freeTrialExpiresAt (now + 7 days), freeTrialUsage.
 * - Invalidates the user-scoped plan context cache.
 * - Fires the welcome email asynchronously (non-blocking).
 */
export async function activateTrial(userId: string): Promise<TrialStatus> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { freeTrialActivatedAt: true, email: true, fullName: true },
  });

  if (!user) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  }

  if (user.freeTrialActivatedAt !== null) {
    throw new TRPCError({
      code:    'CONFLICT',
      message: 'Free trial has already been used on this account.',
    });
  }

  const now       = new Date();
  // 7 days from now expressed in milliseconds -- no external date library needed
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const initialUsage: TrialUsage = { ...EMPTY_TRIAL_USAGE };

  await prisma.user.update({
    where: { id: userId },
    data: {
      freeTrialActivatedAt: now,
      freeTrialExpiresAt:   expiresAt,
      freeTrialUsage:       initialUsage,
    },
  });

  // Invalidate plan context cache so the next request resolves FREE_TRIAL
  try {
    await redis.del(planCtxCacheKey(userId));
  } catch (err: unknown) {
    logger.warn({ type: 'trial_cache_invalidation_failed', userId, err });
  }

  logger.info({ type: 'trial_activated', userId, expiresAt });

  // Fire activation email asynchronously -- never block the response
  void (async () => {
    try {
      const { reactMailer } = await import('@/lib/email/react-mailer.service');
      await reactMailer.sendFreeTrialActivatedEmail(user.email, {
        userName:     user.fullName,
        trialEndsAt:  expiresAt.toISOString(),
        dashboardUrl: `${process.env['FRONTEND_URL'] ?? ''}/startup`,
      });
    } catch (err: unknown) {
      logger.error({ type: 'trial_activation_email_failed', userId, err });
    }
  })();

  return {
    isEligible:   false,
    isActive:     true,
    hasUsedTrial: true,
    expiresAt,
    daysRemaining: computeDaysRemaining(expiresAt),
    usage:        initialUsage,
    limits:       FREE_TRIAL_LIMITS,
  };
}

// ============================================================================
// getTrialStatus
// ============================================================================

/**
 * Returns the current trial status for a user.
 *
 * Also handles lazy side-effects:
 *  - Fires the "trial expiring soon" email once when daysRemaining <= 2.
 */
export async function getTrialStatus(userId: string): Promise<TrialStatus> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: {
      freeTrialActivatedAt: true,
      freeTrialExpiresAt:   true,
      freeTrialUsage:       true,
      email:                true,
      fullName:             true,
    },
  });

  if (!user) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  }

  const { freeTrialActivatedAt, freeTrialExpiresAt, freeTrialUsage } = user;

  // Never activated
  if (!freeTrialActivatedAt || !freeTrialExpiresAt) {
    return {
      isEligible:   true,
      isActive:     false,
      hasUsedTrial: false,
      expiresAt:    null,
      daysRemaining: null,
      usage:        null,
      limits:       FREE_TRIAL_LIMITS,
    };
  }

  const now          = new Date();
  const isActive     = freeTrialExpiresAt > now;
  const usage        = parseUsage(freeTrialUsage);
  const daysRemaining = isActive ? computeDaysRemaining(freeTrialExpiresAt) : null;

  // Lazy "trial expiring soon" email -- fires at most once per trial
  if (isActive && daysRemaining !== null && daysRemaining <= 2) {
    void (async () => {
      try {
        const alreadyNotified = await redis.get<string>(trialExpiringNotifiedKey(userId));
        if (!alreadyNotified) {
          await redis.set(trialExpiringNotifiedKey(userId), '1', { ex: 48 * 60 * 60 });
          const { reactMailer } = await import('@/lib/email/react-mailer.service');
          await reactMailer.sendFreeTrialExpiringEmail(user.email, {
            userName:     user.fullName,
            daysRemaining,
            usage,
            upgradeUrl:   `${process.env['FRONTEND_URL'] ?? ''}/settings/billing`,
          });
          logger.info({ type: 'trial_expiring_email_sent', userId, daysRemaining });
        }
      } catch (err: unknown) {
        logger.error({ type: 'trial_expiring_email_failed', userId, err });
      }
    })();
  }

  return {
    isEligible:   false,
    isActive,
    hasUsedTrial: true,
    expiresAt:    freeTrialExpiresAt,
    daysRemaining,
    usage,
    limits:       FREE_TRIAL_LIMITS,
  };
}

// ============================================================================
// incrementTrialUsage
// ============================================================================

/**
 * Increments a trial usage counter after a successful feature execution.
 *
 * Note: This performs a read-modify-write on the freeTrialUsage JSON column.
 * It is NOT atomic at the DB level. This is acceptable for single-user trial
 * concurrency -- a user cannot realistically execute two AI requests simultaneously
 * in a way that would cause meaningful data loss. The worst case is an under-count
 * by one, which is a minor inconvenience rather than a billing concern.
 *
 * When feature === 'totalTokensUsed', the tokenCount argument is added to the
 * running total. For all other features, the counter is incremented by 1.
 */
export async function incrementTrialUsage(
  userId:     string,
  feature:    TrialFeature,
  tokenCount?: number,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { freeTrialUsage: true },
  });

  const current = parseUsage(user?.freeTrialUsage);

  if (feature === 'totalTokensUsed') {
    current.totalTokensUsed += tokenCount ?? 0;
  } else {
    (current[feature] as number) += 1;
  }

  await prisma.user.update({
    where: { id: userId },
    data:  { freeTrialUsage: current },
  });

  logger.info({
    type:     'trial_usage_incremented',
    userId,
    feature,
    newCount: current[feature],
  });
}

// ============================================================================
// checkTrialLimit
// ============================================================================

/**
 * Checks whether a user is still within their trial limit for a given feature.
 * Does NOT throw -- returns an object so the caller can decide how to respond.
 */
export async function checkTrialLimit(
  userId:  string,
  feature: TrialFeature,
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { freeTrialUsage: true },
  });

  const usage   = parseUsage(user?.freeTrialUsage);
  const current = usage[feature];
  const limit   = FREE_TRIAL_LIMITS[feature];

  return { allowed: current < limit, current, limit };
}

// ============================================================================
// fireTrialExpiredEmail
// ============================================================================

/**
 * Fires the trial-expired email once per trial (idempotent via Redis sentinel).
 * Called from withPlanContext when a trial expiry is detected on cache miss.
 */
export async function fireTrialExpiredEmail(
  userId:   string,
  email:    string,
  fullName: string,
  usage:    TrialUsage,
): Promise<void> {
  try {
    const alreadyNotified = await redis.get<string>(trialExpiredNotifiedKey(userId));
    if (alreadyNotified) return;

    await redis.set(trialExpiredNotifiedKey(userId), '1', { ex: 30 * 24 * 60 * 60 });

    const { reactMailer } = await import('@/lib/email/react-mailer.service');
    await reactMailer.sendFreeTrialExpiredEmail(email, {
      userName:   fullName,
      usage,
      upgradeUrl: `${process.env['FRONTEND_URL'] ?? ''}/settings/billing`,
    });

    logger.info({ type: 'trial_expired_email_sent', userId });
  } catch (err: unknown) {
    logger.error({ type: 'trial_expired_email_failed', userId, err });
  }
}
