import { TRPCError } from '@trpc/server';
import { BillingMetric, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { middleware } from './init';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { getQuota, requireFeature } from '@/utils/entitlements';
import type { FeatureKey } from '@/config/entitlements.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';
import type { EffectivePlan, TrialFeature } from '@/types/plan.types';
import { FREE_TRIAL_LIMITS } from '@/types/plan.types';
import {
  checkTrialLimit,
  incrementTrialUsage,
  planCtxCacheKey,
  fireTrialExpiredEmail,
} from '@/modules/trial';
import { TrialUsageSchema, EMPTY_TRIAL_USAGE } from '@/modules/trial/trial.types';

/**
 * Logging Middleware (Fixed Error Handling)
 * tRPC intercepts procedure errors, so we must check `result.ok` 
 * instead of relying on a try/catch block.
 */
export const logged = middleware(async ({ ctx, path, type, next }) => {
  const start = Date.now();
  
  logger.info({
    type: 'trpc_request_start',
    path,
    requestType: type,
    userId: ctx.user?.id || 'anonymous',
    ip: ctx.req.ip,
  });

  const result = await next({ ctx });
  const duration = Date.now() - start;

  if (result.ok) {
    logger.info({
      type: 'trpc_request_success',
      path,
      requestType: type,
      userId: ctx.user?.id,
      duration,
    });
  } else {
    logger.error({
      type: 'trpc_request_error',
      path,
      requestType: type,
      userId: ctx.user?.id,
      error: result.error.message,
      code: result.error.code,
      duration,
    });
  }

  return result;
});

/**
 * Authentication Middleware
 */
export const isAuthenticated = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Please log in.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user, // TypeScript now infers user as NonNullable downstream
    },
  });
});

/**
 * Role-based Middlewares
 */
export const isAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'ADMIN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  return next({ ctx });
});

export const isRegulator = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'REGULATOR') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Regulator access required' });
  }
  return next({ ctx });
});

export const isStartup = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'STARTUP') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Startup access required' });
  }
  return next({ ctx });
});

export const isEnterprise = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== 'ENTERPRISE') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Enterprise access required' });
  }
  return next({ ctx });
});

/**
 * Rate Limiting Middleware
 */
export const rateLimited = (action: string, maxRequests?: number) =>
  middleware(async ({ ctx, next }) => {
    // Fallback securely if Fastify IP is missing for some reason
    const identifier = ctx.user?.id || ctx.req.ip || 'anonymous';

    try {
      await rateLimiter.checkOrThrow(identifier, action, maxRequests ?? 100, 900);
    } catch (error: unknown) {
      logger.warn({
        type: 'rate_limit_exceeded',
        action,
        identifier,
        userId: ctx.user?.id,
      });

      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded. Please try again later.',
      });
    }

    return next({ ctx });
  });

/**
 * Organization Member Middleware (Fixed Type Safety)
 * Avoids `as any` by safely checking if the input is an object with an organizationId.
 */
export const isOrganizationMember = middleware(async ({ ctx, input, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }

  // Type-safe way to check input without using `any`
  const hasOrgId = input && typeof input === 'object' && 'organizationId' in input;
  const organizationId = hasOrgId ? (input as { organizationId: string }).organizationId : null;
  
  if (!organizationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Organization ID is required in the request payload',
    });
  }

  // Allow admins to bypass this check
  if (ctx.user.organizationId !== organizationId && ctx.user.role !== 'ADMIN') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Access denied to this organization',
    });
  }

  return next({ ctx });
});

// ============================================================================
// Plan-Aware Middleware
// ============================================================================

/** TTL for the user-scoped plan+trial context cache in Redis: 5 minutes */
const PLAN_CACHE_TTL = 300;

/** TTL for usage counters in Redis: 35 days (covers billing cycle edge cases) */
const USAGE_TTL = 35 * 24 * 60 * 60;

/**
 * Shape stored in the user-scoped plan context cache (sheriabot:planctx:{userId}).
 * Includes subscription status and trial timestamps so all resolution logic
 * works on cache hits without extra DB round-trips.
 */
type CachedPlanCtx = {
  orgPlan:            SubscriptionPlan;
  customLimits:       Record<string, unknown> | null;
  subscriptionStatus: SubscriptionStatus | null;
  gracePeriodEndsAt:  string | null; // ISO-8601
  trialActivatedAt:   string | null; // ISO-8601
  trialExpiresAt:     string | null; // ISO-8601
};

/**
 * Returns true when an org is in the GRACE_PERIOD state and the window has
 * already passed -- i.e. access should be revoked NOW.
 */
function isGracePeriodExpired(
  status:            SubscriptionStatus | null,
  gracePeriodEndsAt: string | Date | null,
): boolean {
  return (
    status === SubscriptionStatus.GRACE_PERIOD &&
    gracePeriodEndsAt !== null &&
    new Date(gracePeriodEndsAt) <= new Date()
  );
}

/**
 * Resolves the effective plan for a request, with this priority:
 *
 *  1. Active paid subscription                  -> orgPlan (STARTUP/BUSINESS/ENTERPRISE)
 *  2. Grace period active                       -> orgPlan (retain access until window closes)
 *  3. Free trial active (expiresAt > now)       -> 'FREE_TRIAL'
 *  4. Fallback                                  -> REGULATOR
 *
 * Notes:
 *  - The trial check (step 3) runs BEFORE the org-less fast-return so that
 *    users without an organization can still use their trial.
 *  - Grace-period expiry is lazily enforced (no cron). Same pattern as before.
 *  - Cache key is now user-scoped (sheriabot:planctx:{userId}) so trial fields
 *    are co-located with subscription state.
 *  - The legacy org-scoped key (sheriabot:plan:{orgId}) is left untouched for
 *    any other consumers that may read it directly.
 *
 * Must run AFTER isAuthenticated.
 */
export const withPlanContext = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  const user  = ctx.user;
  const userId = user.id;
  const orgId  = user.organizationId;

  const cacheKey = planCtxCacheKey(userId);

  // ── Try user-scoped plan context cache ────────────────────────────────────
  let orgPlan:            SubscriptionPlan            = SubscriptionPlan.REGULATOR;
  let customLimits:       Record<string, unknown> | null = null;
  let subscriptionStatus: SubscriptionStatus | null   = null;
  let gracePeriodEndsAt:  string | null               = null;
  let trialActivatedAt:   string | null               = null;
  let trialExpiresAt:     string | null               = null;
  let fromCache = false;

  try {
    const cached = await redis.get<CachedPlanCtx>(cacheKey);
    if (cached && typeof cached === 'object' && cached.orgPlan) {
      orgPlan            = cached.orgPlan;
      customLimits       = cached.customLimits ?? null;
      subscriptionStatus = cached.subscriptionStatus ?? null;
      gracePeriodEndsAt  = cached.gracePeriodEndsAt ?? null;
      trialActivatedAt   = cached.trialActivatedAt ?? null;
      trialExpiresAt     = cached.trialExpiresAt ?? null;
      fromCache          = true;
    }
  } catch {
    // Cache miss or parse error -- fall through to DB
  }

  // ── DB lookup on cache miss ────────────────────────────────────────────────
  if (!fromCache) {
    // Always fetch trial fields from the User row
    const userRow = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        freeTrialActivatedAt: true,
        freeTrialExpiresAt:   true,
        freeTrialUsage:       true,
        fullName:             true,
      },
    });

    trialActivatedAt = userRow?.freeTrialActivatedAt?.toISOString() ?? null;
    trialExpiresAt   = userRow?.freeTrialExpiresAt?.toISOString()   ?? null;

    // Fetch org subscription state only if the user belongs to an org
    if (orgId) {
      const org = await prisma.organization.findUnique({
        where:  { id: orgId },
        select: {
          plan:               true,
          customLimits:       true,
          subscriptionStatus: true,
          gracePeriodEndsAt:  true,
        },
      });

      orgPlan            = org?.plan               ?? SubscriptionPlan.REGULATOR;
      customLimits       = (org?.customLimits as Record<string, unknown> | null) ?? null;
      subscriptionStatus = org?.subscriptionStatus ?? null;
      gracePeriodEndsAt  = org?.gracePeriodEndsAt?.toISOString() ?? null;
    }

    // Populate user-scoped cache
    await redis.set(
      cacheKey,
      JSON.stringify({
        orgPlan,
        customLimits,
        subscriptionStatus,
        gracePeriodEndsAt,
        trialActivatedAt,
        trialExpiresAt,
      }),
      { ex: PLAN_CACHE_TTL },
    ).catch(() => { /* non-fatal */ });

    // ── Lazy trial-expiry email (fires once per trial, on cache miss only) ────
    // If a trial was previously active but has now expired, fire the email once.
    if (
      trialActivatedAt !== null &&
      trialExpiresAt !== null &&
      new Date(trialExpiresAt) <= new Date()
    ) {
      const usage = (() => {
        const parsed = TrialUsageSchema.safeParse(userRow?.freeTrialUsage);
        return parsed.success ? parsed.data : { ...EMPTY_TRIAL_USAGE };
      })();

      void fireTrialExpiredEmail(
        userId,
        user.email,
        userRow?.fullName ?? '',
        usage,
      ).catch(() => { /* non-fatal */ });
    }
  }

  // ── Lazy grace-period enforcement ─────────────────────────────────────────
  if (orgId && isGracePeriodExpired(subscriptionStatus, gracePeriodEndsAt)) {
    const previousPlan = orgPlan;

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        plan:               SubscriptionPlan.REGULATOR,
        subscriptionStatus: SubscriptionStatus.EXPIRED,
      },
    });

    // Invalidate user-scoped cache
    try { await redis.del(cacheKey); } catch { /* non-fatal */ }

    orgPlan            = SubscriptionPlan.REGULATOR;
    subscriptionStatus = SubscriptionStatus.EXPIRED;

    logger.info({
      type:  'grace_period_expired_downgraded',
      orgId,
      userId,
      previousGracePeriodEndsAt: gracePeriodEndsAt,
    });

    void (async () => {
      try {
        const contact = await prisma.user.findFirst({
          where:   { organizationId: orgId, role: { in: ['ADMIN', 'STARTUP', 'ENTERPRISE'] } },
          select:  { email: true, fullName: true },
          orderBy: { createdAt: 'asc' },
        });
        const org = await prisma.organization.findUnique({
          where:  { id: orgId },
          select: { name: true },
        });
        if (contact && org) {
          const base      = appConfig.frontendUrl.replace(/\/$/, '');
          const planLabel = previousPlan.charAt(0) + previousPlan.slice(1).toLowerCase();
          await reactMailer.sendPlanDowngradedEmail(contact.email, {
            userName:         contact.fullName,
            orgName:          org.name,
            previousPlanName: planLabel,
            reactivateUrl:    `${base}/settings/billing`,
            dashboardUrl:     `${base}/startup`,
          });
        }
      } catch { /* email failure must never affect the request */ }
    })();
  }

  // ── Resolve effective plan (priority order) ───────────────────────────────
  //
  //  1. Active paid subscription (ACTIVE or TRIALING from Stripe)
  //  2. Grace period active (not yet expired)
  //  3. Free trial active
  //  4. REGULATOR fallback

  let effectivePlan: EffectivePlan = SubscriptionPlan.REGULATOR;
  let trialState: { isActive: boolean; daysRemaining: number | null } | undefined;

  const hasPaidPlan =
    orgPlan !== SubscriptionPlan.REGULATOR &&
    subscriptionStatus !== SubscriptionStatus.EXPIRED;

  const graceStillActive =
    subscriptionStatus === SubscriptionStatus.GRACE_PERIOD &&
    gracePeriodEndsAt !== null &&
    new Date(gracePeriodEndsAt) > new Date();

  if (hasPaidPlan || graceStillActive) {
    // Steps 1 & 2: paid plan or active grace period
    effectivePlan = orgPlan;
  } else if (
    trialActivatedAt !== null &&
    trialExpiresAt !== null &&
    new Date(trialExpiresAt) > new Date()
  ) {
    // Step 3: free trial active
    effectivePlan = 'FREE_TRIAL';
    const msRemaining = new Date(trialExpiresAt).getTime() - Date.now();
    const daysRemaining = Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));
    trialState = { isActive: true, daysRemaining };
  }
  // Step 4: falls through to REGULATOR (default above)

  logger.debug({
    type:   'plan_context_loaded',
    userId,
    orgId,
    effectivePlan,
    subscriptionStatus,
    fromCache,
  });

  return next({
    ctx: {
      ...ctx,
      user,
      plan:         effectivePlan,
      customLimits,
      trialState,
    },
  });
});

/**
 * Factory that returns a middleware blocking access when the org's plan does
 * not include the requested feature.
 *
 * Throws FORBIDDEN with the minimum required plan name.
 * Must run after withPlanContext.
 */
export const requirePlanFeature = (feature: FeatureKey) =>
  middleware(async ({ ctx, next }) => {
    // Re-assert auth (this middleware always runs after isAuthenticated + withPlanContext)
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
    }
    const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;
    requireFeature(plan, feature); // throws TRPCError FORBIDDEN if not allowed
    // Re-narrow user so handlers downstream receive user: User (non-null)
    return next({ ctx: { ...ctx, user: ctx.user } });
  });

/**
 * Maps each BillingMetric to the corresponding FeatureKey in PLAN_ENTITLEMENTS.
 * Used by checkUsageLimit to look up the monthly cap for the org's plan.
 */
const METRIC_FEATURE_MAP = {
  [BillingMetric.COMPLIANCE_QUERIES]:    'complianceQueries',
  [BillingMetric.CHECKLIST_GENERATIONS]: 'checklistGenerations',
  [BillingMetric.API_CALLS]:             'apiAccess',
  [BillingMetric.POLICY_GENERATIONS]:    'policyGeneration',
  [BillingMetric.DOCUMENT_STORAGE_MB]:   'documentRepository',
  [BillingMetric.GAP_ANALYSES]:          'gapAnalysis',
} as const satisfies Record<BillingMetric, FeatureKey>;

/**
 * Maps BillingMetric values to TrialFeature keys.
 * Returns null for metrics that have no trial cap (unlimited during trial).
 */
function mapMetricToTrialFeature(metric: BillingMetric): TrialFeature | null {
  switch (metric) {
    case BillingMetric.COMPLIANCE_QUERIES:    return 'complianceQueries';
    case BillingMetric.CHECKLIST_GENERATIONS: return 'checklists';
    case BillingMetric.GAP_ANALYSES:          return 'gapAnalyses';
    case BillingMetric.DOCUMENT_STORAGE_MB:   return 'vaultUploads';
    default:                                  return null;
  }
}

/** AI-generating metrics that consume the shared token budget. */
const AI_METRICS = new Set<BillingMetric>([
  BillingMetric.COMPLIANCE_QUERIES,
  BillingMetric.CHECKLIST_GENERATIONS,
  BillingMetric.GAP_ANALYSES,
]);

/**
 * Factory that returns a middleware enforcing a usage quota (monthly or lifetime).
 *
 * - Reads plan limit + period from PLAN_ENTITLEMENTS via getQuota().
 * - limit === -1 (unlimited): passes through without touching Redis.
 * - limit === 0 (FORBIDDEN): feature unavailable on this plan.
 * - Otherwise: reads the Redis counter and blocks if at or over limit.
 *
 * Redis keys:
 *   Monthly:  sheriabot:usage:{scopeId}:{metric}:{YYYY-MM}  (TTL: 35 days)
 *   Lifetime: sheriabot:usage:{scopeId}:{metric}:lifetime    (no TTL)
 *
 * Error code semantics:
 *   FORBIDDEN         — feature is not included in the plan at all (limit === 0)
 *   TOO_MANY_REQUESTS — feature is included but the quota is exhausted
 *
 * Options:
 *   deferIncrement?: boolean
 *     When true, the middleware does NOT increment the counter immediately.
 *     Instead, it attaches ctx.incrementUsage() which the router handler
 *     must call after a successful DB write.  This prevents lost credits
 *     when the service call fails after the middleware runs.
 *     Default: false (increment immediately, backward-compatible).
 *
 * Must run after withPlanContext.
 */
export const checkUsageLimit = (
  metric:  BillingMetric,
  opts?:   { deferIncrement?: boolean },
) =>
  middleware(async ({ ctx, next }) => {
    // Re-assert auth (always runs after isAuthenticated + withPlanContext)
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
    }
    const user = ctx.user;
    const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;

    // ── FREE_TRIAL branch ──────────────────────────────────────────────────
    // Trial users bypass the Redis monthly quota path entirely.
    // Caps are enforced against the freeTrialUsage JSON column via trialService.
    if (plan === 'FREE_TRIAL') {
      const trialFeature = mapMetricToTrialFeature(metric);

      if (trialFeature !== null) {
        // 1. Feature-specific lifetime cap
        const featureCheck = await checkTrialLimit(user.id, trialFeature);
        if (!featureCheck.allowed) {
          logger.warn({
            type:    'trial_limit_reached',
            userId:  user.id,
            feature: trialFeature,
            current: featureCheck.current,
            limit:   featureCheck.limit,
          });
          throw new TRPCError({
            code:    'FORBIDDEN',
            message: `Trial limit reached for this feature (${featureCheck.current}/${featureCheck.limit}). Upgrade to continue.`,
          });
        }

        // 2. Cross-feature token budget (AI-generating features only)
        if (AI_METRICS.has(metric)) {
          const tokenCheck = await checkTrialLimit(user.id, 'totalTokensUsed');
          if (!tokenCheck.allowed) {
            logger.warn({
              type:    'trial_token_budget_exhausted',
              userId:  user.id,
              current: tokenCheck.current,
              limit:   tokenCheck.limit,
            });
            throw new TRPCError({
              code:    'FORBIDDEN',
              message: `Trial token budget exhausted (${tokenCheck.current.toLocaleString()}/${tokenCheck.limit.toLocaleString()} tokens). Upgrade to continue.`,
            });
          }
        }

        // Increment deferred to after successful execution via ctx.incrementUsage
        const doTrialIncrement = async (): Promise<void> => {
          await incrementTrialUsage(user.id, trialFeature);
        };

        return next({
          ctx: {
            ...ctx,
            user,
            usageInfo:      { metric, current: featureCheck.current, limit: featureCheck.limit },
            incrementUsage: doTrialIncrement,
          },
        });
      }

      // Metric has no trial cap (e.g. API_CALLS, POLICY_GENERATIONS are not trial features)
      return next({
        ctx: { ...ctx, user, usageInfo: { metric, current: 0, limit: FREE_TRIAL_LIMITS.complianceQueries } },
      });
    }

    // ── Standard Redis monthly / lifetime quota path (paid plans + REGULATOR) ─
    const featureKey = METRIC_FEATURE_MAP[metric];
    const { limit, period } = getQuota(plan, featureKey);

    // Unlimited: skip all Redis I/O
    if (limit === -1) {
      return next({
        ctx: { ...ctx, user, usageInfo: { metric, current: -1, limit: -1 } },
      });
    }

    // Feature unavailable on this plan -- FORBIDDEN (plan issue, not quota issue)
    if (limit === 0) {
      const planName = plan.charAt(0) + plan.slice(1).toLowerCase();
      throw new TRPCError({
        code:    'FORBIDDEN',
        message: `This feature is not available on the ${planName} plan. Please upgrade your subscription.`,
      });
    }

    // Build the Redis key using the correct period bucket
    const scopeId   = user.organizationId ?? user.id;
    const periodKey = period === 'lifetime'
      ? 'lifetime'
      : new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const usageKey  = `sheriabot:usage:${scopeId}:${metric}:${periodKey}`;

    // Read current count to give an accurate error message before touching Redis
    const currentRaw = await redis.get<number>(usageKey);
    const current    = typeof currentRaw === 'number' ? currentRaw : Number(currentRaw ?? 0);

    if (current >= limit) {
      logger.warn({
        type:    'usage_limit_reached',
        userId:  user.id,
        orgId:   scopeId,
        metric,
        current,
        limit,
        period,
        plan,
      });

      const limitLabel = period === 'lifetime' ? 'Lifetime' : 'Monthly';
      throw new TRPCError({
        code:    'TOO_MANY_REQUESTS',
        message: `${limitLabel} limit reached (${current}/${limit}). Upgrade your plan for more.`,
      });
    }

    // -----------------------------------------------------------------
    // Increment logic -- either immediately or deferred.
    // -----------------------------------------------------------------
    const doIncrement = async (): Promise<void> => {
      const newCount = await redis.incr(usageKey);
      // Set TTL only for monthly keys (lifetime keys never expire)
      if (newCount === 1 && period === 'month') {
        await redis.expire(usageKey, USAGE_TTL);
      }
      logger.debug({
        type:    'usage_incremented',
        orgId:   scopeId,
        metric,
        current: newCount,
        limit,
        period,
        deferred: opts?.deferIncrement ?? false,
      });
    };

    if (opts?.deferIncrement) {
      return next({
        ctx: {
          ...ctx,
          user,
          usageInfo:      { metric, current, limit },
          incrementUsage: doIncrement,
        },
      });
    }

    // Default (eager) path: increment now, before the handler runs.
    await doIncrement();

    return next({
      ctx: { ...ctx, user, usageInfo: { metric, current: current + 1, limit } },
    });
  });