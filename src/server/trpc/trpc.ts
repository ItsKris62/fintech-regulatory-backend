import { router, baseProcedure } from './init';
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

// Export router builder for use in your controllers
export { router }; 

// --- Core Procedures ---

/**
 * Public Procedure
 * Accessible by anyone, but still tracked by the logging middleware.
 */
export const publicProcedure = baseProcedure.use(logged);

/**
 * Protected Procedure
 * Requires a valid JWT. Guarantees `ctx.user` is present in downstream resolvers.
 */
export const protectedProcedure = publicProcedure.use(isAuthenticated);

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