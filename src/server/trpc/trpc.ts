import { TRPCError } from '@trpc/server';
import { router, baseProcedure, middleware } from './init';
import { MemberRole } from '@prisma/client';
import {
  isAuthenticated,
  isAdmin,
  isRegulator,
  isStartup,
  isEnterprise,
  logged,
  requireOrgMembership,
  requireOrgMembershipRole,
  requireAgentCapability,
} from './middleware';
import { loadSystemConfig } from '@/lib/system-config';
import type { AgentCapability } from '@/modules/agents/agent-credential.service';
import { redis } from '@/lib/redis/client';
import { logSecurityEvent, SECURITY_EVENT_TYPES } from '@/server/services/audit.service';
import { userSatisfiesMfa } from '../lib/mfa-compliance';
import { getClientIp } from '@/server/lib/client-ip';
import { logger } from '@/utils/logger';

// Export router builder for use in your controllers
export { router };

// --- Core Procedures ---

/**
 * Public Procedure
 * Accessible by anyone, but still tracked by the logging middleware.
 */
export const publicProcedure = baseProcedure.use(logged);

/**
 * Maintenance-mode gate. Module-internal -- not exported.
 *
 * Calls next() with NO argument so the context type narrowed by isAuthenticated
 * (ctx.user: User, non-null) is preserved for downstream handlers.
 * Calling next({ ctx }) instead would reset ctx.user to User|null -- see
 * docs/architecture/data-model-invariants.md (tRPC v11 middleware composition).
 *
 * Admins bypass the gate so they can use the portal to disable maintenance mode.
 */
const systemAvailable = middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role === 'ADMIN') {
    return next();
  }
  const config = await loadSystemConfig();
  if (config.maintenanceMode) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: config.maintenanceMessage || 'The platform is temporarily in maintenance mode.',
    });
  }
  return next();
});

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  'auth.me',
  'auth.logout',
  'auth.changeTemporaryPassword',
]);

const passwordChangeComplete = middleware(async ({ ctx, path, next }) => {
  if (!ctx.user?.mustChangePassword || PASSWORD_CHANGE_ALLOWED_PATHS.has(path)) {
    return next();
  }

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Password change required before accessing SheriaBot.',
  });
});

export const MFA_ENROLLMENT_ALLOWED_PATHS = new Set([
  'auth.me',
  'auth.logout',
  'auth.getSessions',
  'auth.revokeSession',
  'auth.revokeAllSessions',
  'auth.revokeOtherSessions',
  'auth.changeTemporaryPassword',
  'user.getProfile',
  'user.getTotpStatus',
  'user.setupTotp',
  'user.confirmTotpSetup',
  'user.disableTotp',
  'user.getSessions',
  'organization.getOrganization',
  'organization.getTeamOverview',
  'organization.getSecurityCenter',
  'organization.getActivityLog',
  'billing.getCurrentPlan',
  'billing.getSubscription',
  'passkey.generateRegistrationOptions',
  'passkey.verifyRegistration',
  'passkey.listUserPasskeys',
  'passkey.renamePasskey',
  'passkey.deletePasskey',
]);

export function isPathAllowed(path: string): boolean {
  return MFA_ENROLLMENT_ALLOWED_PATHS.has(path);
}

export const organizationMfaEnforced = middleware(async ({ ctx, path, next }) => {
  const mfaCompliant = ctx.user ? userSatisfiesMfa(ctx.user) : false;
  if (!ctx.user || ctx.user.role === 'ADMIN' || mfaCompliant || isPathAllowed(path)) {
    return next();
  }

  if (ctx.user.organizationId) {
    const org = await ctx.prisma.organization.findUnique({
      where: { id: ctx.user.organizationId },
      select: {
        requireMfa: true,
        mfaPolicyEnabledAt: true,
        mfaPolicyFirstEnabledAt: true,
        mfaPolicyGraceHours: true,
      },
    });

    if (org?.requireMfa) {
      let firstEnabledAt = org.mfaPolicyFirstEnabledAt ?? org.mfaPolicyEnabledAt;
      let isLazyBackfill = false;

      if (!firstEnabledAt) {
        const now = new Date();
        firstEnabledAt = now;
        isLazyBackfill = true;
        try {
          const result = await ctx.prisma.organization.updateMany({
            where: { id: ctx.user.organizationId, mfaPolicyFirstEnabledAt: null },
            data: { mfaPolicyEnabledAt: org.mfaPolicyEnabledAt ?? now, mfaPolicyFirstEnabledAt: now },
          });

          if (result.count === 0) {
            // Another request won the race; re-read to get the persisted value.
            const refetched = await ctx.prisma.organization.findUnique({
              where: { id: ctx.user.organizationId },
              select: { mfaPolicyFirstEnabledAt: true, mfaPolicyEnabledAt: true },
            });
            firstEnabledAt = refetched?.mfaPolicyFirstEnabledAt ?? refetched?.mfaPolicyEnabledAt ?? now;
          }
        } catch (err) {
          logger.error({
            type: 'mfa_policy_backfill_failed',
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,
            error: err instanceof Error ? err.message : 'unknown',
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'MFA policy configuration could not be initialized. Please try again.',
          });
        }
      } else if (!org.mfaPolicyFirstEnabledAt && org.mfaPolicyEnabledAt) {
        try {
          const result = await ctx.prisma.organization.updateMany({
            where: { id: ctx.user.organizationId, mfaPolicyFirstEnabledAt: null },
            data: { mfaPolicyFirstEnabledAt: org.mfaPolicyEnabledAt },
          });

          if (result.count === 0) {
            const refetched = await ctx.prisma.organization.findUnique({
              where: { id: ctx.user.organizationId },
              select: { mfaPolicyFirstEnabledAt: true, mfaPolicyEnabledAt: true },
            });
            firstEnabledAt = refetched?.mfaPolicyFirstEnabledAt ?? refetched?.mfaPolicyEnabledAt ?? firstEnabledAt;
          }
        } catch (err) {
          logger.error({
            type: 'mfa_policy_backfill_failed',
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,
            error: err instanceof Error ? err.message : 'unknown',
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'MFA policy configuration could not be initialized. Please try again.',
          });
        }
      }

      const graceHours = org.mfaPolicyGraceHours ?? 48;
      const graceDeadlineMs = new Date(firstEnabledAt).getTime() + graceHours * 3600 * 1000;
      const nowMs = Date.now();

      if (nowMs < graceDeadlineMs) {
        // Within grace period: attach grace state and write throttled audit log
        const graceLogKey = `sheriabot:audit:mfa_grace:${ctx.user.id}`;
        const alreadyLogged = await redis.get(graceLogKey).catch(() => null);
        if (!alreadyLogged) {
          await redis.set(graceLogKey, '1', { ex: 3600 }).catch(() => {});
          await logSecurityEvent({
            eventType: SECURITY_EVENT_TYPES.MFA_ENFORCEMENT_GRACE,
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,
            ipAddress: getClientIp(ctx.req) ?? undefined,
            userAgent: ctx.req.headers['user-agent'],
            metadata: {
              graceDeadline: new Date(graceDeadlineMs).toISOString(),
              graceHours,
              ...(isLazyBackfill ? { reason: 'lazy_backfill' } : {}),
            },
          });
        }
        return next({
          ctx: {
            ...ctx,
            mfaEnforcement: {
              state: 'grace',
              deadline: new Date(graceDeadlineMs),
            },
          },
        });
      }

      // Past grace period: enforce block and log
      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.MFA_ENFORCEMENT_BLOCKED,
        userId: ctx.user.id,
        organizationId: ctx.user.organizationId,
        ipAddress: getClientIp(ctx.req) ?? undefined,
        userAgent: ctx.req.headers['user-agent'],
        metadata: {
          blockedPath: path,
        },
      });

      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'MFA_ENROLLMENT_REQUIRED',
      });
    }
  }

  return next();
});

/**
 * Protected Procedure
 * Requires a valid JWT. Guarantees ctx.user is User (non-null) in downstream handlers.
 */
export const protectedProcedure = publicProcedure
  .use(isAuthenticated)
  .use(passwordChangeComplete)
  .use(systemAvailable)
  .use(organizationMfaEnforced);

// --- Role-Specific Procedures ---

export const adminProcedure = protectedProcedure.use(isAdmin);
export const regulatorProcedure = protectedProcedure.use(isRegulator);
export const startupProcedure = protectedProcedure.use(isStartup);
export const enterpriseProcedure = protectedProcedure.use(isEnterprise);

// --- Organization-Member Procedures ---

/**
 * Requires an ACTIVE OrganizationMember row for ctx.user.organizationId.
 * Applies Redis caching (60s) and denial rate limiting.
 * Attaches ctx.orgMembership for downstream handlers.
 */
export const orgMemberProcedure = protectedProcedure.use(requireOrgMembership);

/**
 * Agent procedure.
 * Requires X-Agent-Credential machine authentication and an explicit capability.
 */
export const agentProcedure = (capability: AgentCapability) =>
  publicProcedure.use(requireAgentCapability(capability));

/**
 * Factory: orgMemberProcedure + minimum role enforcement.
 * Role hierarchy (ascending): VIEWER < MEMBER < ADMIN < OWNER
 *
 * Usage: orgMemberProcedureWithRole([MemberRole.ADMIN, MemberRole.OWNER])
 */
export const orgMemberProcedureWithRole = (allowedRoles: MemberRole[]) =>
  orgMemberProcedure.use(requireOrgMembershipRole(allowedRoles));
