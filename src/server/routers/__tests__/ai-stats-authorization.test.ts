import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole, MemberStatus, SubscriptionPlan } from '@prisma/client';
import { TRPCError } from '@trpc/server';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    organization: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    usageRecord: {
      findMany: vi.fn(),
    },
    organizationMember: {
      findUnique: vi.fn(),
    },
    complianceQuery: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

import { appRouter } from '@/server/trpc/router';

vi.mock('@/lib/ai/gateway/llm-gateway', () => ({
  llmGateway: {
    getMonthlyBudgetStatus: vi.fn().mockResolvedValue({
      period: '2026-09',
      budgetUsd: 20,
      spentUsd: 5.5,
      reservedUsd: 0.5,
      remainingUsd: 14.0,
      percentUsed: 30,
      providers: { anthropic: 4.0, openai: 1.5, gemini: 0 },
    }),
  },
}));

vi.mock('@/lib/ai/gateway/fx.service', () => ({
  getUsdToKesFxRate: vi.fn().mockResolvedValue({
    rate: 130.0,
    source: 'redis_cache',
    capturedAt: new Date('2026-09-28T00:00:00Z'),
  }),
}));

vi.mock('@/lib/circuit-breaker/circuit-breaker.service', () => ({
  getCircuitBreakerMetrics: vi.fn().mockReturnValue([
    { provider: 'anthropic', state: 0, tripCount: 0, rejectionCount: 0 },
    { provider: 'openai', state: 0, tripCount: 0, rejectionCount: 0 },
  ]),
}));

vi.mock('@/services/usage-tracking.service', () => ({
  usageTrackingService: {
    getCurrentUsageSummary: vi.fn().mockResolvedValue({
      period: { start: new Date(), end: new Date(), daysRemaining: 15, daysTotal: 30 },
      planTier: 'STARTUP',
      categories: [],
    }),
    getTenantCostSummary: vi.fn().mockResolvedValue({
      totalCostUsd: 1.5,
      totalCostKes: 195.0,
      byMetric: {},
    }),
  },
}));

function createCaller(user: any) {
  return appRouter.createCaller({
    user,
    prisma: mockPrisma as any,
    tenantPrisma: mockPrisma as any,
    req: { ip: '127.0.0.1', headers: {} } as any,
    res: {} as any,
    session: null,
  } as any);
}

describe('AI Stats Authorization & Scoping Boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows platform admin to retrieve platform AI stats with USD and KES conversion', async () => {
    mockPrisma.usageRecord.findMany.mockResolvedValueOnce([
      {
        organizationId: 'org-1',
        metric: 'COMPLIANCE_QUERIES',
        count: 50,
        costUsd: 2.0,
        costKes: 260.0,
        organization: { id: 'org-1', name: 'Acme Corp', plan: 'ENTERPRISE' },
      },
    ]);

    const adminCaller = createCaller({
      id: 'admin-1',
      role: UserRole.ADMIN,
      organizationId: null,
      email: 'admin@sheriabot.com',
      totpEnabled: true,
    });

    const res = await adminCaller.admin.getAIPlatformStats();
    expect(res.budgetUsd.spentUsd).toBe(5.5);
    expect(res.budgetKes.spentKes).toBe(715.0); // 5.5 * 130
    expect(res.topTenants).toHaveLength(1);
    expect(res.topTenants[0].orgName).toBe('Acme Corp');
    expect(res.topTenants[0].costKes).toBe(260.0);
  });

  it('rejects regular tenant users from calling admin.getAIPlatformStats', async () => {
    const regularCaller = createCaller({
      id: 'user-1',
      role: UserRole.STARTUP,
      organizationId: 'org-1',
      email: 'user@startup.co.ke',
    });

    await expect(regularCaller.admin.getAIPlatformStats()).rejects.toThrow();
  });

  it('allows tenant org member to retrieve only their own org AI usage stats', async () => {
    mockPrisma.organizationMember.findUnique.mockResolvedValueOnce({
      status: MemberStatus.ACTIVE,
    });
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      id: 'org-1',
      name: 'My Org',
      plan: SubscriptionPlan.STARTUP,
    });
    mockPrisma.complianceQuery.count.mockResolvedValueOnce(5);
    mockPrisma.complianceQuery.findMany.mockResolvedValueOnce([
      {
        id: 'q-1',
        queryType: 'REGULATORY',
        jurisdiction: 'KE',
        status: 'COMPLETED',
        confidenceScore: 0.95,
        createdAt: new Date(),
      },
    ]);

    const tenantCaller = createCaller({
      id: 'user-1',
      role: UserRole.STARTUP,
      organizationId: 'org-1',
      email: 'user@startup.co.ke',
    });

    const stats = await tenantCaller.organization.getAIUsageStats();
    expect(stats.planTier).toBe('STARTUP');
    expect(stats.costs.totalCostKes).toBe(195.0);
    expect(stats.recentActivity.total).toBe(5);
    expect(stats.recentActivity.items[0].id).toBe('q-1');
  });

  it('rejects users without organizationId from calling org.getAIUsageStats', async () => {
    const unattachedCaller = createCaller({
      id: 'user-orphan',
      role: UserRole.STARTUP,
      organizationId: null,
      email: 'orphan@test.com',
    });

    await expect(unattachedCaller.organization.getAIUsageStats()).rejects.toThrow(TRPCError);
  });
});
