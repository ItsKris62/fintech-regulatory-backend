import { describe, expect, it, vi, beforeEach } from 'vitest';
import { authRouter } from '../auth.router';
import { userSessionKey, lastSeenKey, sessionFingerprintKey, sessionStartKey } from '@/config/session';

const { mockRedis, mockSupabaseAdmin, mockPrisma } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      ping: vi.fn().mockResolvedValue('PONG'),
    },
    mockSupabaseAdmin: {
      auth: {
        getUser: vi.fn(),
        admin: {
          signOut: vi.fn().mockResolvedValue({}),
        },
      },
    },
    mockPrisma: {
      systemConfig: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org_test',
          name: 'Test Org',
          plan: 'STARTER',
          subscriptionTier: 'starter',
          subscriptionStatus: 'ACTIVE',
        }),
      },
      session: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
  authRateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  get: (...args: any[]) => mockRedis.get(...args),
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  checkRedisHealth: vi.fn().mockResolvedValue(true),
  getRedisStats: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: mockSupabaseAdmin,
  supabaseClient: {
    auth: {
      verifyOtp: vi.fn(),
    },
  },
}));

vi.mock('@/utils/token-revocation', () => ({
  isTokenRevoked: vi.fn().mockResolvedValue(false),
  revokedJtiKey: (jti: string) => `revoked_jti:${jti}`,
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/jwt', () => ({
  extractJti: vi.fn().mockReturnValue('mock_jti_123'),
  extractExp: vi.fn().mockReturnValue(Math.floor(Date.now() / 1000) + 3600),
}));

describe('Auth Logout Unified Redis Key Purge Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('purges user:session:${dbUser.id}, last_seen:${dbUser.id}, and fingerprint:${sessionId} upon logout', async () => {
    const testDbUserId = 'db_user_uuid_123';
    const testSessionId = 'sess_local_456';
    const testSupaAuthId = 'supa_auth_789';

    const caller = authRouter.createCaller({
      user: {
        id: testDbUserId,
        email: 'user@example.com',
        role: 'USER',
        organizationId: 'org_test',
        supabaseAuthId: testSupaAuthId,
        sessionId: testSessionId,
      } as any,
      prisma: mockPrisma as any,
      req: {
        ip: '127.0.0.1',
        headers: {
          authorization: 'Bearer mock_bearer_token',
        },
      } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    const response = await caller.logout();
    expect(response).toEqual({ success: true, message: 'Logged out successfully' });

    // Assert that the exact key templates are deleted
    expect(mockRedis.del).toHaveBeenCalledWith(userSessionKey(testDbUserId));
    expect(mockRedis.del).toHaveBeenCalledWith(lastSeenKey(testDbUserId));
    expect(mockRedis.del).toHaveBeenCalledWith(sessionFingerprintKey(testSessionId));
    expect(mockRedis.del).toHaveBeenCalledWith(sessionStartKey(testDbUserId));

    // Verify key formats
    expect(userSessionKey(testDbUserId)).toBe(`user:session:${testDbUserId}`);
    expect(lastSeenKey(testDbUserId)).toBe(`user:session:last_seen:${testDbUserId}`);
    expect(sessionFingerprintKey(testSessionId)).toBe(`user:session:fingerprint:${testSessionId}`);
  });
});
