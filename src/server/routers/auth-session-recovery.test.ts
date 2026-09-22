import { describe, expect, it, vi, beforeEach } from 'vitest';
import { authRouter } from './auth.router';

const { mockRedis, mockSupabaseAdmin } = vi.hoisted(() => {
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

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: mockSupabaseAdmin,
  supabaseClient: {
    auth: {
      verifyOtp: vi.fn(),
    },
  },
}));

vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: {
    sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/utils/token-revocation', () => ({
  isTokenRevoked: vi.fn().mockResolvedValue(false),
  revokedJtiKey: (jti: string) => `revoked_jti:${jti}`,
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
}));

describe('Auth Session Recovery & Email Callback Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('confirmEmailCallback creates DB session and writes Redis keys for newly verified active users', async () => {
    mockSupabaseAdmin.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa_user_123', email: 'verified@example.com' } },
      error: null,
    });

    const mockPrismaUser = {
      id: 'user_123',
      email: 'verified@example.com',
      fullName: 'Test User',
      role: 'USER',
      emailVerified: false,
      organizationId: 'org_123',
      mustChangePassword: false,
      totpEnabled: false,
      accountStatus: 'pending',
    };

    const mockPrisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue(mockPrismaUser),
        update: vi.fn().mockResolvedValue({ ...mockPrismaUser, emailVerified: true, accountStatus: 'active' }),
      },
      session: {
        create: vi.fn().mockResolvedValue({
          id: 'sess_new_123',
          userId: 'user_123',
          expiresAt: new Date(Date.now() + 8 * 3600 * 1000),
        }),
      },
    };

    const caller = authRouter.createCaller({
      user: null,
      prisma: mockPrisma as any,
      req: {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'Mozilla/5.0' },
      } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    const result = await caller.confirmEmailCallback({ accessToken: 'valid_supabase_token' });

    expect(result.success).toBe(true);
    expect(result.alreadyVerified).toBe(false);
    expect(result.session).toBeDefined();
    expect(result.session?.id).toBe('sess_new_123');

    // Verify DB session was created
    expect(mockPrisma.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_123',
          device: expect.any(String),
        }),
      })
    );

    // Verify Redis user session and session keys written
    expect(mockRedis.set).toHaveBeenCalledWith(
      'user:session:supa_user_123',
      expect.stringContaining('"sessionId":"sess_new_123"'),
      expect.objectContaining({ ex: 3600 })
    );
  });

  it('confirmEmailCallback handles already verified users idempotently and provisions session', async () => {
    mockSupabaseAdmin.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa_user_456', email: 'already_verified@example.com' } },
      error: null,
    });

    const mockPrismaUser = {
      id: 'user_456',
      email: 'already_verified@example.com',
      fullName: 'Already Verified',
      role: 'USER',
      emailVerified: true,
      organizationId: 'org_456',
      mustChangePassword: false,
      totpEnabled: false,
      accountStatus: 'active',
    };

    const mockPrisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue(mockPrismaUser),
        update: vi.fn(),
      },
      session: {
        create: vi.fn().mockResolvedValue({
          id: 'sess_reissue_456',
          userId: 'user_456',
          expiresAt: new Date(Date.now() + 8 * 3600 * 1000),
        }),
      },
    };

    const caller = authRouter.createCaller({
      user: null,
      prisma: mockPrisma as any,
      req: {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'Mozilla/5.0' },
      } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    const result = await caller.confirmEmailCallback({ accessToken: 'valid_supabase_token' });

    expect(result.success).toBe(true);
    expect(result.alreadyVerified).toBe(true);
    expect(result.session?.id).toBe('sess_reissue_456');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
