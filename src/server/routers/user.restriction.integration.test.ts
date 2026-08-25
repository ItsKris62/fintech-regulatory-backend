import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Section34RestrictionService } from '@/modules/user/restriction.service';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/prisma/client', () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (arr) => Promise.all(arr)),
  };
  return { prisma: mockPrisma };
});

describe('Section 34 Restriction Operational DSAR Procedures & Integration', () => {
  let service: Section34RestrictionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new Section34RestrictionService();
  });

  it('DPO applies restriction via DSAR workflow with statutory audit trail', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-dsar-1',
      preferences: { language: 'en' },
      organizationId: 'org-fintech-1',
    } as any);

    const record = await service.restrictProcessing({
      userId: 'user-dsar-1',
      reason: 'DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM',
      requestId: 'DSAR-2026-CLAIM-001',
      dpoAdminId: 'dpo-admin-1',
      restrictedPurposes: ['AI_QUERYING', 'DIRECT_MARKETING'],
    });

    expect(record.status).toBe('RESTRICTED');
    expect(record.reason).toBe('DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM');
    expect(record.requestId).toBe('DSAR-2026-CLAIM-001');
    expect(record.restrictedPurposes).toEqual(['AI_QUERYING', 'DIRECT_MARKETING']);

    expect(prisma.user.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'dpo-admin-1',
        action: 'dsr_processing_restricted',
        entityType: 'User',
        entityId: 'user-dsar-1',
        metadata: {
          reason: 'DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM',
          requestId: 'DSAR-2026-CLAIM-001',
          restrictedPurposes: ['AI_QUERYING', 'DIRECT_MARKETING'],
          organizationId: 'org-fintech-1',
        },
      },
    });
  });

  it('prevents AI querying and marketing while restricted', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-dsar-1',
      preferences: {
        section34Restriction: {
          status: 'RESTRICTED',
          reason: 'ACCURACY_CONTESTED',
          requestId: 'DSAR-2026-008',
          restrictedPurposes: ['AI_QUERYING', 'DIRECT_MARKETING', 'PRODUCT_TELEMETRY'],
        },
      },
    } as any);

    const aiCheck = await service.isProcessingPermitted('user-dsar-1', 'AI_QUERYING');
    expect(aiCheck.permitted).toBe(false);
    expect(aiCheck.reason).toContain('Processing halted pursuant to Section 34 restriction');

    const mktCheck = await service.isProcessingPermitted('user-dsar-1', 'DIRECT_MARKETING');
    expect(mktCheck.permitted).toBe(false);

    // Statutory storage exception under Section 34(2)
    const storageCheck = await service.isProcessingPermitted('user-dsar-1', 'STORAGE_ONLY');
    expect(storageCheck.permitted).toBe(true);
  });

  it('DPO lifts restriction after statutory verification', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-dsar-1',
      preferences: {
        section34Restriction: {
          status: 'RESTRICTED',
          reason: 'ACCURACY_CONTESTED',
          requestId: 'DSAR-2026-008',
          restrictedPurposes: ['AI_QUERYING'],
        },
      },
      organizationId: 'org-fintech-1',
    } as any);

    const liftedRecord = await service.liftRestriction({
      userId: 'user-dsar-1',
      liftReason: 'Account details verified against official identification pursuant to LN 263/2021 Reg 10',
      dpoAdminId: 'dpo-admin-1',
    });

    expect(liftedRecord.status).toBe('LIFTED');
    expect(liftedRecord.liftReason).toContain('Account details verified');

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'dpo-admin-1',
        action: 'dsr_processing_restriction_lifted',
        entityType: 'User',
        entityId: 'user-dsar-1',
        metadata: {
          liftReason: 'Account details verified against official identification pursuant to LN 263/2021 Reg 10',
          organizationId: 'org-fintech-1',
        },
      },
    });
  });
});
