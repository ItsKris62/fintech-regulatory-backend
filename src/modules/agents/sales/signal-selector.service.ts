import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import type { GroundedSalesProspect, SalesProspectRow } from './types';
import { sourceFingerprintFor } from './types';

type SignalSelectorPrisma = Pick<typeof defaultPrisma, '$queryRaw'>;

export interface SignalSelectorDependencies {
  prisma?: SignalSelectorPrisma;
}

export interface SelectProspectsInput {
  limit?: number;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function isoDateTime(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function prospectFromRow(row: SalesProspectRow): GroundedSalesProspect {
  return {
    signalId: row.signalId,
    organizationId: row.organizationId,
    sourceUrl: row.sourceUrl,
    jurisdiction: row.jurisdiction,
    regulatoryBody: row.regulatoryBody,
    documentType: row.documentType,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    effectiveDate: isoDate(row.effectiveDate),
    complianceWindowDays: row.complianceWindowDays,
    reason: row.reason,
    cohort: row.cohort,
    organizationName: row.organizationName,
    organizationType: row.organizationType,
    industry: row.industry,
    cbkLicenseNumber: row.cbkLicenseNumber,
    plan: row.plan,
    contactPerson: row.contactPerson,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    pilotStatus: row.pilotStatus,
    pilotStartsAt: isoDateTime(row.pilotStartsAt),
    pilotExpiresAt: isoDateTime(row.pilotExpiresAt),
  };
}

/**
 * Sales prospects are individual (RegulatorySignal, Organization) pairs
 * expanded from RegulatorySignal.pilotFintechsAffected - the same data B3
 * used to build recommendedActions.sales, queried directly rather than
 * re-parsing the write-once AgentReport.recommendedActions JSON blob.
 * Dedup mirrors B4's sourceFingerprint pattern: signalId|organizationId.
 */
export class SalesSignalSelectorService {
  private readonly prisma: SignalSelectorPrisma;

  constructor(dependencies: SignalSelectorDependencies = {}) {
    this.prisma = dependencies.prisma ?? defaultPrisma;
  }

  async selectProspects(input: SelectProspectsInput = {}): Promise<GroundedSalesProspect[]> {
    const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const rows = await this.prisma.$queryRaw<SalesProspectRow[]>(Prisma.sql`
      SELECT
        rs."id" AS "signalId",
        rs."sourceUrl",
        rs."jurisdiction",
        rs."regulatoryBody",
        rs."documentType",
        rs."title",
        rs."summary",
        rs."severity",
        rs."effectiveDate",
        rs."complianceWindowDays",
        impact->>'organizationId' AS "organizationId",
        impact->>'reason' AS "reason",
        impact->>'cohort' AS "cohort",
        org."name" AS "organizationName",
        org."organizationType",
        org."industry",
        org."cbkLicenseNumber",
        org."plan"::text AS "plan",
        org."contactPerson",
        org."contactEmail",
        org."contactPhone",
        pa."status"::text AS "pilotStatus",
        pa."startsAt" AS "pilotStartsAt",
        pa."expiresAt" AS "pilotExpiresAt"
      FROM "RegulatorySignal" rs
      CROSS JOIN LATERAL jsonb_array_elements(rs."pilotFintechsAffected") AS impact
      JOIN "Organization" org ON org."id" = impact->>'organizationId'
      LEFT JOIN LATERAL (
        SELECT "status", "startsAt", "expiresAt"
        FROM "PilotAccess"
        WHERE "organizationId" = impact->>'organizationId'
        ORDER BY "startsAt" DESC
        LIMIT 1
      ) pa ON true
      WHERE rs."status" IN ('NEW', 'REVIEWED')
        AND jsonb_array_length(rs."pilotFintechsAffected") > 0
        AND NOT EXISTS (
          SELECT 1
          FROM "SalesOutreachDraft" sod
          WHERE sod."sourceFingerprint" = rs."id" || '|' || (impact->>'organizationId')
        )
      ORDER BY rs."createdAt" DESC
      LIMIT ${take}
    `);

    return rows.map(prospectFromRow);
  }
}

export const salesSignalSelectorService = new SalesSignalSelectorService();
export { sourceFingerprintFor };
