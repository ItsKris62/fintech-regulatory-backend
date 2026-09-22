import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { createContext } from '../server/trpc/context';
import { logger } from '@/utils/logger';

const { mockRedis, mockPrisma, mockSupabaseAdmin } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      exists: vi.fn().mockResolvedValue(0),
    },
    mockPrisma: {
      user: {
        findUnique: vi.fn(),
      },
      session: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      organization: {
        findUnique: vi.fn(),
      },
    },
    mockSupabaseAdmin: {
      auth: {
        getUser: vi.fn(),
      },
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  get: (...args: any[]) => mockRedis.get(...args),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

vi.mock('@/utils/token-revocation', () => ({
  isTokenRevoked: vi.fn().mockResolvedValue(false),
  revokedJtiKey: (jti: string) => `revoked_jti:${jti}`,
}));

describe('Observability: context_session_auto_healed Structured Log Event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits context_session_auto_healed structured log when valid Supabase token has no local session', async () => {
    const infoSpy = vi.spyOn(logger, 'info');

    const testDbUserId = 'user_auto_heal_test';
    const testSupaAuthId = 'supa_auto_heal_test';
    const testSessionId = 'sess_auto_healed_999';

    mockSupabaseAdmin.auth.getUser.mockResolvedValue({
      data: { user: { id: testSupaAuthId, email: 'autoheal@example.com' } },
      error: null,
    });

    (mockPrisma.user.findUnique as any).mockResolvedValue({
      id: testDbUserId,
      email: 'autoheal@example.com',
      role: 'STARTUP',
      organizationId: 'org_auto_heal',
      supabaseAuthId: testSupaAuthId,
      accountStatus: 'active',
      deletedAt: null,
      passkeys: [],
    });

    // No local session exists
    (mockPrisma.session.findFirst as any).mockResolvedValue(null);

    // Creates new auto-healed session
    (mockPrisma.session.create as any).mockResolvedValue({
      id: testSessionId,
      expiresAt: new Date(Date.now() + 8 * 3600 * 1000),
    });

    const jwtSecret = process.env.SUPABASE_JWT_SECRET || 'dev-jwt-secret-for-testing';
    const validJwt = jwt.sign(
      {
        sub: testSupaAuthId,
        email: 'autoheal@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: 'test_jti_auto_heal',
      },
      jwtSecret,
      { algorithm: 'HS256' }
    );

    const ctx = await createContext({
      req: {
        ip: '192.168.1.100',
        headers: {
          authorization: `Bearer ${validJwt}`,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
      } as any,
      res: {
        setCookie: vi.fn(),
      } as any,
    });

    expect(ctx.user).not.toBeNull();
    expect(ctx.user?.id).toBe(testDbUserId);
    expect(ctx.user?.sessionId).toBe(testSessionId);

    // Verify structured log emission
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context_session_auto_healed',
        userId: testDbUserId,
        sessionId: testSessionId,
      })
    );
  });
});
