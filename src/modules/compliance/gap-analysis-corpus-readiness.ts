import { prisma } from '@/lib/prisma/client';
import { CORPUS_VERSION_FALLBACK, getCorpusVersionSnapshot } from '@/lib/rag/corpus-version';
import type { JurisdictionCode, JurisdictionContext } from '@/types/jurisdiction';

export type GapAnalysisCorpusReadinessState = 'READY' | 'UNVERIFIED' | 'STALE' | 'NOT_READY';

export interface GapAnalysisFrameworkReadiness {
  jurisdictionCode: JurisdictionCode;
  frameworkSlug: string;
  state: GapAnalysisCorpusReadinessState;
  corpusVersion: string;
  sourceCount: number;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  manifestChecksum: string | null;
  reason: string;
}

type ReadinessRow = {
  status: string;
  corpusVersion: string;
  sourceCount: number;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  manifestChecksum: string | null;
};

type ReadinessClient = {
  gapAnalysisCorpusReadinessSnapshot: {
    findMany(args: unknown): Promise<Array<ReadinessRow & { frameworkSlug: string }>>;
  };
};

function singleJurisdictionContext(jurisdictionCode: JurisdictionCode): JurisdictionContext {
  return {
    mode: 'SINGLE',
    jurisdictions: [jurisdictionCode],
    primaryJurisdiction: jurisdictionCode,
    jurisdictionSource: 'REQUEST',
  };
}

export function evaluateGapAnalysisCorpusReadiness(
  jurisdictionCode: JurisdictionCode,
  frameworkSlug: string,
  corpusVersion: string,
  record?: ReadinessRow,
): GapAnalysisFrameworkReadiness {
  const base = {
    jurisdictionCode,
    frameworkSlug,
    corpusVersion,
    sourceCount: record?.sourceCount ?? 0,
    reviewedAt: record?.reviewedAt ?? null,
    reviewedBy: record?.reviewedBy ?? null,
    manifestChecksum: record?.manifestChecksum ?? null,
  };
  if (corpusVersion === CORPUS_VERSION_FALLBACK) {
    return { ...base, state: 'UNVERIFIED', reason: 'The corpus version could not be resolved.' };
  }
  if (!record) {
    return { ...base, state: 'UNVERIFIED', reason: 'No reviewed readiness snapshot exists for this framework and corpus version.' };
  }
  if (record.corpusVersion !== corpusVersion) {
    return { ...base, state: 'STALE', reason: 'The reviewed readiness snapshot does not match the active corpus version.' };
  }
  if (
    record.status !== 'READY' ||
    record.sourceCount < 1 ||
    !record.reviewedAt ||
    !record.reviewedBy ||
    !record.manifestChecksum
  ) {
    return { ...base, state: 'NOT_READY', reason: 'The matching readiness snapshot is not a reviewed READY attestation.' };
  }
  return { ...base, state: 'READY', reason: 'Reviewed corpus readiness attestation matches the active corpus version.' };
}

export async function getGapAnalysisFrameworkReadiness(
  jurisdictionCode: JurisdictionCode,
  frameworkSlugs: readonly string[],
  db: ReadinessClient = prisma as unknown as ReadinessClient,
): Promise<GapAnalysisFrameworkReadiness[]> {
  const normalizedSlugs = [...new Set(frameworkSlugs.map((slug) => slug.trim().toLowerCase()))];
  const snapshot = await getCorpusVersionSnapshot(singleJurisdictionContext(jurisdictionCode));
  const corpusVersion = snapshot[jurisdictionCode] ?? CORPUS_VERSION_FALLBACK;
  const records = normalizedSlugs.length === 0 ? [] : await db.gapAnalysisCorpusReadinessSnapshot.findMany({
    where: { jurisdictionCode, frameworkSlug: { in: normalizedSlugs } },
    select: {
      frameworkSlug: true,
      status: true,
      corpusVersion: true,
      sourceCount: true,
      reviewedAt: true,
      reviewedBy: true,
      manifestChecksum: true,
    },
  });
  const byFramework = new Map(records.map((record) => [record.frameworkSlug.toLowerCase(), record]));
  return normalizedSlugs.map((frameworkSlug) => evaluateGapAnalysisCorpusReadiness(
    jurisdictionCode,
    frameworkSlug,
    corpusVersion,
    byFramework.get(frameworkSlug),
  ));
}
