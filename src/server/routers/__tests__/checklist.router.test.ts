import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checklistRouter } from '../checklist.router';
import { prisma } from '@/lib/prisma/client';
import { resolveEffectivePlan } from '@/modules/billing/resolve-effective-plan';

vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn().mockResolvedValue({
    plan: undefined,
    source: 'FALLBACK',
    entitlements: {},
  }),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'member_1',
        organizationId: 'org_123',
        userId: 'user_123',
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: 'member_1',
        organizationId: 'org_123',
        userId: 'user_123',
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'org_123',
        name: 'Test Organization',
        status: 'ACTIVE',
      }),
    },
    subscription: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_1' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user_123',
        email: 'user@example.com',
        role: 'ADMIN',
        organizationId: 'org_123',
      }),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
}));

describe('checklistRouter explicit plan requirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws FORBIDDEN when ctx.plan is undefined in getChecklistUsage', async () => {
    vi.mocked(resolveEffectivePlan).mockResolvedValueOnce({
      plan: undefined,
      source: 'FALLBACK',
      entitlements: {} as any,
    } as any);

    const caller = checklistRouter.createCaller({
      user: {
        id: 'user_123',
        email: 'user@example.com',
        role: 'ADMIN',
        organizationId: 'org_123',
      } as any,
      orgMembership: {
        id: 'member_1',
        organizationId: 'org_123',
        userId: 'user_123',
        role: 'ADMIN',
        status: 'ACTIVE',
      } as any,
      plan: undefined as any,
      req: {
        ip: '127.0.0.1',
        headers: {},
      } as any,
      res: {} as any,
      prisma: prisma as any,
      storageService: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      mailer: {} as any,
    } as any);

    await expect(caller.getChecklistUsage()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your plan could not be resolved. Please contact support.',
    });
  });
});
