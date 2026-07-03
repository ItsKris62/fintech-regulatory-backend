import { describe, expect, it, vi } from 'vitest';
import { ProductBiMetricsComputationService } from './metrics-computation.service';

function prismaStub(overrides: Record<string, unknown> = {}) {
  return {
    organization: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentRun: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    usagePeriod: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

describe('ProductBiMetricsComputationService', () => {
  it('aggregates organization counts by plan and subscription status', async () => {
    const prisma = prismaStub({
      organization: {
        groupBy: vi.fn().mockResolvedValue([
          { plan: 'STARTUP', subscriptionStatus: 'ACTIVE', _count: { _all: 12 } },
          { plan: 'BUSINESS', subscriptionStatus: 'ACTIVE', _count: { _all: 3 } },
        ]),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new ProductBiMetricsComputationService({
      prisma: prisma as never,
      postHogQueryClient: { runHogQLQuery: vi.fn().mockResolvedValue({ available: false, reason: 'posthog_not_configured' }) } as never,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    const snapshot = await service.computeSnapshot({ windowDays: 7 });

    expect(snapshot.organizationCountsByPlan).toEqual([
      { plan: 'STARTUP', subscriptionStatus: 'ACTIVE', count: 12 },
      { plan: 'BUSINESS', subscriptionStatus: 'ACTIVE', count: 3 },
    ]);
  });

  it('merges agentRun totals and per-status counts into workforce costs by agentType', async () => {
    const prisma = prismaStub({
      agentRun: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([
            { agentType: 'sales-growth', _sum: { costUsd: { toString: () => '1.5' }, inputTokens: 100, outputTokens: 50 }, _count: { _all: 3 } },
          ])
          .mockResolvedValueOnce([
            { agentType: 'sales-growth', status: 'COMPLETED', _count: { _all: 2 } },
            { agentType: 'sales-growth', status: 'FAILED', _count: { _all: 1 } },
          ]),
      },
    });
    const service = new ProductBiMetricsComputationService({
      prisma: prisma as never,
      postHogQueryClient: { runHogQLQuery: vi.fn().mockResolvedValue({ available: false, reason: 'posthog_not_configured' }) } as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 7 });

    expect(snapshot.workforceCosts).toEqual([
      {
        agentType: 'sales-growth',
        totalCostUsd: 1.5,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        runCount: 3,
        completedCount: 2,
        failedCount: 1,
        haltedBudgetCount: 0,
        haltedIterationsCount: 0,
      },
    ]);
  });

  it('flags a STARTUP org as an upgrade-moment candidate only after repeated periods at the checklist cap', async () => {
    const prisma = prismaStub({
      usagePeriod: {
        findMany: vi.fn().mockResolvedValue([
          { organizationId: 'org-1', periodStart: new Date('2026-06-01'), checklistGenerations: 5, checklistGenerationLimit: 5, organization: { name: 'Acme Fintech' } },
          { organizationId: 'org-1', periodStart: new Date('2026-05-01'), checklistGenerations: 5, checklistGenerationLimit: 5, organization: { name: 'Acme Fintech' } },
          { organizationId: 'org-1', periodStart: new Date('2026-04-01'), checklistGenerations: 2, checklistGenerationLimit: 5, organization: { name: 'Acme Fintech' } },
          { organizationId: 'org-2', periodStart: new Date('2026-06-01'), checklistGenerations: 1, checklistGenerationLimit: 5, organization: { name: 'Beta Co' } },
        ]),
      },
    });
    const service = new ProductBiMetricsComputationService({
      prisma: prisma as never,
      postHogQueryClient: { runHogQLQuery: vi.fn().mockResolvedValue({ available: false, reason: 'posthog_not_configured' }) } as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 7 });

    expect(snapshot.upgradeMomentCandidates).toEqual([
      {
        organizationId: 'org-1',
        organizationName: 'Acme Fintech',
        plan: 'STARTUP',
        metric: 'checklistGenerations',
        periodsAtOrOverLimit: 2,
        latestPeriodStart: new Date('2026-06-01').toISOString(),
        latestUsage: 5,
        latestLimit: 5,
      },
    ]);
  });

  it('degrades engagement to unavailable when PostHog is not configured, without failing the snapshot', async () => {
    const service = new ProductBiMetricsComputationService({
      prisma: prismaStub() as never,
      postHogQueryClient: { runHogQLQuery: vi.fn().mockResolvedValue({ available: false, reason: 'posthog_not_configured' }) } as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 7 });

    expect(snapshot.engagement).toEqual({ available: false, reason: 'posthog_not_configured' });
  });

  it('never populates upgradeMomentCandidates or churnRiskOrgs with a contact email or personal name field', async () => {
    const prisma = prismaStub({
      usagePeriod: {
        findMany: vi.fn().mockResolvedValue([
          { organizationId: 'org-1', periodStart: new Date('2026-06-01'), checklistGenerations: 5, checklistGenerationLimit: 5, organization: { name: 'Acme Fintech' } },
          { organizationId: 'org-1', periodStart: new Date('2026-05-01'), checklistGenerations: 5, checklistGenerationLimit: 5, organization: { name: 'Acme Fintech' } },
        ]),
      },
      organization: {
        groupBy: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockResolvedValue([
          { id: 'org-2', name: 'Beta Co', subscriptionStatus: 'PAST_DUE', mpesaFailedRenewalAttempts: 0 },
        ]),
      },
    });
    const service = new ProductBiMetricsComputationService({
      prisma: prisma as never,
      postHogQueryClient: { runHogQLQuery: vi.fn().mockResolvedValue({ available: false, reason: 'posthog_not_configured' }) } as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 7 });
    const serialized = JSON.stringify([snapshot.upgradeMomentCandidates, snapshot.churnRiskOrgs]);

    expect(serialized).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    expect(serialized).not.toMatch(/contactEmail|contactPerson|fullName/i);
  });
});
