import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { TRPCError } from '@trpc/server';
import { ComplianceCategory } from '@prisma/client';
import { resolveEffectivePlan } from '@/modules/billing/resolve-effective-plan';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import {
  isSupportedJurisdiction,
  hasComplianceBaseline,
  getJurisdictionCapability,
  AUDITED_JURISDICTIONS,
} from '@/config/jurisdictions.config';
import {
  KENYA_BASELINE_REQUIREMENTS,
  CATEGORY_WEIGHTS,
  CATEGORY_LABELS,
  getBaselineRequirementsForJurisdiction,
} from './baseline-requirements';

export type DashboardAvailabilityStatus =
  | 'READY'
  | 'BASELINE_UNAVAILABLE'
  | 'JURISDICTION_NOT_ENTITLED'
  | 'JURISDICTION_NOT_CONFIGURED'
  | 'JURISDICTION_UNSUPPORTED';

export type DashboardAssessmentStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ASSESSED';

export type ComplianceRiskBand = 'CRITICAL' | 'POOR' | 'MODERATE' | 'GOOD' | 'EXCELLENT';

export interface RequirementItemDTO {
  id: string;
  requirementKey: string;
  jurisdictionCode: string;
  category: ComplianceCategory;
  title: string;
  description: string;
  reviewStatus: 'NOT_REVIEWED' | 'MEETS_REQUIREMENT' | 'DOES_NOT_MEET_REQUIREMENT';
  isCompleted: boolean;
  assessedAt: string | null;
  updatedAt: string;
}

export interface CategoryPostureDTO {
  category: ComplianceCategory;
  categoryName: string;
  weight: number;
  totalItems: number;
  assessedItems: number;
  compliantItems: number;
  coveragePercent: number;
  score: number | null;
  reviewStatus: 'NOT_REVIEWED' | 'IN_PROGRESS' | 'COMPLETED';
}

export interface ActiveDashboardData {
  jurisdictionCode: string;
  jurisdictionName: string;
  assessmentStatus: DashboardAssessmentStatus;
  scoreType: 'PROVISIONAL' | 'FINAL' | null;
  overallScore: number | null;
  riskBand: ComplianceRiskBand | null;
  coveragePercent: number;
  totalRequirements: number;
  assessedRequirements: number;
  compliantRequirements: number;
  categories: CategoryPostureDTO[];
  requirements: RequirementItemDTO[];
  trend: {
    direction: 'UP' | 'DOWN' | 'STABLE' | 'NONE';
    delta: number | null;
    historicalScores: Array<{ calculatedAt: string; overallScore: number }>;
  };
}

export interface InactiveDashboardData {
  jurisdictionCode: string | null;
  reasonCode: Exclude<DashboardAvailabilityStatus, 'READY'>;
  message: string;
  entitlement: {
    maxEnabledCountries: number;
    enabledCount: number;
    enabledJurisdictions: string[];
  };
}

export type ComplianceDashboardV2Response =
  | {
      availabilityStatus: 'READY';
      context: {
        selectedJurisdiction: string;
        homeJurisdiction: string;
        enabledJurisdictions: string[];
        maxEnabledCountries: number;
      };
      dashboard: ActiveDashboardData;
    }
  | {
      availabilityStatus: Exclude<DashboardAvailabilityStatus, 'READY'>;
      context: {
        selectedJurisdiction: string | null;
        homeJurisdiction: string | null;
        enabledJurisdictions: string[];
        maxEnabledCountries: number;
      };
      dashboard: InactiveDashboardData;
    };

function mapScoreToRiskBand(score: number): ComplianceRiskBand {
  if (score < 40) return 'CRITICAL';
  if (score < 60) return 'POOR';
  if (score < 75) return 'MODERATE';
  if (score < 90) return 'GOOD';
  return 'EXCELLENT';
}

export class ComplianceV2Service {
  private static readonly V2_CACHE_TTL = 300; // 5 min
  private static v2CacheKey(orgId: string, jurisdiction: string): string {
    return `compliance:v2:${orgId}:${jurisdiction.toUpperCase()}`;
  }

  async invalidateCache(orgId: string, jurisdiction: string): Promise<void> {
    await redis.del(ComplianceV2Service.v2CacheKey(orgId, jurisdiction));
  }

  /**
   * Safe, idempotent baseline seeder for canonical requirements.
   * Never deletes records. Uses skipDuplicates to guarantee concurrency safety.
   */
  async seedJurisdictionBaseline(orgId: string, jurisdictionCode: string): Promise<void> {
    const baseline = getBaselineRequirementsForJurisdiction(jurisdictionCode);
    if (baseline.length === 0) return;

    const existingCount = await prisma.complianceItem.count({
      where: {
        organizationId: orgId,
        jurisdictionCode,
        requirementKey: { not: null },
      },
    });

    if (existingCount >= baseline.length) return;

    await prisma.complianceItem.createMany({
      data: baseline.map((b) => ({
        organizationId: orgId,
        requirementKey: b.requirementKey,
        jurisdictionCode,
        category: b.category,
        title: b.title,
        description: b.description,
        isCompleted: false,
        completedAt: null,
        assessedAt: null,
      })),
      skipDuplicates: true,
    });

    logger.info({
      type: 'compliance_v2.baseline_seeded',
      orgId,
      jurisdictionCode,
      count: baseline.length,
    });
  }

  /**
   * Retrieve full V2 compliance dashboard data.
   */
  async getComplianceDashboardV2(
    orgId: string,
    requestedJurisdiction?: string
  ): Promise<ComplianceDashboardV2Response> {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        homeJurisdictionCode: true,
        enabledJurisdictions: true,
        plan: true,
      },
    });

    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }

    const planKey = (org.plan as keyof typeof PLAN_ENTITLEMENTS) ?? 'FREE';
    const maxEnabledCountries = PLAN_ENTITLEMENTS[planKey]?.maxEnabledCountries ?? 1;
    const enabledJurisdictions = org.enabledJurisdictions ?? [];

    // State 1: JURISDICTION_NOT_CONFIGURED
    if (!org.homeJurisdictionCode) {
      return {
        availabilityStatus: 'JURISDICTION_NOT_CONFIGURED',
        context: {
          selectedJurisdiction: null,
          homeJurisdiction: null,
          enabledJurisdictions,
          maxEnabledCountries,
        },
        dashboard: {
          jurisdictionCode: null,
          reasonCode: 'JURISDICTION_NOT_CONFIGURED',
          message: 'Your organization has not yet configured its primary regulatory jurisdiction.',
          entitlement: {
            maxEnabledCountries,
            enabledCount: enabledJurisdictions.length,
            enabledJurisdictions,
          },
        },
      };
    }

    const homeCode = org.homeJurisdictionCode.toUpperCase();
    const selectedCode = (requestedJurisdiction ? requestedJurisdiction.trim().toUpperCase() : homeCode);

    // State 2: JURISDICTION_UNSUPPORTED
    if (!isSupportedJurisdiction(selectedCode)) {
      return {
        availabilityStatus: 'JURISDICTION_UNSUPPORTED',
        context: {
          selectedJurisdiction: selectedCode,
          homeJurisdiction: homeCode,
          enabledJurisdictions,
          maxEnabledCountries,
        },
        dashboard: {
          jurisdictionCode: selectedCode,
          reasonCode: 'JURISDICTION_UNSUPPORTED',
          message: `Jurisdiction "${selectedCode}" is outside SheriaBot's supported regulatory registry.`,
          entitlement: {
            maxEnabledCountries,
            enabledCount: enabledJurisdictions.length,
            enabledJurisdictions,
          },
        },
      };
    }

    // State 3: JURISDICTION_NOT_ENTITLED
    const isEntitled = selectedCode === homeCode || enabledJurisdictions.includes(selectedCode);
    if (!isEntitled) {
      return {
        availabilityStatus: 'JURISDICTION_NOT_ENTITLED',
        context: {
          selectedJurisdiction: selectedCode,
          homeJurisdiction: homeCode,
          enabledJurisdictions,
          maxEnabledCountries,
        },
        dashboard: {
          jurisdictionCode: selectedCode,
          reasonCode: 'JURISDICTION_NOT_ENTITLED',
          message: `Jurisdiction "${selectedCode}" is not enabled under your organization's subscription plan.`,
          entitlement: {
            maxEnabledCountries,
            enabledCount: enabledJurisdictions.length,
            enabledJurisdictions,
          },
        },
      };
    }

    const capability = getJurisdictionCapability(selectedCode);

    // State 4: BASELINE_UNAVAILABLE (e.g. RW, MW, NG in Phase 1)
    if (!hasComplianceBaseline(selectedCode)) {
      return {
        availabilityStatus: 'BASELINE_UNAVAILABLE',
        context: {
          selectedJurisdiction: selectedCode,
          homeJurisdiction: homeCode,
          enabledJurisdictions,
          maxEnabledCountries,
        },
        dashboard: {
          jurisdictionCode: selectedCode,
          reasonCode: 'BASELINE_UNAVAILABLE',
          message: `Verified compliance baseline for ${capability?.name ?? selectedCode} is not yet available. Regulatory alerts for enabled jurisdictions remain available where supported.`,
          entitlement: {
            maxEnabledCountries,
            enabledCount: enabledJurisdictions.length,
            enabledJurisdictions,
          },
        },
      };
    }

    // State 5: READY (Kenya in Phase 1)
    // Read cache
    const cacheKey = ComplianceV2Service.v2CacheKey(orgId, selectedCode);
    const cached = await redis.get<ComplianceDashboardV2Response>(cacheKey);
    if (cached) {
      return cached;
    }

    // Ensure baseline is seeded idempotently
    await this.seedJurisdictionBaseline(orgId, selectedCode);

    // Fetch canonical requirements (V2 QUERY INVARIANT: requirementKey != null, jurisdictionCode == selectedCode)
    const items = await prisma.complianceItem.findMany({
      where: {
        organizationId: orgId,
        jurisdictionCode: selectedCode,
        requirementKey: { not: null },
      },
      orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
    });

    const totalRequirements = items.length;
    const assessedItemsList = items.filter((i) => i.assessedAt !== null);
    const compliantItemsList = items.filter((i) => i.isCompleted);
    const assessedRequirements = assessedItemsList.length;
    const compliantRequirements = compliantItemsList.length;
    const coveragePercent = totalRequirements > 0
      ? Math.round((assessedRequirements / totalRequirements) * 100)
      : 0;

    // Process categories
    const categories: CategoryPostureDTO[] = Object.values(ComplianceCategory).map((cat) => {
      const catItems = items.filter((i) => i.category === cat);
      const catAssessed = catItems.filter((i) => i.assessedAt !== null);
      const catCompliant = catItems.filter((i) => i.isCompleted);
      const catTotal = catItems.length;
      const catCoverage = catTotal > 0 ? Math.round((catAssessed.length / catTotal) * 100) : 0;
      const catScore = catAssessed.length === 0
        ? null
        : Math.round((catCompliant.length / catAssessed.length) * 100);

      const reviewStatus = catAssessed.length === 0
        ? 'NOT_REVIEWED'
        : catAssessed.length === catTotal
        ? 'COMPLETED'
        : 'IN_PROGRESS';

      return {
        category: cat,
        categoryName: CATEGORY_LABELS[cat] ?? cat,
        weight: CATEGORY_WEIGHTS[cat] ?? 0.20,
        totalItems: catTotal,
        assessedItems: catAssessed.length,
        compliantItems: catCompliant.length,
        coveragePercent: catCoverage,
        score: catScore,
        reviewStatus,
      };
    });

    // Scoring Invariant & Exact Provisional Formula
    let assessmentStatus: DashboardAssessmentStatus;
    let scoreType: 'PROVISIONAL' | 'FINAL' | null = null;
    let overallScore: number | null = null;
    let riskBand: ComplianceRiskBand | null = null;

    if (assessedRequirements === 0) {
      assessmentStatus = 'NOT_STARTED';
      scoreType = null;
      overallScore = null;
      riskBand = null;
    } else if (assessedRequirements < totalRequirements) {
      assessmentStatus = 'IN_PROGRESS';
      scoreType = 'PROVISIONAL';
      riskBand = null; // Strictly null while assessment is in progress

      const activeCategories = categories.filter((c) => c.assessedItems > 0 && c.score !== null);
      const activeWeight = activeCategories.reduce((sum, c) => sum + c.weight, 0);

      if (activeWeight > 0) {
        const weightedSum = activeCategories.reduce(
          (sum, c) => sum + (c.score! * c.weight),
          0
        );
        overallScore = Math.round(weightedSum / activeWeight);
      } else {
        overallScore = null;
      }
    } else {
      // 100% assessed
      assessmentStatus = 'ASSESSED';
      scoreType = 'FINAL';
      const weightedSum = categories.reduce(
        (sum, c) => sum + ((c.score ?? 0) * c.weight),
        0
      );
      overallScore = Math.round(weightedSum);
      riskBand = mapScoreToRiskBand(overallScore);

      // Snapshot completed posture periodically (dedup within 1 hour)
      const oneHourAgo = new Date(Date.now() - 3600 * 1000);
      const recentSnapshot = await prisma.complianceScoreSnapshot.findFirst({
        where: {
          organizationId: orgId,
          jurisdictionCode: selectedCode,
          calculatedAt: { gte: oneHourAgo },
        },
      });

      if (!recentSnapshot) {
        await prisma.complianceScoreSnapshot.create({
          data: {
            organizationId: orgId,
            jurisdictionCode: selectedCode,
            overallScore,
            dataProtectionScore: categories.find((c) => c.category === ComplianceCategory.DATA_PROTECTION)?.score ?? 0,
            amlKycScore: categories.find((c) => c.category === ComplianceCategory.AML_KYC)?.score ?? 0,
            consumerProtectionScore: categories.find((c) => c.category === ComplianceCategory.CONSUMER_PROTECTION)?.score ?? 0,
            cbkLicensingScore: categories.find((c) => c.category === ComplianceCategory.CBK_LICENSING)?.score ?? 0,
            cybersecurityScore: categories.find((c) => c.category === ComplianceCategory.CYBERSECURITY)?.score ?? 0,
          },
        });
      }
    }

    // Historical trend scoped strictly to (orgId, selectedCode)
    const snapshots = await prisma.complianceScoreSnapshot.findMany({
      where: {
        organizationId: orgId,
        jurisdictionCode: selectedCode,
      },
      orderBy: { calculatedAt: 'desc' },
      take: 6,
      select: { calculatedAt: true, overallScore: true },
    });

    let trendDirection: 'UP' | 'DOWN' | 'STABLE' | 'NONE' = 'NONE';
    let delta: number | null = null;

    if (snapshots.length >= 2 && overallScore !== null) {
      const prev = snapshots[1].overallScore;
      delta = overallScore - prev;
      if (delta > 0) trendDirection = 'UP';
      else if (delta < 0) trendDirection = 'DOWN';
      else trendDirection = 'STABLE';
    }

    const requirementDTOs: RequirementItemDTO[] = items.map((i) => {
      let reviewStatus: 'NOT_REVIEWED' | 'MEETS_REQUIREMENT' | 'DOES_NOT_MEET_REQUIREMENT' = 'NOT_REVIEWED';
      if (i.assessedAt) {
        reviewStatus = i.isCompleted ? 'MEETS_REQUIREMENT' : 'DOES_NOT_MEET_REQUIREMENT';
      }
      return {
        id: i.id,
        requirementKey: i.requirementKey!,
        jurisdictionCode: i.jurisdictionCode!,
        category: i.category,
        title: i.title,
        description: i.description,
        reviewStatus,
        isCompleted: i.isCompleted,
        assessedAt: i.assessedAt?.toISOString() ?? null,
        updatedAt: i.updatedAt.toISOString(),
      };
    });

    const response: ComplianceDashboardV2Response = {
      availabilityStatus: 'READY',
      context: {
        selectedJurisdiction: selectedCode,
        homeJurisdiction: homeCode,
        enabledJurisdictions,
        maxEnabledCountries,
      },
      dashboard: {
        jurisdictionCode: selectedCode,
        jurisdictionName: capability?.name ?? selectedCode,
        assessmentStatus,
        scoreType,
        overallScore,
        riskBand,
        coveragePercent,
        totalRequirements,
        assessedRequirements,
        compliantRequirements,
        categories,
        requirements: requirementDTOs,
        trend: {
          direction: trendDirection,
          delta,
          historicalScores: snapshots.reverse().map((s) => ({
            calculatedAt: s.calculatedAt.toISOString(),
            overallScore: s.overallScore,
          })),
        },
      },
    };

    await redis.set(cacheKey, response, { ex: ComplianceV2Service.V2_CACHE_TTL });
    return response;
  }

  /**
   * Assess a single dashboard requirement item with strict tenant and jurisdiction validation.
   */
  async assessDashboardItem(
    orgId: string,
    itemId: string,
    status: 'NOT_REVIEWED' | 'MEETS_REQUIREMENT' | 'DOES_NOT_MEET_REQUIREMENT'
  ): Promise<RequirementItemDTO> {
    const item = await prisma.complianceItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Requirement not found' });
    }

    // Invariant 3: Tenant boundary
    if (item.organizationId !== orgId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied across organizations' });
    }

    // Invariant 4 & 5: Requirement must be canonical V2 item
    if (!item.requirementKey || !item.jurisdictionCode) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot mutate unkeyed or unscoped legacy requirement',
      });
    }

    // Invariant 6 & 7: Check organization entitlement
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { homeJurisdictionCode: true, enabledJurisdictions: true },
    });

    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }

    const permittedCodes = new Set([
      (org.homeJurisdictionCode ?? '').toUpperCase(),
      ...(org.enabledJurisdictions ?? []).map((c) => c.toUpperCase()),
    ]);

    if (!permittedCodes.has(item.jurisdictionCode.toUpperCase())) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Jurisdiction "${item.jurisdictionCode}" is locked or not entitled for this organization. Upgrade subscription to modify.`,
      });
    }

    // Apply state transitions
    const now = new Date();
    let isCompleted = false;
    let completedAt: Date | null = null;
    let assessedAt: Date | null = null;

    if (status === 'MEETS_REQUIREMENT') {
      isCompleted = true;
      completedAt = now;
      assessedAt = now;
    } else if (status === 'DOES_NOT_MEET_REQUIREMENT') {
      isCompleted = false;
      completedAt = null;
      assessedAt = now;
    } else {
      // NOT_REVIEWED
      isCompleted = false;
      completedAt = null;
      assessedAt = null;
    }

    const updated = await prisma.complianceItem.update({
      where: { id: itemId },
      data: {
        isCompleted,
        completedAt,
        assessedAt,
      },
    });

    // Invalidate Redis score cache
    await this.invalidateCache(orgId, item.jurisdictionCode);

    return {
      id: updated.id,
      requirementKey: updated.requirementKey!,
      jurisdictionCode: updated.jurisdictionCode!,
      category: updated.category,
      title: updated.title,
      description: updated.description,
      reviewStatus: status,
      isCompleted: updated.isCompleted,
      assessedAt: updated.assessedAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}

export const complianceV2Service = new ComplianceV2Service();
