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

    const snapshot: CorpusVersionSnapshot = {};
    for (const code of requested) {
      const row = rows.find((item) => item.jurisdictionCode === code);
      snapshot[code] = row ? String(row.version) : CORPUS_VERSION_FALLBACK;
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
