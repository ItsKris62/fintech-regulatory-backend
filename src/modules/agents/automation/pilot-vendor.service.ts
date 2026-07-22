import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { parseJurisdictionFilter } from './duration';

const DEFAULT_ORG_JURISDICTION = 'Kenya';
const MAX_COHORT_ORGS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type PilotVendorPrisma = Pick<typeof defaultPrisma, 'user' | 'complianceQuery'>;

export interface AutomationPilotVendorServiceDependencies {
  prisma?: PilotVendorPrisma;
  now?: () => Date;
}

export interface PilotCohortOrgStatus {
  orgId: string;
  status: string;
  daysSinceLastQuery: number;
}

export interface DpaVendorStatus {
  name: string;
  status: string;
}

export class AutomationPilotVendorService {
  private readonly prisma: PilotVendorPrisma;
  private readonly now: () => Date;

  constructor(dependencies: AutomationPilotVendorServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as PilotVendorPrisma);
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * jurisdiction has no backing field on Organization (same finding as Phase
   * 1's sales metrics) - every org defaults to 'Kenya'; a filter excluding it
   * short-circuits to an empty list rather than guessing per-org values.
   *
   * daysSinceLastQuery: when an org's pilot users have never run a
   * ComplianceQuery, there is no real "last query" event to report. Rather
   * than fabricate 0 (which would misleadingly read as "queried today"),
   * this falls back to days-since-pilot-user-created as an honest, clearly-
   * labeled proxy for "how long this org has been idle since it had any
   * account activity we can measure" - flagged here and in the Phase 3 report.
   */
  async getPilotCohortStatus(input: { cohort: string; jurisdictions: string }): Promise<{ orgs: PilotCohortOrgStatus[] }> {
    const jurisdictionFilter = parseJurisdictionFilter(input.jurisdictions);
    if (jurisdictionFilter && !jurisdictionFilter.includes(DEFAULT_ORG_JURISDICTION)) {
      return { orgs: [] };
    }

    const pilotUsers = await this.prisma.user.findMany({
      where: { isPilot: true, pilotCohort: input.cohort, organizationId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { organizationId: true, pilotAccessStatus: true, createdAt: true },
      take: MAX_COHORT_ORGS * 5,
    });

    const byOrg = new Map<string, { status: string; earliestSignal: Date }>();
    for (const user of pilotUsers) {
      const orgId = user.organizationId as string;
      if (!byOrg.has(orgId)) {
        // pilotUsers is ordered createdAt desc, so the first user seen per org is the most recent - its status represents the org.
        byOrg.set(orgId, { status: user.pilotAccessStatus, earliestSignal: user.createdAt });
      }
    }

    const orgIds = [...byOrg.keys()].slice(0, MAX_COHORT_ORGS);
    const now = this.now();

    const results = await Promise.all(
      orgIds.map(async (orgId): Promise<PilotCohortOrgStatus> => {
        const { status, earliestSignal } = byOrg.get(orgId)!;
        const latestQuery = await this.prisma.complianceQuery.findFirst({
          where: { user: { organizationId: orgId } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });

        const referenceDate = latestQuery?.createdAt ?? earliestSignal;
        const daysSinceLastQuery = Math.max(0, Math.floor((now.getTime() - referenceDate.getTime()) / MS_PER_DAY));

        return { orgId, status, daysSinceLastQuery };
      }),
    );

    logger.info({ type: 'automation_pilot_cohort_status', cohort: input.cohort, orgCount: results.length });
    return { orgs: results };
  }

  /**
   * No DPA/vendor-tracking model or document exists anywhere in this
   * codebase (confirmed by repo-wide search) - returning fabricated vendor
   * names would be worse than an honest empty state. Deviates from the
   * brief's exact `{ vendors: [...] }` shape by adding `dataAvailable`, same
   * pattern as Phase 1's security.dataAvailable.
   */
  async getDpaVendorStatus(): Promise<{ vendors: DpaVendorStatus[]; dataAvailable: boolean }> {
    logger.info({ type: 'automation_dpa_vendor_status_unavailable' });
    return { vendors: [], dataAvailable: false };
  }
}

export const automationPilotVendorService = new AutomationPilotVendorService();
