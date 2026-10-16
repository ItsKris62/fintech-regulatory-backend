import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import type { JurisdictionCode, JurisdictionContext } from '@/types/jurisdiction';

export const CORPUS_VERSION_FALLBACK = 'LEGACY_UNVERSIONED';

export type CorpusVersionSnapshot = Partial<Record<JurisdictionCode, string>>;

type CorpusVersionRow = {
  jurisdictionCode: JurisdictionCode;
  version: number;
};

export type CorpusSourceIdentityRow = {
  jurisdictionCode: JurisdictionCode;
  frameworkSlug: string | null;
  checksum: string | null;
  documentVersion: string | null;
  indexVersion: string;
  documentAuthorityStatus: string;
  documentIsBinding: boolean;
  documentEffectiveDate: Date | null;
  documentEffectiveEndDate: Date | null;
  documentOfficialUrl: string | null;
  approvedSourceJurisdiction: string | null;
  approvedSourceAuthorityName: string | null;
  approvedSourceAuthorityType: string | null;
  approvedSourceBaseUrl: string | null;
  approvedSourceStatus: string | null;
  sourceVersionOfficialUrl: string | null;
  sourceVersionLabel: string | null;
  sourceVersionChecksum: string | null;
  sourceVersionAuthorityStatus: string | null;
  sourceVersionIsBinding: boolean | null;
  sourceVersionStatus: string | null;
  sourceVersionPublicationDate: Date | null;
  sourceVersionEffectiveDate: Date | null;
  sourceVersionEffectiveEndDate: Date | null;
  chunkIndex?: number | null;
  chunkContentHash?: string | null;
  chunkIndexVersion?: string | null;
  chunkPageStart?: number | null;
  chunkPageEnd?: number | null;
  chunkSectionNumber?: string | null;
  chunkClauseNumber?: string | null;
  chunkScheduleNumber?: string | null;
  chunkHeadingPath?: unknown;
  chunkCharStart?: number | null;
  chunkCharEnd?: number | null;
};

function canonicalDate(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function canonicalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function buildCorpusSourceSetFingerprint(rows: CorpusSourceIdentityRow[]): string {
  const canonicalRows = rows
    .map((row) => ({
      jurisdictionCode: row.jurisdictionCode.toUpperCase(),
      frameworkSlug: row.frameworkSlug?.trim().toLowerCase() ?? null,
      checksum: row.checksum,
      documentVersion: row.documentVersion,
      indexVersion: row.indexVersion,
      documentAuthorityStatus: row.documentAuthorityStatus,
      documentIsBinding: row.documentIsBinding,
      documentEffectiveDate: canonicalDate(row.documentEffectiveDate),
      documentEffectiveEndDate: canonicalDate(row.documentEffectiveEndDate),
      documentOfficialUrl: canonicalUrl(row.documentOfficialUrl),
      approvedSourceJurisdiction: row.approvedSourceJurisdiction,
      approvedSourceAuthorityName: row.approvedSourceAuthorityName,
      approvedSourceAuthorityType: row.approvedSourceAuthorityType,
      approvedSourceBaseUrl: canonicalUrl(row.approvedSourceBaseUrl),
      approvedSourceStatus: row.approvedSourceStatus,
      sourceVersionOfficialUrl: canonicalUrl(row.sourceVersionOfficialUrl),
      sourceVersionLabel: row.sourceVersionLabel,
      sourceVersionChecksum: row.sourceVersionChecksum,
      sourceVersionAuthorityStatus: row.sourceVersionAuthorityStatus,
      sourceVersionIsBinding: row.sourceVersionIsBinding,
      sourceVersionStatus: row.sourceVersionStatus,
      sourceVersionPublicationDate: canonicalDate(row.sourceVersionPublicationDate),
      sourceVersionEffectiveDate: canonicalDate(row.sourceVersionEffectiveDate),
      sourceVersionEffectiveEndDate: canonicalDate(row.sourceVersionEffectiveEndDate),
      // Chunk membership is part of the effective retrieval corpus. Content
      // hashes alone are intentionally not unique: the same authoritative text
      // may occur at multiple stable source locations. Keep the locator and
      // membership fields in the fingerprint, but exclude database row IDs and
      // Pinecone IDs because those are deployment artifacts.
      chunkIndex: row.chunkIndex ?? null,
      chunkContentHash: row.chunkContentHash ?? null,
      chunkIndexVersion: row.chunkIndexVersion ?? null,
      chunkPageStart: row.chunkPageStart ?? null,
      chunkPageEnd: row.chunkPageEnd ?? null,
      chunkSectionNumber: row.chunkSectionNumber?.trim() || null,
      chunkClauseNumber: row.chunkClauseNumber?.trim() || null,
      chunkScheduleNumber: row.chunkScheduleNumber?.trim() || null,
      chunkHeadingPath: row.chunkHeadingPath ?? null,
      chunkCharStart: row.chunkCharStart ?? null,
      chunkCharEnd: row.chunkCharEnd ?? null,
    }))
    .map((row) => JSON.stringify(row))
    .sort();

  return createHash('sha256')
    .update(`[${canonicalRows.join(',')}]`)
    .digest('hex');
}

async function loadActiveCorpusSourceRows(
  requested: readonly JurisdictionCode[],
): Promise<CorpusSourceIdentityRow[]> {
  return prisma.$queryRaw<CorpusSourceIdentityRow[]>`
    SELECT
      document."jurisdictionCode",
      document."metadata" ->> 'frameworkSlug' AS "frameworkSlug",
      document."checksum",
      document."version" AS "documentVersion",
      document."indexVersion",
      document."authorityStatus"::text AS "documentAuthorityStatus",
      document."isBinding" AS "documentIsBinding",
      document."effectiveDate" AS "documentEffectiveDate",
      document."effectiveEndDate" AS "documentEffectiveEndDate",
      document."officialUrl" AS "documentOfficialUrl",
      approved."jurisdiction" AS "approvedSourceJurisdiction",
      approved."authorityName" AS "approvedSourceAuthorityName",
      approved."authorityType" AS "approvedSourceAuthorityType",
      approved."baseUrl" AS "approvedSourceBaseUrl",
      approved."status"::text AS "approvedSourceStatus",
      source_version."officialUrl" AS "sourceVersionOfficialUrl",
      source_version."versionLabel" AS "sourceVersionLabel",
      source_version."checksumSha256" AS "sourceVersionChecksum",
      source_version."authorityStatus"::text AS "sourceVersionAuthorityStatus",
      source_version."isBinding" AS "sourceVersionIsBinding",
      source_version."status"::text AS "sourceVersionStatus",
      source_version."publicationDate" AS "sourceVersionPublicationDate",
      source_version."effectiveDate" AS "sourceVersionEffectiveDate",
      source_version."effectiveEndDate" AS "sourceVersionEffectiveEndDate",
      chunk."chunkIndex" AS "chunkIndex",
      chunk."contentHash" AS "chunkContentHash",
      chunk."indexVersion" AS "chunkIndexVersion",
      chunk."pageStart" AS "chunkPageStart",
      chunk."pageEnd" AS "chunkPageEnd",
      chunk."sectionNumber" AS "chunkSectionNumber",
      chunk."clauseNumber" AS "chunkClauseNumber",
      chunk."scheduleNumber" AS "chunkScheduleNumber",
      chunk."headingPath" AS "chunkHeadingPath",
      chunk."charStart" AS "chunkCharStart",
      chunk."charEnd" AS "chunkCharEnd"
    FROM "RegulatoryDocument" AS document
    LEFT JOIN "ApprovedSource" AS approved
      ON approved."id" = document."sourceRegistryId"
    LEFT JOIN "SourceDocumentVersion" AS source_version
      ON source_version."id" = document."sourceDocumentVersionId"
    LEFT JOIN "RegulatoryDocumentChunk" AS chunk
      ON chunk."documentId" = document."id"
    WHERE document."jurisdictionCode" IN (${Prisma.join(requested)})
      AND document."status" = 'ACTIVE'
  `;
}

export async function getCorpusSourceSetFingerprintSnapshot(
  context: JurisdictionContext,
): Promise<CorpusVersionSnapshot> {
  const requested = [...context.jurisdictions];
  const sources = await loadActiveCorpusSourceRows(requested);

  return Object.fromEntries(requested.map((code) => [
    code,
    buildCorpusSourceSetFingerprint(
      sources.filter((source) => source.jurisdictionCode === code),
    ),
  ])) as CorpusVersionSnapshot;
}

export async function getCorpusVersionSnapshot(
  context: JurisdictionContext,
): Promise<CorpusVersionSnapshot> {
  const requested = [...context.jurisdictions];

  try {
    const rows = await prisma.$queryRaw<CorpusVersionRow[]>`
      SELECT "jurisdictionCode", "version"
      FROM "JurisdictionCorpusVersion"
      WHERE "jurisdictionCode" IN (${Prisma.join(requested)})
    `;

    // Bind the snapshot to the exact active source and chunk membership set.
    // The manual generation remains useful for operator-forced invalidation,
    // while this fingerprint prevents a missed counter bump from reusing
    // results grounded in an older effective retrieval corpus.
    const fingerprints = await getCorpusSourceSetFingerprintSnapshot(context);

    const snapshot: CorpusVersionSnapshot = {};
    for (const code of requested) {
      const row = rows.find((item) => item.jurisdictionCode === code);
      if (!row) {
        snapshot[code] = CORPUS_VERSION_FALLBACK;
        continue;
      }

      const fingerprint = fingerprints[code];
      if (!fingerprint) {
        snapshot[code] = CORPUS_VERSION_FALLBACK;
        continue;
      }
      snapshot[code] = `${row.version}:${fingerprint}`;
    }
    return snapshot;
  } catch (error) {
    logger.warn({
      type: 'corpus_version_snapshot_fallback',
      jurisdictions: requested,
      error: error instanceof Error ? error.message : String(error),
    });

    return Object.fromEntries(
      requested.map((code) => [code, CORPUS_VERSION_FALLBACK]),
    ) as CorpusVersionSnapshot;
  }
}
