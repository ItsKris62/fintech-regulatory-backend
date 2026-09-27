import { describe, it, expect } from 'vitest';
import { hasRole } from '../middleware';
import {
  publicProcedure,
  supportAdminProcedure,
  billingAdminProcedure,
  securityAdminProcedure,
  superAdminProcedure,
  router,
} from '../trpc';
import { UserRole } from '@prisma/client';

describe('SEC-02: RBAC Sub-Role Split', () => {
  it('defines all four sub-roles on UserRole enum', () => {
    expect(UserRole).toHaveProperty('SUPPORT_ADMIN');
    expect(UserRole).toHaveProperty('BILLING_ADMIN');
    expect(UserRole).toHaveProperty('SECURITY_ADMIN');
    expect(UserRole).toHaveProperty('SUPER_ADMIN');
  });

  describe('hasRole middleware', () => {
    const makeCaller = (allowedRole: string, user: any) => {
      const tRouter = router({
        check: publicProcedure.use(hasRole(allowedRole)).query(() => ({ ok: true })),
      });
      return tRouter.createCaller({ user, req: { ip: '127.0.0.1', headers: {} } } as any);
    };

    it('allows user with matching role', async () => {
      const caller = makeCaller('SUPPORT_ADMIN', { id: 'u1', role: 'SUPPORT_ADMIN' });
      await expect(caller.check()).resolves.toEqual({ ok: true });
    });

    it('allows SUPER_ADMIN as a superset on any scoped role check', async () => {
      const caller = makeCaller('BILLING_ADMIN', { id: 'u2', role: 'SUPER_ADMIN' });
      await expect(caller.check()).resolves.toEqual({ ok: true });
    });

    it('allows legacy ADMIN for backward compatibility', async () => {
      const caller = makeCaller('SECURITY_ADMIN', { id: 'u3', role: 'ADMIN' });
      await expect(caller.check()).resolves.toEqual({ ok: true });
    });

    it('throws FORBIDDEN when user lacks required role', async () => {
      const caller = makeCaller('BILLING_ADMIN', { id: 'u4', role: 'SUPPORT_ADMIN' });
      await expect(caller.check()).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN' })
      );
    });

    it('throws UNAUTHORIZED when no user is in context', async () => {
      const caller = makeCaller('SUPPORT_ADMIN', null);
      await expect(caller.check()).rejects.toThrowError(
        expect.objectContaining({ code: 'UNAUTHORIZED' })
      );
    });
  });

  describe('Scoped procedure builders', () => {
    const testRouter = router({
      supportOp: supportAdminProcedure.query(() => ({ ok: true })),
      billingOp: billingAdminProcedure.query(() => ({ ok: true })),
      securityOp: securityAdminProcedure.query(() => ({ ok: true })),
      superOp: superAdminProcedure.query(() => ({ ok: true })),
    });

    const createCaller = (role: string, totpEnabled = true) =>
      testRouter.createCaller({
        user: {
          id: 'test-admin',
          email: 'admin@sheriabot.com',
          role,
          organizationId: 'org-admin',
          supabaseAuthId: 'sub-admin',
          totpEnabled,
          hasPasskey: false,
        },
        prisma: {} as any,
        tenantPrisma: {} as any,
        req: { ip: '127.0.0.1', headers: {} } as any,
        res: {} as any,
      } as any);

    it('enforces SUPPORT_ADMIN access', async () => {
      const supportCaller = createCaller('SUPPORT_ADMIN');
      await expect(supportCaller.supportOp()).resolves.toEqual({ ok: true });
      await expect(supportCaller.billingOp()).rejects.toThrowError(/Insufficient role permissions|Admin access required/);
      await expect(supportCaller.superOp()).rejects.toThrowError(/Insufficient role permissions|Admin access required/);
    });

    it('enforces BILLING_ADMIN access', async () => {
      const billingCaller = createCaller('BILLING_ADMIN');
      await expect(billingCaller.billingOp()).resolves.toEqual({ ok: true });
      await expect(billingCaller.supportOp()).rejects.toThrowError(/Insufficient role permissions|Admin access required/);
      await expect(billingCaller.securityOp()).rejects.toThrowError(/Insufficient role permissions|Admin access required/);
    });

    it('enforces SECURITY_ADMIN access', async () => {
      const securityCaller = createCaller('SECURITY_ADMIN');
      await expect(securityCaller.securityOp()).resolves.toEqual({ ok: true });
      await expect(securityCaller.billingOp()).rejects.toThrowError(/Insufficient role permissions|Admin access required/);
      await expect(securityCaller.superOp()).rejects.toThrowError(/Insufficient role permissions|Admin access required/);
    });

    it('allows SUPER_ADMIN to call all procedures', async () => {
      const superCaller = createCaller('SUPER_ADMIN');
      await expect(superCaller.supportOp()).resolves.toEqual({ ok: true });
      await expect(superCaller.billingOp()).resolves.toEqual({ ok: true });
      await expect(superCaller.securityOp()).resolves.toEqual({ ok: true });
      await expect(superCaller.superOp()).resolves.toEqual({ ok: true });
    });
  });
});
