import { TRPCError } from '@trpc/server';
import { BillingMetric, MemberRole, MemberStatus, SubscriptionPlan } from '@prisma/client';
import type { Context, OrgMembershipEntry, User } from './context';
import { middleware } from './init';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import {
  getQuota,
  getQuotaFromEntitlements,
  requireEntitlementFeature,
  requireFeature,
} from '@/utils/entitlements';
import type { FeatureKey } from '@/config/entitlements.config';
import type { TrialFeature } from '@/types/plan.types';
import { FREE_TRIAL_LIMITS } from '@/types/plan.types';
import {
  checkTrialLimit,
  incrementTrialUsageAtomic,
} from '@/modules/trial';
import { resolveEffectivePlan } from '@/modules/billing/resolve-effective-plan';
import { hashIp } from '@/utils/request-identifiers';
import {
  AGENT_CREDENTIAL_HEADER,
  agentCredentialService,
  AgentCredentialError,
  isAgentCapability,
} from '@/modules/agents/agent-credential.service';

/**
 * Logging Middleware (Fixed Error Handling)
 * tRPC intercepts procedure errors, so we must check `result.ok` 
 * instead of relying on a try/catch block.
 */
export const loggedMiddlewareHandler = async ({ ctx, path, type, next }: any) => {
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
    const isClientError = [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'TIMEOUT',
      'CONFLICT',
      'CLIENT_CLOSED_REQUEST',
      'PRECONDITION_FAILED',
      'PAYLOAD_TOO_LARGE',
      'METHOD_NOT_SUPPORTED',
      'UNPROCESSABLE_CONTENT',
      'TOO_MANY_REQUESTS',
    ].includes(result.error.code);

    const logPayload = {
      type: 'trpc_request_error',
      path,
      requestType: type,
      userId: ctx.user?.id,
      error: result.error.message,
      code: result.error.code,
      duration,
    };

    if (isClientError) {
      logger.warn(logPayload);
    } else {
      logger.error(logPayload);
    }
  }

  return result;
};

export const logged = middleware(loggedMiddlewareHandler);

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
export const rateLimited = (
  action: string,
  maxRequests?: number,
  opts?: { window?: number; identifier?: (ctx: { req: { ip: string } }) => string },
) =>
  middleware(async ({ ctx, next }) => {
    // For public (unauthenticated) procedures pass opts.identifier to use
    // ctx.req.ip explicitly. Authenticated procedures fall back to user ID.
    const identifier = opts?.identifier
      ? opts.identifier(ctx)
      : ctx.user?.id || ctx.req.ip || 'anonymous';
    const windowSeconds = opts?.window ?? 900;

    try {
      await rateLimiter.checkOrThrow(identifier, action, maxRequests ?? 100, windowSeconds);
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

// ============================================================================
// Organization Member Role Middlewares
// ============================================================================

/**
 * Verifies the authenticated user holds an active OrganizationMember row for
 * their own organization (ctx.user.organizationId). Attaches the membership
 * record to ctx.orgMember for downstream role checks.
 *
 * Use as: protectedProcedure.use(requireOrgMember)
 * Must run AFTER isAuthenticated.
 */
export const requireOrgMember = middleware(async ({ ctx, next }) => {
  const userId = ctx.user!.id;
  const orgId = ctx.user!.organizationId;

  if (!orgId) {
    logger.warn({
      type: 'compliance_dashboard.access_denied',
      userId,
      organizationId: null,
      reason: 'no_organization',
    });
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not belong to an organization.' });
  }

  const member = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
  });

  if (!member) {
    logger.warn({
      type: 'compliance_dashboard.access_denied',
      userId,
      organizationId: orgId,
      reason: 'no_membership',
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: sanitizeErrorMessage(new Error('You do not have access to this organization.')),
    });
  }

  if (member.status !== MemberStatus.ACTIVE) {
    logger.warn({
      type: 'compliance_dashboard.access_denied',
      userId,
      organizationId: orgId,
      reason: `member_status_${member.status.toLowerCase()}`,
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: sanitizeErrorMessage(new Error('Your membership in this organization is not active.')),
    });
  }

  return next({ ctx: { ...ctx, orgMember: member } });
});

/**
 * Factory that returns a middleware enforcing a minimum MemberRole level.
 * Must run AFTER requireOrgMember (relies on ctx.orgMember being present).
 *
 * Role hierarchy (ascending access): VIEWER < MEMBER < ADMIN < OWNER
 *
 * Usage: .use(requireOrgMember).use(requireMemberRole([MemberRole.MEMBER, MemberRole.ADMIN, MemberRole.OWNER]))
 */
const ROLE_LEVEL: Record<MemberRole, number> = {
  [MemberRole.VIEWER]: 0,
  [MemberRole.MEMBER]: 1,
  [MemberRole.ADMIN]:  2,
  [MemberRole.OWNER]:  3,
};

export const requireMemberRole = (allowedRoles: MemberRole[]) =>
  middleware(async ({ ctx, next }) => {
    const orgMember = ctx.orgMember;

    if (!orgMember) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization membership not resolved.' });
    }

    const minAllowedLevel = Math.min(...allowedRoles.map((r) => ROLE_LEVEL[r]));
    const userLevel = ROLE_LEVEL[orgMember.role] ?? 0;

    if (userLevel < minAllowedLevel) {
      logger.warn({
        type: 'compliance_dashboard.access_denied',
        userId: ctx.user!.id,
        organizationId: orgMember.organizationId,
        reason: 'insufficient_role',
        userRole: orgMember.role,
        requiredMinLevel: minAllowedLevel,
      });
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: sanitizeErrorMessage(new Error('Insufficient permissions for this action.')),
      });
    }

    return next({ ctx });
  });

/**
 * Verifies the authenticated user holds an ACTIVE OrganizationMember row for
 * their session-scoped organization (ctx.user.organizationId). Attaches the
 * membership record to ctx.orgMembership for downstream handlers and role checks.
 *
 * Distinct from requireOrgMember in that it:
 *   - Caches the DB check in Redis with a 60-second TTL
 *   - Rate-limits repeated authorization denials (10 per 60s, fail-closed)
 *   - Uses structured authorization event logging
 *   - Writes every denial and grant to AuditLog (100%)
 *   - Attaches ctx.orgMembership typed as OrgMembershipEntry
 *
 * Security: failures always throw FORBIDDEN, never NOT_FOUND, so callers
 * cannot determine whether an org exists via error code differences.
 *
 * Must run AFTER isAuthenticated.
 */
export const requireOrgMembership = middleware(async ({ ctx, next }) => {
  const userId         = ctx.user!.id;
  const organizationId = ctx.user!.organizationId;

  // Capture request metadata once for all audit writes below.
  const ipAddr = ctx.req.ip ?? (ctx.req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? null;
  const ua     = (ctx.req.headers['user-agent'] as string | undefined)?.substring(0, 500) ?? null;

  if (!organizationId) {
    logger.warn({ type: 'authorization.denied', userId, organizationId: null, reason: 'no_organization' });
    void prisma.auditLog.create({
      data: {
        userId,
        action:     'authorization.denied',
        entityType: 'Organization',
        metadata:   { reason: 'no_organization' },
        ipAddress:  ipAddr,
        userAgent:  ua,
      },
    }).catch(() => {});
    throw new TRPCError({
      code:    'FORBIDDEN',
      message: 'You do not belong to an organization.',
    });
  }

  const cacheKey = `sheriabot:orgmem:${userId}:${organizationId}`;

  let entry: OrgMembershipEntry | null = null;

  try {
    const raw = await redis.get<OrgMembershipEntry>(cacheKey);
    if (raw && typeof raw === 'object' && 'status' in raw) {
      entry = raw;
    }
  } catch {
    // Cache miss or parse error -- fall through to DB
  }

  if (!entry) {
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { userId: true, organizationId: true, role: true, status: true },
    });

    if (member) {
      entry = member;
      if (member.status === MemberStatus.ACTIVE) {
        await redis.set(cacheKey, JSON.stringify(member), { ex: 60 }).catch(() => {});
      }
    }
  }

  if (!entry || entry.status !== MemberStatus.ACTIVE) {
    // Denial rate limiting: throttle org-probing attempts
    const rlResult = await rateLimiter.check(userId, 'auth_denial', 10, 60, { failClosed: true });

    if (!rlResult.allowed) {
      const reason = 'denial_rate_limit_exceeded';
      logger.warn({ type: 'authorization.denied', userId, organizationId, reason });
      void prisma.auditLog.create({
        data: {
          userId,
          action:     'authorization.denied',
          entityType: 'Organization',
          entityId:   organizationId,
          metadata:   { reason },
          ipAddress:  ipAddr,
          userAgent:  ua,
        },
      }).catch(() => {});
      throw new TRPCError({
        code:    'TOO_MANY_REQUESTS',
        message: 'Too many authorization failures. Please try again later.',
      });
    }

    const reason = !entry ? 'no_membership' : `member_status_${entry.status.toLowerCase()}`;
    logger.warn({ type: 'authorization.denied', userId, organizationId, reason });
    void prisma.auditLog.create({
      data: {
        userId,
        action:     'authorization.denied',
        entityType: 'Organization',
        entityId:   organizationId,
        metadata:   { reason },
        ipAddress:  ipAddr,
        userAgent:  ua,
      },
    }).catch(() => {});

    throw new TRPCError({
      code:    'FORBIDDEN',
      message: 'You do not have access to this organization.',
    });
  }

  logger.info({ type: 'authorization.granted', userId, organizationId, role: entry.role });
  void prisma.auditLog.create({
    data: {
      userId,
      action:     'authorization.granted',
      entityType: 'Organization',
      entityId:   organizationId,
      metadata:   { role: entry.role },
      ipAddress:  ipAddr,
      userAgent:  ua,
    },
  }).catch(() => {});

  return next({ ctx: { ...ctx, orgMembership: entry } });
});

/**
 * Factory that enforces a minimum MemberRole level on the org membership
 * resolved by requireOrgMembership. Must run AFTER requireOrgMembership.
 *
 * Role hierarchy (ascending access): VIEWER < MEMBER < ADMIN < OWNER
 *
 * Usage: orgMemberProcedure.use(requireOrgMembershipRole([MemberRole.ADMIN, MemberRole.OWNER]))
 */
export const requireOrgMembershipRole = (allowedRoles: MemberRole[]) =>
  middleware(async ({ ctx, next }) => {
    const membership = ctx.orgMembership;

    if (!membership) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization membership not resolved.' });
    }

    const minAllowedLevel = Math.min(...allowedRoles.map((r) => ROLE_LEVEL[r]));
    const userLevel       = ROLE_LEVEL[membership.role] ?? 0;

    if (userLevel < minAllowedLevel) {
      logger.warn({
        type:              'authorization.denied',
        userId:            ctx.user!.id,
        organizationId:    membership.organizationId,
        reason:            'insufficient_role',
        userRole:          membership.role,
        requiredMinLevel:  minAllowedLevel,
      });
      throw new TRPCError({
        code:    'FORBIDDEN',
        message: sanitizeErrorMessage(new Error('Insufficient permissions for this action.')),
      });
    }

    return next({ ctx });
  });

// ============================================================================
// Plan-Aware Middleware
// ============================================================================

/** TTL for usage counters in Redis: 35 days (covers billing cycle edge cases) */
const USAGE_TTL = 35 * 24 * 60 * 60;

/**
 * Resolves the effective plan for a request, with this priority:
 *
 *  1. Pilot active                              -> ENTERPRISE
 *  2. Active paid subscription                  -> orgPlan (STARTUP/BUSINESS/ENTERPRISE)
 *  3. Grace period active                       -> orgPlan (retain access until window closes)
 *  4. Free trial active (expiresAt > now)       -> 'FREE_TRIAL'
 *  5. Fallback                                  -> REGULATOR
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

  const resolved = await resolveEffectivePlan({
    userId: ctx.user.id,
    organizationId: ctx.user.organizationId ?? null,
    userEmail: ctx.user.email,
    prisma,
    redis,
  });

  const customLimits = typeof resolved.customLimits === 'object' && !Array.isArray(resolved.customLimits)
    ? resolved.customLimits as Record<string, unknown> | null
    : null;
  const entitlements = resolved.entitlements;

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      plan: resolved.plan,
      effectivePlanSource: resolved.source,
      entitlementProfile: resolved.entitlementProfile,
      entitlements,
      appliedPlanOverrides: resolved.appliedOverrides,
      pilotState: resolved.pilotState
        ? {
            status: resolved.pilotState.status ?? 'ACTIVE',
            entitlementProfile: resolved.pilotState.entitlementProfile ?? resolved.entitlementProfile ?? 'PILOT_FULL',
            expiresAt: resolved.pilotState.expiresAt,
            extensionCount: resolved.pilotState.extensionCount ?? 0,
          }
        : null,
      customLimits,
      trialState: resolved.trialState,
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
    if (ctx.entitlements) {
      requireEntitlementFeature(ctx.entitlements, feature);
    } else {
      requireFeature(plan, feature); // throws TRPCError FORBIDDEN if not allowed
    }
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
 *   FORBIDDEN          -  feature is not included in the plan at all (limit === 0)
 *   TOO_MANY_REQUESTS  -  feature is included but the quota is exhausted
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
export interface UsageLimitOptions {
  deferIncrement?: boolean;
}

export interface UsageLimitPatch {
  user: User;
  usageInfo: { metric: BillingMetric; current: number; limit: number };
  incrementUsage?: () => Promise<void>;
}

/**
 * Enforce and optionally consume a feature quota for an already-authenticated
 * request. Routers that must authorize domain scope before quota consumption
 * can call this helper after their feature-specific authorization succeeds.
 */
export async function resolveUsageLimit(
  ctx: Context,
  metric: BillingMetric,
  opts?: UsageLimitOptions,
): Promise<UsageLimitPatch> {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
  }
  const user = ctx.user;
  const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;

  // -- FREE_TRIAL branch --------------------------------------------------
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

      // Atomic pre-handler consumption closes the check-then-increment race:
      // if a parallel request wins the final slot, this request is blocked
      // before the procedure handler runs.
      const featureIncrement = await incrementTrialUsageAtomic(user.id, trialFeature, 1);
      if (!featureIncrement.allowed) {
        logger.warn({
          type:    'trial_limit_reached_atomic',
          userId:  user.id,
          feature: trialFeature,
          current: featureIncrement.newCount,
          limit:   featureIncrement.limit,
        });
        throw new TRPCError({
          code:    'FORBIDDEN',
          message: `Trial limit reached for this feature (${featureIncrement.newCount}/${featureIncrement.limit}). Upgrade to continue.`,
        });
      }

      return {
        user,
        usageInfo: { metric, current: featureIncrement.newCount, limit: featureIncrement.limit },
        incrementUsage: async () => {},
      };
    }

    // Metric has no trial cap (e.g. API_CALLS, POLICY_GENERATIONS are not trial features)
    return {
      user,
      usageInfo: { metric, current: 0, limit: FREE_TRIAL_LIMITS.complianceQueries },
    };
  }

  // -- Standard Redis monthly / lifetime quota path (paid plans + REGULATOR) -
  const featureKey = METRIC_FEATURE_MAP[metric];
  const { limit, period } = ctx.entitlements
    ? getQuotaFromEntitlements(ctx.entitlements, featureKey)
    : getQuota(plan, featureKey);

  // Unlimited: skip all Redis I/O
  if (limit === -1) {
    return { user, usageInfo: { metric, current: -1, limit: -1 } };
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

  // Read current count for user-facing diagnostics. Enforcement happens at
  // increment time below so concurrent requests cannot all pass this precheck.
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
    if (newCount > limit) {
      await redis.decr(usageKey);

      logger.warn({
        type:    'usage_limit_reached_atomic',
        userId:  user.id,
        orgId:   scopeId,
        metric,
        attempted: newCount,
        limit,
        period,
        plan,
      });

      const limitLabel = period === 'lifetime' ? 'Lifetime' : 'Monthly';
      throw new TRPCError({
        code:    'TOO_MANY_REQUESTS',
        message: `${limitLabel} limit reached (${limit}/${limit}). Upgrade your plan for more.`,
      });
    }

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
    return {
      user,
      usageInfo: { metric, current, limit },
      incrementUsage: doIncrement,
    };
  }

  // Default (eager) path: increment now, before the handler runs.
  await doIncrement();

  return { user, usageInfo: { metric, current: current + 1, limit } };
}

export const checkUsageLimit = (
  metric:  BillingMetric,
  opts?:   UsageLimitOptions,
) =>
  middleware(async ({ ctx, next }) => {
    const usagePatch = await resolveUsageLimit(ctx, metric, opts);
    return next({
      ctx: {
        ...ctx,
        ...usagePatch,
      },
    });
  });

// ============================================================================
// Agent Machine Identity Middleware
// ============================================================================

function getAgentCredentialHeaderValue(rawHeader: string | string[] | undefined): string | null {
  if (Array.isArray(rawHeader)) return rawHeader[0] ?? null;
  return rawHeader ?? null;
}

function agentRequestMetadata(ctx: { req: { ip?: string; headers: Record<string, string | string[] | undefined> } }): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: ctx.req.ip ?? null,
    userAgent: (ctx.req.headers['user-agent'] as string | undefined)?.substring(0, 500) ?? null,
  };
}

function auditAgentAuthorization(args: {
  userId?: string | null;
  action: 'authorization.granted' | 'authorization.denied';
  capability: string;
  reason?: string;
  ipAddress: string | null;
  userAgent: string | null;
}): void {
  void prisma.auditLog.create({
    data: {
      userId: args.userId ?? null,
      action: args.action,
      entityType: 'AgentCredential',
      metadata: {
        capability: args.capability,
        reason: args.reason ?? null,
      },
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    },
  }).catch((error: unknown) => {
    logger.error({
      type: 'agent_authorization_audit_failed',
      action: args.action,
      capability: args.capability,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export const requireAgentCapability = (capability: string) =>
  middleware(async ({ ctx, next }) => {
    const requestMetadata = agentRequestMetadata(ctx);
    const identifier = hashIp(ctx.req.ip);
    const rateLimit = await rateLimiter.check(identifier, 'agent-auth', 20, 60, { failClosed: true });

    if (!rateLimit.allowed) {
      logger.warn({ type: 'agent_auth_rate_limited', capability, reason: rateLimit.reason ?? 'rate_limit_exceeded' });
      auditAgentAuthorization({
        action: 'authorization.denied',
        capability,
        reason: rateLimit.reason ?? 'rate_limit_exceeded',
        ...requestMetadata,
      });
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many agent authentication attempts.' });
    }

    const credential = getAgentCredentialHeaderValue(ctx.req.headers[AGENT_CREDENTIAL_HEADER]);
    let agentIdentity: Awaited<ReturnType<typeof agentCredentialService.verifyCredential>>;

    try {
      agentIdentity = await agentCredentialService.verifyCredential(credential);
    } catch (error: unknown) {
      const reason = error instanceof AgentCredentialError ? error.reason : 'service_unavailable';
      logger.warn({ type: 'agent_auth_attempt', capability, success: false, reason });
      auditAgentAuthorization({
        action: 'authorization.denied',
        capability,
        reason,
        ...requestMetadata,
      });
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid agent credential.' });
    }

    if (!isAgentCapability(capability) || !agentIdentity.capabilities.includes(capability)) {
      logger.warn({ type: 'authorization.denied', userId: agentIdentity.userId, capability, reason: 'capability_not_allowed' });
      auditAgentAuthorization({
        userId: agentIdentity.userId,
        action: 'authorization.denied',
        capability,
        reason: 'capability_not_allowed',
        ...requestMetadata,
      });
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Agent capability not allowed.' });
    }

    logger.info({ type: 'agent_auth_attempt', userId: agentIdentity.userId, capability, success: true });
    auditAgentAuthorization({
      userId: agentIdentity.userId,
      action: 'authorization.granted',
      capability,
      ...requestMetadata,
    });

    return next({ ctx: { ...ctx, agent: agentIdentity } });
  });
