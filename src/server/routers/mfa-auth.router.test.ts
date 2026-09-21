import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeMetadata, SECURITY_EVENT_TYPES } from '../services/audit.service';
import { MFA_ENROLLMENT_ALLOWED_PATHS, isPathAllowed, organizationMfaEnforced } from '../trpc/trpc';
import { encryptMfaChallenge } from '../lib/mfa-challenge-crypto';

function src(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('MFA Database Schema & Relations', () => {
  const schemaPrisma = readFileSync(
    resolve(__dirname, '../../../prisma/schema.prisma'),
    'utf8'
  );

  it('defines UserBackupCode model with correct fields and cascade delete', () => {
    expect(schemaPrisma).toContain('model UserBackupCode {');
    expect(schemaPrisma).toContain('userId    String');
    expect(schemaPrisma).toContain('codeHash  String');
    expect(schemaPrisma).toContain('usedAt    DateTime?');
    expect(schemaPrisma).toContain('createdAt DateTime  @default(now())');
    expect(schemaPrisma).toContain('onDelete: Cascade');
  });

  it('includes backupCodes relation in User model', () => {
    expect(schemaPrisma).toMatch(/backupCodes\s+UserBackupCode\[\]/);
  });

  it('defines SecurityAuditEvent model with proper fields, indexes, and relations', () => {
    expect(schemaPrisma).toContain('model SecurityAuditEvent {');
    expect(schemaPrisma).toContain('eventType      String');
    expect(schemaPrisma).toContain('ipAddress      String?');
    expect(schemaPrisma).toContain('userAgent      String?');
    expect(schemaPrisma).toContain('metadata       Json?');
    expect(schemaPrisma).toContain('createdAt      DateTime  @default(now())');
    expect(schemaPrisma).toContain('onDelete: SetNull');
    expect(schemaPrisma).toMatch(/securityAuditEvents\s+SecurityAuditEvent\[\]/);
  });

  it('includes mfaPolicyGraceHours on Organization model', () => {
    expect(schemaPrisma).toMatch(/mfaPolicyGraceHours\s+Int\s+@default\(48\)/);
  });
});

describe('Security Audit Service & Metadata Sanitization', () => {
  it('strips all sensitive keys from audit event metadata', () => {
    const rawMetadata = {
      code: '123456',
      totpCode: '654321',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      tempToken: 'super-secret-temp-token',
      password: 'MySecretPassword123!',
      backupCode: 'ABCD-EFGH',
      backupCodes: ['ABCD-EFGH', 'IJKL-MNOP'],
      // Safe metadata to retain
      userId: 'user_123',
      organizationId: 'org_456',
      action: 'disableTotp',
      attempts: 3,
      method: 'backup_code',
    };

    const sanitized = sanitizeMetadata(rawMetadata);
    expect(sanitized).toBeDefined();
    expect(sanitized).not.toHaveProperty('code');
    expect(sanitized).not.toHaveProperty('totpCode');
    expect(sanitized).not.toHaveProperty('totpSecret');
    expect(sanitized).not.toHaveProperty('tempToken');
    expect(sanitized).not.toHaveProperty('password');
    expect(sanitized).not.toHaveProperty('backupCode');
    expect(sanitized).not.toHaveProperty('backupCodes');

    expect(sanitized).toEqual({
      userId: 'user_123',
      organizationId: 'org_456',
      action: 'disableTotp',
      attempts: 3,
      method: 'backup_code',
    });
  });

  it('recursively sanitizes nested objects, arrays, and cyclic references', () => {
    // 1. Nested object
    expect(sanitizeMetadata({ payload: { code: '123456' } })).toEqual({ payload: {} });

    // 2. Array elements
    expect(sanitizeMetadata({ items: [{ password: 'x', label: 'ok' }] })).toEqual({
      items: [{ label: 'ok' }],
    });

    // 3. Deeply nested
    expect(sanitizeMetadata({ a: { b: { c: { tempToken: 'x' } } } })).toEqual({
      a: { b: { c: {} } },
    });

    // 4. Cyclic input does not throw and marks circular reference
    const cyclic: any = { safe: 'value' };
    cyclic.self = cyclic;
    let cyclicResult: any;
    expect(() => {
      cyclicResult = sanitizeMetadata(cyclic);
    }).not.toThrow();
    expect(cyclicResult.safe).toBe('value');
    expect(cyclicResult.self).toBe('[Circular]');
  });

  it('forbids all WebAuthn / Passkey metadata keys at nested depth', () => {
    const raw = {
      action: 'passkey_operation',
      details: {
        challenge: 'abc-challenge-123',
        credentialId: 'cred-id-456',
        nested: {
          publicKey: 'raw-public-key',
          signature: 'sig-789',
          clientDataJSON: 'client-data-json',
          authenticatorData: 'auth-data',
          attestationObject: 'attestation-obj',
          userHandle: 'user-handle-val',
        },
      },
      safeField: 'retained',
    };

    const sanitized = sanitizeMetadata(raw);
    expect(sanitized).toEqual({
      action: 'passkey_operation',
      details: {
        nested: {},
      },
      safeField: 'retained',
    });
  });

  it('defines all required regulatory MFA security event types', () => {
    expect(SECURITY_EVENT_TYPES.MFA_CHALLENGE_ISSUED).toBe('MFA_CHALLENGE_ISSUED');
    expect(SECURITY_EVENT_TYPES.MFA_VERIFY_SUCCESS).toBe('MFA_VERIFY_SUCCESS');
    expect(SECURITY_EVENT_TYPES.MFA_VERIFY_FAILED).toBe('MFA_VERIFY_FAILED');
    expect(SECURITY_EVENT_TYPES.MFA_BACKUP_CODE_USED).toBe('MFA_BACKUP_CODE_USED');
    expect(SECURITY_EVENT_TYPES.MFA_RATE_LIMITED).toBe('MFA_RATE_LIMITED');
    expect(SECURITY_EVENT_TYPES.MFA_ENROLLED).toBe('MFA_ENROLLED');
    expect(SECURITY_EVENT_TYPES.MFA_DISABLED).toBe('MFA_DISABLED');
    expect(SECURITY_EVENT_TYPES.MFA_ENFORCEMENT_BLOCKED).toBe('MFA_ENFORCEMENT_BLOCKED');
    expect(SECURITY_EVENT_TYPES.MFA_ENFORCEMENT_GRACE).toBe('MFA_ENFORCEMENT_GRACE');
  });
});

describe('MFA Authentication Router Hardening Contract', () => {
  const authRouterSrc = src('auth.router.ts');
  const authSchemaSrc = src('../schemas/auth.schema.ts');

  it('defines verifyTotpLogin schema accepting tempToken and code with flexible length', () => {
    expect(authSchemaSrc).toContain('verifyTotpLoginSchema');
    expect(authSchemaSrc).toContain('tempToken');
    expect(authSchemaSrc).toContain('code');
  });

  it('login challenges MFA users, records audit log, and returns tempToken', () => {
    expect(authRouterSrc).toContain("sheriabot:auth:mfa_challenge:");
    expect(authRouterSrc).toContain("mfaRequired: true");
    expect(authRouterSrc).toContain("tempToken");
    expect(authRouterSrc).toContain("MFA_CHALLENGE_ISSUED");
  });

  it('verifyTotpLogin enforces 5-attempt rate limit and deletes challenge on exhaustion', () => {
    expect(authRouterSrc).toContain("sheriabot:auth:mfa_attempts:");
    expect(authRouterSrc).toContain("attempts > 5");
    expect(authRouterSrc).toContain("MFA_RATE_LIMITED");
    expect(authRouterSrc).toContain("MFA_ATTEMPTS_EXCEEDED");
  });

  it('verifyTotpLogin enforces atomic backup code consumption with normalized formatting', () => {
    expect(authRouterSrc).toContain("replace(/[-\\s]/g, '').toUpperCase()");
    expect(authRouterSrc).toContain("ctx.prisma.userBackupCode.updateMany");
    expect(authRouterSrc).toContain("claimResult.count === 1");
    expect(authRouterSrc).toContain("MFA_BACKUP_CODE_USED");
  });

  it('verifyTotpLogin deletes challenge key on terminal success and logs verify success', () => {
    expect(authRouterSrc).toContain("redis.del(challengeKey)");
    expect(authRouterSrc).toContain("redis.del(attemptKey)");
    expect(authRouterSrc).toContain("MFA_VERIFY_SUCCESS");
  });
});

describe('MFA User Router Hardening Contract (Setup & 2FA Disable)', () => {
  const userRouterSrc = src('user.router.ts');
  const userSchemaSrc = src('../schemas/user.schema.ts');

  it('disableTotpSchema requires both password and 2FA code', () => {
    expect(userSchemaSrc).toContain("disableTotpSchema");
    expect(userSchemaSrc).toContain("password");
    expect(userSchemaSrc).toContain("code");
    expect(userSchemaSrc).toContain("isBackupCode");
  });

  it('confirmTotpSetup logs MFA_ENROLLED upon successful 2FA activation', () => {
    expect(userRouterSrc).toContain("confirmTotpSetup: protectedProcedure");
    expect(userRouterSrc).toContain("MFA_ENROLLED");
  });

  it('disableTotp verifies 2nd factor, rate-limits attempts, and logs MFA_DISABLED', () => {
    expect(userRouterSrc).toContain("disableTotp: protectedProcedure");
    expect(userRouterSrc).toContain("sheriabot:auth:mfa_disable_attempts:");
    expect(userRouterSrc).toContain("attempts > 5");
    expect(userRouterSrc).toContain("isValidSecondFactor");
    expect(userRouterSrc).toContain("MFA_DISABLED");
  });

  it('disableTotp explicitly revokes DB sessions and Redis session caches', () => {
    expect(userRouterSrc).toContain("ctx.prisma.session.deleteMany({");
    expect(userRouterSrc).toContain("userCache.delete(ctx.user.id)");
    expect(userRouterSrc).toContain("redis.del(`user:session:");
    expect(userRouterSrc).toContain("// No userId-keyed session cache exists; fingerprint keys are keyed by sessionId and become unreachable once DB rows are deleted.");
  });
});

describe('MFA Organization Enforcement Middleware & Grace Period', () => {
  const trpcSrc = src('../trpc/trpc.ts');
  const orgRouterSrc = src('../routers/organization.router.ts');

  it('organization router supports configurable grace hours and setMfaPolicy', () => {
    expect(orgRouterSrc).toContain("setMfaPolicy: protectedProcedure");
    expect(orgRouterSrc).toContain("mfaPolicyGraceHours");
    expect(orgRouterSrc).toContain("updateSecurityPolicy: protectedProcedure");
  });

  it('middleware computes grace deadline and attaches grace state within window', () => {
    expect(trpcSrc).toContain("organizationMfaEnforced");
    expect(trpcSrc).toContain("mfaPolicyGraceHours");
    expect(trpcSrc).toContain("nowMs < graceDeadlineMs");
    expect(trpcSrc).toContain("MFA_ENFORCEMENT_GRACE");
    expect(trpcSrc).toContain("state: 'grace'");
  });

  it('middleware blocks non-enrolled members and logs audit event when grace period expires', () => {
    expect(trpcSrc).toContain("MFA_ENFORCEMENT_BLOCKED");
    expect(trpcSrc).toContain("MFA_ENROLLMENT_REQUIRED");
  });

  it('whitelists all necessary UI/dashboard paths to prevent redirect loops via isPathAllowed', () => {
    const requiredPaths = [
      'auth.me',
      'auth.logout',
      'auth.getSessions',
      'auth.revokeSession',
      'auth.revokeAllSessions',
      'auth.revokeOtherSessions',
      'user.getProfile',
      'user.getTotpStatus',
      'user.setupTotp',
      'user.confirmTotpSetup',
      'user.disableTotp',
      'organization.getSecurityCenter',
      'organization.getTeamOverview',
      'organization.getOrganization',
      'billing.getCurrentPlan',
      'billing.getSubscription',
    ];

    for (const p of requiredPaths) {
      expect(isPathAllowed(p)).toBe(true);
      expect(MFA_ENROLLMENT_ALLOWED_PATHS.has(p)).toBe(true);
    }
    expect(isPathAllowed('organization.deleteOrganization')).toBe(false);
  });

  it('handles requireMfa = true with null mfaPolicyEnabledAt via lazy backfill grace period', async () => {
    let persistedTimestamp: Date | null = null;
    const mockPrisma = {
      organization: {
        findUnique: vi.fn().mockImplementation(async () => ({
          requireMfa: true,
          mfaPolicyEnabledAt: persistedTimestamp,
          mfaPolicyGraceHours: 48,
        })),
        updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
          persistedTimestamp = data.mfaPolicyEnabledAt;
          return { count: 1 };
        }),
      },
    };

    const mockCtx = {
      user: {
        id: 'user_test_1',
        role: 'USER',
        totpEnabled: false,
        organizationId: 'org_test_1',
      },
      prisma: mockPrisma,
      req: { ip: '127.0.0.1', headers: {} },
    };

    let nextCtx: any = null;
    const nextFn = vi.fn().mockImplementation((opts?: any) => {
      nextCtx = opts?.ctx;
      return { ok: true };
    });

    const handler = (organizationMfaEnforced as any)._middlewares?.[0] || organizationMfaEnforced;
    await (handler as any)({
      ctx: mockCtx,
      path: 'compliance.getScore',
      next: nextFn,
    });

    expect(mockPrisma.organization.updateMany).toHaveBeenCalledTimes(1);
    expect(persistedTimestamp).not.toBeNull();
    expect(nextFn).toHaveBeenCalled();
    expect(nextCtx?.mfaEnforcement?.state).toBe('grace');

    // Second request: reads persisted timestamp
    nextCtx = null;
    await (handler as any)({
      ctx: mockCtx,
      path: 'compliance.getScore',
      next: nextFn,
    });
    expect(mockPrisma.organization.findUnique).toHaveBeenCalledTimes(2);
    expect(nextCtx?.mfaEnforcement?.state).toBe('grace');
  });

  it('allows all whitelisted paths through organizationMfaEnforced without throwing', async () => {
    const mockCtx = {
      user: {
        id: 'user_test_2',
        role: 'USER',
        totpEnabled: false,
        organizationId: 'org_test_2',
      },
      prisma: {
        organization: {
          findUnique: vi.fn().mockResolvedValue({
            requireMfa: true,
            mfaPolicyEnabledAt: new Date(Date.now() - 100 * 3600 * 1000), // expired grace
            mfaPolicyGraceHours: 48,
          }),
        },
      },
      req: { ip: '127.0.0.1', headers: {} },
    };

    const handler = (organizationMfaEnforced as any)._middlewares?.[0] || organizationMfaEnforced;

    for (const allowedPath of MFA_ENROLLMENT_ALLOWED_PATHS) {
      const nextFn = vi.fn().mockReturnValue({ ok: true });
      await expect(
        (handler as any)({
          ctx: mockCtx,
          path: allowedPath,
          next: nextFn,
        })
      ).resolves.not.toThrow();
      expect(nextFn).toHaveBeenCalled();
    }
  });

  it('blocks non-whitelisted paths when grace period is expired with PRECONDITION_FAILED', async () => {
    const mockCtx = {
      user: {
        id: 'user_test_3',
        role: 'USER',
        totpEnabled: false,
        organizationId: 'org_test_3',
      },
      prisma: {
        organization: {
          findUnique: vi.fn().mockResolvedValue({
            requireMfa: true,
            mfaPolicyEnabledAt: new Date(Date.now() - 100 * 3600 * 1000), // expired grace
            mfaPolicyFirstEnabledAt: new Date(Date.now() - 100 * 3600 * 1000),
            mfaPolicyGraceHours: 48,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      },
      req: { ip: '127.0.0.1', headers: {} },
    };

    const handler = (organizationMfaEnforced as any)._middlewares?.[0] || organizationMfaEnforced;
    const nextFn = vi.fn().mockReturnValue({ ok: true });

    await expect(
      (handler as any)({
        ctx: mockCtx,
        path: 'organization.deleteOrganization',
        next: nextFn,
      })
    ).rejects.toThrow('MFA_ENROLLMENT_REQUIRED');
  });
});

describe('F-02: AES-256-GCM Encrypted MFA Challenges (auth.login & auth.verifyTotpLogin)', () => {
  const authRouterSrc = src('auth.router.ts');

  it('uses encryptMfaChallenge in auth.login and avoids plaintext token storage in Redis', () => {
    expect(authRouterSrc).toContain("encryptMfaChallenge({");
    expect(authRouterSrc).toContain("accessToken: authData.session.access_token");
    expect(authRouterSrc).toContain("refreshToken: authData.session.refresh_token");
    expect(authRouterSrc).not.toContain("supabaseAccessToken: authData.session.access_token");
  });

  it('uses decryptMfaChallenge in verifyTotpLogin and logs MFA_CHALLENGE_DECRYPTION_FAILED on error', () => {
    expect(authRouterSrc).toContain("decryptMfaChallenge(raw)");
    expect(authRouterSrc).toContain("MfaChallengeDecryptError");
    expect(authRouterSrc).toContain("MFA_CHALLENGE_DECRYPTION_FAILED");
    expect(authRouterSrc).toContain("'MFA session expired. Please sign in again.'");
  });

  it('verifies that an encrypted MFA challenge string conforms to <userId>.<iv>.<tag>.<ciphertext>', () => {
    const rawAccessToken = 'supabase-jwt-secret-access-token-12345';
    const encrypted = encryptMfaChallenge({
      userId: 'usr_enc_test',
      accessToken: rawAccessToken,
      refreshToken: 'supabase-refresh-token-67890',
    });

    const segments = encrypted.split('.');
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe('usr_enc_test');
    expect(encrypted).not.toContain('access_token');
    expect(encrypted).not.toContain(rawAccessToken);
  });
});

describe('F-04: MFA Compliance Shared Helper (userSatisfiesMfa)', () => {
  it('correctly evaluates MFA compliance for TOTP and Passkey combinations', async () => {
    const { userSatisfiesMfa } = await import('../lib/mfa-compliance');
    expect(userSatisfiesMfa({ totpEnabled: true, hasPasskey: false })).toBe(true);
    expect(userSatisfiesMfa({ totpEnabled: false, hasPasskey: true })).toBe(true);
    expect(userSatisfiesMfa({ totpEnabled: true, hasPasskey: true })).toBe(true);
    expect(userSatisfiesMfa({ totpEnabled: false, hasPasskey: false })).toBe(false);
  });

  it('verifies setMfaPolicy and organizationMfaEnforced use userSatisfiesMfa', () => {
    const orgRouterSrc = src('organization.router.ts');
    const trpcSrc = src('../trpc/trpc.ts');
    expect(orgRouterSrc).toContain('userSatisfiesMfa(ctx.user)');
    expect(trpcSrc).toContain('userSatisfiesMfa(ctx.user)');
  });
});

describe('F-03: Immutable mfaPolicyFirstEnabledAt & Grace Period Invariants', () => {
  const schemaPrisma = readFileSync(
    resolve(__dirname, '../../../prisma/schema.prisma'),
    'utf8'
  );
  const migrationSql = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260921120000_add_mfa_policy_first_enabled_at/migration.sql'),
    'utf8'
  );
  const trpcSrc = src('../trpc/trpc.ts');
  const orgRouterSrc = src('organization.router.ts');

  it('defines mfaPolicyFirstEnabledAt on Organization model and migration includes backfill', () => {
    expect(schemaPrisma).toContain('mfaPolicyFirstEnabledAt DateTime?');
    expect(migrationSql).toContain('ALTER TABLE "Organization" ADD COLUMN "mfaPolicyFirstEnabledAt" TIMESTAMP(3);');
    expect(migrationSql).toContain('SET "mfaPolicyFirstEnabledAt" = "mfaPolicyEnabledAt"');
  });

  it('setMfaPolicy initializes mfaPolicyFirstEnabledAt on first enable and preserves it on re-enable', () => {
    expect(orgRouterSrc).toContain('mfaPolicyFirstEnabledAt: true');
    expect(orgRouterSrc).toContain('if (!existingOrg?.mfaPolicyFirstEnabledAt)');
    expect(orgRouterSrc).toContain('mfaPolicyFirstEnabledAt = now;');
  });

  it('organizationMfaEnforced calculates grace period from mfaPolicyFirstEnabledAt', () => {
    expect(trpcSrc).toContain('let firstEnabledAt = org.mfaPolicyFirstEnabledAt ?? org.mfaPolicyEnabledAt;');
    expect(trpcSrc).toContain('const graceDeadlineMs = new Date(firstEnabledAt).getTime() + graceHours * 3600 * 1000;');
  });

  it('organizationMfaEnforced lazy backfill handles pre-migration edge case', () => {
    expect(trpcSrc).toContain('where: { id: ctx.user.organizationId, mfaPolicyFirstEnabledAt: null }');
  });

  it('throws INTERNAL_SERVER_ERROR if lazy backfill updateMany throws (fail-closed)', async () => {
    const mockCtx = {
      user: {
        id: 'user_fail_close',
        role: 'USER',
        totpEnabled: false,
        organizationId: 'org_fail_close',
      },
      prisma: {
        organization: {
          findUnique: vi.fn().mockResolvedValue({
            requireMfa: true,
            mfaPolicyEnabledAt: null,
            mfaPolicyFirstEnabledAt: null,
            mfaPolicyGraceHours: 48,
          }),
          updateMany: vi.fn().mockRejectedValue(new Error('DB connection dropped')),
        },
      },
      req: { ip: '127.0.0.1', headers: {} },
    };

    const handler = (organizationMfaEnforced as any)._middlewares?.[0] || organizationMfaEnforced;
    const nextFn = vi.fn();

    await expect(
      (handler as any)({
        ctx: mockCtx,
        path: 'compliance.getQueries',
        next: nextFn,
      })
    ).rejects.toThrow('MFA policy configuration could not be initialized. Please try again.');
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('handles race condition on concurrent first requests by refetching persisted timestamp when count is 0', async () => {
    const persistedTimestamp = new Date(Date.now() - 10 * 3600 * 1000); // 10h ago
    const mockCtx = {
      user: {
        id: 'user_race_condition',
        role: 'USER',
        totpEnabled: false,
        organizationId: 'org_race',
      },
      prisma: {
        organization: {
          findUnique: vi
            .fn()
            // 1st call: initial lookup with nulls
            .mockResolvedValueOnce({
              requireMfa: true,
              mfaPolicyEnabledAt: null,
              mfaPolicyFirstEnabledAt: null,
              mfaPolicyGraceHours: 48,
            })
            // 2nd call: refetch after updateMany count === 0
            .mockResolvedValueOnce({
              mfaPolicyFirstEnabledAt: persistedTimestamp,
              mfaPolicyEnabledAt: persistedTimestamp,
            }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      },
      req: { ip: '127.0.0.1', headers: {} },
    };

    const handler = (organizationMfaEnforced as any)._middlewares?.[0] || organizationMfaEnforced;
    const nextFn = vi.fn().mockImplementation(({ ctx }) => {
      return { ok: true, deadline: ctx.mfaEnforcement?.deadline };
    });

    const res = await (handler as any)({
      ctx: mockCtx,
      path: 'compliance.getQueries',
      next: nextFn,
    });

    expect(nextFn).toHaveBeenCalled();
    const expectedDeadline = new Date(persistedTimestamp.getTime() + 48 * 3600 * 1000);
    expect(res.deadline.getTime()).toBe(expectedDeadline.getTime());
  });
});

describe('Fix 4: AuditLog Foreign Key onDelete SetNull', () => {
  const schemaPrisma = readFileSync(
    resolve(__dirname, '../../../prisma/schema.prisma'),
    'utf8'
  );
  const migrationSql = readFileSync(
    resolve(__dirname, '../../../prisma/migrations/20260921130000_fix_auditlog_user_fk_ondelete/migration.sql'),
    'utf8'
  );

  it('defines onDelete: SetNull on AuditLog.user relation in schema and migration SQL', () => {
    expect(schemaPrisma).toMatch(/user\s+User\?\s+@relation\(fields:\s*\[userId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/);
    expect(migrationSql).toContain('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";');
    expect(migrationSql).toContain('REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;');
  });
});

