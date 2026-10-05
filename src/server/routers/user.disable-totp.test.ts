import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
  verifyPassword: vi.fn(),
  userCacheDelete: vi.fn(),
  evictInMemoryUserSession: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

vi.mock('@/lib/redis/client', () => ({ redis: mocks.redis }));
vi.mock('@/lib/redis/cache.service', () => ({
  userCache: { delete: mocks.userCacheDelete },
}));
vi.mock('@/utils/helpers', () => ({
  hashPassword: vi.fn(async (value: string) => `hashed:${value}`),
  verifyPassword: mocks.verifyPassword,
}));
vi.mock('@/server/services/audit.service', () => ({
  logSecurityEvent: mocks.logSecurityEvent,
  SECURITY_EVENT_TYPES: {
    MFA_RATE_LIMITED: 'MFA_RATE_LIMITED',
    MFA_VERIFY_FAILED: 'MFA_VERIFY_FAILED',
    MFA_BACKUP_CODE_USED: 'MFA_BACKUP_CODE_USED',
    MFA_DISABLED: 'MFA_DISABLED',
    MFA_ENROLLED: 'MFA_ENROLLED',
    MFA_STEP_UP_VERIFIED: 'MFA_STEP_UP_VERIFIED',
  },
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { auth: {} },
  supabaseClient: { auth: { signInWithPassword: vi.fn() } },
}));
vi.mock('../trpc/context', () => ({
  evictInMemoryUserSession: mocks.evictInMemoryUserSession,
}));
vi.mock('@/lib/system-config', () => ({
  getSystemConfigNumber: vi.fn(async () => 8),
  loadSystemConfig: vi.fn(async () => ({ maintenanceMode: false })),
}));

import { generate, generateSecret } from 'otplib';
import { userRouter } from './user.router';

const genericProofMessage =
  'Unable to verify your credentials. Check your password and authentication code and try again.';

function createContext(options?: { secret?: string; backupCodes?: Array<{ id: string; codeHash: string }> }) {
  const tx = {
    user: { update: vi.fn().mockResolvedValue({}) },
    userBackupCode: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'qa@example.test',
        password: 'password-hash',
        totpEnabled: true,
        totpSecret: options?.secret ?? generateSecret(),
        backupCodes: options?.backupCodes ?? [{ id: 'backup-1', codeHash: 'backup-hash' }],
      }),
    },
    userBackupCode: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
  };

  return {
    ctx: {
      user: {
        id: 'user-1',
        email: 'qa@example.test',
        role: 'STARTUP',
        organizationId: 'org-1',
        supabaseAuthId: 'supabase-user-1',
        totpEnabled: true,
      },
      prisma,
      tenantPrisma: prisma,
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } },
      res: {},
    } as any,
    prisma,
    tx,
  };
}

describe('user.disableTotp proof and session contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.incr.mockResolvedValue(1);
    mocks.redis.expire.mockResolvedValue(1);
    mocks.redis.del.mockResolvedValue(1);
    mocks.userCacheDelete.mockResolvedValue(undefined);
    mocks.logSecurityEvent.mockResolvedValue(undefined);
  });

  it('keeps MFA and sessions intact when the current password is wrong', async () => {
    const { ctx, prisma, tx } = createContext();
    mocks.verifyPassword.mockResolvedValue(false);

    const caller = userRouter.createCaller(ctx);
    await expect(caller.disableTotp({ password: 'wrong-password', code: '123456' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: genericProofMessage });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.userBackupCode.deleteMany).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
    expect(mocks.userCacheDelete).not.toHaveBeenCalled();
  });

  it('keeps MFA and sessions intact when the TOTP is wrong', async () => {
    const { ctx, prisma, tx } = createContext();
    mocks.verifyPassword.mockResolvedValue(true);

    const caller = userRouter.createCaller(ctx);
    await expect(caller.disableTotp({ password: 'correct-password', code: '000000' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: genericProofMessage });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps MFA and sessions intact for an invalid or exhausted backup code', async () => {
    const { ctx, prisma, tx } = createContext();
    mocks.verifyPassword.mockImplementation(async (value: string, hash: string) =>
      value === 'correct-password' && hash === 'password-hash');

    const caller = userRouter.createCaller(ctx);
    await expect(caller.disableTotp({ password: 'correct-password', code: 'USED-CODE', isBackupCode: true }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: genericProofMessage });

    expect(prisma.userBackupCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.userBackupCode.deleteMany).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });

  it('preserves valid disable semantics including factor deletion and session revocation', async () => {
    const secret = generateSecret();
    const code = await generate({ secret });
    const { ctx, prisma, tx } = createContext({ secret });
    mocks.verifyPassword.mockResolvedValue(true);

    const caller = userRouter.createCaller(ctx);
    await expect(caller.disableTotp({ password: 'correct-password', code }))
      .resolves.toMatchObject({ success: true });

    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: { totpSecret: null, totpEnabled: false },
    }));
    expect(tx.userBackupCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mocks.userCacheDelete).toHaveBeenCalledWith('user-1');
    expect(mocks.evictInMemoryUserSession).toHaveBeenCalledWith('supabase-user-1');
  });
});
