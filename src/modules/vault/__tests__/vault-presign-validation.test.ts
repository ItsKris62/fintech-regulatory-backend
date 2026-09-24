import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { logger } from '@/utils/logger';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    vaultDocument: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { fileSize: 0 } }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_1' }),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    incrby: vi.fn().mockResolvedValue(1024),
    decrby: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/storage/storage.service', () => ({
  storageService: {
    getVaultUploadUrl: vi.fn().mockResolvedValue({
      url: 'https://r2.example.com/upload-target',
      requiredHeaders: { 'content-type': 'application/pdf' },
    }),
  },
}));

import { vaultModule } from '../vault.module';

describe('vault presign validation and error diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validParams = {
    userId: 'user_123',
    organizationId: 'org_123',
    name: 'Standard Document',
    declaredFilename: 'doc.pdf',
    declaredMimeType: 'application/pdf',
    declaredSize: 1024 * 50,
    category: 'COMPLIANCE' as const,
    tags: ['compliance'],
  };

  it('populates cause on TRPCError and logs diagnostic when plan is invalid', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await vaultModule.generateUploadPresignedUrl({
        ...validParams,
        plan: 'INVALID_PLAN' as any,
      });
      expect.unreachable('Should have thrown BAD_REQUEST TRPCError');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      const trpcError = error as TRPCError;
      expect(trpcError.code).toBe('BAD_REQUEST');
      expect(trpcError.message).toBe('Invalid vault upload request.');
      expect(trpcError.cause).toBeDefined();

      const causeIssues = (trpcError.cause as any)?.issues;
      expect(Array.isArray(causeIssues)).toBe(true);
      expect(causeIssues.some((issue: any) => issue.path.includes('tier'))).toBe(true);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'vault.presign.validation_failed',
          userId: 'user_123',
          organizationId: 'org_123',
          receivedPlan: 'INVALID_PLAN',
          issues: expect.any(Array),
        }),
      );
    }
  });

  it('does not throw BAD_REQUEST schema validation error for FREE, STARTER, or GROWTH plans', async () => {
    const tiersToTest = ['FREE', 'STARTER', 'GROWTH'] as const;

    for (const plan of tiersToTest) {
      const result = await vaultModule.generateUploadPresignedUrl({
        ...validParams,
        plan,
      });

      expect(result).toBeDefined();
      expect(result.uploadUrl).toBe('https://r2.example.com/upload-target');
      expect(result.documentId).toBeDefined();
    }
  });
});
