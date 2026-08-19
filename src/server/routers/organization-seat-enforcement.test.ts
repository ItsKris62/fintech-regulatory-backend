import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('active organization member flow map', () => {
  const rootRouter = src('../trpc/router.ts');
  const organizationRouter = src('organization.router.ts');
  const authRouter = src('auth.router.ts');
  const adminRouter = src('admin.router.ts');
  const legacyOrganizationModule = src('../../modules/organization/organization.module.ts');

  it('mounts organizationRouter as the active tRPC organization implementation', () => {
    expect(rootRouter).toContain("import { organizationRouter } from '../routers/organization.router';");
    expect(rootRouter).toMatch(/\borganization:\s*organizationRouter\b/);
    expect(rootRouter).not.toContain('organizationModule');
  });

  it('keeps the legacy Redis invitation module out of the active tRPC root router', () => {
    expect(legacyOrganizationModule).toContain('REDIS_KEYS.INVITATION');
    expect(legacyOrganizationModule).toContain('async acceptInvitation');
    expect(rootRouter).not.toContain("from '../modules/organization'");
    expect(rootRouter).not.toContain('acceptInvitation');
  });

  it('requires organization OWNER or ADMIN membership for active member management', () => {
    expect(organizationRouter).toContain('async function assertOrganizationManager');
    expect(organizationRouter).toContain('member.role !== MemberRole.OWNER && member.role !== MemberRole.ADMIN');

    for (const procedureName of ['addMember', 'removeMember', 'updateMemberRole']) {
      const start = organizationRouter.indexOf(`${procedureName}: protectedProcedure`);
      expect(start).toBeGreaterThan(-1);
      const body = organizationRouter.slice(start, start + 2200);
      expect(body).toContain('assertOrganizationManager');
    }
  });

  it('enforces server-side seat capacity on active direct member creation', () => {
    const start = organizationRouter.indexOf('addMember: protectedProcedure');
    const body = organizationRouter.slice(start, start + 4200);
    const seatService = src('../services/organization-invitation.service.ts');

    expect(body).toContain('assertOrganizationCanUseTeamSeats');
    expect(body).toContain('ctx.prisma.$transaction');
    expect(body).toContain('lockOrganizationSeatAllocation');
    expect(body).toContain('assertSeatCapacityLocked');
    expect(seatService).toContain('pg_advisory_xact_lock');
    expect(seatService).toContain('getSeatUsageForOrganization');
    expect(seatService).toContain('buildSeatLimitMessage');
  });

  it('updates OrganizationMember.role rather than global User.role in the active role update path', () => {
    const start = organizationRouter.indexOf('updateMemberRole: protectedProcedure');
    const body = organizationRouter.slice(start, start + 3600);

    expect(body).toContain('ctx.prisma.organizationMember.update');
    expect(body).toContain('data: { role: input.role as MemberRole }');
    expect(body).not.toContain('ctx.prisma.user.update');
  });

  it('invalidates org membership cache after active membership mutations', () => {
    for (const procedureName of ['addMember', 'updateMemberRole']) {
      const start = organizationRouter.indexOf(`${procedureName}: protectedProcedure`);
      const body = organizationRouter.slice(start, start + 3200);
      expect(body).toContain('redis.del(`sheriabot:orgmem:');
    }

    const removeStart = organizationRouter.indexOf('removeMember: protectedProcedure');
    const removeBody = organizationRouter.slice(removeStart, removeStart + 3600);
    expect(removeBody).toContain('revokeMemberAccess');
  });

  it('locks and re-checks seat capacity before DB invitation acceptance creates membership', () => {
    const checkStart = authRouter.indexOf('if (input.invitationToken)');
    const createStart = authRouter.indexOf('tx.organizationMember.upsert');
    const preCreate = authRouter.slice(checkStart, createStart);

    expect(checkStart).toBeGreaterThan(-1);
    expect(createStart).toBeGreaterThan(checkStart);
    expect(preCreate).toContain('lockOrganizationSeatAllocation');
    expect(preCreate).toContain('getSeatUsageForOrganization');
    expect(preCreate).toContain('usedSeatsAfterConsumingThisInvite');
    expect(preCreate).toContain("code: 'FORBIDDEN'");
    expect(preCreate).toContain('buildSeatLimitMessage');
  });

  it('invalidates org membership cache after invite acceptance', () => {
    const start = authRouter.indexOf('tx.organizationMember.upsert');
    const body = authRouter.slice(start, start + 1800);

    expect(authRouter).toContain('redis.del(`sheriabot:orgmem:${user.id}:${invitation.organizationId}`)');
    expect(body).toContain('tx.invitation.update');
    expect(body).toContain('used: true');
  });

  it('guards platform admin DB invitation creation with duplicate, locked seat checks, and token hashing', () => {
    const start = adminRouter.indexOf('createInvitation: adminProcedure');
    const body = adminRouter.slice(start, start + 3600);

    expect(body).toContain('findPendingOrganizationInvite');
    expect(body).toContain('lockOrganizationSeatAllocation');
    expect(body).toContain('assertSeatCapacityLocked');
    expect(body).toContain('hashInvitationToken(token)');
    expect(body).toContain('tx.invitation.create');
  });
});
