import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplianceCategory } from '@prisma/client';
import {
  isSupportedJurisdiction,
  hasComplianceBaseline,
  getJurisdictionCapability,
} from '@/config/jurisdictions.config';
import {
  KENYA_BASELINE_REQUIREMENTS,
  getBaselineRequirementsForJurisdiction,
  findKenyaBaselineByKey,
  findKenyaBaselineByTitleAndCategory,
} from '../baseline-requirements';
import { ComplianceV2Service } from '../compliance-dashboard-v2.service';
import { isComplianceDashboardV2Enabled } from '@/lib/rollout/compliance-dashboard-v2-rollout';

const { mockPrisma, mockRedis } = vi.hoisted(() => {
  const mockPrisma = {
    organization: {
      findUnique: vi.fn(),
    },
    complianceItem: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    complianceScoreSnapshot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    featureFlag: {
      findUnique: vi.fn(),
    },
  };

  const mockRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };

  return { mockPrisma, mockRedis };
});

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
}));

describe('Compliance V2 Phase-1 Architecture & Safety Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPLIANCE_DASHBOARD_V2_DISABLED;
  });

  describe('1. Canonical Jurisdiction Capability Resolver', () => {
    it('accurately identifies supported jurisdictions vs unsupported', () => {
      expect(isSupportedJurisdiction('KE')).toBe(true);
      expect(isSupportedJurisdiction('RW')).toBe(true);
      expect(isSupportedJurisdiction('MW')).toBe(true);
      expect(isSupportedJurisdiction('NG')).toBe(true);
      expect(isSupportedJurisdiction('US')).toBe(false);
      expect(isSupportedJurisdiction('GB')).toBe(false);
      expect(isSupportedJurisdiction(null)).toBe(false);
    });

    it('identifies baseline availability strictly for Kenya in Phase 1', () => {
      expect(hasComplianceBaseline('KE')).toBe(true);
      expect(hasComplianceBaseline('RW')).toBe(false);
      expect(hasComplianceBaseline('MW')).toBe(false);
      expect(hasComplianceBaseline('NG')).toBe(false);
      expect(hasComplianceBaseline('FR')).toBe(false);
    });

    it('returns null capability for unsupported country codes', () => {
      expect(getJurisdictionCapability('INVALID')).toBeNull();
      expect(getJurisdictionCapability('RW')?.name).toBe('Rwanda');
    });
  });

  describe('2. Stable Requirement Keys & Catalog', () => {
    it('contains exactly 35 deterministic Kenya baseline requirements', () => {
      expect(KENYA_BASELINE_REQUIREMENTS.length).toBe(35);
      const baseline = getBaselineRequirementsForJurisdiction('KE');
      expect(baseline.length).toBe(35);
    });

    it('returns empty baseline for non-Kenya jurisdictions without guessing', () => {
      expect(getBaselineRequirementsForJurisdiction('RW')).toEqual([]);
      expect(getBaselineRequirementsForJurisdiction('MW')).toEqual([]);
      expect(getBaselineRequirementsForJurisdiction('NG')).toEqual([]);
    });

    it('survives title lookups and resolves canonical requirementKey', () => {
      const match = findKenyaBaselineByTitleAndCategory(
        'Data Protection Officer (DPO) registered',
        ComplianceCategory.DATA_PROTECTION
      );
      expect(match).toBeDefined();
      expect(match?.requirementKey).toBe('KE:DATA_PROTECTION:DPO_REGISTRATION');

      const byKey = findKenyaBaselineByKey('KE:DATA_PROTECTION:DPO_REGISTRATION');
      expect(byKey?.title).toBe('Data Protection Officer (DPO) registered');
    });
  });

  describe('3. Availability Status vs Assessment Status Separation', () => {
    it('returns JURISDICTION_NOT_CONFIGURED when organization has no primary jurisdiction', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_unconfigured',
        homeJurisdictionCode: null,
        enabledJurisdictions: [],
        plan: 'STARTER',
      });

      const res = await service.getComplianceDashboardV2('org_unconfigured');
      expect(res.availabilityStatus).toBe('JURISDICTION_NOT_CONFIGURED');
    });

    it('returns JURISDICTION_UNSUPPORTED when requesting unlisted jurisdiction', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_test',
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
        plan: 'STARTER',
      });

      const res = await service.getComplianceDashboardV2('org_test', 'ZZ');
      expect(res.availabilityStatus).toBe('JURISDICTION_UNSUPPORTED');
    });

    it('returns JURISDICTION_NOT_ENTITLED when requesting country not enabled under subscription', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_test',
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'], // RW not enabled
        plan: 'STARTER',
      });

      const res = await service.getComplianceDashboardV2('org_test', 'RW');
      expect(res.availabilityStatus).toBe('JURISDICTION_NOT_ENTITLED');
    });

    it('returns BASELINE_UNAVAILABLE for enabled non-Kenya country without creating CRITICAL posture', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_rwanda',
        homeJurisdictionCode: 'RW',
        enabledJurisdictions: ['RW'],
        plan: 'STARTER',
      });

      const res = await service.getComplianceDashboardV2('org_rwanda', 'RW');
      expect(res.availabilityStatus).toBe('BASELINE_UNAVAILABLE');
      if (res.availabilityStatus === 'BASELINE_UNAVAILABLE') {
        expect(res.dashboard.message).toContain('Verified compliance baseline for Rwanda is not yet available');
        // Proves Kenya requirements were NEVER seeded
        expect(mockPrisma.complianceItem.createMany).not.toHaveBeenCalled();
      }
    });
  });

  describe('4. Exact Provisional Score Math & Invariants', () => {
    it('returns score=null, scoreType=null, riskBand=null when 0 requirements are assessed', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_ke',
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
        plan: 'STARTER',
      });
      mockPrisma.complianceItem.count.mockResolvedValueOnce(35);
      mockPrisma.complianceItem.findMany.mockResolvedValueOnce(
        KENYA_BASELINE_REQUIREMENTS.map((r, i) => ({
          id: `item_${i}`,
          organizationId: 'org_ke',
          jurisdictionCode: 'KE',
          requirementKey: r.requirementKey,
          category: r.category,
          title: r.title,
          description: r.description,
          isCompleted: false,
          assessedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }))
      );
      mockPrisma.complianceScoreSnapshot.findMany.mockResolvedValueOnce([]);

      const res = await service.getComplianceDashboardV2('org_ke', 'KE');
      expect(res.availabilityStatus).toBe('READY');
      if (res.availabilityStatus === 'READY') {
        expect(res.dashboard.assessmentStatus).toBe('NOT_STARTED');
        expect(res.dashboard.overallScore).toBeNull();
        expect(res.dashboard.scoreType).toBeNull();
        expect(res.dashboard.riskBand).toBeNull();
        expect(res.dashboard.coveragePercent).toBe(0);
      }
    });

    it('calculates provisional score normalized by active category weights when partially assessed', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_ke',
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
        plan: 'STARTER',
      });
      mockPrisma.complianceItem.count.mockResolvedValueOnce(35);

      // Only DATA_PROTECTION items assessed (weight 0.25), all 7 completed (100% in category)
      const mockItems = KENYA_BASELINE_REQUIREMENTS.map((r, i) => {
        const isDp = r.category === ComplianceCategory.DATA_PROTECTION;
        return {
          id: `item_${i}`,
          organizationId: 'org_ke',
          jurisdictionCode: 'KE',
          requirementKey: r.requirementKey,
          category: r.category,
          title: r.title,
          description: r.description,
          isCompleted: isDp,
          assessedAt: isDp ? new Date() : null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });
      mockPrisma.complianceItem.findMany.mockResolvedValueOnce(mockItems);
      mockPrisma.complianceScoreSnapshot.findMany.mockResolvedValueOnce([]);

      const res = await service.getComplianceDashboardV2('org_ke', 'KE');
      expect(res.availabilityStatus).toBe('READY');
      if (res.availabilityStatus === 'READY') {
        expect(res.dashboard.assessmentStatus).toBe('IN_PROGRESS');
        expect(res.dashboard.scoreType).toBe('PROVISIONAL');
        // Active category is 100%, divided by active weight (0.25 / 0.25) -> 100%
        expect(res.dashboard.overallScore).toBe(100);
        // CRITICAL INVARIANT: riskBand must remain null during partial assessment
        expect(res.dashboard.riskBand).toBeNull();
        expect(res.dashboard.coveragePercent).toBe(Math.round((7 / 35) * 100));
      }
    });

    it('returns score=0, scoreType=FINAL, riskBand=CRITICAL when 100% assessed and 0% compliant', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: 'org_ke',
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
        plan: 'STARTER',
      });
      mockPrisma.complianceItem.count.mockResolvedValueOnce(35);

      // All 35 items reviewed as NOT compliant (isCompleted = false, assessedAt != null)
      const mockItems = KENYA_BASELINE_REQUIREMENTS.map((r, i) => ({
        id: `item_${i}`,
        organizationId: 'org_ke',
        jurisdictionCode: 'KE',
        requirementKey: r.requirementKey,
        category: r.category,
        title: r.title,
        description: r.description,
        isCompleted: false,
        assessedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      mockPrisma.complianceItem.findMany.mockResolvedValueOnce(mockItems);
      mockPrisma.complianceScoreSnapshot.findFirst.mockResolvedValueOnce(null);
      mockPrisma.complianceScoreSnapshot.create.mockResolvedValueOnce({ id: 'snap_1' });
      mockPrisma.complianceScoreSnapshot.findMany.mockResolvedValueOnce([]);

      const res = await service.getComplianceDashboardV2('org_ke', 'KE');
      expect(res.availabilityStatus).toBe('READY');
      if (res.availabilityStatus === 'READY') {
        expect(res.dashboard.assessmentStatus).toBe('ASSESSED');
        expect(res.dashboard.scoreType).toBe('FINAL');
        expect(res.dashboard.overallScore).toBe(0);
        expect(res.dashboard.riskBand).toBe('CRITICAL');
        expect(res.dashboard.coveragePercent).toBe(100);
      }
    });
  });

  describe('5. Assessment Write Authorization & Downgrade Protection', () => {
    it('fails closed when attempting to mutate across organization boundary', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.complianceItem.findUnique.mockResolvedValueOnce({
        id: 'item_1',
        organizationId: 'org_other',
        requirementKey: 'KE:DATA_PROTECTION:DPO_REGISTRATION',
        jurisdictionCode: 'KE',
      });

      await expect(
        service.assessDashboardItem('org_current', 'item_1', 'MEETS_REQUIREMENT')
      ).rejects.toThrow('Access denied across organizations');
    });

    it('fails closed when mutating unkeyed legacy requirement', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.complianceItem.findUnique.mockResolvedValueOnce({
        id: 'item_legacy',
        organizationId: 'org_current',
        requirementKey: null, // Legacy unkeyed item
        jurisdictionCode: null,
      });

      await expect(
        service.assessDashboardItem('org_current', 'item_legacy', 'MEETS_REQUIREMENT')
      ).rejects.toThrow('Cannot mutate unkeyed or unscoped legacy requirement');
    });

    it('fails closed when mutating item from locked/downgraded jurisdiction', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.complianceItem.findUnique.mockResolvedValueOnce({
        id: 'item_rw',
        organizationId: 'org_current',
        requirementKey: 'RW:DATA_PROTECTION:TEST',
        jurisdictionCode: 'RW',
      });
      // Organization downgraded to single country (home=KE, enabledJurisdictions=[KE])
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
      });

      await expect(
        service.assessDashboardItem('org_current', 'item_rw', 'MEETS_REQUIREMENT')
      ).rejects.toThrow('locked or not entitled');
    });

    it('applies state transitions correctly on permitted mutation', async () => {
      const service = new ComplianceV2Service();
      mockPrisma.complianceItem.findUnique.mockResolvedValueOnce({
        id: 'item_valid',
        organizationId: 'org_current',
        requirementKey: 'KE:DATA_PROTECTION:DPO_REGISTRATION',
        jurisdictionCode: 'KE',
      });
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
      });
      mockPrisma.complianceItem.update.mockResolvedValueOnce({
        id: 'item_valid',
        organizationId: 'org_current',
        requirementKey: 'KE:DATA_PROTECTION:DPO_REGISTRATION',
        jurisdictionCode: 'KE',
        category: ComplianceCategory.DATA_PROTECTION,
        title: 'Data Protection Officer (DPO) registered',
        description: 'Test description',
        isCompleted: true,
        assessedAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await service.assessDashboardItem('org_current', 'item_valid', 'MEETS_REQUIREMENT');
      expect(updated.isCompleted).toBe(true);
      expect(updated.reviewStatus).toBe('MEETS_REQUIREMENT');
      expect(mockRedis.del).toHaveBeenCalledWith('compliance:v2:org_current:KE');
    });
  });

  describe('6. Feature Flag Precedence Hierarchy', () => {
    it('emergency kill switch overrides database flag and disables V2', async () => {
      process.env.COMPLIANCE_DASHBOARD_V2_DISABLED = 'true';
      mockPrisma.featureFlag.findUnique.mockResolvedValueOnce({
        enabled: true,
        metadata: { rolloutMode: 'ON' },
      });

      const isEnabled = await isComplianceDashboardV2Enabled('org_any');
      expect(isEnabled).toBe(false);
    });

    it('pilot allowlist enables V2 ONLY for allowlisted organizations', async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        enabled: true,
        metadata: {
          rolloutMode: 'ALLOWLIST',
          allowedOrgIds: ['org_pilot_1', 'org_sheriabot_internal'],
        },
      });

      expect(await isComplianceDashboardV2Enabled('org_pilot_1')).toBe(true);
      expect(await isComplianceDashboardV2Enabled('org_sheriabot_internal')).toBe(true);
      expect(await isComplianceDashboardV2Enabled('org_random_customer')).toBe(false);
    });

    it('disabled feature flag fails closed for all organizations', async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValueOnce({
        enabled: false,
        metadata: { rolloutMode: 'ON' },
      });

      expect(await isComplianceDashboardV2Enabled('org_any')).toBe(false);
    });
  });
});
