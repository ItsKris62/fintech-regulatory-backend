import { describe, expect, it, vi, beforeEach } from 'vitest';
import { organizationMfaEnforced } from '../trpc/trpc';
import * as sessionService from '../services/session.service';
import * as auditService from '../services/audit.service';
import * as webauthnRateLimit from '@/server/lib/webauthn-rate-limit';
import {
  PASSKEY_RATE_LIMITS,
  PASSKEY_REDIS_KEYS,
} from '@/server/lib/webauthn-rate-limit';

// Use vi.hoisted so variables are available inside vi.mock hoisted factory functions
const { mockRedis, mockWebAuthn } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      incr: vi.fn(),
      expire: vi.fn(),
      ping: vi.fn().mockResolvedValue('PONG'),
    },
    mockWebAuthn: {
      generateRegistrationOptions: vi.fn(),
      verifyRegistrationResponse: vi.fn(),
      generateAuthenticationOptions: vi.fn(),
      verifyAuthenticationResponse: vi.fn(),
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

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    systemConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    securityAuditEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...args: any[]) => mockWebAuthn.generateRegistrationOptions(...args),
  verifyRegistrationResponse: (...args: any[]) => mockWebAuthn.verifyRegistrationResponse(...args),
  generateAuthenticationOptions: (...args: any[]) => mockWebAuthn.generateAuthenticationOptions(...args),
  verifyAuthenticationResponse: (...args: any[]) => mockWebAuthn.verifyAuthenticationResponse(...args),
}));

import { passkeyRouter } from './passkey.router';

function createMockPrisma(overrides: any = {}) {
  const defaultPasskey = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'pk_default', deviceName: 'Device', createdAt: new Date() }),
    update: vi.fn().mockResolvedValue({ id: 'pk_default', deviceName: 'New Name' }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn().mockResolvedValue({ id: 'pk_default' }),
    count: vi.fn().mockResolvedValue(0),
  };
  const defaultUser = {
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
  };
  const defaultOrg = {
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const defaultSession = {
    create: vi.fn().mockResolvedValue({ id: 'sess_123' }),
  };
  const defaultAuditEvent = {
    create: vi.fn().mockResolvedValue({}),
  };
  const defaultSystemConfig = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  return {
    ...overrides,
    passkey: { ...defaultPasskey, ...(overrides.passkey || {}) },
    user: { ...defaultUser, ...(overrides.user || {}) },
    organization: { ...defaultOrg, ...(overrides.organization || {}) },
    session: { ...defaultSession, ...(overrides.session || {}) },
    auditLog: { create: vi.fn().mockResolvedValue({}), ...(overrides.auditLog || {}) },
    securityAuditEvent: { ...defaultAuditEvent, ...(overrides.securityAuditEvent || {}) },
    systemConfig: { ...defaultSystemConfig, ...(overrides.systemConfig || {}) },
  };
}

function createMockCtx(user: any = null, prismaOverrides: any = {}) {
  return {
    user,
    prisma: createMockPrisma(prismaOverrides),
    req: {
      ip: '127.0.0.1',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    },
    res: {},
  };
}

describe('Passkey Router & Security Hardening Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebAuthn.generateRegistrationOptions.mockReset();
    mockWebAuthn.verifyRegistrationResponse.mockReset();
    mockWebAuthn.generateAuthenticationOptions.mockReset();
    mockWebAuthn.verifyAuthenticationResponse.mockReset();

    // Default healthy redis mocks
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(null);

    // Default audit log spy
    vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    // Default rate limit allowed for checkRateLimit
    vi.spyOn(webauthnRateLimit, 'checkRateLimit').mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Math.floor(Date.now() / 1000) + 900,
    });
  });

  // 1. generateRegistrationOptions excludes existing passkeys
  it('1. generateRegistrationOptions excludes existing passkeys', async () => {
    const existingPasskeys = [
      { credentialId: 'cred_1', transports: ['usb'] },
      { credentialId: 'cred_2', transports: ['internal'] },
    ];

    const ctx = createMockCtx(
      { id: 'user_1', email: 'test@example.com', organizationId: 'org_1' },
      { passkey: { findMany: vi.fn().mockResolvedValue(existingPasskeys) } },
    );

    mockWebAuthn.generateRegistrationOptions.mockResolvedValue({
      challenge: 'reg_challenge_123',
      rp: { name: 'Sheria Bot', id: 'localhost' },
      user: { id: 'user_1', name: 'test@example.com', displayName: 'test@example.com' },
      pubKeyCredParams: [],
      excludeCredentials: [
        { id: 'cred_1', transports: ['usb'] },
        { id: 'cred_2', transports: ['internal'] },
      ],
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    const result = await caller.generateRegistrationOptions();

    expect(mockWebAuthn.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: [
          { id: 'cred_1', transports: ['usb'] },
          { id: 'cred_2', transports: ['internal'] },
        ],
      }),
    );
    expect(result.challenge).toBe('reg_challenge_123');
  });

  // 2. Registration challenge is stored in Redis with 300s TTL
  it('2. Registration challenge is stored in Redis with 300s TTL', async () => {
    const ctx = createMockCtx({ id: 'user_123', email: 'user@example.com' });

    mockRedis.set.mockResolvedValue('OK');
    mockWebAuthn.generateRegistrationOptions.mockResolvedValue({
      challenge: 'stored_challenge_abc',
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    await caller.generateRegistrationOptions();

    expect(mockRedis.set).toHaveBeenCalledWith(
      PASSKEY_REDIS_KEYS.regChallenge('user_123'),
      'stored_challenge_abc',
      { ex: 300 },
    );
  });

  // 3. verifyRegistration deletes challenge key before calling verifyRegistrationResponse (single-use)
  it('3. verifyRegistration deletes challenge key before calling verifyRegistrationResponse (single-use)', async () => {
    const callOrder: string[] = [];
    const targetKey = PASSKEY_REDIS_KEYS.regChallenge('user_123');

    mockRedis.get.mockImplementation(async (key: string) => {
      if (key === targetKey) {
        callOrder.push('redis.get(regChallenge)');
        return 'challenge_val';
      }
      return null;
    });
    mockRedis.del.mockImplementation(async (key: string) => {
      if (key === targetKey) {
        callOrder.push('redis.del(regChallenge)');
      }
      return 1;
    });

    mockWebAuthn.verifyRegistrationResponse.mockImplementation(async () => {
      callOrder.push('verifyRegistrationResponse');
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: 'cred_id_1',
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 0,
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          aaguid: '00000000-0000-0000-0000-000000000000',
        },
      };
    });

    const ctx = createMockCtx({ id: 'user_123', email: 'user@example.com' });

    const caller = passkeyRouter.createCaller(ctx as any);
    await caller.verifyRegistration({
      response: {
        id: 'cred_id_1',
        rawId: 'cred_id_1',
        response: {
          clientDataJSON: 'client_data_json',
          attestationObject: 'attestation_obj',
        },
        type: 'public-key',
      },
      deviceName: 'MacBook',
    });

    expect(callOrder).toEqual(['redis.get(regChallenge)', 'redis.del(regChallenge)', 'verifyRegistrationResponse']);
  });

  // 4. verifyRegistration rejects expired/missing challenge with UNAUTHORIZED
  it('4. verifyRegistration rejects expired/missing challenge with UNAUTHORIZED', async () => {
    mockRedis.get.mockResolvedValue(null);

    const ctx = createMockCtx({ id: 'user_123', email: 'user@example.com' });

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyRegistration({
        response: {
          id: 'cred_id_1',
          rawId: 'cred_id_1',
          response: {
            clientDataJSON: 'client_data_json',
            attestationObject: 'attestation_obj',
          },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('Passkey registration session expired');
  });

  // 5. verifyRegistration handles P2002 duplicate credential gracefully (CONFLICT)
  it('5. verifyRegistration handles P2002 duplicate credential gracefully (CONFLICT)', async () => {
    mockRedis.get.mockResolvedValue('challenge_val');

    mockWebAuthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'duplicate_cred',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });

    const ctx = createMockCtx(
      { id: 'user_123', email: 'user@example.com' },
      { passkey: { create: vi.fn().mockRejectedValue({ code: 'P2002', message: 'Unique constraint failed' }) } },
    );

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyRegistration({
        response: {
          id: 'duplicate_cred',
          rawId: 'duplicate_cred',
          response: {
            clientDataJSON: 'client_data_json',
            attestationObject: 'attestation_obj',
          },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('This passkey is already registered');
  });

  // 6. verifyRegistration writes PASSKEY_REGISTRATION_SUCCESS audit event without credential bytes in metadata
  it('6. verifyRegistration writes PASSKEY_REGISTRATION_SUCCESS audit event without credential bytes in metadata', async () => {
    mockRedis.get.mockResolvedValue('challenge_val');
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    mockWebAuthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred_id_safe',
          publicKey: new Uint8Array([9, 9, 9]),
          counter: 0,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        aaguid: 'aaguid-1234',
      },
    });

    const ctx = createMockCtx(
      { id: 'user_123', email: 'user@example.com', organizationId: 'org_123' },
      { passkey: { create: vi.fn().mockResolvedValue({ id: 'pk_new_id', deviceName: 'YubiKey', createdAt: new Date() }) } },
    );

    const caller = passkeyRouter.createCaller(ctx as any);
    await caller.verifyRegistration({
      response: {
        id: 'cred_id_safe',
        rawId: 'cred_id_safe',
        response: {
          clientDataJSON: 'client_data_json',
          attestationObject: 'attestation_obj',
        },
        type: 'public-key',
      },
      deviceName: 'YubiKey',
    });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_REGISTRATION_SUCCESS',
        userId: 'user_123',
        metadata: {
          passkeyId: 'pk_new_id',
          deviceName: 'YubiKey',
          aaguid: 'aaguid-1234',
          backedUp: false,
        },
      }),
    );
  });

  // 7. generateAuthenticationOptions rate-limits per IP (30/15min)
  it('7. generateAuthenticationOptions rate-limits per IP (30/15min)', async () => {
    expect(PASSKEY_RATE_LIMITS.authOptions).toEqual({ max: 30, windowSec: 900 });

    vi.spyOn(webauthnRateLimit, 'checkAuthOptionsRateLimit').mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 900,
    });
    mockRedis.incr.mockResolvedValue(31);
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null);
    ctx.req.ip = '192.168.1.50';

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(caller.generateAuthenticationOptions({})).rejects.toThrow('PASSKEY_RATE_LIMITED');
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_RATE_LIMITED',
        ipAddress: '192.168.1.50',
      }),
    );
  });

  it('7b. generateAuthenticationOptions fails closed when IP is missing in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null);
    ctx.req.ip = undefined as any;

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(caller.generateAuthenticationOptions({})).rejects.toThrow('PASSKEY_RATE_LIMITED');
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_RATE_LIMITED',
        ipAddress: 'missing',
      }),
    );

    process.env.NODE_ENV = originalEnv;
  });

  it('7c. generateAuthenticationOptions allows request with valid real IP when within limits', async () => {
    vi.spyOn(webauthnRateLimit, 'checkRateLimit').mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: Math.floor(Date.now() / 1000) + 900,
    });
    mockWebAuthn.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'chal_test_123',
    });
    mockRedis.set.mockResolvedValue('OK');
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null);
    ctx.req.ip = '198.51.100.77';

    const caller = passkeyRouter.createCaller(ctx as any);
    const res = await caller.generateAuthenticationOptions({});

    expect(res).toBeDefined();
    expect(res.options.challenge).toBe('chal_test_123');
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_AUTH_STARTED',
        ipAddress: '198.51.100.77',
      }),
    );
  });

  // 8. verifyAuthentication rejects unknown credentialId
  it('8. verifyAuthentication rejects unknown credentialId', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ challenge: 'chal_1' }));
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null, {
      passkey: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyAuthentication({
        challengeId: 'cid_1',
        response: {
          id: 'unknown_cred_id',
          rawId: 'unknown_cred_id',
          response: {
            clientDataJSON: 'cd',
            authenticatorData: 'ad',
            signature: 'sig',
          },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('Passkey verification failed');

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_AUTH_FAILED',
        metadata: { reason: 'unknown_credential' },
      }),
    );
  });

  // 9. verifyAuthentication rejects userHandle mismatch
  it('9. verifyAuthentication rejects userHandle mismatch', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ challenge: 'chal_1', userHandle: 'expected_user_A' }));
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null, {
      passkey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pk_1',
          userId: 'different_user_B',
          credentialId: 'cred_1',
          publicKey: Buffer.from([1, 2, 3]),
          counter: 1n,
          transports: [],
        }),
      },
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyAuthentication({
        challengeId: 'cid_1',
        response: {
          id: 'cred_1',
          rawId: 'cred_1',
          response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('Passkey verification failed');

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_AUTH_FAILED',
        userId: 'different_user_B',
        metadata: { reason: 'user_handle_mismatch' },
      }),
    );
  });

  // 10. verifyAuthentication counter regression: presented <= stored (both non-zero) -> PASSKEY_COUNTER_REGRESSION logged, UNAUTHORIZED thrown
  it('10. verifyAuthentication counter regression: presented <= stored (both non-zero) -> PASSKEY_COUNTER_REGRESSION logged, UNAUTHORIZED thrown', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ challenge: 'chal_1' }));
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    mockWebAuthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 5, // Regression! Stored is 10
      },
    });

    const ctx = createMockCtx(null, {
      passkey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pk_regress',
          userId: 'user_attacked',
          credentialId: 'cred_regress',
          publicKey: Buffer.from([1, 2, 3]),
          counter: 10n,
          transports: [],
          user: { id: 'user_attacked', accountStatus: 'active' },
        }),
      },
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyAuthentication({
        challengeId: 'cid_1',
        response: {
          id: 'cred_regress',
          rawId: 'cred_regress',
          response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('Passkey verification failed');

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_COUNTER_REGRESSION',
        userId: 'user_attacked',
        metadata: {
          passkeyId: 'pk_regress',
          stored: 10,
          presented: 5,
        },
      }),
    );
  });

  // 11. verifyAuthentication counter race: updateMany returns 0 -> CONFLICT thrown
  it('11. verifyAuthentication counter race: updateMany returns 0 -> CONFLICT thrown', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ challenge: 'chal_1' }));
    mockWebAuthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 11 },
    });

    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null, {
      passkey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pk_race',
          userId: 'user_race',
          credentialId: 'cred_race',
          publicKey: Buffer.from([1, 2, 3]),
          counter: 10n,
          transports: [],
          user: { id: 'user_race', accountStatus: 'active' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // Lost race to concurrent request
      },
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyAuthentication({
        challengeId: 'cid_1',
        response: {
          id: 'cred_race',
          rawId: 'cred_race',
          response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('Passkey authentication conflict, please retry');

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_AUTH_FAILED',
        metadata: { reason: 'counter_race' },
      }),
    );
  });

  // 12. verifyAuthentication issues a session via issueSessionForUser (mock and assert call)
  it('12. verifyAuthentication issues a session via issueSessionForUser (mock and assert call)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ challenge: 'chal_1' }));
    mockWebAuthn.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 15 },
    });

    const issueSessionSpy = vi.spyOn(sessionService, 'issueSessionForUser').mockResolvedValue({
      mfaRequired: false,
      tempToken: null,
      accessToken: 'access_jwt_passkey',
      refreshToken: 'refresh_jwt_passkey',
      user: {
        id: 'user_passkey_auth',
        email: 'passkey_user@example.com',
        name: 'Passkey User',
        role: 'STARTUP',
        emailVerified: true,
        mustChangePassword: false,
        organization: null,
        createdAt: new Date(),
      },
    });

    const mockUser = {
      id: 'user_passkey_auth',
      email: 'passkey_user@example.com',
      accountStatus: 'active',
      deletedAt: null,
    };

    const ctx = createMockCtx(null, {
      passkey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pk_valid',
          userId: 'user_passkey_auth',
          credentialId: 'cred_valid',
          publicKey: Buffer.from([1, 2, 3]),
          counter: 10n,
          transports: [],
          backedUp: true,
          user: mockUser,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    const res = await caller.verifyAuthentication({
      challengeId: 'cid_1',
      response: {
        id: 'cred_valid',
        rawId: 'cred_valid',
        response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
        type: 'public-key',
      },
    });

    expect(issueSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'passkey',
        user: expect.objectContaining({ id: 'user_passkey_auth', hasPasskey: true }),
      }),
    );
    expect(res.accessToken).toBe('access_jwt_passkey');
    expect(res.mfaRequired).toBe(false);
  });

  // 13. verifyAuthentication deletes challenge on failure (single-use)
  it('13. verifyAuthentication deletes challenge on failure (single-use)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ challenge: 'chal_1' }));
    mockRedis.del.mockResolvedValue(1);

    mockWebAuthn.verifyAuthenticationResponse.mockRejectedValue(new Error('Signature verification failed'));

    const ctx = createMockCtx(null, {
      passkey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pk_sig_fail',
          userId: 'user_sig_fail',
          credentialId: 'cred_sig_fail',
          publicKey: Buffer.from([1, 2, 3]),
          counter: 0n,
          transports: [],
          user: { id: 'user_sig_fail', accountStatus: 'active' },
        }),
      },
    });

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyAuthentication({
        challengeId: 'cid_delete_fail',
        response: {
          id: 'cred_sig_fail',
          rawId: 'cred_sig_fail',
          response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('Passkey verification failed');

    expect(mockRedis.del).toHaveBeenCalledWith(PASSKEY_REDIS_KEYS.authChallenge('cid_delete_fail'));
  });

  // 14. authVerify rate limit: 6th attempt on same challengeId -> TOO_MANY_REQUESTS
  it('14. authVerify rate limit: 6th attempt on same challengeId -> TOO_MANY_REQUESTS', async () => {
    expect(PASSKEY_RATE_LIMITS.authVerify).toEqual({ max: 5, windowSec: 300 });

    vi.spyOn(webauthnRateLimit, 'checkRateLimit').mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 300,
    });
    mockRedis.del.mockResolvedValue(1);
    const auditSpy = vi.spyOn(auditService, 'logSecurityEvent').mockResolvedValue(undefined);

    const ctx = createMockCtx(null);

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(
      caller.verifyAuthentication({
        challengeId: 'cid_bruteforce',
        response: {
          id: 'cred_x',
          rawId: 'cred_x',
          response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
          type: 'public-key',
        },
      }),
    ).rejects.toThrow('PASSKEY_RATE_LIMITED');

    expect(mockRedis.del).toHaveBeenCalledWith(PASSKEY_REDIS_KEYS.authChallenge('cid_bruteforce'));
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PASSKEY_RATE_LIMITED',
        metadata: { action: 'verifyAuthentication', challengeId: 'cid_bruteforce' },
      }),
    );
  });

  // 15. deletePasskey enforces ownership (cannot delete another user's passkey)
  it("15. deletePasskey enforces ownership (cannot delete another user's passkey)", async () => {
    const ctx = createMockCtx(
      { id: 'attacker_user_id', organizationId: 'org_1' },
      { passkey: { findUnique: vi.fn().mockResolvedValue({ id: 'pk_victim', userId: 'victim_user_id' }) } },
    );

    const caller = passkeyRouter.createCaller(ctx as any);
    await expect(caller.deletePasskey({ id: 'pk_victim' })).rejects.toThrow('Passkey not found');
    expect(ctx.prisma.passkey.delete).not.toHaveBeenCalled();
  });

  // 16. listUserPasskeys never returns publicKey, credentialId bytes, or counter
  it('16. listUserPasskeys never returns publicKey, credentialId bytes, or counter', async () => {
    const mockList = [
      {
        id: 'pk_1',
        deviceName: 'MacBook Pro',
        transports: ['internal'],
        backedUp: true,
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    ];

    const ctx = createMockCtx(
      { id: 'user_1' },
      {
        passkey: {
          findMany: vi.fn().mockImplementation(({ select }) => {
            expect(select).toEqual({
              id: true,
              deviceName: true,
              transports: true,
              backedUp: true,
              createdAt: true,
              lastUsedAt: true,
            });
            expect(select.publicKey).toBeUndefined();
            expect(select.credentialId).toBeUndefined();
            expect(select.counter).toBeUndefined();
            return Promise.resolve(mockList);
          }),
        },
      },
    );

    const caller = passkeyRouter.createCaller(ctx as any);
    const res = await caller.listUserPasskeys();

    expect(res).toEqual(mockList);
    expect(res[0]).not.toHaveProperty('publicKey');
    expect(res[0]).not.toHaveProperty('counter');
  });

  // 17. organizationMfaEnforced allows passkey-only users through when requireMfa = true
  it('17. organizationMfaEnforced allows passkey-only users through when requireMfa = true', async () => {
    const nextFn = vi.fn().mockResolvedValue('passed');

    // Case A: User has TOTP disabled but hasPasskey = true -> allowed
    const passkeyOnlyCtx = createMockCtx(
      {
        id: 'user_pk_only',
        role: 'STARTUP',
        organizationId: 'org_mfa_required',
        totpEnabled: false,
        hasPasskey: true,
      },
      {
        organization: {
          findUnique: vi.fn().mockResolvedValue({
            requireMfa: true,
            mfaPolicyEnabledAt: new Date(Date.now() - 100 * 3600 * 1000), // Grace expired
            mfaPolicyGraceHours: 48,
          }),
        },
      },
    );

    const handler = (organizationMfaEnforced as any)._middlewares?.[0] || organizationMfaEnforced;
    await (handler as any)({
      ctx: passkeyOnlyCtx,
      path: 'compliance.getQueries',
      next: nextFn,
    });

    expect(nextFn).toHaveBeenCalledTimes(1);

    // Case B: User has neither TOTP nor Passkey -> blocked after grace
    nextFn.mockClear();
    const nonMfaCtx = createMockCtx(
      {
        id: 'user_no_mfa',
        role: 'STARTUP',
        organizationId: 'org_mfa_required',
        totpEnabled: false,
        hasPasskey: false,
      },
      {
        organization: {
          findUnique: vi.fn().mockResolvedValue({
            requireMfa: true,
            mfaPolicyEnabledAt: new Date(Date.now() - 100 * 3600 * 1000), // Grace expired
            mfaPolicyGraceHours: 48,
          }),
        },
      },
    );

    await expect(
      (handler as any)({
        ctx: nonMfaCtx,
        path: 'compliance.getQueries',
        next: nextFn,
      }),
    ).rejects.toThrow('MFA_ENROLLMENT_REQUIRED');
  });

  // 18. verifyRegistration invalidates user:session cache upon success
  it('18. verifyRegistration invalidates user:session cache upon success', async () => {
    mockWebAuthn.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: 'pk_cache_test_id', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        aaguid: '00000000-0000-0000-0000-000000000000',
      },
    });
    const regChallengeKey = PASSKEY_REDIS_KEYS.regChallenge('user_cache_inval');
    mockRedis.get.mockImplementation(async (key: string) => {
      if (key === regChallengeKey) {
        return 'mock_reg_challenge_token';
      }
      return null;
    });

    const ctx = createMockCtx(
      { id: 'user_cache_inval', supabaseAuthId: 'sb_auth_cache_reg', organizationId: 'org_1' },
      {
        passkey: {
          create: vi.fn().mockResolvedValue({
            id: 'pk_cache_1',
            deviceName: 'Hardware Key',
            createdAt: new Date(),
          }),
        },
      },
    );

    const caller = passkeyRouter.createCaller(ctx as any);
    await caller.verifyRegistration({
      response: {
        id: 'pk_cache_test_id',
        rawId: 'pk_cache_test_id',
        response: { clientDataJSON: 'e30', attestationObject: 'e30', transports: ['usb'] },
        type: 'public-key',
        clientExtensionResults: {},
      },
      deviceName: 'Hardware Key',
    });

    expect(mockRedis.del).toHaveBeenCalledWith('user:session:sb_auth_cache_reg');
  });

  // 19. deletePasskey invalidates user:session cache upon success
  it('19. deletePasskey invalidates user:session cache upon success', async () => {
    const ctx = createMockCtx(
      { id: 'user_cache_del', supabaseAuthId: 'sb_auth_cache_del', organizationId: 'org_1' },
      {
        passkey: {
          findUnique: vi.fn().mockResolvedValue({ id: 'pk_to_delete', userId: 'user_cache_del' }),
          delete: vi.fn().mockResolvedValue({ id: 'pk_to_delete' }),
          count: vi.fn().mockResolvedValue(0),
        },
      },
    );

    const caller = passkeyRouter.createCaller(ctx as any);
    const result = await caller.deletePasskey({ id: 'pk_to_delete' });

    expect(result.success).toBe(true);
    expect(result.remainingPasskeyCount).toBe(0);
    expect(mockRedis.del).toHaveBeenCalledWith('user:session:sb_auth_cache_del');
  });
});

