import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import type { ClassifiedSignalCore, PilotFintechImpact } from './types';

interface ActivePilotRow {
  id: string;
  email: string;
  pilotCohort: string | null;
  organization: {
    id: string;
    name: string;
    organizationType: string;
    industry: string | null;
    cbkLicenseNumber: string | null;
    website: string | null;
  } | null;
}

interface ImpactMatcherPrisma {
  user: {
    findMany(args: object): Promise<ActivePilotRow[]>;
  };
}

export interface ImpactMatcherDependencies {
  prisma?: ImpactMatcherPrisma;
  now?: () => Date;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function sectorAliases(sector: string): string[] {
  const normalized = normalize(sector);
  const aliases = [normalized];
  if (normalized.includes('payment')) aliases.push('fintech', 'payments', 'psp', 'mobile money');
  if (normalized.includes('digital-lending') || normalized.includes('credit') || normalized.includes('lending')) aliases.push('lending', 'credit', 'digital credit');
  if (normalized.includes('data')) aliases.push('privacy', 'data protection');
  if (normalized.includes('capital') || normalized.includes('securities') || normalized.includes('investment')) aliases.push('investment', 'securities', 'capital markets');
  if (normalized.includes('bank')) aliases.push('banking', 'bank');
  return [...new Set(aliases.filter(Boolean))];
}

function collectMatches(signal: ClassifiedSignalCore, pilot: ActivePilotRow): string[] {
  const organization = pilot.organization;
  if (!organization) return [];

  const haystack = normalize([
    organization.name,
    organization.organizationType,
    organization.industry,
    organization.cbkLicenseNumber ? 'cbk licensed regulated financial institution' : null,
    organization.website,
  ].filter((value): value is string => typeof value === 'string').join(' '));

  const sectors = signal.affectedSectors.flatMap(sectorAliases);
  const obligations = signal.affectedObligations.map(normalize);
  const matches: string[] = [];

  for (const sector of sectors) {
    if (sector.length > 2 && haystack.includes(sector)) matches.push(`sector:${sector}`);
  }

  for (const obligation of obligations) {
    if (obligation.length > 3 && haystack.includes(obligation)) matches.push(`obligation:${obligation}`);
  }

  if (signal.regulatoryBody === 'CBK' && organization.cbkLicenseNumber) matches.push('license:cbk');
  if (signal.jurisdiction === 'KE' && organization.cbkLicenseNumber) matches.push('jurisdiction:ke-cbk');
  if (haystack.includes('fintech') && signal.affectedSectors.length > 0) matches.push('organization:fintech');

  return [...new Set(matches)];
}

export class ImpactMatcherService {
  private readonly prisma: ImpactMatcherPrisma;
  private readonly now: () => Date;

  constructor(dependencies: ImpactMatcherDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as ImpactMatcherPrisma);
    this.now = dependencies.now ?? (() => new Date());
  }

  async matchSignal(agentRunId: string, signal: ClassifiedSignalCore): Promise<PilotFintechImpact[]> {
    const pilots = await this.prisma.user.findMany({
      where: {
        isPilot: true,
        pilotCohort: 'PILOT_COHORT_001',
        pilotAccessStatus: 'ACTIVE',
        pilotExpiresAt: { gt: this.now() },
        organization: { isNot: null },
      },
      select: {
        id: true,
        email: true,
        pilotCohort: true,
        organization: {
          select: {
            id: true,
            name: true,
            organizationType: true,
            industry: true,
            cbkLicenseNumber: true,
            website: true,
          },
        },
      },
    });

    const impacts = pilots.flatMap((pilot) => {
      const organization = pilot.organization;
      if (!organization) return [];
      const matchedFields = collectMatches(signal, pilot);
      if (matchedFields.length === 0) return [];
      return [{
        organizationId: organization.id,
        organizationName: organization.name,
        userId: pilot.id,
        userEmail: pilot.email,
        cohort: pilot.pilotCohort,
        reason: `${organization.name} matched ${signal.title} via ${matchedFields.join(', ')}.`,
        matchedFields,
      }];
    });

    logger.info({ type: 'reg_intel_impact_matched', agentRunId, sourceUrl: signal.sourceUrl, affectedPilotCount: impacts.length });
    return impacts;
  }
}

export const impactMatcherService = new ImpactMatcherService();