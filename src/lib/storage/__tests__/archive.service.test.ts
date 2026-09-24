import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopyObjectCommand } from '@aws-sdk/client-s3';

describe('Archive Storage Service (archive.service.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses R2_BACKUP_BUCKET and does not read R2_BACKUP_BUCKET_NAME', async () => {
    process.env.R2_BACKUP_BUCKET = 'sheria-bot-backups';
    delete process.env.R2_BACKUP_BUCKET_NAME;

    const { BACKUP_BUCKET } = await import('../archive.service');
    expect(BACKUP_BUCKET).toBe('sheria-bot-backups');
  });

  it('initializes backupClient using dedicated R2_BACKUP credentials', async () => {
    process.env.R2_BACKUP_ACCESS_KEY_ID = 'test-backup-key-id';
    process.env.R2_BACKUP_SECRET_ACCESS_KEY = 'test-backup-secret-key';
    process.env.R2_ACCOUNT_ID = 'test-r2-account-id';

    const { backupClient } = await import('../archive.service');
    expect(backupClient).toBeDefined();
  });

  it('successfully executes CopyObjectCommand using backupClient', async () => {
    process.env.R2_BACKUP_ACCESS_KEY_ID = 'test-backup-key-id';
    process.env.R2_BACKUP_SECRET_ACCESS_KEY = 'test-backup-secret-key';

    const { archiveObject, backupClient } = await import('../archive.service');
    const sendSpy = vi.spyOn(backupClient, 'send').mockResolvedValueOnce({} as any);

    const result = await archiveObject({
      sourceBucket: 'sheria-bot-saas',
      sourceKey: 'legal-documents/doc-1.pdf',
      archivePrefix: 'purge/2026-09-24/user-1',
    });

    expect(result.archived).toBe(true);
    expect(result.archiveKey).toBe('purge/2026-09-24/user-1/sheria-bot-saas/legal-documents/doc-1.pdf');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const command = sendSpy.mock.calls[0][0] as CopyObjectCommand;
    expect(command.input.Bucket).toBe('sheria-bot-backups');
    expect(command.input.CopySource).toBe('sheria-bot-saas/legal-documents/doc-1.pdf');
    expect(command.input.Key).toBe('purge/2026-09-24/user-1/sheria-bot-saas/legal-documents/doc-1.pdf');
  });

  it('gracefully returns { archived: false } when backup credentials are missing without throwing', async () => {
    delete process.env.R2_BACKUP_ACCESS_KEY_ID;
    delete process.env.R2_BACKUP_SECRET_ACCESS_KEY;

    const { archiveObject } = await import('../archive.service');
    const result = await archiveObject({
      sourceBucket: 'sheria-bot-saas',
      sourceKey: 'test.pdf',
      archivePrefix: 'purge/test',
    });

    expect(result.archived).toBe(false);
    expect(result.archiveKey).toBeNull();
  });
});
