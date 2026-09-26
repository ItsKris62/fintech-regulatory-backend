import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

let requestCount = 0;
const recordedCalls: { identifier: string; action: string; max: number; window: number }[] = [];

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: vi.fn(async (identifier: string, action: string, max: number, window: number) => {
      recordedCalls.push({ identifier, action, max, window });
      requestCount++;
      if (requestCount > max) {
        throw new Error('Rate limit exceeded');
      }
    }),
    check: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_1' }),
    },
    systemConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'admin_usr_1',
        role: 'ADMIN',
        totpEnabled: true,
      }),
    },
  },
}));

import { router } from '../init';
import { adminProcedure } from '../trpc';

describe('F-11: Admin rate limiting', () => {
  beforeEach(() => {
    store.clear();
    requestCount = 0;
    recordedCalls.length = 0;
    vi.clearAllMocks();
  });

  it('allows 120 admin requests within the 60s window and blocks the 121st with 429 TOO_MANY_REQUESTS', async () => {
    const testAdminRouter = router({
      adminAction: adminProcedure.mutation(async () => ({ success: true })),
    });

    const ctx: any = {
      user: {
        id: 'admin_usr_1',
        role: 'ADMIN',
        email: 'admin@sheriabot.com',
        totpEnabled: true,
      },
      req: {
        ip: '10.0.0.1',
        headers: {},
      },
    };

    // Mark MFA as verified in Redis to pass adminMfaEnforced
    store.set('sheriabot:admin:mfa_verified:admin_usr_1', 'verified');

    const caller = testAdminRouter.createCaller(ctx);

    // Perform 120 calls
    for (let i = 0; i < 120; i++) {
      const res = await caller.adminAction();
      expect(res).toEqual({ success: true });
    }

    // Verify key derivation strategy: per-user ID, not IP
    expect(recordedCalls[0]).toEqual({
      identifier: 'admin_usr_1',
      action: 'admin_action',
      max: 120,
      window: 60,
    });

    // 121st call must throw 429 TOO_MANY_REQUESTS
    await expect(caller.adminAction()).rejects.toThrowError(
      expect.objectContaining({
        code: 'TOO_MANY_REQUESTS',
      }),
    );
  });
});
