import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSecurityAuditCreate = vi.fn();
vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    securityAuditEvent: {
      create: (...args: any[]) => mockSecurityAuditCreate(...args),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    apiKey: {
      create: vi.fn(),
      update: vi.fn(),
    },
    policy: { findMany: vi.fn().mockResolvedValue([]) },
    complianceQuery: { findMany: vi.fn().mockResolvedValue([]) },
    legalDocument: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/storage/service', () => ({
  storageService: {
    uploadTempFile: vi.fn().mockResolvedValue({ key: 'export_key' }),
    getDownloadUrl: vi.fn().mockResolvedValue('https://downloads.sheriabot.com/export.json'),
  },
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

import { SECURITY_EVENT_TYPES } from '../audit.service';
import { userModule } from '@/modules/user/user.module';
import { apiKeyService } from '../api-key.service';

describe('F-14: Missing audit events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. API key creation writes API_KEY_CREATED SecurityAuditEvent with orgId and resourceId', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    (prisma.apiKey.create as any).mockResolvedValueOnce({
      id: 'key_123',
      userId: 'usr_1',
      name: 'Production Key',
      key: 'sha256_hash',
      active: true,
    });

    await apiKeyService.createApiKey({
      userId: 'usr_1',
      organizationId: 'org_1',
      name: 'Production Key',
    });

    expect(mockSecurityAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: SECURITY_EVENT_TYPES.API_KEY_CREATED,
          userId: 'usr_1',
          organizationId: 'org_1',
          metadata: expect.objectContaining({
            orgId: 'org_1',
            resourceId: 'key_123',
          }),
        }),
      }),
    );
  });

  it('2. API key revocation writes API_KEY_REVOKED SecurityAuditEvent with orgId and resourceId', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    (prisma.apiKey.update as any).mockResolvedValueOnce({
      id: 'key_123',
      userId: 'usr_1',
      active: false,
    });

    await apiKeyService.revokeApiKey({
      keyId: 'key_123',
      userId: 'usr_1',
      organizationId: 'org_1',
    });

    expect(mockSecurityAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: SECURITY_EVENT_TYPES.API_KEY_REVOKED,
          userId: 'usr_1',
          organizationId: 'org_1',
          metadata: expect.objectContaining({
            orgId: 'org_1',
            resourceId: 'key_123',
          }),
        }),
      }),
    );
  });

  it('3. GDPR data export request writes DATA_EXPORT_REQUESTED SecurityAuditEvent with orgId and resourceId', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    (prisma.user.findUnique as any).mockResolvedValueOnce({
      id: 'usr_export_1',
      organizationId: 'org_export_1',
      fullName: 'Export User',
      email: 'export@test.com',
      organization: { name: 'Export Org' },
      preferences: {},
    });

    await userModule.exportUserData('usr_export_1');

    expect(mockSecurityAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: SECURITY_EVENT_TYPES.DATA_EXPORT_REQUESTED,
          userId: 'usr_export_1',
          organizationId: 'org_export_1',
          metadata: expect.objectContaining({
            orgId: 'org_export_1',
            resourceId: 'usr_export_1',
          }),
        }),
      }),
    );
  });

  it('4. GDPR data deletion request writes DATA_DELETION_REQUESTED SecurityAuditEvent with orgId and resourceId', async () => {
    const { prisma } = await import('@/lib/prisma/client');
    (prisma.user.findUnique as any).mockResolvedValueOnce({
      id: 'usr_delete_1',
      organizationId: 'org_delete_1',
      fullName: 'Delete User',
      email: 'delete@test.com',
      password: '$2a$12$eX4mpleHashedPassword....................',
    });
    (prisma.user.update as any).mockResolvedValueOnce({ id: 'usr_delete_1' });

    // Mock verifyPassword
    vi.spyOn(await import('@/modules/auth/auth.utils'), 'verifyPassword').mockResolvedValueOnce(true);
    vi.spyOn(userModule, 'exportUserData').mockResolvedValueOnce({ success: true, downloadUrl: 'http://test' });

    await userModule.deleteAccount('usr_delete_1', {
      password: 'CorrectPassword123!',
      reason: 'GDPR deletion request',
    });

    expect(mockSecurityAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: SECURITY_EVENT_TYPES.DATA_DELETION_REQUESTED,
          userId: 'usr_delete_1',
          organizationId: 'org_delete_1',
          metadata: expect.objectContaining({
            orgId: 'org_delete_1',
            resourceId: 'usr_delete_1',
          }),
        }),
      }),
    );
  });
});
