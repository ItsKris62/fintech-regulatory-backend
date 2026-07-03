import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { postHogQueryClient as defaultPostHogQueryClient, type PostHogQueryClient } from '@/lib/posthog/query-client';
import type {
  AgentWorkforceCost,
  ChurnRiskOrg,
  EngagementAggregate,
  GroundedMetricsSnapshot,
  OrganizationCountByPlan,
  PilotCohortSnapshot,
  UpgradeMomentCandidate,
} from './types';

const CHURN_STATUSES = ['PAST_DUE', 'CANCELLED', 'GRACE_PERIOD', 'EXPIRED'] as const;
const UPGRADE_LOOKBACK_PERIODS = 3;
const UPGRADE_MIN_PERIODS_AT_LIMIT = 2;

type MetricsPrisma = Pick<typeof defaultPrisma, 'organization' | 'agentRun' | 'usagePeriod' | 'user'>;

export interface MetricsComputationDependencies {
  prisma?: MetricsPrisma;
  postHogQueryClient?: PostHogQueryClient;
  now?: () => Date;
}

export interface ComputeSnapshotInput {
  windowDays: number;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export class ProductBiMetricsComputationService {
  private readonly prisma: MetricsPrisma;
  private readonly postHogQueryClient: PostHogQueryClient;
  private readonly now: () => Date;

  constructor(dependencies: MetricsComputationDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as MetricsPrisma);
    this.postHogQueryClient = dependencies.postHogQueryClient ?? defaultPostHogQueryClient;
    this.now = dependencies.now ?? (() => new Date());
  }

  async computeSnapshot(input: ComputeSnapshotInput): Promise<GroundedMetricsSnapshot> {
    const windowEnd = this.now();
    const windowStart = daysAgo(windowEnd, input.windowDays);

    const [organizationCountsByPlan, workforceCosts, upgradeMomentCandidates, churnRiskOrgs, pilotCohorts, engagement] = await Promise.all([
      this.computeOrganizationCountsByPlan(),
      this.computeWorkforceCosts(windowStart, windowEnd),
      this.computeUpgradeMomentCandidates(),
      this.computeChurnRiskOrgs(),
      this.computePilotCohorts(),
      this.computeEngagement(windowStart, windowEnd),
    ]);

    return {
      version: 1,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      organizationCountsByPlan,
      workforceCosts,
      upgradeMomentCandidates,
      churnRiskOrgs,
      pilotCohorts,
      engagement,
    };
  }

  private async computeOrganizationCountsByPlan(): Promise<OrganizationCountByPlan[]> {
    const rows = await this.prisma.organization.groupBy({
      by: ['plan', 'subscriptionStatus'],
      _count: { _all: true },
    });
    return rows.map((row) => ({
      plan: row.plan,
      subscriptionStatus: row.subscriptionStatus,
      count: row._count._all,
    }));
  }

  private async computeWorkforceCosts(windowStart: Date, windowEnd: Date): Promise<AgentWorkforceCost[]> {
    const where = { startedAt: { gte: windowStart, lte: windowEnd } };
    const [totals, byStatus] = await Promise.all([
      this.prisma.agentRun.groupBy({
        by: ['agentType'],
        where,
        _sum: { costUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      this.prisma.agentRun.groupBy({
        by: ['agentType', 'status'],
        where,
        _count: { _all: true },
      }),
    ]);

    const statusCounts = new Map<string, { completed: number; failed: number; haltedBudget: number; haltedIterations: number }>();
    for (const row of byStatus) {
      const existing = statusCounts.get(row.agentType) ?? { completed: 0, failed: 0, haltedBudget: 0, haltedIterations: 0 };
      if (row.status === 'COMPLETED') existing.completed += row._count._all;
      else if (row.status === 'FAILED') existing.failed += row._count._all;
      else if (row.status === 'HALTED_BUDGET') existing.haltedBudget += row._count._all;
      else if (row.status === 'HALTED_ITERATIONS') existing.haltedIterations += row._count._all;
      statusCounts.set(row.agentType, existing);
    }

    return totals.map((row) => {
      const counts = statusCounts.get(row.agentType) ?? { completed: 0, failed: 0, haltedBudget: 0, haltedIterations: 0 };
      return {
        agentType: row.agentType,
        totalCostUsd: Number(row._sum.costUsd ?? 0),
        totalInputTokens: row._sum.inputTokens ?? 0,
        totalOutputTokens: row._sum.outputTokens ?? 0,
        runCount: row._count._all,
        completedCount: counts.completed,
        failedCount: counts.failed,
        haltedBudgetCount: counts.haltedBudget,
        haltedIterationsCount: counts.haltedIterations,
      };
    });
  }

  private async computeUpgradeMomentCandidates(): Promise<UpgradeMomentCandidate[]> {
    const periods = await this.prisma.usagePeriod.findMany({
      where: { planTier: 'STARTUP', checklistGenerationLimit: { gt: 0 } },
      orderBy: [{ organizationId: 'asc' }, { periodStart: 'desc' }],
      select: {
        organizationId: true,
        periodStart: true,
        checklistGenerations: true,
        checklistGenerationLimit: true,
        organization: { select: { name: true } },
      },
    });

    const byOrg = new Map<string, typeof periods>();
    for (const period of periods) {
      const existing = byOrg.get(period.organizationId) ?? [];
      existing.push(period);
      byOrg.set(period.organizationId, existing);
    }

    const candidates: UpgradeMomentCandidate[] = [];
    for (const [organizationId, orgPeriods] of byOrg) {
      const recent = orgPeriods.slice(0, UPGRADE_LOOKBACK_PERIODS);
      const periodsAtOrOverLimit = recent.filter((period) => period.checklistGenerations >= period.checklistGenerationLimit).length;
      if (periodsAtOrOverLimit < UPGRADE_MIN_PERIODS_AT_LIMIT) continue;

      const latest = recent[0];
      candidates.push({
        organizationId,
        organizationName: latest.organization.name,
        plan: 'STARTUP',
        metric: 'checklistGenerations',
        periodsAtOrOverLimit,
        latestPeriodStart: latest.periodStart.toISOString(),
        latestUsage: latest.checklistGenerations,
        latestLimit: latest.checklistGenerationLimit,
      });
    }

    return candidates;
  }

  private async computeChurnRiskOrgs(): Promise<ChurnRiskOrg[]> {
    const orgs = await this.prisma.organization.findMany({
      where: {
        OR: [
          { subscriptionStatus: { in: [...CHURN_STATUSES] } },
          { mpesaFailedRenewalAttempts: { gt: 2 } },
        ],
      },
      select: { id: true, name: true, subscriptionStatus: true, mpesaFailedRenewalAttempts: true },
    });

    return orgs.map((org) => ({
      organizationId: org.id,
      organizationName: org.name,
      subscriptionStatus: org.subscriptionStatus,
      mpesaFailedRenewalAttempts: org.mpesaFailedRenewalAttempts,
      reason: org.mpesaFailedRenewalAttempts > 2
        ? `${org.mpesaFailedRenewalAttempts} failed M-Pesa renewal attempts`
        : `subscriptionStatus is ${org.subscriptionStatus}`,
    }));
  }

  private async computePilotCohorts(): Promise<PilotCohortSnapshot[]> {
    const rows = await this.prisma.user.groupBy({
      by: ['pilotCohort', 'pilotAccessStatus'],
      where: { isPilot: true, pilotCohort: { not: null } },
      _count: { _all: true },
    });

    const byCohort = new Map<string, PilotCohortSnapshot>();
    for (const row of rows) {
      const cohort = row.pilotCohort as string;
      const existing = byCohort.get(cohort) ?? { cohort, activeCount: 0, convertedCount: 0, expiredCount: 0 };
      if (row.pilotAccessStatus === 'ACTIVE') existing.activeCount += row._count._all;
      else if (row.pilotAccessStatus === 'CONVERTED') existing.convertedCount += row._count._all;
      else if (row.pilotAccessStatus === 'EXPIRED') existing.expiredCount += row._count._all;
      byCohort.set(cohort, existing);
    }

    return [...byCohort.values()];
  }

  private async computeEngagement(windowStart: Date, windowEnd: Date): Promise<EngagementAggregate> {
    const result = await this.postHogQueryClient.runHogQLQuery(
      'SELECT count(DISTINCT person_id) FROM events WHERE timestamp > {windowStart} AND timestamp <= {windowEnd}',
      { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    );

    if (!result.available) return { available: false, reason: result.reason };
    const count = result.results[0]?.[0];
    return { available: true, activeDistinctPersons7d: typeof count === 'number' ? count : 0 };
  }
}

export const productBiMetricsComputationService = new ProductBiMetricsComputationService();
