import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createContext } from '../context';
import { authRouter } from '../../routers/auth.router';
import {
  userSessionKey,
  sessionFingerprintKey,
  buildSessionFingerprint,
} from '@/config/session';
import { logger } from '@/utils/logger';
import jwt from 'jsonwebtoken';

const { mockRedisStore, mockRedis, mockSupabaseAdmin, mockSupabaseClient, mockPrisma } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const dbUser = {
    id: 'cuid_prisma_user_9999',
    email: 'engineer@sheriabot.com',
    fullName: 'Incident Response Engineer',
    role: 'ADMIN',
    organizationId: 'org_admin_01',
    supabaseAuthId: 'supa-uuid-1111-2222-3333-444455556666',
    emailVerified: true,
    emailVerifiedAt: new Date(),
    mustChangePassword: false,
    totpEnabled: false,
    accountStatus: 'active',
    deletedAt: null,
    passkeys: [],
  };

  const activeSession = {
    id: 'sess_incident_fixed_001',
    userId: 'cuid_prisma_user_9999',
    token: 'random_token_string',
    expiresAt: new Date(Date.now() + 8 * 3600 * 1000),
    device: 'macOS Browser',
    ipAddress: '172.70.242.164',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  };

  const prismaMock = {
    user: {
      findUnique: vi.fn().mockResolvedValue(dbUser),
      update: vi.fn().mockResolvedValue(dbUser),
    },
    session: {
      findFirst: vi.fn().mockResolvedValue(activeSession),
      create: vi.fn().mockResolvedValue(activeSession),
    },
    systemConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_01' }),
    },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => callback(prismaMock)),
  };

  return {
    mockRedisStore: store,
    mockPrisma: prismaMock,
    mockRedis: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => {
        store.set(key, val);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        const existed = store.has(key);
        store.delete(key);
        return existed ? 1 : 0;
      }),
      exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
      ping: vi.fn().mockResolvedValue('PONG'),
    },
    mockSupabaseAdmin: {
      auth: {
        getUser: vi.fn(),
        admin: {
          signOut: vi.fn().mockResolvedValue({}),
          generateLink: vi.fn(),
          createUser: vi.fn(),
          deleteUser: vi.fn(),
        },
      },
    },
    mockSupabaseClient: {
      auth: {
        signInWithPassword: vi.fn(),
        verifyOtp: vi.fn(),
      },
    },
  };
});

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  get: (key: string) => mockRedis.get(key),
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  checkRedisHealth: vi.fn().mockResolvedValue(true),
  getRedisStats: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: mockSupabaseAdmin,
  supabaseClient: mockSupabaseClient,
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
  authRateLimiter: {
    login: vi.fn().mockResolvedValue({ allowed: true }),
    register: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/utils/token-revocation', () => ({
  isTokenRevoked: vi.fn(async (_token: string, _userId?: string) => {
    return false;
  }),
  revokedJtiKey: (jti: string) => `revoked_jti:${jti}`,
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
}));

describe('Session Fingerprint & IP Tolerance (Incident Remediation)', () => {
  const TEST_JWT_SECRET = 'super-secret-jwt-key-that-is-at-least-32-chars-long';
  const SUPABASE_AUTH_ID = 'supa-uuid-1111-2222-3333-444455556666';
  const PRISMA_USER_ID = 'cuid_prisma_user_9999';
  const SESSION_ID = 'sess_incident_fixed_001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisStore.clear();
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    process.env.ENABLE_CONTEXT_FAST_PATH = 'true';
    process.env.ENABLE_SESSION_LRU = 'false';
    process.env.SESSION_FINGERPRINT_MODE = 'monitor';
  });

  function createValidBearerToken(jti = 'jti_token_abc123'): string {
    return jwt.sign(
      {
        sub: SUPABASE_AUTH_ID,
        email: 'engineer@sheriabot.com',
        role: 'authenticated',
        jti,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      },
      TEST_JWT_SECRET,
      { algorithm: 'HS256' },
    );
  }



  it('1. Fingerprint: IP change does NOT revoke the JTI and does NOT return UNAUTHORIZED', async () => {
    const token = createValidBearerToken('jti_test_ip_change');
    const loginUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    const loginIp = '172.70.242.164'; // Initial login IP

    // Setup session fingerprint recorded at login
    const initialFp = buildSessionFingerprint(loginIp, loginUa);
    mockRedisStore.set(sessionFingerprintKey(SESSION_ID), initialFp);

    // Populate user session in Redis using canonical key
    const userProfile = {
      id: PRISMA_USER_ID,
      email: 'engineer@sheriabot.com',
      role: 'ADMIN',
      organizationId: 'org_admin_01',
      supabaseAuthId: SUPABASE_AUTH_ID,
      mustChangePassword: false,
      totpEnabled: false,
      sessionId: SESSION_ID,
      sessionExpiresAt: Date.now() + 8 * 3600 * 1000,
    };
    mockRedisStore.set(userSessionKey(SUPABASE_AUTH_ID), JSON.stringify(userProfile));

    // Subsequent request arrives 2 seconds later from a different Anycast IP (e.g. 172.70.242.165)
    const subsequentReq: any = {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': loginUa,
      },
      ip: '172.70.242.165', // Changed IP
    };
    const subsequentRes: any = {};

    const ctx = await createContext({ req: subsequentReq, res: subsequentRes });

    // User must remain authenticated
    expect(ctx.user).not.toBeNull();
    expect(ctx.user?.id).toBe(PRISMA_USER_ID);
    expect(ctx.user?.supabaseAuthId).toBe(SUPABASE_AUTH_ID);

    // JTI must NOT be revoked in Redis
    expect(mockRedisStore.has('revoked_jti:jti_test_ip_change')).toBe(false);
  });

  it('2. Fingerprint: IP change DOES emit a warn-level log with old/new IP and userId', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn');
    const token = createValidBearerToken('jti_test_ip_warn');
    const loginUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    const oldIp = '104.28.156.10';
    const newIp = '104.28.156.20';

    mockRedisStore.set(sessionFingerprintKey(SESSION_ID), buildSessionFingerprint(oldIp, loginUa));
    mockRedisStore.set(
      userSessionKey(SUPABASE_AUTH_ID),
      JSON.stringify({
        id: PRISMA_USER_ID,
        email: 'engineer@sheriabot.com',
        role: 'ADMIN',
        organizationId: 'org_admin_01',
        supabaseAuthId: SUPABASE_AUTH_ID,
        sessionId: SESSION_ID,
        sessionExpiresAt: Date.now() + 8 * 3600 * 1000,
      }),
    );

    const req: any = {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': loginUa,
      },
      ip: newIp,
    };

    const ctx = await createContext({ req, res: {} as any });
    expect(ctx.user).not.toBeNull();

    // Verify structured log for IP transition
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_ip_changed',
        event: 'session_ip_changed',
        userId: PRISMA_USER_ID,
        sessionId: SESSION_ID,
        oldIp,
        newIp,
      }),
    );
  });

  it('3. Fingerprint: User-Agent change is detected and handled according to mode', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn');
    const token = createValidBearerToken('jti_ua_change_test');
    const initialUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
    const hijackedUa = 'python-requests/2.28.1'; // Disparate User-Agent

    mockRedisStore.set(sessionFingerprintKey(SESSION_ID), buildSessionFingerprint('198.51.100.1', initialUa));
    mockRedisStore.set(
      userSessionKey(SUPABASE_AUTH_ID),
      JSON.stringify({
        id: PRISMA_USER_ID,
        email: 'engineer@sheriabot.com',
        role: 'ADMIN',
        supabaseAuthId: SUPABASE_AUTH_ID,
        sessionId: SESSION_ID,
        sessionExpiresAt: Date.now() + 8 * 3600 * 1000,
      }),
    );

    // In default 'monitor' mode, UA mismatch logs warning but does not hard-lock user
    const reqMonitor: any = {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': hijackedUa,
      },
      ip: '198.51.100.1',
    };

    const ctx = await createContext({ req: reqMonitor, res: {} as any });
    expect(ctx.user).not.toBeNull();
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_anomaly_monitored',
        userId: PRISMA_USER_ID,
      }),
    );
  });

  it('4. Auth flow: auth.login followed immediately by authenticated query succeeds end-to-end across IP changes', async () => {
    const loginIp = '172.70.242.164';
    const nextReqIp = '172.70.242.188'; // IP shift behind Cloudflare Anycast

    const testToken = createValidBearerToken('jti_login_e2e_flow');
    mockSupabaseClient.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: SUPABASE_AUTH_ID, email: 'engineer@sheriabot.com', email_confirmed_at: new Date().toISOString() },
        session: { access_token: testToken, refresh_token: 'refresh_tok_123' },
      },
      error: null,
    });

    // 1. User executes auth.login
    const loginCaller = authRouter.createCaller({
      user: null,
      prisma: mockPrisma as any,
      req: {
        ip: loginIp,
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    const loginResult = await loginCaller.login({
      email: 'engineer@sheriabot.com',
      password: 'StrongPassword123!',
    });

    expect(loginResult.accessToken).toBe(testToken);
    expect(loginResult.user?.id).toBe(PRISMA_USER_ID);

    // 2. Browser immediately makes subsequent request (e.g. alert.createStreamToken or auth.me) with changed IP
    const nextReq: any = {
      headers: {
        authorization: `Bearer ${loginResult.accessToken}`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
      ip: nextReqIp,
    };

    const nextCtx = await createContext({ req: nextReq, res: {} as any });
    expect(nextCtx.user).not.toBeNull();
    expect(nextCtx.user?.id).toBe(PRISMA_USER_ID);

    // Call protected procedure auth.me with the new context
    const authedCaller = authRouter.createCaller(nextCtx);
    const meResult = await authedCaller.me();
    expect(meResult.id).toBe(PRISMA_USER_ID);
    expect(meResult.email).toBe('engineer@sheriabot.com');
  });

  it('5. Cache key: auth.router writes to and context.ts reads from the same canonical key (Supabase Auth ID)', async () => {
    const testToken = createValidBearerToken('jti_cache_key_align');
    mockSupabaseClient.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: SUPABASE_AUTH_ID, email: 'engineer@sheriabot.com', email_confirmed_at: new Date().toISOString() },
        session: { access_token: testToken, refresh_token: 'refresh_tok_123' },
      },
      error: null,
    });

    const loginCaller = authRouter.createCaller({
      user: null,
      prisma: mockPrisma as any,
      req: {
        ip: '198.51.100.20',
        headers: { 'user-agent': 'Mozilla/5.0' },
      } as any,
      res: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      storageService: {} as any,
      mailer: {} as any,
    });

    await loginCaller.login({
      email: 'engineer@sheriabot.com',
      password: 'StrongPassword123!',
    });

    // Check that Redis was populated with both user.id and supabaseAuthId keys
    const prismaKey = userSessionKey(PRISMA_USER_ID);
    const supaKey = userSessionKey(SUPABASE_AUTH_ID);

    expect(mockRedisStore.has(prismaKey)).toBe(true);
    expect(mockRedisStore.has(supaKey)).toBe(true);

    const cachedData = JSON.parse(mockRedisStore.get(supaKey)!);
    expect(cachedData.id).toBe(PRISMA_USER_ID);
    expect(cachedData.supabaseAuthId).toBe(SUPABASE_AUTH_ID);
  });
});
