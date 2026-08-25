import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Section34RestrictionService } from './restriction.service';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/prisma/client', () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    contact: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    suppressionList: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (arr) => Promise.all(arr)),
  };
  return { prisma: mockPrisma };
});

describe('Section34RestrictionService (Kenya DPA Section 34 Statutory Semantics & Exceptions)', () => {
  let service: Section34RestrictionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new Section34RestrictionService();
  });

  it('applies Section 34 restriction with statutory reason and updates user preferences', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-restrict-1',
      preferences: { theme: 'dark' },
      organizationId: 'org-1',
    } as any);

    const result = await service.restrictProcessing({
      userId: 'user-restrict-1',
      reason: 'ACCURACY_CONTESTED',
      requestId: 'DSAR-2026-004',
      dpoAdminId: 'dpo-admin-1',
    });

    expect(result.status).toBe('RESTRICTED');
    expect(result.reason).toBe('ACCURACY_CONTESTED');
    expect(result.requestId).toBe('DSAR-2026-004');
    expect(result.restrictedPurposes).toContain('AI_QUERYING');
    expect(result.restrictedPurposes).toContain('DIRECT_MARKETING');
    expect(result.restrictedPurposes).toContain('PRODUCT_TELEMETRY');

    expect(prisma.user.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('correctly models all 4 statutory restriction reasons under Section 34(1)', async () => {
    const reasons = [
      'ACCURACY_CONTESTED',
      'DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM',
      'UNLAWFUL_PROCESSING_ERASURE_OPPOSED',
      'OBJECTION_PENDING_VERIFICATION',
    ] as const;

    for (const reason of reasons) {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        id: 'user-test',
        preferences: {},
        organizationId: 'org-1',
      } as any);

      const res = await service.restrictProcessing({
        userId: 'user-test',
        reason,
        requestId: `DSAR-${reason}`,
      });

      expect(res.reason).toBe(reason);
    }
  });

  it('enforces Section 34(2) processing exceptions (storage, consent, legal claim defense, protection of rights, public interest)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-restricted',
      preferences: {
        section34Restriction: {
          status: 'RESTRICTED',
          reason: 'UNLAWFUL_PROCESSING_ERASURE_OPPOSED',
          requestId: 'DSAR-2026-005',
          restrictedPurposes: ['AI_QUERYING', 'DIRECT_MARKETING', 'PRODUCT_TELEMETRY', 'POLICY_GENERATION', 'GAP_ANALYSIS'],
        },
      },
    } as any);

    // Blocked optional processing
    expect((await service.isProcessingPermitted('user-restricted', 'AI_QUERYING')).permitted).toBe(false);
    expect((await service.isProcessingPermitted('user-restricted', 'DIRECT_MARKETING')).permitted).toBe(false);
    expect((await service.isProcessingPermitted('user-restricted', 'PRODUCT_TELEMETRY')).permitted).toBe(false);
    expect((await service.isProcessingPermitted('user-restricted', 'POLICY_GENERATION')).permitted).toBe(false);
    expect((await service.isProcessingPermitted('user-restricted', 'GAP_ANALYSIS')).permitted).toBe(false);

    // Section 34(2)(a) Permitted exceptions ALWAYS permitted
    expect((await service.isProcessingPermitted('user-restricted', 'STORAGE_ONLY')).permitted).toBe(true);
    expect((await service.isProcessingPermitted('user-restricted', 'CONSENT_GRANTED')).permitted).toBe(true);
    expect((await service.isProcessingPermitted('user-restricted', 'LEGAL_CLAIMS_DEFENSE')).permitted).toBe(true);
    expect((await service.isProcessingPermitted('user-restricted', 'PROTECTION_OF_RIGHTS')).permitted).toBe(true);
    expect((await service.isProcessingPermitted('user-restricted', 'PUBLIC_INTEREST')).permitted).toBe(true);
  });

  it('assertProcessingPermitted throws error when activity is restricted', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-restricted',
      preferences: {
        section34Restriction: {
          status: 'RESTRICTED',
          reason: 'OBJECTION_PENDING_VERIFICATION',
          requestId: 'DSAR-2026-009',
          restrictedPurposes: ['AI_QUERYING'],
        },
      },
    } as any);

    await expect(service.assertProcessingPermitted('user-restricted', 'AI_QUERYING')).rejects.toThrow(
      'Processing halted pursuant to Section 34 restriction',
    );

    await expect(service.assertProcessingPermitted('user-restricted', 'STORAGE_ONLY')).resolves.not.toThrow();
  });

  it('lifts restriction with statutory lift reason and audit log (s.34(2)(b))', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-lift-1',
      preferences: {
        section34Restriction: {
          status: 'RESTRICTED',
          reason: 'ACCURACY_CONTESTED',
          requestId: 'DSAR-2026-004',
          restrictedPurposes: ['AI_QUERYING'],
        },
      },
      organizationId: 'org-1',
    } as any);

    const result = await service.liftRestriction({
      userId: 'user-lift-1',
      liftReason: 'Accuracy of personal data verified and confirmed with user',
    });

    expect(result.status).toBe('LIFTED');
    expect(result.liftReason).toBe('Accuracy of personal data verified and confirmed with user');
    expect(prisma.user.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  describe('Non-User Data Subject Section 34 Restrictions', () => {
    it('restricts processing for a prospect / newsletter contact who has NO User row', async () => {
      // No User row exists
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

      // Contact row exists
      vi.mocked(prisma.contact.findMany).mockResolvedValueOnce([
        { id: 'contact-prospect-1', email: 'prospect@fintech.co.ke', metadata: { source: 'newsletter' } } as any,
      ]);

      const result = await service.restrictProcessingForEmail({
        email: 'prospect@fintech.co.ke',
        reason: 'OBJECTION_PENDING_VERIFICATION',
        requestId: 'DSAR-NONUSER-001',
        dpoAdminId: 'dpo-1',
      });

      expect(result.status).toBe('RESTRICTED');
      expect(result.reason).toBe('OBJECTION_PENDING_VERIFICATION');

      // Verified SuppressionList upsert
      expect(prisma.suppressionList.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'prospect@fintech.co.ke' },
        }),
      );

      // Verified Contact suppression update
      expect(prisma.contact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'prospect@fintech.co.ke', deletedAt: null },
        }),
      );

      // Verified AuditLog
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'dsr_email_processing_restricted',
            entityId: 'prospect@fintech.co.ke',
          }),
        }),
      );
    });

    it('enforces marketing and optional processing blocks on restricted non-user emails', async () => {
      // SuppressionList has restriction
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.suppressionList.findUnique).mockResolvedValueOnce({
        id: 'supp-1',
        metadata: {
          section34Restriction: {
            status: 'RESTRICTED',
            reason: 'OBJECTION_PENDING_VERIFICATION',
            requestId: 'DSAR-NONUSER-001',
            restrictedPurposes: ['DIRECT_MARKETING', 'AI_QUERYING'],
          },
        },
      } as any);

      const checkMarketing = await service.isProcessingPermittedForEmail('prospect@fintech.co.ke', 'DIRECT_MARKETING');
      expect(checkMarketing.permitted).toBe(false);
      expect(checkMarketing.reason).toContain('Processing halted pursuant to Section 34 restriction');

      // Storage exemption remains permitted under s.34(2)(a)
      const checkStorage = await service.isProcessingPermittedForEmail('prospect@fintech.co.ke', 'STORAGE_ONLY');
      expect(checkStorage.permitted).toBe(true);
    });

    it('lifts restriction for non-user email following statutory resolution (s.34(2)(b))', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.suppressionList.findUnique).mockResolvedValueOnce({
        id: 'supp-1',
        metadata: {
          section34Restriction: {
            status: 'RESTRICTED',
            reason: 'ACCURACY_CONTESTED',
            requestId: 'DSAR-NONUSER-002',
            restrictedPurposes: ['DIRECT_MARKETING'],
          },
        },
      } as any);
      vi.mocked(prisma.contact.findMany).mockResolvedValueOnce([
        { id: 'contact-1', metadata: {} } as any,
      ]);

      const result = await service.liftRestrictionForEmail({
        email: 'prospect@fintech.co.ke',
        liftReason: 'Contact email accuracy verified against official regulatory registry',
        dpoAdminId: 'dpo-1',
      });

      expect(result.status).toBe('LIFTED');
      expect(result.liftReason).toContain('accuracy verified');
      expect(prisma.suppressionList.updateMany).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'dsr_email_processing_restriction_lifted',
          }),
        }),
      );
    });
  });
});
