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
} from './middleware';
import { loadSystemConfig } from '@/lib/system-config';

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

/**
 * Protected Procedure
 * Requires a valid JWT. Guarantees ctx.user is User (non-null) in downstream handlers.
 */
export const protectedProcedure = publicProcedure.use(isAuthenticated).use(passwordChangeComplete).use(systemAvailable);

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
 * Factory: orgMemberProcedure + minimum role enforcement.
 * Role hierarchy (ascending): VIEWER < MEMBER < ADMIN < OWNER
 *
 * Usage: orgMemberProcedureWithRole([MemberRole.ADMIN, MemberRole.OWNER])
 */
export const orgMemberProcedureWithRole = (allowedRoles: MemberRole[]) =>
  orgMemberProcedure.use(requireOrgMembershipRole(allowedRoles));
