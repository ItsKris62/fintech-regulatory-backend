import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orphanedCreditReconciliationService } from '@/services/orphaned-credit-reconciliation.service';
import { redis } from '@/lib/redis/client';
import { BillingMetric } from '@prisma/client';

const redisData = new Map<string, string>();

vi.mock('@/lib/redis/client', () => ({
  redis: {
    scan: vi.fn(async (cursor: number | string) => {
      if (cursor === '0' || cursor === 0) {
        const keys = Array.from(redisData.keys()).filter((k) => k.startsWith('sheriabot:reservation:'));
        return ['0', keys];
      }
      return ['0', []];
    }),
    get: vi.fn(async (key: string) => redisData.get(key) ?? null),
    set: vi.fn(async (key: string, val: string) => {
      redisData.set(key, val);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = redisData.delete(key);
      return existed ? 1 : 0;
    }),
    decrby: vi.fn(async (key: string, amount: number) => {
      const current = parseInt(redisData.get(key) ?? '0', 10);
      const next = current - amount;
      redisData.set(key, String(next));
      return next;
    }),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Orphaned Credit Reconciliation Cron (Phase 2 Deferred)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisData.clear();
  });

  it('detects stale un-settled reservations and rolls back quota counter', async () => {
    const orgId = 'org_test_orphan_1';
    const operationId = 'op_orphan_abandoned_123';
    const periodKey = '2026-09';
    const usageKey = `sheriabot:usage:${orgId}:${BillingMetric.COMPLIANCE_QUERIES}:${periodKey}`;
    const reservationKey = `sheriabot:reservation:${orgId}:${operationId}`;

    // Usage counter is currently at 5 units
    redisData.set(usageKey, '5');

    // Stale reservation created 20 minutes ago (threshold is 15 minutes)
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    redisData.set(
      reservationKey,
      JSON.stringify({
        reservationId: 'res_12345',
        orgId,
        operationId,
        metric: BillingMetric.COMPLIANCE_QUERIES,
        units: 2,
        periodKey,
        createdAt: twentyMinsAgo,
      })
    );

    const result = await orphanedCreditReconciliationService.reconcileOrphanedCredits({
      staleThresholdMs: 15 * 60 * 1000,
    });

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.refundedUnits).toBe(2);

    // Counter was decremented by 2 units (from 5 to 3)
    expect(redis.decrby).toHaveBeenCalledWith(usageKey, 2);
    expect(redisData.get(usageKey)).toBe('3');

    // Stale reservation key was removed
    expect(redis.del).toHaveBeenCalledWith(reservationKey);
    expect(redisData.has(reservationKey)).toBe(false);
  });

  it('ignores active non-stale reservations', async () => {
    const orgId = 'org_test_active';
    const operationId = 'op_in_flight_456';
    const periodKey = '2026-09';
    const usageKey = `sheriabot:usage:${orgId}:${BillingMetric.COMPLIANCE_QUERIES}:${periodKey}`;
    const reservationKey = `sheriabot:reservation:${orgId}:${operationId}`;

    redisData.set(usageKey, '10');

    // Active reservation created 2 minutes ago
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    redisData.set(
      reservationKey,
      JSON.stringify({
        reservationId: 'res_active_1',
        orgId,
        operationId,
        metric: BillingMetric.COMPLIANCE_QUERIES,
        units: 1,
        periodKey,
        createdAt: twoMinsAgo,
      })
    );

    const result = await orphanedCreditReconciliationService.reconcileOrphanedCredits({
      staleThresholdMs: 15 * 60 * 1000,
    });

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(result.refundedUnits).toBe(0);
    expect(redis.decrby).not.toHaveBeenCalled();
    expect(redisData.get(usageKey)).toBe('10');
    expect(redisData.has(reservationKey)).toBe(true);
  });
});
