import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AutomationMetricsService } from './metrics.service';
import type { SalesEngagementLookupService } from '@/modules/agents/sales/engagement-lookup.service';
import type { SentryQueryService } from '@/lib/sentry-query.service';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function buildService(overrides: {
  complianceQueryCounts?: number[];
  agentRunSpend?: string;
  organizations?: Array<{ id: string; name: string; subscriptionTier: string; contactEmail: string | null }>;
  engagementLookup?: SalesEngagementLookupService['lookup'];
  checkCriticalIssues?: SentryQueryService['checkCriticalIssues'];
} = {}) {
  const countMock = vi.fn();
  (overrides.complianceQueryCounts ?? []).forEach((count) => countMock.mockResolvedValueOnce(count));

  const prisma = {
    complianceQuery: { count: countMock },
    agentRun: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal(overrides.agentRunSpend ?? '0') } }),
    },
    organization: {
      findMany: vi.fn().mockResolvedValue(overrides.organizations ?? []),
    },
  };

  const salesEngagementLookupService = {
    lookup: overrides.engagementLookup ?? vi.fn().mockResolvedValue({ available: false, reason: 'no_contact_email' }),
  } as unknown as SalesEngagementLookupService;

  const sentryQueryService = {
    checkCriticalIssues: overrides.checkCriticalIssues ?? vi.fn().mockResolvedValue({ hasCriticalIssue: false, dataAvailable: false }),
  } as unknown as SentryQueryService;

  return new AutomationMetricsService({
    prisma: prisma as never,
    salesEngagementLookupService,
    sentryQueryService,
    now: () => NOW,
  });
}

describe('AutomationMetricsService.getMetrics - department validation', () => {
  it('rejects an unsupported department rather than fabricating a shape', async () => {
    const service = buildService();
    await expect(service.getMetrics({ department: 'marketing', window: '1d' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a malformed window rather than silently defaulting', async () => {
    const service = buildService();
    await expect(service.getMetrics({ department: 'product', window: 'yesterday' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('AutomationMetricsService.getMetrics - product', () => {
  it('returns todays count and the 7-day daily-average baseline from real ComplianceQuery rows', async () => {
    const service = buildService({ complianceQueryCounts: [42, 140] });
    const result = await service.getMetrics({ department: 'product', window: '1d' });
    expect(result).toEqual({ queries: 42, baselineQueries: 20 });
  });
});

describe('AutomationMetricsService.getMetrics - sales', () => {
  it('requires detail=orgs - no other sales shape is defined', async () => {
    const service = buildService();
    await expect(service.getMetrics({ department: 'sales', window: '1d' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns real org fields plus honestly-empty topFeatures and a jurisdiction filter short-circuit', async () => {
    const service = buildService({
      organizations: [{ id: 'org_1', name: 'Acme Startup', subscriptionTier: 'starter', contactEmail: 'ops@acme.test' }],
      engagementLookup: vi.fn().mockResolvedValue({ available: true, lastSeenAt: '2026-07-21T00:00:00.000Z', eventCount7d: 25 }),
    });

    const result = await service.getMetrics({ department: 'sales', window: '1d', detail: 'orgs' });

    expect(result).toEqual({
      orgs: [{
        orgId: 'org_1',
        orgName: 'Acme Startup',
        tier: 'starter',
        usageIntensity: 0.5,
        jurisdiction: 'Kenya',
        topFeatures: [],
      }],
    });
  });

  it('short-circuits to an empty org list when the jurisdiction filter excludes Kenya, without querying', async () => {
    const findMany = vi.fn();
    const service = new AutomationMetricsService({
      prisma: { complianceQuery: { count: vi.fn() }, agentRun: { aggregate: vi.fn() }, organization: { findMany } } as never,
      now: () => NOW,
    });

    const result = await service.getMetrics({ department: 'sales', window: '1d', detail: 'orgs', jurisdictions: 'Nigeria,Ghana' });

    expect(result).toEqual({ orgs: [] });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('AutomationMetricsService.getMetrics - security', () => {
  it('computes aiSpendVsCeiling from real AgentRun spend and reports Sentry data as unavailable, not a fabricated false-negative, when the Sentry check cannot be trusted', async () => {
    const service = buildService({
      agentRunSpend: '10',
      checkCriticalIssues: vi.fn().mockResolvedValue({ hasCriticalIssue: false, dataAvailable: false }),
    });
    const result = await service.getMetrics({ department: 'security', window: '1d' });
    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: false, aiSpendVsCeiling: 0.5 });
  });

  it('passes through a confirmed critical issue from the Sentry check', async () => {
    const service = buildService({
      agentRunSpend: '10',
      checkCriticalIssues: vi.fn().mockResolvedValue({ hasCriticalIssue: true, dataAvailable: true }),
    });
    const result = await service.getMetrics({ department: 'security', window: '1d' });
    expect(result).toEqual({ hasCriticalIssue: true, dataAvailable: true, aiSpendVsCeiling: 0.5 });
  });

  it('passes through a confirmed-clean Sentry check', async () => {
    const service = buildService({
      agentRunSpend: '10',
      checkCriticalIssues: vi.fn().mockResolvedValue({ hasCriticalIssue: false, dataAvailable: true }),
    });
    const result = await service.getMetrics({ department: 'security', window: '1d' });
    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: true, aiSpendVsCeiling: 0.5 });
  });
});
