import { describe, expect, it, vi, beforeEach } from 'vitest';
import { vaultRouter } from '../vault.router';
import { vaultModule } from '@/modules/vault';
import { prisma } from '@/lib/prisma/client';
import { resolveEffectivePlan } from '@/modules/billing/resolve-effective-plan';

vi.mock('@/modules/vault', () => ({
  vaultModule: {
    generateUploadPresignedUrl: vi.fn().mockResolvedValue({
      uploadUrl: 'https://r2.example.com/upload-target',
      documentId: 'doc_123',
      requiredHeaders: {},
      expiresAt: new Date().toISOString(),
    }),
    replaceDocument: vi.fn().mockResolvedValue({
      uploadUrl: 'https://r2.example.com/replace-target',
      documentId: 'doc_123',
      requiredHeaders: {},
      expiresAt: new Date().toISOString(),
    }),
  },
}));

vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn().mockResolvedValue({
    plan: undefined,
    source: 'FALLBACK',
    entitlements: {
      documentRepository: { limitMB: 100 },
      vaultDocumentMaxBytes: 5 * 1024 * 1024,
      vaultTotalQuotaBytes: 100 * 1024 * 1024,
      vaultAllowedMimeTypes: ['application/pdf'],
    },
  }),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'member_1',
        organizationId: 'org_123',
        userId: 'user_123',
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: 'member_1',
        organizationId: 'org_123',
        userId: 'user_123',
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'org_123',
        name: 'Test Organization',
        status: 'ACTIVE',
      }),
    },
    subscription: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_1' }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user_123',
        email: 'user@example.com',
        role: 'ADMIN',
        organizationId: 'org_123',
      }),
    },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  },
}));

describe('vaultRouter explicit plan requirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createTestCaller = (plan?: any) => {
    return vaultRouter.createCaller({
      user: {
        id: 'user_123',
        email: 'user@example.com',
        role: 'ADMIN',
        organizationId: 'org_123',
      } as any,
      orgMembership: {
        id: 'member_1',
        organizationId: 'org_123',
        userId: 'user_123',
        role: 'ADMIN',
        status: 'ACTIVE',
      } as any,
      plan: plan as any,
      req: {
        ip: '127.0.0.1',
        headers: {},
      } as any,
      res: {} as any,
      prisma: prisma as any,
      storageService: {} as any,
      aiService: {} as any,
      ragService: {} as any,
      mailer: {} as any,
    } as any);
  };

  it('throws FORBIDDEN when ctx.plan is undefined in getUploadUrl', async () => {
    vi.mocked(resolveEffectivePlan).mockResolvedValueOnce({
      plan: undefined,
      source: 'FALLBACK',
      entitlements: {
        documentRepository: { limitMB: 100 },
        vaultDocumentMaxBytes: 5 * 1024 * 1024,
        vaultTotalQuotaBytes: 100 * 1024 * 1024,
        vaultAllowedMimeTypes: ['application/pdf'],
      } as any,
    } as any);

    const caller = createTestCaller(undefined);

    await expect(
      caller.getUploadUrl({
        name: 'Sample Doc',
        declaredFilename: 'sample.pdf',
        declaredMimeType: 'application/pdf',
        declaredSize: 1024 * 10,
        category: 'COMPLIANCE',
        tags: ['test'],
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your plan could not be resolved. Please contact support.',
    });
  });

  it('throws FORBIDDEN when ctx.plan is undefined in getReplaceUrl', async () => {
    vi.mocked(resolveEffectivePlan).mockResolvedValueOnce({
      plan: undefined,
      source: 'FALLBACK',
      entitlements: {
        documentRepository: { limitMB: 100 },
        vaultDocumentMaxBytes: 5 * 1024 * 1024,
        vaultTotalQuotaBytes: 100 * 1024 * 1024,
        vaultAllowedMimeTypes: ['application/pdf'],
      } as any,
    } as any);

    const caller = createTestCaller(undefined);

    await expect(
      caller.getReplaceUrl({
        id: 'doc_123',
        filename: 'sample.pdf',
        fileType: 'application/pdf',
        fileSize: 1024 * 10,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your plan could not be resolved. Please contact support.',
    });
  });

  it('passes resolved plan when ctx.plan is defined', async () => {
    vi.mocked(resolveEffectivePlan).mockResolvedValueOnce({
      plan: 'FREE',
      source: 'SUBSCRIPTION',
      entitlements: {
        documentRepository: { limitMB: 100 },
        vaultDocumentMaxBytes: 5 * 1024 * 1024,
        vaultTotalQuotaBytes: 100 * 1024 * 1024,
        vaultAllowedMimeTypes: ['application/pdf'],
      } as any,
    } as any);

    const caller = createTestCaller('FREE');

    await caller.getUploadUrl({
      name: 'Sample Doc',
      declaredFilename: 'sample.pdf',
      declaredMimeType: 'application/pdf',
      declaredSize: 1024 * 10,
      category: 'COMPLIANCE',
      tags: ['test'],
    });

    expect(vaultModule.generateUploadPresignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_123',
        organizationId: 'org_123',
        plan: 'FREE',
      }),
    );
  });
});
