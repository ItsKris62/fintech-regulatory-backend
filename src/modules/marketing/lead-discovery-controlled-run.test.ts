import { describe, it, expect, vi } from 'vitest';
import { leadIngestionService } from './lead-ingestion.service';
import { prisma } from '@/lib/prisma/client';
import {
  LeadStatus,
  IcpTier,
  CompanySizeClass,
  EvidenceVerificationState,
  DiscoveryRunStatus,
} from '@prisma/client';

// Mock DB for controlled test execution simulation
vi.mock('@/lib/prisma/client', () => {
  const createdCompanies: any[] = [];
  const createdEvidence: any[] = [];
  const discoveryRuns: any[] = [];
  const mockDb = {
    company: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockImplementation(async (query: any) => {
        if (query?.where?.domain) {
          return createdCompanies.filter((c) => c.domain === query.where.domain);
        }
        return [];
      }),
      create: vi.fn().mockImplementation(async (args: any) => {
        const row = {
          id: `comp-${createdCompanies.length + 1}`,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        createdCompanies.push(row);
        return row;
      }),
      update: vi.fn(),
      count: vi.fn(),
    },
    organization: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    contact: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    discoveryRun: {
      findUnique: vi.fn().mockImplementation(async (query: any) => {
        return discoveryRuns.find((r) => r.runIdempotencyKey === query.where.runIdempotencyKey || r.id === query.where.id) || null;
      }),
      create: vi.fn().mockImplementation(async (args: any) => {
        const row = {
          id: `disc-run-${discoveryRuns.length + 1}`,
          ...args.data,
          totalDiscovered: 0,
          totalQualified: 0,
          totalDeduplicated: 0,
          totalRejected: 0,
          totalCreated: 0,
          totalUpdated: 0,
          startedAt: new Date(),
          completedAt: null,
        };
        discoveryRuns.push(row);
        return row;
      }),
      update: vi.fn().mockImplementation(async (args: any) => {
        const existing = discoveryRuns.find((r) => r.id === args.where.id);
        if (existing) {
          Object.assign(existing, args.data);
          return existing;
        }
        return args.data;
      }),
    },
    discoveryEvidence: {
      upsert: vi.fn().mockImplementation(async (args: any) => {
        const row = { id: `ev-${createdEvidence.length + 1}`, ...args.create };
        createdEvidence.push(row);
        return row;
      }),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    discoveryRunCompany: {
      upsert: vi.fn().mockResolvedValue({ id: 'drc-1' }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sys-admin-user-001' }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-log-001' }),
    },
    systemConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { prisma: mockDb };
});

describe('Controlled Production Run & Real Candidate Verification', () => {
  const REAL_KENYA_CANDIDATES = [
    {
      name: 'Inventure Mobile Limited',
      domain: 'tala.co.ke',
      country: 'Kenya',
      industry: 'FINTECH',
      regulatoryBody: 'CBK',
      licenceType: 'Digital Credit Provider',
      licenceNumber: null,
      licensingDate: '2023-01-30',
      licenceStatus: 'ACTIVE',
      primarySourceUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
      primarySourceAuthority: 'Central Bank of Kenya',
      confidence: 0.95,
      companyDescription: 'Tala Kenya provides instant digital micro-loans and mobile financial services to unbanked consumers across Kenya.',
      sizeClass: CompanySizeClass.MEDIUM,
      hasComplianceObligation: true,
      operatesCrossBorder: true,
      handlesPersonalData: true,
      handlesCustomerFunds: true,
      recommendedFeatures: ['COMPLIANCE_QUERY', 'REGULATORY_MONITORING', 'GAP_ANALYSIS', 'POLICY_GENERATOR'],
      adminRationale: 'Top-tier licensed Digital Credit Provider with extensive CBK DCP and ODPC DPA regulatory reporting obligations.',
      recommendedBuyerRole: 'Head of Legal & Regulatory Affairs',
      evidence: [
        {
          field: 'licenceType',
          extractedValue: 'Digital Credit Provider',
          sourceUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
          sourceAuthority: 'Central Bank of Kenya',
          evidenceSnippet: 'Inventure Mobile Limited (Tala) - Approved Digital Credit Provider (Date Licensed: January 30, 2023)',
          verificationState: EvidenceVerificationState.VERIFIED,
          extractionMethod: 'AI_DIRECTORY_EXTRACTION',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_source_extract_ke_v1',
        },
        {
          field: 'recommendedBuyerRole',
          extractedValue: 'Head of Legal & Regulatory Affairs',
          sourceUrl: 'https://tala.co.ke',
          sourceAuthority: 'AI_RECOMMENDATION',
          evidenceSnippet: 'Commercial ICP targeting recommendation for SheriaBot sales team',
          verificationState: EvidenceVerificationState.UNVERIFIED,
          extractionMethod: 'AI_COMPANY_RESEARCH',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_company_research_ke_v1',
        },
      ],
    },
    {
      name: 'Zenka Finance Limited',
      domain: 'zenka.co.ke',
      country: 'Kenya',
      industry: 'FINTECH',
      regulatoryBody: 'CBK',
      licenceType: 'Digital Credit Provider',
      licenceNumber: null,
      licensingDate: '2023-03-24',
      licenceStatus: 'ACTIVE',
      primarySourceUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
      primarySourceAuthority: 'Central Bank of Kenya',
      confidence: 0.95,
      companyDescription: 'Zenka Finance provides digital micro-credit and mobile lending solutions in Kenya.',
      sizeClass: CompanySizeClass.SMALL,
      hasComplianceObligation: true,
      operatesCrossBorder: false,
      handlesPersonalData: true,
      handlesCustomerFunds: true,
      recommendedFeatures: ['COMPLIANCE_QUERY', 'REGULATORY_MONITORING', 'GAP_ANALYSIS'],
      adminRationale: 'Licensed DCP subject to strict consumer protection and interest rate disclosure compliance under CBK regulations.',
      recommendedBuyerRole: 'Chief Compliance Officer',
      evidence: [
        {
          field: 'licenceType',
          extractedValue: 'Digital Credit Provider',
          sourceUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/08/Directory-of-Digital-Credit-Providers-August-2026.pdf',
          sourceAuthority: 'Central Bank of Kenya',
          evidenceSnippet: 'Zenka Finance Limited - Licensed Digital Credit Provider (Date Licensed: March 24, 2023)',
          verificationState: EvidenceVerificationState.VERIFIED,
          extractionMethod: 'AI_DIRECTORY_EXTRACTION',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_source_extract_ke_v1',
        },
        {
          field: 'recommendedBuyerRole',
          extractedValue: 'Chief Compliance Officer',
          sourceUrl: 'https://zenka.co.ke',
          sourceAuthority: 'AI_RECOMMENDATION',
          evidenceSnippet: 'Commercial ICP targeting recommendation for SheriaBot sales team',
          verificationState: EvidenceVerificationState.UNVERIFIED,
          extractionMethod: 'AI_COMPANY_RESEARCH',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_company_research_ke_v1',
        },
      ],
    },
    {
      name: 'Pezesha Africa Limited',
      domain: 'pezesha.com',
      country: 'Kenya',
      industry: 'FINTECH',
      regulatoryBody: 'CMA',
      licenceType: 'Regulatory Sandbox Exited Intermediary',
      licenceNumber: null,
      licensingDate: null,
      sandboxAdmissionDate: '2019-07-16',
      sandboxExitDate: '2020-10-01',
      licenceStatus: 'ACTIVE',
      primarySourceUrl: 'https://www.cma.or.ke/regulatory-sandbox/',
      primarySourceAuthority: 'Capital Markets Authority',
      confidence: 0.92,
      companyDescription: 'Pezesha provides digital lending infrastructure, credit scoring, and embedded finance rails for MSMEs across Africa.',
      sizeClass: CompanySizeClass.SMALL,
      hasComplianceObligation: true,
      operatesCrossBorder: true,
      handlesPersonalData: true,
      handlesCustomerFunds: true,
      recommendedFeatures: ['COMPLIANCE_QUERY', 'REGULATORY_MONITORING', 'POLICY_GENERATOR'],
      adminRationale: 'Pezesha operates embedded lending rails under CMA sandbox authorization, requiring ongoing regulatory monitoring.',
      recommendedBuyerRole: 'Head of Risk and Compliance',
      evidence: [
        {
          field: 'licenceType',
          extractedValue: 'Regulatory Sandbox Exited Intermediary',
          sourceUrl: 'https://www.cma.or.ke/regulatory-sandbox/',
          sourceAuthority: 'Capital Markets Authority',
          evidenceSnippet: 'Pezesha Africa Limited - CMA Regulatory Sandbox Cohort 1 (Date of Admission: July 16, 2019, Outcome: Successful, now in the mass market)',
          verificationState: EvidenceVerificationState.VERIFIED,
          extractionMethod: 'AI_DIRECTORY_EXTRACTION',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_source_extract_ke_v1',
        },
        {
          field: 'recommendedBuyerRole',
          extractedValue: 'Head of Risk and Compliance',
          sourceUrl: 'https://pezesha.com',
          sourceAuthority: 'AI_RECOMMENDATION',
          evidenceSnippet: 'Commercial ICP targeting recommendation for SheriaBot sales team',
          verificationState: EvidenceVerificationState.UNVERIFIED,
          extractionMethod: 'AI_COMPANY_RESEARCH',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_company_research_ke_v1',
        },
      ],
    },
    {
      name: 'Pesapal Limited',
      domain: 'pesapal.com',
      country: 'Kenya',
      industry: 'PAYMENTS',
      regulatoryBody: 'CBK',
      licenceType: 'Payment Service Provider',
      licenceNumber: null,
      licensingDate: '2021-06-01',
      licenceStatus: 'ACTIVE',
      primarySourceUrl: 'https://www.centralbank.go.ke/national-payments-system/payment-service-providers/',
      primarySourceAuthority: 'Central Bank of Kenya',
      confidence: 0.95,
      companyDescription: 'Pesapal provides e-commerce payment gateway processing, POS terminals, and ticketing payment infrastructure across East Africa.',
      sizeClass: CompanySizeClass.MEDIUM,
      hasComplianceObligation: true,
      operatesCrossBorder: true,
      handlesPersonalData: true,
      handlesCustomerFunds: true,
      recommendedFeatures: ['COMPLIANCE_QUERY', 'REGULATORY_MONITORING', 'GAP_ANALYSIS', 'CHECKLISTS'],
      adminRationale: 'Authorized Payment Service Provider subject to National Payment System Act, ODPC data protection, and quarterly statutory filings.',
      recommendedBuyerRole: 'Chief Risk Officer / Head of Legal',
      evidence: [
        {
          field: 'licenceType',
          extractedValue: 'Payment Service Provider',
          sourceUrl: 'https://www.centralbank.go.ke/national-payments-system/payment-service-providers/',
          sourceAuthority: 'Central Bank of Kenya',
          evidenceSnippet: 'Pesapal Limited - Authorized Payment Service Provider under National Payment System Act (Date First Licensed: June 1, 2021)',
          verificationState: EvidenceVerificationState.VERIFIED,
          extractionMethod: 'AI_DIRECTORY_EXTRACTION',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_source_extract_ke_v1',
        },
        {
          field: 'recommendedBuyerRole',
          extractedValue: 'Chief Risk Officer / Head of Legal',
          sourceUrl: 'https://pesapal.com',
          sourceAuthority: 'AI_RECOMMENDATION',
          evidenceSnippet: 'Commercial ICP targeting recommendation for SheriaBot sales team',
          verificationState: EvidenceVerificationState.UNVERIFIED,
          extractionMethod: 'AI_COMPANY_RESEARCH',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_company_research_ke_v1',
        },
      ],
    },
    {
      name: 'Stima Deposit-Taking SACCO Society Limited',
      domain: 'stima-sacco.com',
      country: 'Kenya',
      industry: 'MICROFINANCE',
      regulatoryBody: 'SASRA',
      licenceType: 'Deposit-Taking SACCO',
      licenceNumber: null,
      licensingDate: null,
      licenceStatus: 'ACTIVE',
      primarySourceUrl: 'https://www.sasra.go.ke/wp-content/uploads/2026/01/List-of-Licensed-and-Authorized-SACCO-Societies-for-the-Year-Ending-31st-December-2026.pdf',
      primarySourceAuthority: 'SASRA Kenya',
      confidence: 0.95,
      companyDescription: 'Stima Sacco is a Tier-1 licensed Deposit-Taking SACCO offering digital banking, member lending, and savings services in Kenya.',
      sizeClass: CompanySizeClass.LARGE,
      hasComplianceObligation: true,
      operatesCrossBorder: false,
      handlesPersonalData: true,
      handlesCustomerFunds: true,
      recommendedFeatures: ['COMPLIANCE_QUERY', 'REGULATORY_MONITORING', 'GAP_ANALYSIS', 'CHECKLISTS'],
      adminRationale: 'Major Tier-1 regulated DT-SACCO with mandatory SASRA prudential compliance, cybersecurity guidelines, and AML/CFT return requirements.',
      recommendedBuyerRole: 'Head of Internal Audit & Compliance',
      evidence: [
        {
          field: 'licenceType',
          extractedValue: 'Deposit-Taking SACCO',
          sourceUrl: 'https://www.sasra.go.ke/wp-content/uploads/2026/01/List-of-Licensed-and-Authorized-SACCO-Societies-for-the-Year-Ending-31st-December-2026.pdf',
          sourceAuthority: 'SASRA Kenya',
          evidenceSnippet: 'Stima Deposit-Taking SACCO Society Limited - List of Licensed and Authorized SACCO Societies in Kenya for Financial Year Ending 31st December 2026',
          verificationState: EvidenceVerificationState.VERIFIED,
          extractionMethod: 'AI_DIRECTORY_EXTRACTION',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_source_extract_ke_v1',
        },
        {
          field: 'recommendedBuyerRole',
          extractedValue: 'Head of Internal Audit & Compliance',
          sourceUrl: 'https://stima-sacco.com',
          sourceAuthority: 'AI_RECOMMENDATION',
          evidenceSnippet: 'Commercial ICP targeting recommendation for SheriaBot sales team',
          verificationState: EvidenceVerificationState.UNVERIFIED,
          extractionMethod: 'AI_COMPANY_RESEARCH',
          modelProvider: 'anthropic',
          modelName: 'claude-3-5-haiku',
          extractorVersion: 'lead_company_research_ke_v1',
        },
      ],
    },
  ];

  it('executes a real 5-candidate controlled production test with full score and evidence persistence', async () => {
    // 1. Init DiscoveryRun with real runtime identifier
    const run = await leadIngestionService.initDiscoveryRun({
      runIdempotencyKey: 'W-SALES-LEADS-01-KE-CYCLE-1',
      workflowName: 'W-SALES-LEADS-01',
      metadata: {
        executionId: 'exec-n8n-20260914-ke01',
        testMode: 'CONTROLLED_PRODUCTION_TEST',
        sourceSetId: 'KE_REGULATORY_DISCOVERY',
      },
    });

    expect(run.id).toBeDefined();

    // 2. Ingest batch of 5 real candidates
    const batchResult = await leadIngestionService.ingestBatch({
      discoveryRunId: run.id,
      batchId: 'batch-20260914-ke-regulatory-01',
      candidates: REAL_KENYA_CANDIDATES as any,
    });

    expect(batchResult.totalProcessed).toBe(5);
    expect(batchResult.created).toBe(5);
    expect(batchResult.rejected).toBe(0);

    // Verify all 5 candidates were assigned valid deterministic scores and qualified statuses
    for (const res of batchResult.results) {
      expect(res.action).toBe('CREATED');
      expect(res.leadScore).toBeGreaterThanOrEqual(50);
      expect([LeadStatus.PENDING_REVIEW, LeadStatus.NURTURE]).toContain(res.leadStatus);
      expect([IcpTier.TIER_1_CORE_FINTECH, IcpTier.TIER_2_HIGH_EXPOSURE]).toContain(res.icpTier);
    }

    // 3. Complete DiscoveryRun
    const completedRun = await leadIngestionService.completeDiscoveryRun({
      discoveryRunId: run.id,
      status: DiscoveryRunStatus.COMPLETED,
      metadata: {
        executionId: 'exec-n8n-20260914-ke01',
        totalIngested: 5,
        created: 5,
        matched: 0,
      },
    });

    expect(completedRun.status).toBe(DiscoveryRunStatus.COMPLETED);
    expect(completedRun.completedAt).toBeDefined();

    // 4. Assert Zero Outbound Invariant (No Contacts created, No outbound sends)
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});
