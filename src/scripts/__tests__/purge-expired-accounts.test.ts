import { describe, it, expect, vi, beforeEach } from 'vitest';
import { purgeExpiredAccounts } from '../purge-expired-accounts';
import { prisma } from '@/lib/prisma/client';
import { archiveObject, BACKUP_BUCKET } from '@/lib/storage/archive.service';
import { storageService } from '@/lib/storage/storage.service';
import { vaultS3Client } from '@/lib/storage/client';
import { deleteAvatarByKey } from '@/lib/storage/public-storage.service';

vi.mock('@/lib/storage/archive.service', () => ({
  BACKUP_BUCKET: process.env.R2_BACKUP_BUCKET ?? 'sheria-bot-backups',
  archiveObject: vi.fn().mockResolvedValue({ archived: true, archiveKey: 'purge/2026-09-23/user-1/test.pdf' }),
}));

vi.mock('@/lib/storage/storage.service', () => ({
  storageService: {
    deleteFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/storage/client', () => ({
  vaultS3Client: {
    send: vi.fn().mockResolvedValue({}),
  },
  vaultStorageConfig: {
    bucket: 'sheriabot-storage',
  },
}));

vi.mock('@/lib/storage/public-storage.service', () => ({
  deleteAvatarByKey: vi.fn().mockResolvedValue(undefined),
  extractKeyFromAvatarUrl: vi.fn((url: string) => url.replace(/^https?:\/\/[^\/]+\//, '')),
}));

vi.mock('@/lib/prisma/client', () => {
  const mockTx = {
    license: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    vaultDocument: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    apiKey: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    notification: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    notificationPreference: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    notificationCategoryPreference: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    savedResponse: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    queryFeedback: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    organizationMember: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    user: { delete: vi.fn().mockResolvedValue({}) },
  };

  return {
    prisma: {
      user: {
        findMany: vi.fn(),
      },
      legalDocument: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      generatedPolicyExportLog: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gapAnalysis: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      auditLog: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      vaultDocument: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        deleteUser: vi.fn().mockResolvedValue({}),
      },
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('purgeExpiredAccounts - Archive-Then-Delete Guarantees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('archives each R2 asset (including all export categories) before deleting from source bucket', async () => {
    const expiredDate = new Date(Date.now() - 100000);
    const mockUser = {
      id: 'user-purge-1',
      supabaseAuthId: 'sup-1',
      status: 'SUSPENDED',
      avatar: 'https://cdn.sheriabot.com/avatars/user-purge-1/avatar.png',
      deletionScheduledAt: expiredDate,
      organizationId: 'org-1',
    };

    (prisma.user.findMany as any).mockResolvedValue([mockUser]);
    (prisma.legalDocument.findMany as any).mockResolvedValue([
      { id: 'leg-1', fileUrl: 'legal-documents/doc-1.pdf' },
    ]);
    (prisma.generatedPolicyExportLog.findMany as any).mockResolvedValue([
      { id: 'pol-1', storageKey: 'policy-exports/pol-1.pdf' },
    ]);
    (prisma.gapAnalysis.findMany as any).mockResolvedValue([
      { id: 'gap-1', reportUrl: 'gap-analysis-exports/gap-1/report.docx' },
    ]);
    (prisma.auditLog.findMany as any).mockResolvedValue([
      { id: 'audit-chk-1', action: 'CHECKLIST_EXPORTED', metadata: { r2Key: 'checklist-exports/chk-1/export.docx' } },
      { id: 'audit-cq-1', action: 'COMPLIANCE_QUERY_EXPORTED', metadata: { r2Key: 'exports/compliance-queries/cq-1/export.docx' } },
    ]);
    (prisma.vaultDocument.findMany as any).mockResolvedValue([
      { id: 'vault-1', storageKey: 'vault/org-1/file-1.pdf', r2Bucket: 'sheriabot-storage' },
    ]);

    const executionOrder: string[] = [];

    (archiveObject as any).mockImplementation(async ({ sourceKey }: any) => {
      executionOrder.push(`archive:${sourceKey}`);
      return { archived: true, archiveKey: `backup/${sourceKey}` };
    });

    (deleteAvatarByKey as any).mockImplementation(async (key: string) => {
      executionOrder.push(`delete-public:${key}`);
    });

    (storageService.deleteFile as any).mockImplementation(async (key: string) => {
      executionOrder.push(`delete-saas:${key}`);
    });

    (vaultS3Client.send as any).mockImplementation(async (cmd: any) => {
      executionOrder.push(`delete-vault:${cmd.input.Key}`);
      return {};
    });

    const result = await purgeExpiredAccounts({ dryRun: false, now: new Date() });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.archived).toBe(7);
    expect(result.deleted).toBe(7);

    // Verify copy occurred for each category
    expect(archiveObject).toHaveBeenCalledTimes(7);
    expect(deleteAvatarByKey).toHaveBeenCalledWith('avatars/user-purge-1/avatar.png');
    expect(storageService.deleteFile).toHaveBeenCalledWith('legal-documents/doc-1.pdf');
    expect(storageService.deleteFile).toHaveBeenCalledWith('policy-exports/pol-1.pdf');
    expect(storageService.deleteFile).toHaveBeenCalledWith('gap-analysis-exports/gap-1/report.docx');
    expect(storageService.deleteFile).toHaveBeenCalledWith('checklist-exports/chk-1/export.docx');
    expect(vaultS3Client.send).toHaveBeenCalledTimes(2); // compliance query export + vault document

    // Ensure archive happens before delete for each
    const archiveChkIdx = executionOrder.indexOf('archive:checklist-exports/chk-1/export.docx');
    const deleteChkIdx = executionOrder.indexOf('delete-saas:checklist-exports/chk-1/export.docx');
    expect(archiveChkIdx).toBeGreaterThanOrEqual(0);
    expect(deleteChkIdx).toBeGreaterThan(archiveChkIdx);

    const archiveCqIdx = executionOrder.indexOf('archive:exports/compliance-queries/cq-1/export.docx');
    const deleteCqIdx = executionOrder.indexOf('delete-vault:exports/compliance-queries/cq-1/export.docx');
    expect(archiveCqIdx).toBeGreaterThanOrEqual(0);
    expect(deleteCqIdx).toBeGreaterThan(archiveCqIdx);
  });

  it('skips source deletion for any asset whose archive copy fails', async () => {
    const expiredDate = new Date(Date.now() - 100000);
    const mockUser = {
      id: 'user-purge-2',
      supabaseAuthId: null,
      status: 'SUSPENDED',
      avatar: null,
      deletionScheduledAt: expiredDate,
      organizationId: null,
    };

    (prisma.user.findMany as any).mockResolvedValue([mockUser]);
    (prisma.legalDocument.findMany as any).mockResolvedValue([
      { id: 'leg-2a', fileUrl: 'legal-documents/fails.pdf' },
      { id: 'leg-2b', fileUrl: 'legal-documents/succeeds.pdf' },
    ]);
    (prisma.generatedPolicyExportLog.findMany as any).mockResolvedValue([]);
    (prisma.gapAnalysis.findMany as any).mockResolvedValue([]);
    (prisma.auditLog.findMany as any).mockResolvedValue([]);
    (prisma.vaultDocument.findMany as any).mockResolvedValue([]);

    (archiveObject as any).mockImplementation(async ({ sourceKey }: any) => {
      if (sourceKey.includes('fails')) {
        return { archived: false, archiveKey: null };
      }
      return { archived: true, archiveKey: `backup/${sourceKey}` };
    });

    const result = await purgeExpiredAccounts({ dryRun: false, now: new Date() });

    expect(result.failed).toBe(1);
    expect(result.archived).toBe(1);
    expect(result.deleted).toBe(1);

    // The failed object was NEVER deleted from source
    expect(storageService.deleteFile).not.toHaveBeenCalledWith('legal-documents/fails.pdf');
    // The successful object WAS deleted from source
    expect(storageService.deleteFile).toHaveBeenCalledWith('legal-documents/succeeds.pdf');
  });

  it('performs zero archive or delete writes in dry-run mode', async () => {
    const expiredDate = new Date(Date.now() - 100000);
    const mockUser = {
      id: 'user-purge-3',
      supabaseAuthId: 'sup-3',
      status: 'SUSPENDED',
      avatar: 'https://cdn.sheriabot.com/avatars/user-purge-3/avatar.png',
      deletionScheduledAt: expiredDate,
      organizationId: 'org-3',
    };

    (prisma.user.findMany as any).mockResolvedValue([mockUser]);
    (prisma.legalDocument.findMany as any).mockResolvedValue([
      { id: 'leg-3', fileUrl: 'legal-documents/doc-3.pdf' },
    ]);
    (prisma.generatedPolicyExportLog.findMany as any).mockResolvedValue([]);
    (prisma.gapAnalysis.findMany as any).mockResolvedValue([]);
    (prisma.auditLog.findMany as any).mockResolvedValue([]);
    (prisma.vaultDocument.findMany as any).mockResolvedValue([]);

    const result = await purgeExpiredAccounts({ dryRun: true, now: new Date() });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.dryRun).toBe(true);

    // Ensure zero mutations
    expect(archiveObject).not.toHaveBeenCalled();
    expect(deleteAvatarByKey).not.toHaveBeenCalled();
    expect(storageService.deleteFile).not.toHaveBeenCalled();
    expect(vaultS3Client.send).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('uses R2_BACKUP_BUCKET for the backup bucket constant', () => {
    expect(BACKUP_BUCKET).toBe('sheria-bot-backups');
  });
});
