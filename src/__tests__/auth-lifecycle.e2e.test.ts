import { describe, expect, it, vi, beforeEach } from 'vitest';
import { authRouter } from '../server/routers/auth.router';
import { MemberRole, MemberStatus } from '@prisma/client';

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
        signUp: vi.fn(),
        getUser: vi.fn(),
        admin: {
          createUser: vi.fn(),
          deleteUser: vi.fn().mockResolvedValue({}),
          signOut: vi.fn().mockResolvedValue({}),
          generateLink: vi.fn().mockResolvedValue({
            data: {
              user: { id: 'supa_new_user_1', email: 'fintech@example.com' },
              properties: { hashed_token: 'hash_123', action_link: 'http://localhost:3000/auth/callback' },
            },
            error: null,
          }),
        },
      },
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  get: (...args: any[]) => mockRedis.get(...args),
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  checkRedisHealth: vi.fn().mockResolvedValue(true),
  getRedisStats: vi.fn(),
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
  authRateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
    register: vi.fn().mockResolvedValue({ allowed: true }),
    login: vi.fn().mockResolvedValue({ allowed: true }),
    resetPassword: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: mockSupabaseAdmin,
  supabaseClient: {
    auth: {
      signUp: vi.fn(),
      verifyOtp: vi.fn(),
    },
  },
}));

vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/utils/token-revocation', () => ({
  isTokenRevoked: vi.fn().mockResolvedValue(false),
  revokedJtiKey: (jti: string) => `revoked_jti:${jti}`,
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
}));

describe('Auth Lifecycle & Workspace Provisioning E2E Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes registration -> auto-provisions organization -> confirms email -> establishes session', async () => {
    // 1. Mock Supabase sign up
    mockSupabaseAdmin.auth.signUp.mockResolvedValue({
      data: {
        user: { id: 'supa_new_user_1', email: 'fintech@example.com' },
        session: null,
      },
      error: null,
    });

    const mockPrisma = {
      $transaction: vi.fn().mockImplementation((cb) => typeof cb === 'function' ? cb(mockPrisma) : Promise.all(cb)),
      systemConfig: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: vi.fn().mockImplementation(({ where }) => {
          if (where.email === 'fintech@example.com') return Promise.resolve(null);
          if (where.supabaseAuthId === 'supa_new_user_1') {
            return Promise.resolve({
              id: 'user_created_1',
              email: 'fintech@example.com',
              fullName: 'Alex Founder',
              role: 'STARTUP',
              emailVerified: false,
              organizationId: 'org_auto_1',
              mustChangePassword: false,
              totpEnabled: false,
              accountStatus: 'pending',
            });
          }
          return Promise.resolve(null);
        }),
        create: vi.fn().mockResolvedValue({
          id: 'user_created_1',
          email: 'fintech@example.com',
          fullName: 'Alex Founder',
          role: 'STARTUP',
          accountStatus: 'pending',
          emailVerified: false,
          supabaseAuthId: 'supa_new_user_1',
          organizationId: null,
        }),
        update: vi.fn().mockResolvedValue({
          id: 'user_created_1',
          email: 'fintech@example.com',
          fullName: 'Alex Founder',
          role: 'STARTUP',
          accountStatus: 'active',
          emailVerified: true,
          organizationId: 'org_auto_1',
        }),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'org_auto_1',
          name: 'Alex Founder\'s Organization',
          type: 'STARTUP',
          subscriptionTier: 'starter',
          plan: 'STARTER',
        }),
      },
      organizationMember: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'mem_auto_1',
          userId: 'user_created_1',
          organizationId: 'org_auto_1',
          role: MemberRole.OWNER,
          status: MemberStatus.ACTIVE,
        }),
      },
      session: {
        create: vi.fn().mockResolvedValue({
          id: 'sess_live_1',
          userId: 'user_created_1',
          expiresAt: new Date(Date.now() + 8 * 3600 * 1000),
        }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      notificationPreference: {
        create: vi.fn().mockResolvedValue({}),
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

    // Step 1: User registers without specifying companyName
    const registerRes = await caller.register({
      email: 'fintech@example.com',
      password: 'StrongPassword123!@#',
      name: 'Alex Founder',
      role: 'STARTUP',
    });

    expect(registerRes.requiresEmailVerification).toBe(true);
    expect(mockPrisma.organization.create).toHaveBeenCalled();
    expect(mockPrisma.organizationMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user_created_1',
          organizationId: 'org_auto_1',
          role: MemberRole.OWNER,
          status: MemberStatus.ACTIVE,
        }),
      })
    );

    // Step 2: User confirms email
    mockSupabaseAdmin.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supa_new_user_1', email: 'fintech@example.com' } },
      error: null,
    });

    const confirmRes = await caller.confirmEmailCallback({
      accessToken: 'valid_email_confirmation_jwt',
    });

    expect(confirmRes.success).toBe(true);
    expect(confirmRes.session).toBeDefined();
    expect(confirmRes.session?.id).toBe('sess_live_1');
    expect(mockPrisma.session.create).toHaveBeenCalled();
  });
});
