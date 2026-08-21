import type { SearchResult } from '@/lib/rag/rag.service';
import type { AcceptedChunkRef } from '@/modules/compliance/orchestrator/types';
import type { JurisdictionContext, JurisdictionCode } from '@/types/jurisdiction';

export type CitationVerificationStatus = 'verified' | 'unverified' | 'not_checked';

export type SourceCitation = {
  vectorId: string | null;
  chunkId: string | null;
  documentId: string | null;
  documentTitle: string;
  jurisdictionCode: JurisdictionCode | null;
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
  contentHash?: string;
  matchingStrategy?: 'vectorId' | 'chunkId' | 'document_section_rank' | 'document_section';
};

export function buildCitationFromSearchResult(
  source: SearchResult,
  verificationStatus: CitationVerificationStatus = 'not_checked',
): SourceCitation {
  return {
    vectorId: source.vectorId ?? null,
    chunkId: source.chunkId ?? null,
    documentId: source.documentId ?? null,
    documentTitle: source.documentTitle || 'Unknown',
    jurisdictionCode: source.jurisdictionCode ?? null,
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
    regulator: source.source,
    sectionNumber: source.sectionNumber,
    pageNumber: source.pageStart,
    contentHash: source.contentHash,
    matchingStrategy: source.matchingStrategy ?? 'vectorId',
  };
}

export function buildCitationsFromChunks(
  chunks: SearchResult[],
  verificationStatus: CitationVerificationStatus = 'not_checked',
): SourceCitation[] {
  return chunks.map((chunk) => buildCitationFromSearchResult(chunk, verificationStatus));
}

export function hasUsableCitations(citations: SourceCitation[]): boolean {
  return citations.some((citation) =>
    !!citation.vectorId &&
    !!citation.chunkId &&
    !!citation.documentId &&
    !!citation.jurisdictionCode &&
    citation.textSnippet.trim().length > 0,
  );
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
    const vectorMatch = ref.vectorId
      ? ragResults.find((result) => result.vectorId === ref.vectorId)
      : undefined;
    const chunkMatch = !vectorMatch && ref.chunkId
      ? ragResults.find((result) => result.chunkId === ref.chunkId)
      : undefined;
    const documentRankMatch =
      !vectorMatch && !chunkMatch
        ? ragResults.find(
        (result) =>
          result.documentId === ref.documentId &&
          (result.section ?? '') === (ref.section ?? '') &&
          (ref.rank == null || result.rank === ref.rank),
      )
        : undefined;
    const documentSectionMatch =
      !vectorMatch && !chunkMatch && !documentRankMatch
        ? ragResults.find(
        (result) =>
          result.documentId === ref.documentId &&
          (result.section ?? '') === (ref.section ?? ''),
      )
        : undefined;

    const match = vectorMatch ?? chunkMatch ?? documentRankMatch ?? documentSectionMatch;

    if (!match) continue;
    const key = `${match.vectorId}:${match.chunkId}:${match.documentId}:${match.section ?? ''}:${match.rank}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({
      ...match,
      matchingStrategy:
        vectorMatch ? 'vectorId' :
        chunkMatch ? 'chunkId' :
        documentRankMatch ? 'document_section_rank' :
        'document_section',
    });
  }

  return accepted;
}

export function validateCitationsForJurisdiction(
  citations: SourceCitation[],
  jurisdictionContext: JurisdictionContext,
): { valid: boolean; invalidCitations: SourceCitation[] } {
  const invalidCitations = citations.filter((citation) =>
    !citation.vectorId ||
    !citation.chunkId ||
    !citation.documentId ||
    citation.jurisdictionCode !== jurisdictionContext.primaryJurisdiction,
  );

  return {
    valid: invalidCitations.length === 0 && citations.length > 0,
    invalidCitations,
  };
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
