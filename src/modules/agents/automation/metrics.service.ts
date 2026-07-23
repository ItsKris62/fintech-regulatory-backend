import { TRPCError } from '@trpc/server';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { salesEngagementLookupService as defaultSalesEngagementLookupService, type SalesEngagementLookupService } from '@/modules/agents/sales/engagement-lookup.service';
import { sentryQueryService as defaultSentryQueryService, type SentryQueryService } from '@/lib/sentry-query.service';
import { parseWindowDays, parseJurisdictionFilter } from './duration';
import {
  isSupportedMetricsDepartment,
  SUPPORTED_METRICS_DEPARTMENTS,
  type GetMetricsInput,
  type GetMetricsResult,
  type ProductMetrics,
  type SalesMetrics,
  type SalesOrgSignal,
  type SecurityMetrics,
} from './metrics-types';

const DEFAULT_ORG_JURISDICTION = 'Kenya';
const BASELINE_WINDOW_DAYS = 7;
// PostHog eventCount7d at or above this saturates usageIntensity to 1.0 -
// a provisional heuristic (no existing usage-scoring model to reuse), linear
// below that. Flagged in metrics-types.ts; tune once real conversion data
// validates or invalidates this threshold.
const USAGE_INTENSITY_SATURATION_EVENTS = 50;
const MAX_SALES_ORGS = 50;

type MetricsPrisma = Pick<typeof defaultPrisma, 'complianceQuery' | 'agentRun' | 'organization'>;

export interface AutomationMetricsServiceDependencies {
  prisma?: MetricsPrisma;
  salesEngagementLookupService?: SalesEngagementLookupService;
  sentryQueryService?: SentryQueryService;
  now?: () => Date;
}


export class AutomationMetricsService {
  private readonly prisma: MetricsPrisma;
  private readonly salesEngagementLookupService: SalesEngagementLookupService;
  private readonly sentryQueryService: SentryQueryService;
  private readonly now: () => Date;

  constructor(dependencies: AutomationMetricsServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as MetricsPrisma);
    this.salesEngagementLookupService = dependencies.salesEngagementLookupService ?? defaultSalesEngagementLookupService;
    this.sentryQueryService = dependencies.sentryQueryService ?? defaultSentryQueryService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async getMetrics(input: GetMetricsInput): Promise<GetMetricsResult> {
    if (!isSupportedMetricsDepartment(input.department)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Unsupported department "${input.department}". Supported: ${SUPPORTED_METRICS_DEPARTMENTS.join(', ')}.`,
      });
    }

    const windowDays = parseWindowDays(input.window);

    switch (input.department) {
      case 'product':
        return this.getProductMetrics(windowDays);
      case 'sales':
        return this.getSalesMetrics(windowDays, input.detail, input.jurisdictions);
      case 'security':
        return this.getSecurityMetrics(windowDays);
    }
  }

  private async getProductMetrics(windowDays: number): Promise<ProductMetrics> {
    const periodEnd = this.now();
    const periodStart = new Date(periodEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const baselineStart = new Date(periodStart.getTime() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [queries, baselineTotal] = await Promise.all([
      this.prisma.complianceQuery.count({ where: { createdAt: { gte: periodStart, lt: periodEnd } } }),
      this.prisma.complianceQuery.count({ where: { createdAt: { gte: baselineStart, lt: periodStart } } }),
    ]);

    logger.info({ type: 'automation_metrics_product', queries, baselineTotal, windowDays });

    return { queries, baselineQueries: Math.round(baselineTotal / BASELINE_WINDOW_DAYS) };
  }

  private async getSalesMetrics(windowDays: number, detail: string | undefined, jurisdictions: string | undefined): Promise<SalesMetrics> {
    if (detail !== 'orgs') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'department=sales requires detail=orgs - no other sales metrics shape is defined yet.',
      });
    }

    const jurisdictionFilter = parseJurisdictionFilter(jurisdictions);
    if (jurisdictionFilter && !jurisdictionFilter.includes(DEFAULT_ORG_JURISDICTION)) {
      // Every org defaults to 'Kenya' (see metrics-types.ts) - a filter that
      // excludes it can never match, so return early rather than run the query.
      return { orgs: [] };
    }

    const orgs = await this.prisma.organization.findMany({
      where: { plan: { not: 'REGULATOR' } },
      select: { id: true, name: true, subscriptionTier: true, contactEmail: true },
      orderBy: { name: 'asc' },
      take: MAX_SALES_ORGS,
    });

    const signals: SalesOrgSignal[] = await Promise.all(
      orgs.map(async (org): Promise<SalesOrgSignal> => {
        const engagement = await this.salesEngagementLookupService.lookup(org.id, org.contactEmail);
        const eventCount7d = engagement.available ? engagement.eventCount7d : 0;
        const usageIntensity = Math.min(eventCount7d / USAGE_INTENSITY_SATURATION_EVENTS, 1);

        return {
          orgId: org.id,
          orgName: org.name,
          tier: org.subscriptionTier,
          usageIntensity,
          jurisdiction: DEFAULT_ORG_JURISDICTION,
          topFeatures: [],
        };
      }),
    );

    void windowDays; // no time-windowed field in this shape today; accepted for schema consistency across departments.
    logger.info({ type: 'automation_metrics_sales', orgCount: signals.length });

    return { orgs: signals };
  }

  private async getSecurityMetrics(windowDays: number): Promise<SecurityMetrics> {
    const periodEnd = this.now();
    const periodStart = new Date(periodEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const spend = await this.prisma.agentRun.aggregate({
      where: { startedAt: { gte: periodStart, lt: periodEnd } },
      _sum: { costUsd: true },
    });

    const ceiling = appConfig.agents.maxCostPerDayUsd * windowDays;
    const totalSpend = Number(spend._sum.costUsd ?? 0);
    const aiSpendVsCeiling = ceiling > 0 ? totalSpend / ceiling : 0;

    const { hasCriticalIssue, dataAvailable } = await this.sentryQueryService.checkCriticalIssues();

    logger.info({ type: 'automation_metrics_security', totalSpend, ceiling, aiSpendVsCeiling, hasCriticalIssue, dataAvailable });

    return { hasCriticalIssue, dataAvailable, aiSpendVsCeiling };
  }
}

export const automationMetricsService = new AutomationMetricsService();
