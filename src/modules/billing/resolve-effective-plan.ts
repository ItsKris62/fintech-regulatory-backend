import { PaymentProvider, Prisma, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import type { Redis } from '@upstash/redis';
import type { prisma as prismaSingleton } from '@/lib/prisma/client';
import type { EffectivePlan } from '@/types/plan.types';
import type { TrialContextState } from '@/modules/trial/trial.types';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { getRuntimePlan, resolvePlanPriceForInterval } from '@/lib/runtime-billing-plans';
import {
  fireTrialExpiredEmail,
  planCtxCacheKey,
} from '@/modules/trial';
import {
  EMPTY_TRIAL_USAGE,
  TrialUsageSchema,
} from '@/modules/trial/trial.types';

const PLAN_CACHE_TTL = 300;

export interface PilotContextState {
  isPilot: boolean;
  expiresAt: string | null;
}

export interface ResolvedEffectivePlan {
  plan: EffectivePlan;
  orgPlan: SubscriptionPlan;
  customLimits: Prisma.JsonValue | null;
  subscriptionStatus: SubscriptionStatus | null;
  gracePeriodEndsAt: string | null;
  trialState: TrialContextState | undefined;
  pilotState: PilotContextState | null;
  fromCache: boolean;
}

type CachedPlanCtx = {
  orgPlan: SubscriptionPlan;
  customLimits: Prisma.JsonValue | null;
  subscriptionStatus: SubscriptionStatus | null;
  gracePeriodEndsAt: string | null;
  trialActivatedAt: string | null;
  trialExpiresAt: string | null;
  preferredPaymentMethod: PaymentProvider | null;
  mpesaNextPaymentDueDate: string | null;
  // B4 (2026-05-27) -- Background lifecycle field, read-only.
  // Always written in parallel with mpesaNextPaymentDueDate by the IntaSend
  // webhook. The downgrade gate continues to read mpesaNextPaymentDueDate;
  // this field is consumed by B6's renewal cron.
  subscriptionCycleEnd: string | null; // ISO-8601
  isPilot: boolean;
  pilotExpiresAt: string | null;
  pilotAccessStatus: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCachedPlanCtx(raw: unknown): CachedPlanCtx | null {
  const value = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!isRecord(value) || typeof value['orgPlan'] !== 'string') return null;

  return {
    orgPlan: value['orgPlan'] as SubscriptionPlan,
    customLimits: (value['customLimits'] ?? null) as Prisma.JsonValue | null,
    subscriptionStatus: (value['subscriptionStatus'] ?? null) as SubscriptionStatus | null,
    gracePeriodEndsAt: typeof value['gracePeriodEndsAt'] === 'string' ? value['gracePeriodEndsAt'] : null,
    trialActivatedAt: typeof value['trialActivatedAt'] === 'string' ? value['trialActivatedAt'] : null,
    trialExpiresAt: typeof value['trialExpiresAt'] === 'string' ? value['trialExpiresAt'] : null,
    preferredPaymentMethod: (value['preferredPaymentMethod'] ?? null) as PaymentProvider | null,
    mpesaNextPaymentDueDate: typeof value['mpesaNextPaymentDueDate'] === 'string' ? value['mpesaNextPaymentDueDate'] : null,
    subscriptionCycleEnd: typeof value['subscriptionCycleEnd'] === 'string' ? value['subscriptionCycleEnd'] : null,
    isPilot: value['isPilot'] === true,
    pilotExpiresAt: typeof value['pilotExpiresAt'] === 'string' ? value['pilotExpiresAt'] : null,
    pilotAccessStatus: typeof value['pilotAccessStatus'] === 'string' ? value['pilotAccessStatus'] : null,
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isGracePeriodExpired(
  status: SubscriptionStatus | null,
  gracePeriodEndsAt: string | Date | null,
  now: Date,
): boolean {
  return (
    status === SubscriptionStatus.GRACE_PERIOD &&
    gracePeriodEndsAt !== null &&
    new Date(gracePeriodEndsAt) <= now
  );
}

async function resolveMonthlyPlanAmountKes(plan: SubscriptionPlan | null | undefined): Promise<number> {
  if (plan !== SubscriptionPlan.STARTUP && plan !== SubscriptionPlan.BUSINESS) {
    return 0;
  }

  try {
    const runtimePlan = await getRuntimePlan(plan);
    return resolvePlanPriceForInterval(runtimePlan, 'monthly') ?? 0;
  } catch (error: unknown) {
    logger.warn({
      type: 'mpesa_plan_price_resolution_failed',
      plan,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function sendPlanDowngradeEmail(input: {
  prisma: typeof prismaSingleton;
  organizationId: string;
  previousPlan: SubscriptionPlan;
  dueDate?: Date;
  daysPast?: number;
  daysUntil?: number;
}): Promise<void> {
  const contact = await input.prisma.user.findFirst({
    where: {
      organizationId: input.organizationId,
      role: { in: ['ADMIN', 'STARTUP', 'ENTERPRISE'] },
    },
    select: { email: true, fullName: true, id: true },
    orderBy: { createdAt: 'asc' },
  });
  const org = await input.prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { name: true, plan: true },
  });
  if (!contact || !org) return;

  const base = appConfig.frontendUrl.replace(/\/$/, '');

  if (input.dueDate) {
    const planLabel = (org.plan ?? 'Subscription').charAt(0) + (org.plan ?? '').slice(1).toLowerCase();
    const amountKes = await resolveMonthlyPlanAmountKes(org.plan);
    const amountStr = `KES ${amountKes.toLocaleString('en-KE')}`;
    await reactMailer.sendPaymentDueEmail(contact.email, contact.id, {
      userName: contact.fullName,
      amount: amountStr,
      dueDate: input.dueDate.toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' }),
      planName: planLabel,
      paymentUrl: `${base}/settings/billing`,
      daysUntilDue: input.daysPast !== undefined ? -input.daysPast : input.daysUntil ?? 0,
    });
    return;
  }

  const planLabel = input.previousPlan.charAt(0) + input.previousPlan.slice(1).toLowerCase();
  await reactMailer.sendPlanDowngradedEmail(contact.email, {
    userName: contact.fullName,
    orgName: org.name,
    previousPlanName: planLabel,
    reactivateUrl: `${base}/settings/billing`,
    dashboardUrl: `${base}/startup`,
  });
}

export async function resolveEffectivePlan(input: {
  userId: string;
  organizationId: string | null;
  userEmail?: string;
  prisma: typeof prismaSingleton;
  redis: Redis;
  now?: Date;
}): Promise<ResolvedEffectivePlan> {
  const now = input.now ?? new Date();
  const cacheKey = planCtxCacheKey(input.userId);

  let orgPlan: SubscriptionPlan = SubscriptionPlan.REGULATOR;
  let customLimits: Prisma.JsonValue | null = null;
  let subscriptionStatus: SubscriptionStatus | null = null;
  let gracePeriodEndsAt: string | null = null;
  let trialActivatedAt: string | null = null;
  let trialExpiresAt: string | null = null;
  let preferredPaymentMethod: PaymentProvider | null = null;
  let mpesaNextPaymentDueDate: string | null = null;
  let subscriptionCycleEnd: string | null = null;
  let isPilot = false;
  let pilotExpiresAt: string | null = null;
  let pilotAccessStatus: string | null = null;
  let fromCache = false;
  let userFullName = '';
  let userEmail = input.userEmail ?? '';
  let userFreeTrialUsage: Prisma.JsonValue | null = null;

  try {
    const cached = parseCachedPlanCtx(await input.redis.get<unknown>(cacheKey));
    if (cached) {
      orgPlan = cached.orgPlan;
      customLimits = cached.customLimits;
      subscriptionStatus = cached.subscriptionStatus;
      gracePeriodEndsAt = cached.gracePeriodEndsAt;
      trialActivatedAt = cached.trialActivatedAt;
      trialExpiresAt = cached.trialExpiresAt;
      preferredPaymentMethod = cached.preferredPaymentMethod;
      mpesaNextPaymentDueDate = cached.mpesaNextPaymentDueDate;
      subscriptionCycleEnd = cached.subscriptionCycleEnd;
      isPilot = cached.isPilot;
      pilotExpiresAt = cached.pilotExpiresAt;
      pilotAccessStatus = cached.pilotAccessStatus;
      fromCache = true;
    }
  } catch {
    // Cache miss or parse error: fall through to DB.
  }

  if (!fromCache) {
    const userRow = await input.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        email: true,
        freeTrialActivatedAt: true,
        freeTrialExpiresAt: true,
        freeTrialUsage: true,
        fullName: true,
        isPilot: true,
        pilotExpiresAt: true,
        pilotAccessStatus: true,
      },
    });

    userEmail = input.userEmail ?? userRow?.email ?? '';
    userFullName = userRow?.fullName ?? '';
    userFreeTrialUsage = userRow?.freeTrialUsage ?? null;
    trialActivatedAt = userRow?.freeTrialActivatedAt?.toISOString() ?? null;
    trialExpiresAt = userRow?.freeTrialExpiresAt?.toISOString() ?? null;
    isPilot = userRow?.isPilot ?? false;
    pilotExpiresAt = userRow?.pilotExpiresAt?.toISOString() ?? null;
    pilotAccessStatus = (userRow as any)?.pilotAccessStatus ?? null;

    if (input.organizationId) {
      const org = await input.prisma.organization.findUnique({
        where: { id: input.organizationId },
        select: {
          plan: true,
          customLimits: true,
          subscriptionStatus: true,
          gracePeriodEndsAt: true,
          preferredPaymentMethod: true,
          mpesaNextPaymentDueDate: true,
          subscriptionCycleEnd: true,
        },
      });

      orgPlan = org?.plan ?? SubscriptionPlan.REGULATOR;
      customLimits = org?.customLimits ?? null;
      subscriptionStatus = org?.subscriptionStatus ?? null;
      gracePeriodEndsAt = org?.gracePeriodEndsAt?.toISOString() ?? null;
      preferredPaymentMethod = org?.preferredPaymentMethod ?? null;
      mpesaNextPaymentDueDate = org?.mpesaNextPaymentDueDate?.toISOString() ?? null;
      subscriptionCycleEnd = org?.subscriptionCycleEnd?.toISOString() ?? null;
    }

    await input.redis.set(
      cacheKey,
      JSON.stringify({
        orgPlan,
        customLimits,
        subscriptionStatus,
        gracePeriodEndsAt,
        trialActivatedAt,
        trialExpiresAt,
        preferredPaymentMethod,
        mpesaNextPaymentDueDate,
        subscriptionCycleEnd,
        isPilot,
        pilotExpiresAt,
        pilotAccessStatus,
      } satisfies CachedPlanCtx),
      { ex: PLAN_CACHE_TTL },
    ).catch(() => { /* non-fatal */ });

    if (
      trialActivatedAt !== null &&
      trialExpiresAt !== null &&
      new Date(trialExpiresAt) <= now
    ) {
      const parsed = TrialUsageSchema.safeParse(userFreeTrialUsage);
      const usage = parsed.success ? parsed.data : { ...EMPTY_TRIAL_USAGE };
      void fireTrialExpiredEmail(
        input.userId,
        userEmail,
        userFullName,
        usage,
      ).catch(() => { /* non-fatal */ });
    }
  }

  if (input.organizationId && isGracePeriodExpired(subscriptionStatus, gracePeriodEndsAt, now)) {
    const previousPlan = orgPlan;

    await input.prisma.organization.update({
      where: { id: input.organizationId },
      data: {
        plan: SubscriptionPlan.REGULATOR,
        subscriptionStatus: SubscriptionStatus.EXPIRED,
      },
    });

    try { await input.redis.del(cacheKey); } catch { /* non-fatal */ }

    orgPlan = SubscriptionPlan.REGULATOR;
    subscriptionStatus = SubscriptionStatus.EXPIRED;

    logger.info({
      type: 'grace_period_expired_downgraded',
      orgId: input.organizationId,
      userId: input.userId,
      previousGracePeriodEndsAt: gracePeriodEndsAt,
    });

    void sendPlanDowngradeEmail({
      prisma: input.prisma,
      organizationId: input.organizationId,
      previousPlan,
    }).catch(() => { /* email failure must never affect the request */ });
  }

  if (
    input.organizationId &&
    preferredPaymentMethod === PaymentProvider.MPESA &&
    mpesaNextPaymentDueDate !== null
  ) {
    const orgId = input.organizationId;
    const dueDate = new Date(mpesaNextPaymentDueDate);

    // B4 (2026-05-27) -- Defensive parity check.
    // The IntaSend webhook writes both fields to the same value on every
    // successful payment. If they disagree by more than one second, the
    // transition window has slipped (manual DB edit, race, or partial write).
    // Option A semantics: mpesaNextPaymentDueDate remains the authoritative
    // gate. We log and proceed -- never silently prefer one field over the
    // other, never block the lazy check.
    if (subscriptionCycleEnd !== null) {
      const cycleEndDate = new Date(subscriptionCycleEnd);
      const diffMs       = Math.abs(dueDate.getTime() - cycleEndDate.getTime());
      if (diffMs > 1000) {
        logger.warn({
          type:                    'mpesa_cycle_field_mismatch',
          orgId,
          userId:                  input.userId,
          mpesaNextPaymentDueDate: dueDate.toISOString(),
          subscriptionCycleEnd:    cycleEndDate.toISOString(),
          diffMs,
        });
      }
    }

    const msPerDay = 1000 * 60 * 60 * 24;
    const msDiff = dueDate.getTime() - now.getTime();
    const daysPast = msDiff < 0 ? Math.floor(-msDiff / msPerDay) : 0;
    const daysUntil = msDiff > 0 ? Math.floor(msDiff / msPerDay) : 0;

    if (daysPast > 7) {
      const previousPlan = orgPlan;

      await input.prisma.organization.update({
        where: { id: orgId },
        data: {
          plan: SubscriptionPlan.REGULATOR,
          subscriptionStatus: SubscriptionStatus.EXPIRED,
        },
      });

      try { await input.redis.del(cacheKey); } catch { /* non-fatal */ }

      orgPlan = SubscriptionPlan.REGULATOR;
      subscriptionStatus = SubscriptionStatus.EXPIRED;

      logger.info({
        type: 'mpesa_grace_period_expired_downgraded',
        orgId,
        userId: input.userId,
        previousPlan,
        mpesaNextPaymentDueDate,
      });

      void sendPlanDowngradeEmail({
        prisma: input.prisma,
        organizationId: orgId,
        previousPlan,
      }).catch(() => { /* email failure must never affect the request */ });
    } else if (daysPast > 0) {
      const today = now.toISOString().slice(0, 10);
      const sentinelKey = `sheriabot:mpesa:due_notified:${orgId}:${today}`;

      void (async () => {
        try {
          const alreadyNotified = await input.redis.get<string>(sentinelKey);
          if (!alreadyNotified) {
            await input.redis.set(sentinelKey, '1', { ex: 60 * 60 * 24 });
            await sendPlanDowngradeEmail({
              prisma: input.prisma,
              organizationId: orgId,
              previousPlan: orgPlan,
              dueDate,
              daysPast,
            });
          }
        } catch { /* non-fatal */ }
      })();
    } else if (daysUntil <= 3 && daysUntil >= 0) {
      const sentinelKey = `sheriabot:mpesa:upcoming_notified:${orgId}`;

      void (async () => {
        try {
          const alreadyNotified = await input.redis.get<string>(sentinelKey);
          if (!alreadyNotified) {
            await input.redis.set(sentinelKey, '1', { ex: 60 * 60 * 72 });
            await sendPlanDowngradeEmail({
              prisma: input.prisma,
              organizationId: orgId,
              previousPlan: orgPlan,
              dueDate,
              daysUntil,
            });
          }
        } catch { /* non-fatal */ }
      })();
    }
  }

  let pilotEffectivePlan: EffectivePlan | null = null;
  let pilotState: PilotContextState | null = null;
  if (isPilot && pilotExpiresAt !== null && pilotAccessStatus !== 'REVOKED' && pilotAccessStatus !== 'CONVERTED') {
    if (new Date(pilotExpiresAt) <= now || pilotAccessStatus === 'EXPIRED') {
      if (pilotAccessStatus !== 'EXPIRED') {
        await input.prisma.user.update({
          where: { id: input.userId },
          data: { pilotAccessStatus: 'EXPIRED' } as any,
        }).catch(() => {});
      }
      try { await input.redis.del(cacheKey); } catch { /* non-fatal */ }
      logger.info({
        type: 'PILOT_EXPIRED_GATE',
        userId: input.userId,
        pilotExpiresAt,
      });
      pilotEffectivePlan = SubscriptionPlan.REGULATOR;
      logger.info({
        type: 'effective_plan_resolved_regulator',
        userId: input.userId,
        orgId: input.organizationId,
        reason: 'pilot_expired',
      });
    } else {
      const msRemaining = new Date(pilotExpiresAt).getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));
      logger.debug({
        type: 'PILOT_ACTIVE_GATE',
        userId: input.userId,
        daysRemaining,
        pilotExpiresAt,
      });
      pilotEffectivePlan = SubscriptionPlan.ENTERPRISE;
      pilotState = { isPilot: true, expiresAt: pilotExpiresAt };
      logger.info({
        type: 'effective_plan_resolved_pilot',
        userId: input.userId,
        orgId: input.organizationId,
        pilotExpiresAt,
      });
    }
  }

  let effectivePlan: EffectivePlan = SubscriptionPlan.REGULATOR;
  let trialState: TrialContextState | undefined;

  const hasPaidPlan =
    orgPlan !== SubscriptionPlan.REGULATOR &&
    (subscriptionStatus === SubscriptionStatus.ACTIVE ||
     subscriptionStatus === SubscriptionStatus.TRIALING);

  const graceStillActive =
    subscriptionStatus === SubscriptionStatus.GRACE_PERIOD &&
    gracePeriodEndsAt !== null &&
    new Date(gracePeriodEndsAt) > now;

  if (!hasPaidPlan && !graceStillActive && orgPlan !== SubscriptionPlan.REGULATOR) {
    logger.warn({
      type: 'plan_downgrade',
      userId: input.userId,
      orgId: input.organizationId,
      orgPlan,
      subscriptionStatus,
      effectivePlan: 'REGULATOR',
    });
  }

  if (pilotEffectivePlan === null) {
    if (subscriptionStatus === SubscriptionStatus.SUSPENDED) {
      // Admin-suspended orgs are denied all paid entitlements and FREE_TRIAL access.
      // Design choice (CC-C-039 Batch 5): FREE_TRIAL is also blocked for SUSPENDED orgs —
      // an admin-suspended user must not be able to fall through to trial access.
      // Full enforcement chain (webhook hardening, billing halt, reactivation) is Batch 7.
      logger.warn({
        type: 'effective_plan_resolved_suspended',
        userId: input.userId,
        orgId: input.organizationId,
        subscriptionStatus,
      });
      logger.info({
        type: 'effective_plan_resolved_regulator',
        userId: input.userId,
        orgId: input.organizationId,
        reason: 'admin_suspended',
      });
      // effectivePlan remains SubscriptionPlan.REGULATOR (the initialized default above)
    } else if (hasPaidPlan) {
      effectivePlan = orgPlan;
      logger.info({
        type: 'effective_plan_resolved_paid',
        userId: input.userId,
        orgId: input.organizationId,
        orgPlan,
        subscriptionStatus,
      });
    } else if (graceStillActive) {
      effectivePlan = orgPlan;
      logger.info({
        type: 'effective_plan_resolved_grace',
        userId: input.userId,
        orgId: input.organizationId,
        orgPlan,
        gracePeriodEndsAt,
      });
    } else if (
      trialActivatedAt !== null &&
      trialExpiresAt !== null &&
      new Date(trialExpiresAt) > now
    ) {
      effectivePlan = 'FREE_TRIAL';
      const msRemaining = new Date(trialExpiresAt).getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));
      trialState = { isActive: true, daysRemaining };
      logger.info({
        type: 'effective_plan_resolved_trial',
        userId: input.userId,
        orgId: input.organizationId,
        trialExpiresAt,
      });
    } else {
      logger.info({
        type: 'effective_plan_resolved_regulator',
        userId: input.userId,
        orgId: input.organizationId,
        reason: 'fallback',
      });
    }
  }

  const finalPlan = pilotEffectivePlan ?? effectivePlan;

  logger.debug({
    type: 'plan_context_loaded',
    userId: input.userId,
    orgId: input.organizationId,
    effectivePlan: finalPlan,
    subscriptionStatus,
    fromCache,
    isPilot,
  });

  return {
    plan: finalPlan,
    orgPlan,
    customLimits: pilotEffectivePlan !== null ? null : customLimits,
    subscriptionStatus,
    gracePeriodEndsAt,
    trialState: pilotEffectivePlan !== null ? undefined : trialState,
    pilotState,
    fromCache,
  };
}
