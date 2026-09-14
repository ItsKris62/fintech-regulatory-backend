import { describe, it, expect, beforeEach, vi } from 'vitest';
import { leadIngestionService } from './lead-ingestion.service';
import { prisma } from '@/lib/prisma/client';
import { CompanyOrigin, LeadStatus, IcpTier, CompanySizeClass, DiscoveryRunStatus } from '@prisma/client';

// Mock prisma for isolated service unit tests
vi.mock('@/lib/prisma/client', () => {
  const mockDb = {
    company: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    organization: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    discoveryRun: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    discoveryEvidence: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    discoveryRunCompany: {
      upsert: vi.fn(),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sys-admin-user-id' }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-log-id' }),
    },
  };
  return { prisma: mockDb };
});

describe('Lead Ingestion Service (P0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initDiscoveryRun', () => {
    it('creates a new DiscoveryRun when idempotency key is new', async () => {
      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.discoveryRun.create).mockResolvedValue({
        id: 'run-123',
        runIdempotencyKey: 'idemp-run-001',
        workflowName: 'W-SALES-LEADS-01',
        sourceAuthority: 'CBK_DCP_DIRECTORY',
        sourceUrl: 'https://cbk.go.ke/dcps',
        status: DiscoveryRunStatus.RUNNING,
        totalDiscovered: 0,
        totalQualified: 0,
        totalDeduplicated: 0,
        totalRejected: 0,
        totalCreated: 0,
        totalUpdated: 0,
        errorMessage: null,
        metadata: null,
        startedAt: new Date(),
        completedAt: null,
      });

      const res = await leadIngestionService.initDiscoveryRun({
        runIdempotencyKey: 'idemp-run-001',
        workflowName: 'W-SALES-LEADS-01',
        sourceAuthority: 'CBK_DCP_DIRECTORY',
        sourceUrl: 'https://cbk.go.ke/dcps',
      });

      expect(res.id).toBe('run-123');
      expect(prisma.discoveryRun.create).toHaveBeenCalledOnce();
    });

    it('returns existing DiscoveryRun idempotently without creating duplicate on replay', async () => {
      const existingRun = {
        id: 'run-123',
        runIdempotencyKey: 'idemp-run-001',
        workflowName: 'W-SALES-LEADS-01',
        sourceAuthority: 'CBK_DCP_DIRECTORY',
        sourceUrl: 'https://cbk.go.ke/dcps',
        status: DiscoveryRunStatus.RUNNING,
        totalDiscovered: 10,
        totalQualified: 8,
        totalDeduplicated: 2,
        totalRejected: 0,
        totalCreated: 8,
        totalUpdated: 2,
        errorMessage: null,
        metadata: null,
        startedAt: new Date(),
        completedAt: null,
      };

      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue(existingRun);

      const res = await leadIngestionService.initDiscoveryRun({
        runIdempotencyKey: 'idemp-run-001',
        sourceAuthority: 'CBK_DCP_DIRECTORY',
        sourceUrl: 'https://cbk.go.ke/dcps',
      });

      expect(res.id).toBe('run-123');
      expect(prisma.discoveryRun.create).not.toHaveBeenCalled();
    });
  });

  describe('ingestBatch', () => {
    it('ingests a new candidate lead and attributes AI_DISCOVERY origin and score', async () => {
      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue({
        id: 'run-123',
      } as any);

      // No paying customer
      vi.mocked(prisma.organization.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.organization.findMany).mockResolvedValue([]);

      // No existing company
      vi.mocked(prisma.company.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.company.findMany).mockResolvedValue([]);

      vi.mocked(prisma.company.create).mockResolvedValue({
        id: 'comp-new-1',
        name: 'Zenka Finance Ltd',
        domain: 'zenka.co.ke',
        origin: CompanyOrigin.AI_DISCOVERY,
        leadStatus: LeadStatus.PENDING_REVIEW,
        icpTier: IcpTier.TIER_1_CORE_FINTECH,
        leadScore: 85,
      } as any);

      vi.mocked(prisma.discoveryEvidence.upsert).mockResolvedValue({ id: 'ev-1' } as any);
      vi.mocked(prisma.discoveryRunCompany.upsert).mockResolvedValue({ id: 'runc-1' } as any);
      vi.mocked(prisma.discoveryRun.update).mockResolvedValue({ id: 'run-123' } as any);

      const res = await leadIngestionService.ingestBatch({
        discoveryRunId: 'run-123',
        batchId: 'batch-01',
        candidates: [
          {
            name: 'Zenka Finance Ltd',
            domain: 'zenka.co.ke',
            country: 'Kenya',
            regulatoryBody: 'CBK',
            licenceType: 'Digital Credit Provider',
            licenceNumber: 'CBK/DCP/014',
            sizeClass: CompanySizeClass.MEDIUM,
            hasComplianceObligation: true,
            handlesPersonalData: true,
            handlesCustomerFunds: true,
            hasNamedBuyerContact: true,
            primarySourceUrl: 'https://cbk.go.ke/dcps',
            confidence: 0.9,
          },
        ],
      });

      expect(res.totalProcessed).toBe(1);
      expect(res.created).toBe(1);
      expect(res.results[0].action).toBe('CREATED');
      expect(res.results[0].leadStatus).toBe(LeadStatus.PENDING_REVIEW);
      expect(res.results[0].icpTier).toBe(IcpTier.TIER_1_CORE_FINTECH);
      expect(prisma.company.create).toHaveBeenCalledOnce();
    });

    it('matches existing company and updates qualification without creating duplicate (Deduplication)', async () => {
      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue({
        id: 'run-123',
      } as any);

      vi.mocked(prisma.organization.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.organization.findMany).mockResolvedValue([]);

      const existingLegacyCompany = {
        id: 'comp-existing-1',
        name: 'Zenka Finance',
        domain: 'zenka.co.ke',
        origin: CompanyOrigin.MANUAL_CRM,
        leadStatus: LeadStatus.UNASSESSED,
        leadScore: null,
        licenceNumber: null,
        licenceType: null,
        licenceStatus: null,
        regulatoryBody: null,
        reviewReason: null,
        _count: { contacts: 2, evidence: 0 },
      };

      vi.mocked(prisma.company.findFirst).mockResolvedValue(existingLegacyCompany as any);
      vi.mocked(prisma.company.update).mockResolvedValue({
        ...existingLegacyCompany,
        leadStatus: LeadStatus.PENDING_REVIEW,
        leadScore: 85,
      } as any);

      vi.mocked(prisma.discoveryEvidence.upsert).mockResolvedValue({ id: 'ev-1' } as any);
      vi.mocked(prisma.discoveryRunCompany.upsert).mockResolvedValue({ id: 'runc-1' } as any);
      vi.mocked(prisma.discoveryRun.update).mockResolvedValue({ id: 'run-123' } as any);

      const res = await leadIngestionService.ingestBatch({
        discoveryRunId: 'run-123',
        batchId: 'batch-02',
        candidates: [
          {
            name: 'Zenka Finance Limited',
            domain: 'zenka.co.ke',
            country: 'Kenya',
            regulatoryBody: 'CBK',
            licenceType: 'Digital Credit Provider',
            licenceNumber: 'CBK/DCP/014',
            hasComplianceObligation: true,
            handlesPersonalData: true,
            handlesCustomerFunds: true,
            hasNamedBuyerContact: true,
            primarySourceUrl: 'https://cbk.go.ke/dcps',
          },
        ],
      });

      expect(res.totalProcessed).toBe(1);
      expect(res.updated).toBe(1);
      expect(res.deduplicated).toBe(1);
      expect(res.results[0].action).toBe('UPDATED');
      expect(res.results[0].companyId).toBe('comp-existing-1');
      expect(prisma.company.create).not.toHaveBeenCalled();
      expect(prisma.company.update).toHaveBeenCalledOnce();
    });

    it('identifies existing paying customer as CONVERTED (commercial match) instead of bad score (Amendment 13)', async () => {
      vi.mocked(prisma.discoveryRun.findUnique).mockResolvedValue({
        id: 'run-123',
      } as any);

      // Paying customer match!
      vi.mocked(prisma.organization.findFirst).mockResolvedValue({
        id: 'org-client-1',
        subscriptionStatus: 'ACTIVE',
      } as any);

      vi.mocked(prisma.company.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.company.findMany).mockResolvedValue([]);

      vi.mocked(prisma.company.create).mockResolvedValue({
        id: 'comp-paying-1',
        name: 'Paying Customer Ltd',
        domain: 'payingclient.co.ke',
        leadStatus: LeadStatus.CONVERTED,
        icpTier: IcpTier.NON_ICP,
        leadScore: 0,
      } as any);

      vi.mocked(prisma.discoveryEvidence.upsert).mockResolvedValue({ id: 'ev-1' } as any);
      vi.mocked(prisma.discoveryRunCompany.upsert).mockResolvedValue({ id: 'runc-1' } as any);
      vi.mocked(prisma.discoveryRun.update).mockResolvedValue({ id: 'run-123' } as any);

      const res = await leadIngestionService.ingestBatch({
        discoveryRunId: 'run-123',
        batchId: 'batch-03',
        candidates: [
          {
            name: 'Paying Customer Ltd',
            domain: 'payingclient.co.ke',
            primarySourceUrl: 'https://cbk.go.ke',
          },
        ],
      });

      expect(res.results[0].leadStatus).toBe(LeadStatus.CONVERTED);
    });
  });
});
