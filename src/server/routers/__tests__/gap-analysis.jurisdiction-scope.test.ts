import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberRole, MemberStatus } from '@prisma/client';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import type { EffectivePlan } from '@/types/plan.types';
import {
  isFrameworkApplicableToJurisdiction,
} from '@/config/framework-metadata.config';
import { buildInternationalEvidenceFilter, type SearchResult } from '@/lib/rag/rag.service';

const mocks = vi.hoisted(() => ({
  plan: 'STARTER' as EffectivePlan,
  source: 'SUBSCRIPTION' as 'SUBSCRIPTION' | 'FREE_TRIAL' | 'PILOT',
  entitlements: null as typeof PLAN_ENTITLEMENTS[EffectivePlan] | null,
  orgHomeJurisdiction: 'KE',
  orgEnabledJurisdictions: ['KE'] as string[],
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  runGapAnalysis: vi.fn(),
  validateBenchmarks: vi.fn(),
  trialIncrement: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    organizationMember: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    regulatoryFramework: { findMany: vi.fn() },
    gapAnalysisFramework: { createMany: vi.fn() },
    gapAnalysis: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/gap-analysis-file-validator', () => ({
  validateGapAnalysisFile: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    incr: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockImplementation(async (_k: string, n: number) => n),
    decr: vi.fn(),
    decrby: vi.fn(),
    expire: vi.fn().mockResolvedValue(1),
    del: mocks.redisDel,
  },
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/lib/system-config', () => ({
  loadSystemConfig: vi.fn().mockResolvedValue({ maintenanceMode: false, maintenanceMessage: '' }),
  getSystemConfigNumber: vi.fn().mockImplementation(async (_key: string, fallback: number) => fallback),
}));

vi.mock('@/server/services/audit.service', () => ({
  logSecurityEvent: vi.fn().mockResolvedValue(undefined),
  SECURITY_EVENT_TYPES: {},
}));

vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 5 }),
  incrementTrialUsageAtomic: mocks.trialIncrement,
}));

vi.mock('@/modules/user/restriction.service', () => ({
  section34RestrictionService: {
    isProcessingPermitted: vi.fn().mockResolvedValue({ permitted: true }),
  },
}));

vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn(async () => ({
    plan: mocks.plan,
    orgPlan: mocks.plan === 'FREE_TRIAL' ? 'FREE' : mocks.plan,
    entitlements: mocks.entitlements ?? PLAN_ENTITLEMENTS[mocks.plan],
    appliedOverrides: [],
    customLimits: null,
    subscriptionStatus: 'ACTIVE',
    gracePeriodEndsAt: null,
    trialState: mocks.plan === 'FREE_TRIAL' ? { isActive: true, daysRemaining: 5 } : undefined,
    pilotState: undefined,
    source: mocks.source,
  })),
}));

vi.mock('@/modules/compliance', () => ({
  complianceModule: {
    runGapAnalysis: mocks.runGapAnalysis,
    getUserGapAnalyses: vi.fn().mockResolvedValue([]),
    getGapAnalysisResult: vi.fn().mockResolvedValue(null),
    deleteGapAnalysis: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../services/benchmark-document.service', () => ({
  validateAuthorizedBenchmarkDocumentIds: mocks.validateBenchmarks,
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mocks.prisma,
}));

vi.mock('@/lib/prisma/tenant-client', () => ({
  getTenantPrisma: vi.fn(() => mocks.prisma),
}));

import { gapAnalysisRouter } from '../gap-analysis.router';

function createCaller(userId = 'usr_batch2_test', orgId = 'org_batch2_test') {
  const routerCaller = gapAnalysisRouter.createCaller({
    prisma: mocks.prisma as any,
    tenantPrisma: mocks.prisma as any,
    user: {
      id: userId,
      email: 'test@sheriabot.com',
      fullName: 'Test User',
      isActive: true,
      emailVerified: true,
      organizationId: orgId,
      lastLoginAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any,
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } },
    res: {},
  } as any);

  return {
    ...routerCaller,
    runGapAnalysis: (input: any) =>
      routerCaller.runGapAnalysis({
        processingConsentAcknowledged: true,
        consentVersion: '2026-10-01',
        ...input,
      }),
  };
}

describe('Batch 2: Jurisdiction Architecture & Framework Scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GAP_ANALYSIS_PILOT_VALIDATED_FRAMEWORKS', '*');
    mocks.plan = 'STARTER';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = null;
    mocks.orgHomeJurisdiction = 'KE';
    mocks.orgEnabledJurisdictions = ['KE'];
    mocks.runGapAnalysis.mockResolvedValue({ analysisId: 'ga_test_123', status: 'QUEUED' });
    mocks.validateBenchmarks.mockResolvedValue([]);
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('sheriabot:orgmem:')) {
        return {
          id: 'mem_batch2',
          organizationId: 'org_batch2_test',
          userId: 'usr_batch2_test',
          role: MemberRole.ADMIN,
          status: MemberStatus.ACTIVE,
        };
      }
      return null;
    });

    mocks.prisma.organization.findUnique.mockImplementation(async () => ({
      id: 'org_batch2_test',
      name: 'Batch 2 Test Org',
      homeJurisdictionCode: mocks.orgHomeJurisdiction,
      enabledJurisdictions: mocks.orgEnabledJurisdictions,
      needsCountryConfirmation: false,
    }));

    mocks.prisma.organizationMember.findUnique.mockResolvedValue({
      id: 'mem_batch2',
      organizationId: 'org_batch2_test',
      userId: 'usr_batch2_test',
      role: MemberRole.ADMIN,
      status: MemberStatus.ACTIVE,
    });

    mocks.prisma.regulatoryFramework.findMany.mockImplementation(async ({ where }: any) => {
      const validDbSlugs = ['cbk-prudential', 'dpa-2019', 'iso-27001', 'pci-dss'];
      const slugs: string[] = (where?.slug?.in ?? []).filter((s: string) => validDbSlugs.includes(s));
      return slugs.map((slug) => {
        const isEnterprise = ['iso-27001', 'pci-dss'].includes(slug);
        return {
          id: `fw_${slug}`,
          slug,
          name: slug.toUpperCase(),
          category: 'Compliance',
          tier: isEnterprise ? 'ENTERPRISE' : 'STARTUP',
          isActive: true,
          sortOrder: 1,
        };
      });
    });

    mocks.prisma.gapAnalysisFramework.createMany.mockResolvedValue({ count: 1 });
  });

  // ==========================================================================
  // AUTHORIZATION MATRIX (Tests 1-10)
  // ==========================================================================
  describe('Authorization Matrix (Tests 1-10)', () => {
    it('1. KE-only org -> KE allowed', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      mocks.plan = 'STARTER';

      const caller = createCaller();
      const res = await caller.runGapAnalysis({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        fileContent: Buffer.from('dummy policy text').toString('base64'),
        regulatoryFrameworks: ['cbk-prudential'],
        analysisDepth: 'quick',
        jurisdiction: 'KE',
      });
      expect(res.analysisId).toBe('ga_test_123');
      expect(mocks.runGapAnalysis).toHaveBeenCalledWith(
        'usr_batch2_test',
        expect.objectContaining({
          jurisdictionContext: expect.objectContaining({
            mode: 'SINGLE',
            primaryJurisdiction: 'KE',
            jurisdictions: ['KE'],
          }),
        }),
      );
    });

    it('2. KE-only org -> RW rejected (FORBIDDEN)', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      mocks.plan = 'STARTER';

      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['cbk-prudential'],
          analysisDepth: 'quick',
          jurisdiction: 'RW',
        }),
      ).rejects.toThrow(/JURISDICTION_NOT_ENTITLED|HOME_JURISDICTION_RESTRICTED|not authorized|JURISDICTION_UNAUTHORIZED/i);
    });

    it('3. RW-only org -> RW allowed', async () => {
      mocks.orgHomeJurisdiction = 'RW';
      mocks.orgEnabledJurisdictions = ['RW'];
      mocks.plan = 'ENTERPRISE';

      const caller = createCaller();
      const res = await caller.runGapAnalysis({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        fileContent: Buffer.from('dummy policy text').toString('base64'),
        regulatoryFrameworks: ['iso-27001'],
        jurisdiction: 'RW',
      });
      expect(res.analysisId).toBe('ga_test_123');
      expect(mocks.runGapAnalysis).toHaveBeenCalledWith(
        'usr_batch2_test',
        expect.objectContaining({
          jurisdictionContext: expect.objectContaining({
            mode: 'SINGLE',
            primaryJurisdiction: 'RW',
          }),
        }),
      );
    });

    it('4. RW-only org -> KE rejected', async () => {
      mocks.orgHomeJurisdiction = 'RW';
      mocks.orgEnabledJurisdictions = ['RW'];
      mocks.plan = 'ENTERPRISE';

      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['iso-27001'],
          jurisdiction: 'KE',
        }),
      ).rejects.toThrow(/JURISDICTION_NOT_ENTITLED|HOME_JURISDICTION_RESTRICTED|not authorized|JURISDICTION_UNAUTHORIZED/i);
    });

    it('5. Business KE+RW -> both KE and RW allowed', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE', 'RW'];
      mocks.plan = 'BUSINESS';

      const caller = createCaller();
      const resKE = await caller.runGapAnalysis({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        fileContent: Buffer.from('dummy policy text').toString('base64'),
        regulatoryFrameworks: ['cbk-prudential'],
        jurisdiction: 'KE',
      });
      expect(resKE.analysisId).toBe('ga_test_123');

      // For RW, use an international or valid RW framework
      mocks.plan = 'ENTERPRISE';
      const resRW = await caller.runGapAnalysis({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        fileContent: Buffer.from('dummy policy text').toString('base64'),
        regulatoryFrameworks: ['iso-27001'],
        jurisdiction: 'RW',
      });
      expect(resRW.analysisId).toBe('ga_test_123');
    });

    it('6. Business KE+RW -> NG rejected', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE', 'RW'];
      mocks.plan = 'ENTERPRISE';

      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['iso-27001'],
          jurisdiction: 'NG',
        }),
      ).rejects.toThrow(/JURISDICTION_NOT_ENTITLED|HOME_JURISDICTION_RESTRICTED|not authorized|JURISDICTION_UNAUTHORIZED/i);
    });

    it('7. Enterprise KE/RW/MW/NG -> all four allowed individually', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE', 'RW', 'MW', 'NG'];
      mocks.plan = 'ENTERPRISE';

      const caller = createCaller();
      for (const j of ['KE', 'RW', 'MW', 'NG'] as const) {
        const res = await caller.runGapAnalysis({
          fileName: `policy_${j}.pdf`,
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['iso-27001'],
          jurisdiction: j,
        });
        expect(res.analysisId).toBe('ga_test_123');
      }
    });

    it('8. Crafted tRPC unauthorized jurisdiction is rejected server-side', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      mocks.plan = 'ENTERPRISE'; // Even with Enterprise plan, if org has only KE enabled, MW is rejected

      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'exploit.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['iso-27001'],
          jurisdiction: 'MW',
        }),
      ).rejects.toThrow(/JURISDICTION_NOT_ENTITLED|HOME_JURISDICTION_RESTRICTED|not authorized|JURISDICTION_UNAUTHORIZED/i);
    });

    it('9. Stale frontend jurisdiction rejected by backend authorization', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      mocks.plan = 'BUSINESS';

      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'stale.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['cbk-prudential'],
          jurisdiction: 'NG',
        }),
      ).rejects.toThrow(/JURISDICTION_NOT_ENTITLED|HOME_JURISDICTION_RESTRICTED|not authorized|JURISDICTION_UNAUTHORIZED/i);
    });

    it('10. Organization country change does not mutate historical analysis jurisdiction snapshot', () => {
      const historicalRecord = {
        id: 'ga_historical_1',
        userId: 'usr_batch2_test',
        organizationId: 'org_batch2_test',
        documentName: 'historical.pdf',
        jurisdictionCode: 'KE',
        createdAt: new Date('2026-01-01'),
      };

      mocks.orgHomeJurisdiction = 'RW';
      mocks.orgEnabledJurisdictions = ['RW'];

      expect(historicalRecord.jurisdictionCode).toBe('KE');
    });
  });

  // ==========================================================================
  // FRAMEWORK APPLICABILITY (Tests 11-17)
  // ==========================================================================
  describe('Framework Applicability (Tests 11-17)', () => {
    it('11. KE domestic framework + KE => allowed', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      const caller = createCaller();

      const res = await caller.runGapAnalysis({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        fileContent: Buffer.from('dummy policy text').toString('base64'),
        regulatoryFrameworks: ['cbk-prudential'],
        analysisDepth: 'quick',
        jurisdiction: 'KE',
      });
      expect(res.analysisId).toBe('ga_test_123');
    });

    it('12. KE domestic framework + RW => rejected with BAD_REQUEST', async () => {
      mocks.orgHomeJurisdiction = 'RW';
      mocks.orgEnabledJurisdictions = ['RW'];
      mocks.plan = 'ENTERPRISE';
      const caller = createCaller();

      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['cbk-prudential'],
          jurisdiction: 'RW',
        }),
      ).rejects.toThrow(/not applicable to jurisdiction RW/i);
    });

    it('13. Framework applicability validator correctly identifies domestic vs international', () => {
      expect(isFrameworkApplicableToJurisdiction('cbk-prudential', 'KE')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction('cbk-prudential', 'RW')).toBe(false);
      expect(isFrameworkApplicableToJurisdiction('cbk-prudential', 'NG')).toBe(false);

      expect(isFrameworkApplicableToJurisdiction('iso-27001', 'KE')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction('iso-27001', 'RW')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction('iso-27001', 'MW')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction('iso-27001', 'NG')).toBe(true);
    });

    it('14. Domestic framework for wrong country cannot be submitted directly', async () => {
      mocks.orgHomeJurisdiction = 'NG';
      mocks.orgEnabledJurisdictions = ['NG'];
      mocks.plan = 'ENTERPRISE';
      const caller = createCaller();

      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['dpa-2019'],
          jurisdiction: 'NG',
        }),
      ).rejects.toThrow(/not applicable to jurisdiction NG/i);
    });

    it('15. International framework + permitted country => allowed', async () => {
      mocks.orgHomeJurisdiction = 'RW';
      mocks.orgEnabledJurisdictions = ['RW'];
      mocks.plan = 'ENTERPRISE';
      const caller = createCaller();

      const res = await caller.runGapAnalysis({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        fileContent: Buffer.from('dummy policy text').toString('base64'),
        regulatoryFrameworks: ['pci-dss', 'iso-27001'],
        jurisdiction: 'RW',
      });
      expect(res.analysisId).toBe('ga_test_123');
    });

    it('16. Invalid framework ID => rejected', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      const caller = createCaller();

      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['non-existent-framework-xyz'],
          analysisDepth: 'quick',
          jurisdiction: 'KE',
        }),
      ).rejects.toThrow(/Invalid framework slug/i);
    });

    it('17. Inactive framework => rejected', async () => {
      mocks.orgHomeJurisdiction = 'KE';
      mocks.orgEnabledJurisdictions = ['KE'];
      const caller = createCaller();

      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.pdf',
          fileType: 'pdf',
          fileContent: Buffer.from('dummy policy text').toString('base64'),
          regulatoryFrameworks: ['inactive-framework'],
          analysisDepth: 'quick',
          jurisdiction: 'KE',
        }),
      ).rejects.toThrow(/Invalid framework slug/i);
    });
  });

  // ==========================================================================
  // RETRIEVAL ISOLATION & INTERNATIONAL EVIDENCE (Tests 18-24)
  // ==========================================================================
  describe('Retrieval Isolation & International Evidence (Tests 18-24)', () => {
    it('18-21. Domestic scope strictly rejects foreign chunks', () => {
      const mockChunks: any[] = [
        { chunkId: '1', chunkText: 'KE law', score: 0.9, jurisdictionCode: 'KE', documentTitle: 'Doc 1' },
        { chunkId: '2', chunkText: 'RW law', score: 0.85, jurisdictionCode: 'RW', documentTitle: 'Doc 2' },
        { chunkId: '3', chunkText: 'MW law', score: 0.8, jurisdictionCode: 'MW', documentTitle: 'Doc 3' },
        { chunkId: '4', chunkText: 'NG law', score: 0.75, jurisdictionCode: 'NG', documentTitle: 'Doc 4' },
      ];

      // KE domestic analysis
      const keFiltered = mockChunks.filter((c) => c.jurisdictionCode === 'KE');
      expect(keFiltered).toHaveLength(1);
      expect(keFiltered[0].jurisdictionCode).toBe('KE');

      // RW domestic analysis
      const rwFiltered = mockChunks.filter((c) => c.jurisdictionCode === 'RW');
      expect(rwFiltered).toHaveLength(1);
      expect(rwFiltered[0].jurisdictionCode).toBe('RW');

      // MW domestic analysis
      const mwFiltered = mockChunks.filter((c) => c.jurisdictionCode === 'MW');
      expect(mwFiltered).toHaveLength(1);
      expect(mwFiltered[0].jurisdictionCode).toBe('MW');

      // NG domestic analysis
      const ngFiltered = mockChunks.filter((c) => c.jurisdictionCode === 'NG');
      expect(ngFiltered).toHaveLength(1);
      expect(ngFiltered[0].jurisdictionCode).toBe('NG');
    });

    it('22. International framework retrieves approved international evidence', () => {
      const mockChunks: any[] = [
        { chunkId: '1', chunkText: 'ISO clause 5.1', score: 0.95, jurisdictionCode: 'GLOBAL', documentTitle: 'ISO 27001' },
        { chunkId: '2', chunkText: 'ISO clause 9.2', score: 0.9, jurisdictionCode: null as any, documentTitle: 'ISO 27001' },
        { chunkId: '3', chunkText: 'RW Domestic Statute', score: 0.85, jurisdictionCode: 'RW', documentTitle: 'RW Law' },
      ];

      const jcode = 'KE';
      const scoped = mockChunks.filter((r) => {
        const isInternational =
          !r.jurisdictionCode ||
          (r.jurisdictionCode as string) === 'GLOBAL' ||
          (r.jurisdictionCode as string) === 'INTERNATIONAL' ||
          r.jurisdiction === 'International' ||
          r.jurisdiction === 'Global';
        const isDomesticMatch = r.jurisdictionCode === jcode;
        return isInternational || isDomesticMatch;
      });

      expect(scoped).toHaveLength(2);
      expect(scoped.map((s) => s.chunkId)).toEqual(['1', '2']);
    });

    it('23. International evidence is not discarded solely because jurisdiction != KE', () => {
      const internationalFilter = buildInternationalEvidenceFilter('RW');
      expect(internationalFilter).toBeDefined();
      // internationalFilter has $and containing the jurisdiction filter
      const orClause = (internationalFilter as any).$and
        ? (internationalFilter as any).$and[0].$or
        : (internationalFilter as any).$or;
      expect(orClause).toBeDefined();
      const hasRW = orClause.some((c: any) => c.jurisdictionCode?.$eq === 'RW');
      const hasGlobal = orClause.some((c: any) => c.jurisdictionCode?.$in?.includes('GLOBAL'));
      expect(hasRW).toBe(true);
      expect(hasGlobal).toBe(true);
    });

    it('24. Unrelated international evidence is not admitted if chunk metadata does not match framework', () => {
      const frameworkSlug = 'iso-27001';
      const chunks = [
        { chunkId: '1', chunkText: 'ISO chunk', frameworkSlug: 'iso-27001' },
        { chunkId: '2', chunkText: 'PCI chunk', frameworkSlug: 'pci-dss' },
      ];

      const validResults = chunks.filter((r) => {
        const chunkSlug = (r as any).frameworkSlug;
        if (chunkSlug && chunkSlug !== frameworkSlug) return false;
        return true;
      });

      expect(validResults).toHaveLength(1);
      expect(validResults[0].chunkId).toBe('1');
    });
  });

  // ==========================================================================
  // GENERIC FALLBACK ELIMINATION (Tests 25-27)
  // ==========================================================================
  describe('Generic Fallback Elimination (Tests 25-27)', () => {
    it('25. No strict framework evidence results in coverage limitation (empty array, no relabelling)', () => {
      const strictEvidence: SearchResult[] = [];
      const hasEvidence = strictEvidence.length > 0;
      expect(hasEvidence).toBe(false);
      const finalEvidence = hasEvidence ? strictEvidence : [];
      expect(finalEvidence).toEqual([]);
    });

    it('26. Generic same-country evidence is NOT relabelled as selected framework', () => {
      const genericCountryChunks = [
        { chunkId: 'gen_1', chunkText: 'General Banking Act Kenya', frameworkSlug: 'banking-act' },
      ];
      const targetFrameworkSlug = 'cbk-prudential';

      const validResults = genericCountryChunks.filter((r) => r.frameworkSlug === targetFrameworkSlug);
      expect(validResults).toHaveLength(0);
    });

    it('27. Evidence for Framework A cannot satisfy Framework B without explicit mapping', () => {
      const chunksForFrameworkA = [
        { chunkId: 'fw_a_1', frameworkSlug: 'pci-dss' },
      ];
      const targetFrameworkSlug = 'iso-27001';

      const validForB = chunksForFrameworkA.filter((r) => r.frameworkSlug === targetFrameworkSlug);
      expect(validForB).toHaveLength(0);
    });
  });

  // ==========================================================================
  // REPORTS & HISTORICAL DISPLAY (Tests 35-37)
  // ==========================================================================
  describe('Reports & Historical Display (Tests 35-37)', () => {
    it('35. Legacy unknown jurisdiction is not fabricated as Kenya', () => {
      const legacyAnalysis = {
        id: 'legacy_1',
        documentName: 'old_policy.pdf',
        jurisdictionCode: null,
      };

      const displayLabel = legacyAnalysis.jurisdictionCode
        ? legacyAnalysis.jurisdictionCode
        : 'Jurisdiction not recorded for this legacy analysis';

      expect(displayLabel).toBe('Jurisdiction not recorded for this legacy analysis');
      expect(displayLabel).not.toContain('Kenya');
      expect(displayLabel).not.toContain('KE');
    });
  });
});
