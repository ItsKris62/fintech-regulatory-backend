import { TRPCError } from '@trpc/server';
import { BillingMetric, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { middleware } from './init';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { getLimit, requireFeature } from '@/utils/entitlements';
import type { FeatureKey } from '@/config/entitlements.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';

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

/** TTL for org plan cache in Redis: 5 minutes */
const PLAN_CACHE_TTL = 300;

/** TTL for usage counters in Redis: 35 days (covers billing cycle edge cases) */
const USAGE_TTL = 35 * 24 * 60 * 60;

/**
 * Shape stored in Redis for the org plan cache.
 * Includes subscription status fields so grace-period enforcement works
 * on cache hits without an extra DB round-trip.
 */
type CachedPlan = {
  plan:               SubscriptionPlan;
  customLimits:       Record<string, unknown> | null;
  subscriptionStatus: SubscriptionStatus | null;
  gracePeriodEndsAt:  string | null; // ISO-8601 string
};

/**
 * Returns true when an org is in the GRACE_PERIOD state and the window has
 * already passed — i.e. access should be revoked NOW.
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
 * Fetches the organization's SubscriptionPlan and customLimits from the
 * database (with a 5-min Redis cache) and attaches them to ctx.
 *
 * Grace-period enforcement (lazy, no cron required):
 *   If the org is in GRACE_PERIOD and gracePeriodEndsAt has passed, this
 *   middleware atomically downgrades the plan to REGULATOR, sets status to
 *   EXPIRED, and invalidates the cache — all within the current request.
 *
 * Must run AFTER isAuthenticated. Falls back to REGULATOR for users
 * without an organization (e.g. accounts mid-onboarding).
 */
export const withPlanContext = middleware(async ({ ctx, next }) => {
  // isAuthenticated must run before this middleware
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  // Keep user non-null in the extended context (mirrors isAuthenticated narrowing pattern)
  const user = ctx.user;
  const orgId = user.organizationId;

  // No organization → apply the most restrictive defaults
  if (!orgId) {
    return next({
      ctx: { ...ctx, user, plan: SubscriptionPlan.REGULATOR, customLimits: null },
    });
  }

  const cacheKey = `sheriabot:plan:${orgId}`;

  // ── Try Redis cache ────────────────────────────────────────────────────────
  let plan:               SubscriptionPlan            = SubscriptionPlan.REGULATOR;
  let customLimits:       Record<string, unknown> | null = null;
  let subscriptionStatus: SubscriptionStatus | null   = null;
  let gracePeriodEndsAt:  string | null               = null;
  let fromCache = false;

  try {
    const cached = await redis.get<CachedPlan>(cacheKey);
    if (cached && typeof cached === 'object' && cached.plan) {
      plan               = cached.plan;
      customLimits       = cached.customLimits ?? null;
      subscriptionStatus = cached.subscriptionStatus ?? null;
      gracePeriodEndsAt  = cached.gracePeriodEndsAt ?? null;
      fromCache          = true;
    }
  } catch {
    // Cache miss or parse error — fall through to DB
  }

  // ── DB lookup (on cache miss) ──────────────────────────────────────────────
  if (!fromCache) {
    const org = await prisma.organization.findUnique({
      where:  { id: orgId },
      select: { plan: true, customLimits: true, subscriptionStatus: true, gracePeriodEndsAt: true },
    });

    plan               = org?.plan               ?? SubscriptionPlan.REGULATOR;
    customLimits       = (org?.customLimits as Record<string, unknown> | null) ?? null;
    subscriptionStatus = org?.subscriptionStatus ?? null;
    gracePeriodEndsAt  = org?.gracePeriodEndsAt?.toISOString() ?? null;

    // Populate cache (includes status fields for future grace-period checks)
    await redis.set(
      cacheKey,
      JSON.stringify({ plan, customLimits, subscriptionStatus, gracePeriodEndsAt }),
      { ex: PLAN_CACHE_TTL },
    );
  }

  // ── Lazy grace-period enforcement ─────────────────────────────────────────
  // If the grace window has elapsed, atomically downgrade the plan. This
  // happens on the first request after expiry — no cron job required.
  if (isGracePeriodExpired(subscriptionStatus, gracePeriodEndsAt)) {
    const previousPlan = plan; // capture before overwrite

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        plan:               SubscriptionPlan.REGULATOR,
        subscriptionStatus: SubscriptionStatus.EXPIRED,
      },
    });

    // Invalidate cache so the next request sees the downgraded state from DB
    try { await redis.del(cacheKey); } catch { /* non-fatal */ }

    plan               = SubscriptionPlan.REGULATOR;
    subscriptionStatus = SubscriptionStatus.EXPIRED;

    logger.info({
      type:  'grace_period_expired_downgraded',
      orgId,
      previousGracePeriodEndsAt: gracePeriodEndsAt,
    });

    // ── Fire downgrade email (non-blocking) ──────────────────────────────────
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
          const base = appConfig.frontendUrl.replace(/\/$/, '');
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

  logger.debug({ type: 'plan_context_loaded', orgId, plan, subscriptionStatus, fromCache });

  return next({ ctx: { ...ctx, user, plan, customLimits } });
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
 * Factory that returns a middleware enforcing a monthly usage quota.
 *
 * - Reads the plan's limit from PLAN_ENTITLEMENTS.
 * - If limit === -1 (unlimited): passes through without touching Redis.
 * - If limit === 0: blocks (feature unavailable — use requirePlanFeature instead).
 * - Otherwise: atomically increments the Redis counter and blocks if over limit.
 *
 * Redis key: sheriabot:usage:{orgId}:{metric}:{YYYY-MM}
 * TTL: 35 days (automatically cleaned up after billing cycle).
 *
 * Must run after withPlanContext.
 */
export const checkUsageLimit = (metric: BillingMetric) =>
  middleware(async ({ ctx, next }) => {
    // Re-assert auth (this middleware always runs after isAuthenticated + withPlanContext)
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
    }
    const user = ctx.user; // User (non-null)

    const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;
    const featureKey = METRIC_FEATURE_MAP[metric];
    const limit = getLimit(plan, featureKey);

    // Unlimited: skip all Redis I/O
    if (limit === -1) {
      return next({
        ctx: { ...ctx, user, usageInfo: { metric, current: -1, limit: -1 } },
      });
    }

    // Feature unavailable on this plan (should be caught by requirePlanFeature first)
    if (limit === 0) {
      const planName = plan.charAt(0) + plan.slice(1).toLowerCase();
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `This feature is not available on the ${planName} plan. Please upgrade your subscription.`,
      });
    }

    // Build the Redis key for this org + metric + billing period
    const scopeId = user.organizationId ?? user.id;
    const period = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const usageKey = `sheriabot:usage:${scopeId}:${metric}:${period}`;

    // Read current count first to give an accurate error message
    const currentRaw = await redis.get<number>(usageKey);
    const current = typeof currentRaw === 'number' ? currentRaw : Number(currentRaw ?? 0);

    if (current >= limit) {
      logger.warn({
        type: 'usage_limit_reached',
        userId: user.id,
        orgId: scopeId,
        metric,
        current,
        limit,
        plan,
      });

      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Monthly limit reached (${current}/${limit}). Upgrade your plan for more.`,
      });
    }

    // Atomically increment
    const newCount = await redis.incr(usageKey);

    // Set TTL on first write (new period key)
    if (newCount === 1) {
      await redis.expire(usageKey, USAGE_TTL);
    }

    logger.debug({
      type: 'usage_incremented',
      orgId: scopeId,
      metric,
      current: newCount,
      limit,
    });

    return next({
      ctx: { ...ctx, user, usageInfo: { metric, current: newCount, limit } },
    });
  });