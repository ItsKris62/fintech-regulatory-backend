import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAndPrepareUsage } from '../compliance-stream.route';

let redisCounter = 0;

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(async () => {
      // Simulate asynchronous Redis roundtrip
      await new Promise((resolve) => setTimeout(resolve, 5));
      return redisCounter;
    }),
    incrby: vi.fn(async (_key: string, amount: number) => {
      // Simulate atomic server-side Redis increment
      redisCounter += amount;
      return redisCounter;
    }),
    decrby: vi.fn(async (_key: string, amount: number) => {
      // Simulate atomic server-side Redis decrement
      redisCounter -= amount;
      return redisCounter;
    }),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {},
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {},
}));

vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn(),
  incrementTrialUsageAtomic: vi.fn(),
}));

describe('F-07: Streaming Quota TOCTOU Concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisCounter = 9; // Limit is 10, exactly 1 credit remaining
  });

  it('prevents TOCTOU race: N parallel stream requests against 1 remaining credit allow exactly one and return 429 for N-1', async () => {
    const mockAuth: any = {
      userId: 'user_123',
      organizationId: 'org_123',
      plan: 'STARTUP',
      effectivePlanSource: 'SUBSCRIPTION',
      entitlements: {
        complianceQueries: {
          limit: 10,
          period: 'monthly',
        },
      },
    };

    const N = 5;
    // Fire N concurrent usage checks simultaneously
    const results = await Promise.all(
      Array.from({ length: N }).map(() => checkAndPrepareUsage(mockAuth, 1))
    );

    const allowedRequests = results.filter((r) => r.allowed);
    const rejectedRequests = results.filter((r) => !r.allowed && r.statusCode === 429);

    // TOCTOU failure assertion: in vulnerable check-then-act, multiple or all requests succeed
    expect(allowedRequests).toHaveLength(1);
    expect(rejectedRequests).toHaveLength(N - 1);

    // If allowed requests execute their stream, counter must be exactly at the limit (10)
    for (const req of allowedRequests) {
      await req.increment();
    }

    expect(redisCounter).toBe(10);
  });

  it('decrements pre-allocated credit on mid-stream failure when using release', async () => {
    const mockAuth: any = {
      userId: 'user_123',
      organizationId: 'org_123',
      plan: 'STARTUP',
      effectivePlanSource: 'SUBSCRIPTION',
      entitlements: {
        complianceQueries: {
          limit: 10,
          period: 'monthly',
        },
      },
    };

    // Exactly 1 credit left (9 / 10 used)
    redisCounter = 9;

    const usage = await checkAndPrepareUsage(mockAuth, 1);
    expect(usage.allowed).toBe(true);

    // After pre-allocation, counter should be 10
    expect(redisCounter).toBe(10);

    // Simulate mid-stream failure: release pre-allocated credit
    if ('release' in usage && typeof (usage as any).release === 'function') {
      await (usage as any).release();
    }

    // Counter must be rolled back to 9
    expect(redisCounter).toBe(9);
  });
});
