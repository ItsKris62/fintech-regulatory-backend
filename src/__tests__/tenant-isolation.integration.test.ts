import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checklistRouter } from '../server/routers/checklist.router';
import { MemberRole, MemberStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

const { mockRedis, mockPrisma, mockComplianceModule } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    },
    mockPrisma: {
      systemConfig: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org_a',
          name: 'Company A',
          plan: 'STARTER',
          subscriptionTier: 'starter',
          subscriptionStatus: 'ACTIVE',
        }),
      },
      organizationMember: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          const userId = where?.userId_organizationId?.userId || where?.userId;
          const organizationId = where?.userId_organizationId?.organizationId || where?.organizationId;
          if (userId === 'user_a' && organizationId === 'org_a') {
            return Promise.resolve({
              userId: 'user_a',
              organizationId: 'org_a',
              role: MemberRole.OWNER,
              status: MemberStatus.ACTIVE,
            });
          }
          return Promise.resolve(null);
        }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
    mockComplianceModule: {
      getUserChecklists: vi.fn(),
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  get: (...args: any[]) => mockRedis.get(...args),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/modules/compliance', () => ({
  complianceModule: mockComplianceModule,
}));

describe('Tenant Isolation Integration Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces organization scoping on checklist queries and prevents cross-tenant access', async () => {
    const userOrgA = {
      id: 'user_a',
      email: 'user_a@company-a.com',
      role: 'USER',
      organizationId: 'org_a',
      supabaseAuthId: 'supa_a',
      sessionId: 'sess_a',
    };

    mockComplianceModule.getUserChecklists.mockImplementation((_userId, orgId) => {
      if (orgId === 'org_a') {
        return Promise.resolve([
          { id: 'chk_a_1', title: 'Org A Checklist', organizationId: 'org_a' },
        ]);
      }
      return Promise.resolve([]);
    });

    const caller = checklistRouter.createCaller({
      user: userOrgA as any,
      prisma: mockPrisma as any,
      req: { ip: '127.0.0.1', headers: {} } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    // List checklists for Org A
    const result = await caller.getUserChecklists();
    expect(result).toHaveLength(1);
    expect((result[0] as any).organizationId).toBe('org_a');
    expect(mockComplianceModule.getUserChecklists).toHaveBeenCalledWith('user_a', 'org_a');
  });

  it('rejects access when user has no organizationId', async () => {
    const orphanedUser = {
      id: 'orphan_user',
      email: 'orphan@example.com',
      role: 'USER',
      organizationId: undefined,
      supabaseAuthId: 'supa_orphan',
      sessionId: 'sess_orphan',
    };

    const caller = checklistRouter.createCaller({
      user: orphanedUser as any,
      prisma: mockPrisma as any,
      req: { ip: '127.0.0.1', headers: {} } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    await expect(caller.getUserChecklists()).rejects.toThrow(TRPCError);
  });
});
