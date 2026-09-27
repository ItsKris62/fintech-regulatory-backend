import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanupDeletedVaultDocuments } from './cleanup-deleted-vault-documents';
import { prisma } from '@/lib/prisma/client';
import { vaultS3Client } from '@/lib/storage/client';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    vaultDocument: {
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    $disconnect: vi.fn(),
  },
}));

vi.mock('@/lib/storage/client', () => ({
  vaultS3Client: {
    send: vi.fn().mockResolvedValue({}),
  },
  vaultStorageConfig: {
    bucket: 'test-r2-vault',
  },
}));

describe('cleanupDeletedVaultDocuments', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const pastCutoffDate = new Date('2026-07-20T12:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scans and permanently purges soft-deleted vault objects past retention cutoff', async () => {
    vi.mocked(prisma.vaultDocument.findMany).mockResolvedValueOnce([
      {
        id: 'doc-expired-1',
        storageKey: 'vault/org-1/doc1.pdf',
        r2Bucket: 'test-r2-vault',
        organizationId: 'org-1',
        uploadedById: 'user-1',
        deletedAt: pastCutoffDate,
      } as any,
    ]);

    const result = await cleanupDeletedVaultDocuments({ retentionDays: 30, now });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);

    expect(vaultS3Client.send).toHaveBeenCalled();
    expect(prisma.vaultDocument.delete).toHaveBeenCalledWith({
      where: { id: 'doc-expired-1' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('handles empty scan without error', async () => {
    vi.mocked(prisma.vaultDocument.findMany).mockResolvedValueOnce([]);

    const result = await cleanupDeletedVaultDocuments({ retentionDays: 30, now });

    expect(result.scanned).toBe(0);
    expect(result.purged).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('throws error for invalid non-positive retentionDays', async () => {
    await expect(cleanupDeletedVaultDocuments({ retentionDays: 0 })).rejects.toThrow(
      'VAULT_DELETED_RETENTION_DAYS must be a positive integer',
    );
  });

  it('enforces RLS bypass: sees cross-tenant VaultDocument rows when bypassRls is enabled, and zero rows without it', async () => {
    let bypassRlsActive = false;

    // Simulate RLS engine behavior on Prisma
    vi.mocked(prisma.$transaction).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        const tx = {
          $executeRawUnsafe: vi.fn(async (sql: string) => {
            if (sql.includes("app.bypass_rls', 'true'")) {
              bypassRlsActive = true;
            }
          }),
          vaultDocument: {
            findMany: vi.fn(async () => {
              if (!bypassRlsActive) return []; // RLS blocks cross-tenant rows without bypass
              return [
                { id: 'doc-1', organizationId: 'org-a', storageKey: 'k1', uploadedById: 'u1', deletedAt: pastCutoffDate },
                { id: 'doc-2', organizationId: 'org-b', storageKey: 'k2', uploadedById: 'u2', deletedAt: pastCutoffDate },
              ];
            }),
            delete: vi.fn().mockResolvedValue({ id: 'doc-1' }),
          },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return arg(tx);
      }
      return Promise.all(arg);
    });

    // Default raw prisma.vaultDocument without bypass returns 0 rows (RLS blocks)
    vi.mocked(prisma.vaultDocument.findMany).mockImplementation(async () => {
      if (!bypassRlsActive) return [];
      return [
        { id: 'doc-1', organizationId: 'org-a', storageKey: 'k1', uploadedById: 'u1', deletedAt: pastCutoffDate },
        { id: 'doc-2', organizationId: 'org-b', storageKey: 'k2', uploadedById: 'u2', deletedAt: pastCutoffDate },
      ] as any;
    });

    const result = await cleanupDeletedVaultDocuments({ retentionDays: 30, now });
    expect(result.scanned).toBe(2);
    expect(result.purged).toBe(2);
  });
});
