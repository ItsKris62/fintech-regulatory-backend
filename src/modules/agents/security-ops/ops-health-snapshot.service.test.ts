import { describe, expect, it, vi } from 'vitest';
import { OpsHealthSnapshotService } from './ops-health-snapshot.service';

function prismaStub(overrides: Record<string, unknown> = {}) {
  return {
    agentRun: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    ...overrides,
  };
}

function redisStub(overrides: Record<string, unknown> = {}) {
  return { ping: vi.fn().mockResolvedValue('PONG'), ...overrides };
}

function errorTrackerStub(overrides: Record<string, unknown> = {}) {
  return { getSummary: vi.fn().mockReturnValue({ totalUniqueErrors: 0, topErrors: [] }), ...overrides };
}

describe('OpsHealthSnapshotService', () => {
  it('merges agentRun totals and per-status counts into workforce costs by agentType', async () => {
    const prisma = prismaStub({
      agentRun: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([
            { agentType: 'product-bi', _sum: { costUsd: { toString: () => '2.0' }, inputTokens: 200, outputTokens: 100 }, _count: { _all: 4 } },
          ])
          .mockResolvedValueOnce([
            { agentType: 'product-bi', status: 'COMPLETED', _count: { _all: 3 } },
            { agentType: 'product-bi', status: 'HALTED_BUDGET', _count: { _all: 1 } },
          ]),
      },
    });
    const service = new OpsHealthSnapshotService({
      prisma: prisma as never,
      redis: redisStub() as never,
      errorTracker: errorTrackerStub() as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 1 });

    expect(snapshot.workforceCosts).toEqual([
      {
        agentType: 'product-bi',
        totalCostUsd: 2.0,
        totalInputTokens: 200,
        totalOutputTokens: 100,
        runCount: 4,
        completedCount: 3,
        failedCount: 0,
        haltedBudgetCount: 1,
        haltedIterationsCount: 0,
      },
    ]);
  });

  it('marks a service healthy with latency when its check succeeds', async () => {
    const service = new OpsHealthSnapshotService({
      prisma: prismaStub() as never,
      redis: redisStub() as never,
      errorTracker: errorTrackerStub() as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 1 });

    expect(snapshot.serviceHealth).toEqual([
      { service: 'database', status: 'healthy', latencyMs: expect.any(Number) },
      { service: 'redis', status: 'healthy', latencyMs: expect.any(Number) },
    ]);
  });

  it('marks a service down without a fabricated latency when its check throws', async () => {
    const prisma = prismaStub({ $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')) });
    const service = new OpsHealthSnapshotService({
      prisma: prisma as never,
      redis: redisStub({ ping: vi.fn().mockRejectedValue(new Error('timeout')) }) as never,
      errorTracker: errorTrackerStub() as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 1 });

    expect(snapshot.serviceHealth).toEqual([
      { service: 'database', status: 'down' },
      { service: 'redis', status: 'down' },
    ]);
  });

  it('applies a second sanitization pass to errorTracker messages: truncates and redacts email/phone-shaped text', async () => {
    const longMessage = `Payment failed for user jane.doe@acme.test, call +254 700 000 000 for support. ${'x'.repeat(150)}`;
    const service = new OpsHealthSnapshotService({
      prisma: prismaStub() as never,
      redis: redisStub() as never,
      errorTracker: errorTrackerStub({
        getSummary: vi.fn().mockReturnValue({
          totalUniqueErrors: 1,
          topErrors: [{ code: 'PAYMENT_ERROR', count: 5, message: longMessage, firstSeen: 0, lastSeen: 0 }],
        }),
      }) as never,
    });

    const snapshot = await service.computeSnapshot({ windowDays: 1 });

    expect(snapshot.errorSummary.topErrors).toHaveLength(1);
    const [sanitized] = snapshot.errorSummary.topErrors;
    expect(sanitized.code).toBe('PAYMENT_ERROR');
    expect(sanitized.count).toBe(5);
    expect(sanitized.message.length).toBeLessThanOrEqual(100);
    expect(sanitized.message).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    expect(sanitized.message).not.toContain('700 000 000');
  });
});
