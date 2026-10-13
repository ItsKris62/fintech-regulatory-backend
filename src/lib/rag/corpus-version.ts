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

type CorpusSourceRow = {
  jurisdictionCode: JurisdictionCode;
  id: string;
  checksum: string | null;
  version: string | null;
  sourceDocumentVersionId: string | null;
  indexVersion: string;
  authorityStatus: string;
  isBinding: boolean;
  effectiveDate: Date | null;
  effectiveEndDate: Date | null;
  officialUrl: string | null;
  frameworkSlug: string | null;
};

function sourceSetFingerprint(rows: CorpusSourceRow[]): string {
  const canonicalRows = rows
    .map((row) => ({
      id: row.id,
      checksum: row.checksum,
      version: row.version,
      sourceDocumentVersionId: row.sourceDocumentVersionId,
      indexVersion: row.indexVersion,
      authorityStatus: row.authorityStatus,
      isBinding: row.isBinding,
      effectiveDate: row.effectiveDate?.toISOString() ?? null,
      effectiveEndDate: row.effectiveEndDate?.toISOString() ?? null,
      officialUrl: row.officialUrl,
      frameworkSlug: row.frameworkSlug,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return createHash('sha256')
    .update(JSON.stringify(canonicalRows))
    .digest('hex');
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

    // Bind the snapshot to the exact active source set. The manual generation
    // remains useful for operator-forced invalidation, while this fingerprint
    // prevents a missed counter bump from reusing results grounded in an older
    // corpus. No document or chunk content is read into the identity.
    const sources = await prisma.$queryRaw<CorpusSourceRow[]>`
      SELECT
        "jurisdictionCode",
        "id",
        "checksum",
        "version",
        "sourceDocumentVersionId",
        "indexVersion",
        "authorityStatus"::text AS "authorityStatus",
        "isBinding",
        "effectiveDate",
        "effectiveEndDate",
        "officialUrl",
        "metadata" ->> 'frameworkSlug' AS "frameworkSlug"
      FROM "RegulatoryDocument"
      WHERE "jurisdictionCode" IN (${Prisma.join(requested)})
        AND "status" = 'ACTIVE'
      ORDER BY "jurisdictionCode", "id"
    `;

    const snapshot: CorpusVersionSnapshot = {};
    for (const code of requested) {
      const row = rows.find((item) => item.jurisdictionCode === code);
      if (!row) {
        snapshot[code] = CORPUS_VERSION_FALLBACK;
        continue;
      }

      const fingerprint = sourceSetFingerprint(
        sources.filter((source) => source.jurisdictionCode === code),
      );
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
