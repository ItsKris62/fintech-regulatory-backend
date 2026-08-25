import { describe, it, expect, vi, beforeEach } from 'vitest';
import { purgeExpiredAccounts } from './purge-expired-accounts';
import { prisma } from '@/lib/prisma/client';
import { supabaseAdmin } from '@/lib/supabase';
import { redis } from '@/lib/redis/client';
import { vaultS3Client } from '@/lib/storage/client';

// Mock dependencies
vi.mock('@/lib/prisma/client', () => {
  const mockPrisma = {
    user: {
      findMany: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    vaultDocument: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    payment: {
      updateMany: vi.fn(),
    },
    regulatoryApplication: {
      updateMany: vi.fn(),
    },
    license: {
      updateMany: vi.fn(),
    },
    legalDocument: {
      updateMany: vi.fn(),
    },
    blogPost: {
      updateMany: vi.fn(),
    },
    contact: {
      updateMany: vi.fn(),
    },
    company: {
      updateMany: vi.fn(),
    },
    auditLog: {
      updateMany: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
    apiKey: {
      deleteMany: vi.fn(),
    },
    notification: {
      deleteMany: vi.fn(),
    },
    notificationPreference: {
      deleteMany: vi.fn(),
    },
    notificationCategoryPreference: {
      deleteMany: vi.fn(),
    },
    savedResponse: {
      deleteMany: vi.fn(),
    },
    queryFeedback: {
      deleteMany: vi.fn(),
    },
    organizationMember: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === 'function') {
        return cb(mockPrisma);
      }
      return Array.isArray(cb) ? Promise.all(cb) : cb;
    }),
    $disconnect: vi.fn(),
  };

  return { prisma: mockPrisma };
});

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/storage/client', () => ({
  vaultS3Client: {
    send: vi.fn().mockResolvedValue({}),
  },
  vaultStorageConfig: {
    bucket: 'test-vault-bucket',
  },
}));

describe('purgeExpiredAccounts (Safety Gates & Erasure Lifecycle)', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const pastDate = new Date('2026-08-20T12:00:00Z');
  const futureDate = new Date('2026-09-01T12:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Gate 1 & 2: refuses to purge active accounts or suspended accounts with future scheduled deletion date', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        id: 'user-future',
        supabaseAuthId: 'sb-future',
        status: 'SUSPENDED' as any,
        deletionScheduledAt: futureDate,
        organizationId: 'org-1',
      },
      {
        id: 'user-active',
        supabaseAuthId: 'sb-active',
        status: 'ACTIVE' as any,
        deletionScheduledAt: pastDate,
        organizationId: 'org-1',
      },
    ] as any[]);

    const result = await purgeExpiredAccounts({ now, dryRun: false });

    expect(result.scanned).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.purged).toBe(0);
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('Gate 3, 4 & 5: successfully purges eligible expired suspended account and invalidates sessions', async () => {
    const expiredUser = {
      id: 'user-expired-1',
      supabaseAuthId: 'sb-expired-1',
      status: 'SUSPENDED' as any,
      deletionScheduledAt: pastDate,
      organizationId: 'org-1',
    };

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([expiredUser] as any[]);
    vi.mocked(prisma.vaultDocument.findMany).mockResolvedValueOnce([
      { id: 'doc-del-1', storageKey: 'vault/user-expired-1/doc.pdf', r2Bucket: 'test-bucket' } as any,
    ]);

    const result = await purgeExpiredAccounts({ now, dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);

    // Verify Supabase Auth deletion
    expect(supabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('sb-expired-1');

    // Verify Redis invalidation
    expect(redis.del).toHaveBeenCalledWith('user:session:sb-expired-1');
    expect(redis.del).toHaveBeenCalledWith('sheriabot:idx:sessions:user-expired-1');

    // Verify R2 deletion of user soft-deleted files
    expect(vaultS3Client.send).toHaveBeenCalled();

    // Verify audit logs disassociated
    expect(prisma.auditLog.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-expired-1' },
      data: { userId: null },
    });

    // Verify hard deletion of user
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-expired-1' },
    });
  });

  it('Gate 6 & 7: deletes user soft-deleted documents while leaving organization data intact', async () => {
    const expiredUser = {
      id: 'user-org-uploader',
      supabaseAuthId: 'sb-uploader',
      status: 'SUSPENDED' as any,
      deletionScheduledAt: pastDate,
      organizationId: 'org-1',
    };

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([expiredUser] as any[]);
    vi.mocked(prisma.vaultDocument.findMany).mockResolvedValueOnce([]); // no soft-deleted docs

    const result = await purgeExpiredAccounts({ now, dryRun: false });

    expect(result.purged).toBe(1);
    expect(prisma.vaultDocument.deleteMany).toHaveBeenCalledWith({
      where: { uploadedById: 'user-org-uploader', uploadStatus: 'DELETED' },
    });
  });

  it('Gate 14: dry-run mode produces zero database mutations or external deletions', async () => {
    const expiredUser = {
      id: 'user-dry-1',
      supabaseAuthId: 'sb-dry-1',
      status: 'SUSPENDED' as any,
      deletionScheduledAt: pastDate,
      organizationId: 'org-1',
    };

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([expiredUser] as any[]);

    const result = await purgeExpiredAccounts({ now, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.purged).toBe(1);
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(vaultS3Client.send).not.toHaveBeenCalled();
  });

  it('Gate 12 & 13: idempotent and resilient to partial external failure (e.g. Supabase already deleted)', async () => {
    const expiredUser = {
      id: 'user-already-deleted-supabase',
      supabaseAuthId: 'sb-missing',
      status: 'SUSPENDED' as any,
      deletionScheduledAt: pastDate,
      organizationId: 'org-1',
    };

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([expiredUser] as any[]);
    vi.mocked(prisma.vaultDocument.findMany).mockResolvedValueOnce([]);
    vi.mocked(supabaseAdmin.auth.admin.deleteUser).mockRejectedValueOnce(new Error('User not found'));

    const result = await purgeExpiredAccounts({ now, dryRun: false });

    // Should gracefully complete DB purge without failing the batch
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-already-deleted-supabase' },
    });
  });
});
