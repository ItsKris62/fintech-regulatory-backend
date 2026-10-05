import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/system-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/system-config')>()),
  loadSystemConfig: vi.fn(async () => ({ maintenanceMode: false })),
}));

import { organizationRouter } from './organization.router';

function createContext(member: { status: string; role: string } | null) {
  const organizationFindUnique = vi.fn().mockResolvedValue({
    id: 'org-a',
    name: 'Organization A',
    plan: 'STARTER',
    requireMfa: false,
    mfaPolicyEnabledAt: null,
    mfaPolicyGraceHours: 48,
    mfaPolicyUpdatedBy: null,
  });
  const auditLogFindMany = vi.fn().mockResolvedValue([
    {
      id: 'audit-a',
      action: 'organization_security_policy_updated',
      entityType: 'Organization',
      entityId: 'org-a',
      metadata: { organizationId: 'org-a' },
      createdAt: new Date('2026-10-05T00:00:00.000Z'),
      user: { id: 'user-a', email: 'user-a@example.test', fullName: 'User A' },
    },
  ]);
  const memberFindFirst = vi.fn().mockResolvedValue(member);
  const memberFindMany = vi.fn().mockResolvedValue([
    {
      role: 'OWNER',
      status: 'ACTIVE',
      user: {
        id: 'user-a',
        email: 'user-a@example.test',
        fullName: 'User A',
        totpEnabled: true,
        lastLoginAt: null,
      },
    },
  ]);
  const ctx = {
    user: {
      id: 'user-a',
      email: 'user-a@example.test',
      role: 'STARTUP',
      organizationId: 'org-a',
      supabaseAuthId: 'supabase-user-a',
      totpEnabled: true,
    },
    prisma: { organization: { findUnique: organizationFindUnique }, auditLog: { findMany: auditLogFindMany } },
    tenantPrisma: {
      organizationMember: { findFirst: memberFindFirst, findMany: memberFindMany },
    },
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } },
    res: {},
  } as any;

  return { ctx, organizationFindUnique, auditLogFindMany, memberFindFirst, memberFindMany };
}

describe('organization.getSecurityCenter membership boundary', () => {
  it('returns the complete Security Center response for an active member', async () => {
    const { ctx, memberFindFirst } = createContext({ status: 'ACTIVE', role: 'OWNER' });

    const result = await organizationRouter.createCaller(ctx).getSecurityCenter();

    expect(memberFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user-a', organizationId: 'org-a' },
      select: { status: true, role: true },
    });
    expect(result).toMatchObject({
      posture: { totalMembers: 1, mfaEnabled: 1, mfaMissing: 0, percentage: 100 },
      currentUserMfaEnabled: true,
      members: [{ id: 'user-a', totpEnabled: true, status: 'ACTIVE' }],
    });
  });

  it.each([null, { status: 'SUSPENDED', role: 'MEMBER' }, { status: 'REMOVED', role: 'MEMBER' }])(
    'denies missing or inactive membership without querying organization data',
    async (member) => {
      const { ctx, organizationFindUnique, memberFindMany } = createContext(member);

      await expect(organizationRouter.createCaller(ctx).getSecurityCenter())
        .rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(organizationFindUnique).not.toHaveBeenCalled();
      expect(memberFindMany).not.toHaveBeenCalled();
    },
  );
});

describe('organization.getActivityLog membership boundary', () => {
  it('uses a flat tenant-scoped manager lookup before returning organization audit logs', async () => {
    const { ctx, auditLogFindMany, memberFindFirst } = createContext({ status: 'ACTIVE', role: 'ADMIN' });

    const result = await organizationRouter.createCaller(ctx).getActivityLog({ limit: 10 });

    expect(memberFindFirst).toHaveBeenCalledWith({
      where: { userId: 'user-a', organizationId: 'org-a' },
      select: { status: true, role: true },
    });
    expect(auditLogFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 10,
      where: {
        OR: [
          { entityType: 'Organization', entityId: 'org-a' },
          { metadata: { path: ['organizationId'], equals: 'org-a' } },
        ],
      },
    }));
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      id: 'audit-a',
      actor: { id: 'user-a', email: 'user-a@example.test', name: 'User A' },
      action: 'organization_security_policy_updated',
      target: 'Organization',
      targetId: 'org-a',
      result: 'SUCCESS',
    });
  });

  it('denies non-manager members before reading organization audit logs', async () => {
    const { ctx, auditLogFindMany } = createContext({ status: 'ACTIVE', role: 'MEMBER' });

    await expect(organizationRouter.createCaller(ctx).getActivityLog({ limit: 10 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auditLogFindMany).not.toHaveBeenCalled();
  });
});
