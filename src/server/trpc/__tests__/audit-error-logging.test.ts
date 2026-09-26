import { describe, it, expect, vi, beforeEach } from 'vitest';

const warnSpy = vi.fn();
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: any[]) => warnSpy(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockAuditCreate = vi.fn();
vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    auditLog: {
      create: (...args: any[]) => mockAuditCreate(...args),
    },
    organizationMember: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

import { router, baseProcedure } from '../init';
import { requireOrgMembership } from '../middleware';

describe('F-10: Audit log error swallowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits structured WARN when authorization.granted audit write fails', async () => {
    mockAuditCreate.mockRejectedValue(new Error('Audit DB write failure'));

    const ctx: any = {
      user: { id: 'usr_123', organizationId: 'org_123' },
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } },
    };

    const { prisma } = await import('@/lib/prisma/client');
    (prisma.organizationMember.findUnique as any).mockResolvedValueOnce({
      userId: 'usr_123',
      organizationId: 'org_123',
      role: 'MEMBER',
      status: 'ACTIVE',
    });

    const testRouter = router({
      testProc: baseProcedure.use(requireOrgMembership).query(() => ({ ok: true })),
    });

    const caller = testRouter.createCaller(ctx);
    const res = await caller.testProc();
    expect(res).toEqual({ ok: true });

    // Allow background catch handlers to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'authorization_granted_audit_write_failed',
        error: 'Audit DB write failure',
      }),
    );
  });
});
