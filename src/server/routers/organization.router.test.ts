import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('Organization Router - getMembers role map', () => {
  const routerSrc = src('organization.router.ts');

  it('queries from organizationMember directly instead of user table', () => {
    expect(routerSrc).toContain('ctx.prisma.organizationMember.findMany');
    expect(routerSrc).toContain('ctx.prisma.organizationMember.count');
  });

  it('correctly aliases platformRole and maps the org role', () => {
    expect(routerSrc).toContain('platformRole: m.user.role');
    expect(routerSrc).toContain('orgRole: m.role');
    expect(routerSrc).toContain('joinedAt: m.joinedAt');
  });
});

describe('Business organization portal router contract', () => {
  const routerSrc = src('organization.router.ts');
  const contextSrc = src('../trpc/context.ts');
  const authSrc = src('auth.router.ts');

  it('returns real team overview data for members, invitations, seats, owner, and caller RBAC', () => {
    expect(routerSrc).toContain('getTeamOverview: protectedProcedure');
    expect(routerSrc).toContain('getSeatUsageForOrganization(ctx.prisma as any, organizationId)');
    expect(routerSrc).toContain('pendingInvitations.length');
    expect(routerSrc).toContain('owner: owner?.user ?? null');
    expect(routerSrc).toContain('canManageMembers: canManageOrganization');
    expect(routerSrc).toContain('totpEnabled: m.user.totpEnabled');
    expect(routerSrc).toContain('status: { not: MemberStatus.REMOVED }');
  });

  it('supports only backend-authorized member status transitions and invalidates revoked access', () => {
    expect(routerSrc).toContain('suspendMember: protectedProcedure');
    expect(routerSrc).toContain('reactivateMember: protectedProcedure');
    expect(routerSrc).toContain('Organization admins cannot suspend themselves');
    expect(routerSrc).toContain('revokeMemberAccess(ctx, input.userId, organizationId');
    expect(routerSrc).toContain("action: 'organization_member_suspended'");
    expect(routerSrc).toContain("action: 'organization_member_reactivated'");
  });

  it('prevents ownerless organizations on removal, suspension, and role-change attempts', () => {
    expect(routerSrc).toContain('async function assertNotLastActiveOwner');
    expect(routerSrc).toContain('role: MemberRole.OWNER');
    expect(routerSrc).toContain('status: MemberStatus.ACTIVE');
    expect(routerSrc).toContain('Cannot ${action} the last active organization owner');
    expect(routerSrc).toContain("assertNotLastActiveOwner(tx as any, organizationId, userId, 'remove')");
    expect(routerSrc).toContain("assertNotLastActiveOwner(tx as any, organizationId, input.userId, 'suspend')");
    expect(routerSrc).toContain("assertNotLastActiveOwner(ctx.prisma as any, callerOrgId, input.userId, 'demote')");
  });

  it('exposes MFA security posture and blocks impossible owner rollout', () => {
    expect(routerSrc).toContain('getSecurityCenter: protectedProcedure');
    expect(routerSrc).toContain('mfaEnabled: enabled');
    expect(routerSrc).toContain('mfaMissing: total - enabled');
    expect(routerSrc).toContain('percentage');
    expect(routerSrc).toContain('updateSecurityPolicy: protectedProcedure');
    expect(routerSrc).toContain('Enable two-factor authentication on your own account before requiring it for the organization.');
    expect(routerSrc).toContain("action: 'organization_security_policy_updated'");
    expect(contextSrc).toContain('totpEnabled?: boolean');
    expect(contextSrc).toContain('totpEnabled: dbUser.totpEnabled');
    expect(authSrc).toContain('requireMfa: true');
  });

  it('scopes organization activity log through organization entity or metadata organizationId', () => {
    expect(routerSrc).toContain('getActivityLog: protectedProcedure');
    expect(routerSrc).toContain('await assertOrganizationManager(ctx, organizationId)');
    expect(routerSrc).toContain("{ entityType: 'Organization', entityId: organizationId }");
    expect(routerSrc).toContain("metadata: { path: ['organizationId'], equals: organizationId }");
    expect(routerSrc).not.toContain('targetToken');
  });

  it('supports owner/admin home jurisdiction recovery through organization settings', () => {
    const schemaSrc = src('../schemas/organization.schema.ts');

    expect(schemaSrc).toContain('homeJurisdictionCode: homeJurisdictionCodeSchema.optional()');
    expect(routerSrc).toContain('homeJurisdictionCode: true');
    expect(routerSrc).toContain('canManageOrganizationSettings: canManageOrganization');
    expect(routerSrc).toContain("action: 'organization_home_jurisdiction_changed'");
    expect(routerSrc).toContain("source: 'organization.updateSettings'");
    expect(routerSrc).toContain('await assertOrganizationManager(ctx, organizationId)');
  });
});
