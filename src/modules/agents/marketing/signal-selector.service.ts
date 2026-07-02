import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import type { GroundedMarketingSignal, MarketingContentType, MarketingSignalRow } from './types';

type SignalSelectorPrisma = Pick<typeof defaultPrisma, '$queryRaw'>;

export interface SignalSelectorDependencies {
  prisma?: SignalSelectorPrisma;
}

export interface SelectSignalsInput {
  contentType: MarketingContentType;
  limit?: number;
}

function stringArrayFromJson(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function signalFromRow(row: MarketingSignalRow): GroundedMarketingSignal {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    jurisdiction: row.jurisdiction,
    regulatoryBody: row.regulatoryBody,
    documentType: row.documentType,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    affectedSectors: stringArrayFromJson(row.affectedSectors),
    affectedObligations: stringArrayFromJson(row.affectedObligations),
    effectiveDate: row.effectiveDate ? row.effectiveDate.toISOString().slice(0, 10) : null,
    complianceWindowDays: row.complianceWindowDays,
    status: row.status,
  };
}

export function sourceFingerprintFor(signalIds: readonly string[]): string {
  return [...signalIds].sort().join('|');
}

export class MarketingSignalSelectorService {
  private readonly prisma: SignalSelectorPrisma;

  constructor(dependencies: SignalSelectorDependencies = {}) {
    this.prisma = dependencies.prisma ?? defaultPrisma;
  }

  async selectSignals(input: SelectSignalsInput): Promise<GroundedMarketingSignal[]> {
    const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const rows = await this.prisma.$queryRaw<MarketingSignalRow[]>(Prisma.sql`
      SELECT
        rs."id",
        rs."sourceUrl",
        rs."jurisdiction",
        rs."regulatoryBody",
        rs."documentType",
        rs."title",
        rs."summary",
        rs."severity",
        rs."affectedSectors",
        rs."affectedObligations",
        rs."effectiveDate",
        rs."complianceWindowDays",
        rs."status",
        rs."createdAt"
      FROM "RegulatorySignal" rs
      WHERE rs."status" IN ('NEW', 'REVIEWED')
        AND NOT EXISTS (
          SELECT 1
          FROM "MarketingDraft" md
          WHERE md."contentType" = ${input.contentType}
            AND md."sourceFingerprint" = rs."id"
        )
      ORDER BY rs."createdAt" DESC
      LIMIT ${take}
    `);

    return rows.map(signalFromRow);
  }
}

export const marketingSignalSelectorService = new MarketingSignalSelectorService();