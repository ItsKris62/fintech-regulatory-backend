import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/storage/client', () => {
  return {
    createStorageService: vi.fn(() => ({
      uploadBuffer: vi.fn().mockImplementation(async (key: string, buffer: Buffer, options: any) => ({
        key,
        size: buffer.length || 1234,
        contentType: options?.contentType || 'application/pdf',
        metadata: options?.metadata || {},
      })),
    })),
    getVaultFileMetadata: vi.fn(),
    getVaultPresignedDownloadUrl: vi.fn(),
    getVaultPresignedUploadUrl: vi.fn(),
    vaultS3Client: {
      send: vi.fn().mockResolvedValue({}),
    },
    vaultStorageConfig: {
      bucket: 'test-bucket',
      endpoint: 'https://test.r2.cloudflarestorage.com',
    },
  };
});

vi.mock('@/config/app.config', () => {
  return {
    appConfig: {
      storage: {
        accountId: 'test-account-id',
        accessKeyId: 'test-access-key-id',
        secretAccessKey: 'test-secret-access-key',
        bucketName: 'test-bucket',
        auditBucketName: 'sheria-bot-audit-immutable',
        publicUrl: '',
      },
      publicStorage: {
        accessKeyId: 'test-public-access-key',
        secretAccessKey: 'test-public-secret-key',
        bucketName: 'test-public-bucket',
        bucketUrl: 'https://cdn.example.com',
      },
      frontendUrl: 'http://localhost:3000',
      isProduction: false,
      malwareScanEnabled: false,
    },
  };
});

vi.mock('@/utils/logger', () => {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('@/lib/system-config', () => {
  return {
    getSystemConfigNumber: vi.fn().mockResolvedValue(50),
  };
});

import { storageService } from '../storage.service';
import * as storageConfig from '@/config/storage.config';

describe('StorageService - Private Category URL Contract', () => {
  it('uploadDocument resolves with url === key and key does not start with http', async () => {
    const buffer = Buffer.from('dummy-document-content');
    const result = await storageService.uploadDocument(buffer, 'document.pdf', 'user-1');

    expect(result.url).toBe(result.key);
    expect(result.key).toMatch(/^legal-documents\//);
    expect(result.key.startsWith('http')).toBe(false);
    expect(result.url.startsWith('http')).toBe(false);
  });

  it('uploadImage resolves with url === key and key does not start with http', async () => {
    const buffer = Buffer.from('dummy-image-content');
    const result = await storageService.uploadImage(buffer, 'avatar.png', 'user-1');

    expect(result.url).toBe(result.key);
    expect(result.key).toMatch(/^user-uploads\/user-1\//);
    expect(result.key.startsWith('http')).toBe(false);
    expect(result.url.startsWith('http')).toBe(false);
  });

  it('uploadPolicyExport resolves with url === key and key does not start with http', async () => {
    const buffer = Buffer.from('dummy-policy-content');
    const result = await storageService.uploadPolicyExport(buffer, 'export.pdf', 'policy-1', 'user-1');

    expect(result.url).toBe(result.key);
    expect(result.key).toMatch(/^policy-exports\/policy-1\//);
    expect(result.key.startsWith('http')).toBe(false);
    expect(result.url.startsWith('http')).toBe(false);
  });

  it('uploadTempFile resolves with url === key and key does not start with http', async () => {
    const buffer = Buffer.from('dummy-temp-content');
    const result = await storageService.uploadTempFile(buffer, 'temp.pdf', 3600);

    expect(result.url).toBe(result.key);
    expect(result.key).toMatch(/^temp\//);
    expect(result.key.startsWith('http')).toBe(false);
    expect(result.url.startsWith('http')).toBe(false);
  });

  it('uploadChecklistExport resolves with url === key and key does not start with http', async () => {
    const buffer = Buffer.from('dummy-checklist-content');
    const result = await storageService.uploadChecklistExport(buffer, 'checklist.docx', 'chk-1', 'user-1');

    expect(result.url).toBe(result.key);
    expect(result.key).toMatch(/^checklist-exports\/chk-1\//);
    expect(result.key.startsWith('http')).toBe(false);
    expect(result.url.startsWith('http')).toBe(false);
  });

  it('uploadGapAnalysisExport resolves with url === key and key does not start with http', async () => {
    const buffer = Buffer.from('dummy-gap-analysis-content');
    const result = await storageService.uploadGapAnalysisExport(buffer, 'gap-analysis.docx', 'gap-1', 'user-1');

    expect(result.url).toBe(result.key);
    expect(result.key).toMatch(/^gap-analysis-exports\/gap-1\//);
    expect(result.key.startsWith('http')).toBe(false);
    expect(result.url.startsWith('http')).toBe(false);
  });

  it('does not export getPublicUrl', () => {
    expect('getPublicUrl' in storageConfig).toBe(false);
  });
});
