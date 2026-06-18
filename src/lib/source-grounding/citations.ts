import type { SearchResult } from '@/lib/rag/rag.service';
import type { AcceptedChunkRef } from '@/modules/compliance/orchestrator/types';

export type CitationVerificationStatus = 'verified' | 'unverified' | 'not_checked';

export type SourceCitation = {
  documentId: string | null;
  documentTitle: string;
  section: string;
  textSnippet: string;
  score: number;
  citation: string | null;
  authorityStatus: string;
  isBinding: boolean;
  source: string | null;
  version: string | null;
  verified: boolean;
  verificationStatus: CitationVerificationStatus;
  regulator?: string;
  sectionTitle?: string;
  sectionNumber?: string;
  pageNumber?: number;
  chunkId?: string;
};

export function buildCitationFromSearchResult(
  source: SearchResult,
  verificationStatus: CitationVerificationStatus = 'not_checked',
): SourceCitation {
  return {
    documentId: source.documentId ?? null,
    documentTitle: source.documentTitle || 'Unknown',
    section: source.section || '',
    textSnippet: (source.chunkText || '').slice(0, 500),
    score: source.score ?? 0,
    citation: source.citation ?? null,
    authorityStatus: source.authorityStatus ?? 'IN_FORCE',
    isBinding: source.isBinding ?? true,
    source: source.source ?? null,
    version: source.version ?? null,
    verified: verificationStatus === 'verified',
    verificationStatus,
    regulator: source.authorityStatus, // regulator is not natively in SearchResult, but we can pass it if it existed.
    sectionNumber: source.sectionNumber,
    pageNumber: source.pageStart,
    // Note: chunkId can be inferred from contentHash or just not provided if not available.
    chunkId: source.contentHash,
  };
}

export function buildCitationsFromChunks(
  chunks: SearchResult[],
  verificationStatus: CitationVerificationStatus = 'not_checked',
): SourceCitation[] {
  return chunks.map((chunk) => buildCitationFromSearchResult(chunk, verificationStatus));
}

export function hasUsableCitations(citations: SourceCitation[]): boolean {
  return citations.some((citation) => !!citation.documentId && citation.textSnippet.trim().length > 0);
}

export function findAcceptedChunks(
  acceptedChunkIds: unknown,
  ragResults: SearchResult[],
): SearchResult[] {
  const acceptedRefs = Array.isArray(acceptedChunkIds)
    ? (acceptedChunkIds as AcceptedChunkRef[])
    : [];

  const accepted: SearchResult[] = [];
  const seen = new Set<string>();

  for (const ref of acceptedRefs) {
    const match =
      ragResults.find(
        (result) =>
          result.documentId === ref.documentId &&
          (result.section ?? '') === (ref.section ?? '') &&
          (ref.rank == null || result.rank === ref.rank),
      ) ??
      ragResults.find(
        (result) =>
          result.documentId === ref.documentId &&
          (result.section ?? '') === (ref.section ?? ''),
      );

    if (!match) continue;
    const key = `${match.documentId}:${match.section ?? ''}:${match.rank}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(match);
  }

  return accepted;
}

export function buildCitationsFromAcceptedRefs(
  acceptedChunkIds: unknown,
  ragResults: SearchResult[],
  verificationStatus: CitationVerificationStatus = 'verified',
): SourceCitation[] {
  return buildCitationsFromChunks(
    findAcceptedChunks(acceptedChunkIds, ragResults),
    verificationStatus,
  );
}
