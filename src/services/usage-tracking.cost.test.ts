import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usageTrackingService } from './usage-tracking.service';
import { prisma } from '@/lib/prisma/client';
import { BillingMetric } from '@prisma/client';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    usageRecord: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    usagePeriod: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    incrbyfloat: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('UsageTrackingService Tenant Cost Aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates tenant costs in USD and KES correctly across multiple metrics', async () => {
    vi.mocked(prisma.usageRecord.findMany).mockResolvedValueOnce([
      {
        id: 'rec-1',
        organizationId: 'org-test-1',
        metric: BillingMetric.COMPLIANCE_QUERIES,
        count: 10,
        costUsd: 0.05 as any,
        costKes: 6.50 as any,
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-09-30T23:59:59Z'),
        fxRateUsdToKes: 130.0 as any,
        fxRateCapturedAt: new Date(),
        pricingVersion: '2026.09.v1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'rec-2',
        organizationId: 'org-test-1',
        metric: BillingMetric.POLICY_GENERATIONS,
        count: 2,
        costUsd: 0.20 as any,
        costKes: 26.00 as any,
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-09-30T23:59:59Z'),
        fxRateUsdToKes: 130.0 as any,
        fxRateCapturedAt: new Date(),
        pricingVersion: '2026.09.v1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const summary = await usageTrackingService.getTenantCostSummary(
      'org-test-1',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T23:59:59Z')
    );

    expect(summary.totalCostUsd).toBe(0.25);
    expect(summary.totalCostKes).toBe(32.5);
    expect(summary.byMetric[BillingMetric.COMPLIANCE_QUERIES]).toEqual({
      count: 10,
      costUsd: 0.05,
      costKes: 6.50,
    });
    expect(summary.byMetric[BillingMetric.POLICY_GENERATIONS]).toEqual({
      count: 2,
      costUsd: 0.20,
      costKes: 26.00,
    });
  });
});
