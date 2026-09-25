import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  executeAdminMfaEnforced,
  ADMIN_ZERO_FACTOR_ALLOWED_PATHS,
  ADMIN_STEP_UP_MUTATION_PATHS,
  recordFreshMfaVerification,
  isFreshMfaChallengeVerified,
} from '../trpc';
import { TRPCError } from '@trpc/server';
import { redis } from '@/lib/redis/client';

vi.mock('@/lib/redis/client', () => {
  const store = new Map<string, string>();
  return {
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
      _store: store,
    },
  };
});

vi.mock('@/server/services/audit.service', () => ({
  logSecurityEvent: vi.fn().mockResolvedValue(undefined),
  SECURITY_EVENT_TYPES: {
    MFA_ENFORCEMENT_BLOCKED: 'mfa_enforcement_blocked',
  },
}));

describe('adminMfaEnforced state-gated & step-up behavioral enforcement (F-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (redis as any)._store.clear();
  });

  describe('Unenrolled Admin (0 factors enrolled)', () => {
    it('blocks unenrolled admin attempting any administrative procedure', async () => {
      const next = vi.fn();
      const ctx = {
        user: { id: 'admin-1', role: 'ADMIN', totpEnabled: false, hasPasskey: false },
        req: { headers: {} },
      } as any;

      await expect(
        executeAdminMfaEnforced({
          ctx,
          path: 'admin.getDashboardStats',
          next,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'PRECONDITION_FAILED',
          message: 'MFA_REQUIRED_FOR_ADMIN',
        })
      );

      expect(next).not.toHaveBeenCalled();
    });

    it('blocks unenrolled admin attempting user.disableTotp', async () => {
      const next = vi.fn();
      const ctx = {
        user: { id: 'admin-1', role: 'ADMIN', totpEnabled: false, hasPasskey: false },
        req: { headers: {} },
      } as any;

      await expect(
        executeAdminMfaEnforced({
          ctx,
          path: 'user.disableTotp',
          next,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'PRECONDITION_FAILED',
          message: 'MFA_REQUIRED_FOR_ADMIN',
        })
      );

      expect(next).not.toHaveBeenCalled();
    });

    it('allows unenrolled admin exclusively on factor setup paths', async () => {
      const allowed = ['user.setupTotp', 'user.confirmTotpSetup', 'passkey.generateRegistrationOptions', 'passkey.verifyRegistration'];

      for (const path of allowed) {
        const next = vi.fn().mockResolvedValue({ ok: true });
        const ctx = {
          user: { id: 'admin-1', role: 'ADMIN', totpEnabled: false, hasPasskey: false },
          req: { headers: {} },
        } as any;

        const result = await executeAdminMfaEnforced({
          ctx,
          path,
          next,
        });

        expect(next).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ ok: true });
      }
    });
  });

  describe('Enrolled Admin (1+ factors enrolled) & Step-up Enforcement', () => {
    it('allows standard admin procedures for enrolled admin without step-up', async () => {
      const next = vi.fn().mockResolvedValue({ ok: true });
      const ctx = {
        user: { id: 'admin-enrolled', role: 'ADMIN', totpEnabled: true, hasPasskey: false },
        req: { headers: {} },
      } as any;

      const result = await executeAdminMfaEnforced({
        ctx,
        path: 'admin.getDashboardStats',
        next,
      });

      expect(next).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
    });

    it('REJECTS enrolled admin calling user.disableTotp when fresh step-up challenge is missing', async () => {
      const next = vi.fn();
      const ctx = {
        user: { id: 'admin-enrolled', role: 'ADMIN', totpEnabled: true, hasPasskey: false },
        req: { headers: {} },
      } as any;

      await expect(
        executeAdminMfaEnforced({
          ctx,
          path: 'user.disableTotp',
          next,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'PRECONDITION_FAILED',
          message: 'MFA_STEP_UP_REQUIRED',
        })
      );

      expect(next).not.toHaveBeenCalled();
    });

    it('REJECTS enrolled admin calling user.disableTotp when step-up challenge is expired (>15 min)', async () => {
      const next = vi.fn();
      const ctx = {
        user: { id: 'admin-enrolled', role: 'ADMIN', totpEnabled: true, hasPasskey: false },
        req: { headers: {} },
      } as any;

      // Seed expired step-up challenge (16 minutes ago)
      (redis as any)._store.set('sheriabot:admin:mfa_verified:admin-enrolled', String(Date.now() - 16 * 60 * 1000));

      await expect(
        executeAdminMfaEnforced({
          ctx,
          path: 'user.disableTotp',
          next,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'PRECONDITION_FAILED',
          message: 'MFA_STEP_UP_REQUIRED',
        })
      );

      expect(next).not.toHaveBeenCalled();
    });

    it('ALLOWS enrolled admin calling user.disableTotp when fresh step-up challenge was verified within 15 min', async () => {
      const next = vi.fn().mockResolvedValue({ success: true });
      const ctx = {
        user: { id: 'admin-enrolled', role: 'ADMIN', totpEnabled: true, hasPasskey: false },
        req: { headers: {} },
      } as any;

      // Record fresh step-up verification (e.g. just now)
      await recordFreshMfaVerification('admin-enrolled');

      const result = await executeAdminMfaEnforced({
        ctx,
        path: 'user.disableTotp',
        next,
      });

      expect(next).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    it('REJECTS enrolled admin on admin.auth.* mutations without fresh step-up', async () => {
      const next = vi.fn();
      const ctx = {
        user: { id: 'admin-enrolled', role: 'ADMIN', totpEnabled: true, hasPasskey: false },
        req: { headers: {} },
      } as any;

      await expect(
        executeAdminMfaEnforced({
          ctx,
          path: 'admin.auth.resetUserMfa',
          next,
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'PRECONDITION_FAILED',
          message: 'MFA_STEP_UP_REQUIRED',
        })
      );

      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Non-Admin Users', () => {
    it('non-admin users completely bypass adminMfaEnforced even on user.disableTotp', async () => {
      const next = vi.fn().mockResolvedValue({ ok: true });
      const ctx = {
        user: { id: 'regular-user', role: 'MEMBER', totpEnabled: true, hasPasskey: false },
        req: { headers: {} },
      } as any;

      const result = await executeAdminMfaEnforced({
        ctx,
        path: 'user.disableTotp',
        next,
      });

      expect(next).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
    });
  });
});
