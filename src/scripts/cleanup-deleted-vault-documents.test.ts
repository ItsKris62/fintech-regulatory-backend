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
    $transaction: vi.fn(async (arr) => Promise.all(arr)),
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
});
