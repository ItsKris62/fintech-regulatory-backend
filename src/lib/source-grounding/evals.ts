import type { SearchResult } from '@/lib/rag/rag.service';

export type SourceVerificationExpectedBehavior = 'ANSWER' | 'ABSTAIN' | 'PARTIAL';

export type SourceVerificationEvalItem = {
  id: string;
  question: string;
  jurisdiction?: string;
  framework?: string;
  expectedBehavior: SourceVerificationExpectedBehavior;
  expectedSourceTitles?: string[];
  expectedDocumentIds?: string[];
  forbiddenSourceTitles?: string[];
  forbiddenDocumentIds?: string[];
  requiresExactProvision?: boolean;
  notes?: string;
};

export type RetrievalEvalResult = {
  id: string;
  expectedBehavior: SourceVerificationExpectedBehavior;
  retrievedCount: number;
  expectedSourceHit: boolean;
  forbiddenSourceHit: boolean;
  abstainSatisfied: boolean;
  precisionSignal: number;
  metadataCompleteness: number;
  missingMetadataFields: string[];
};

function includesAny(value: string | undefined | null, candidates: string[] = []): boolean {
  const normalized = (value ?? '').toLowerCase();
  return candidates.some((candidate) => normalized.includes(candidate.toLowerCase()));
}

export function scoreSourceMetadataCompleteness(results: SearchResult[]): {
  score: number;
  missingFields: string[];
} {
  if (results.length === 0) return { score: 0, missingFields: [] };

  const fields: Array<keyof SearchResult> = [
    'documentId',
    'documentTitle',
    'contentHash',
    'indexVersion',
    'sourceDocumentVersionId',
    'officialUrl',
    'sectionNumber',
    'provisionId',
    'authorityStatus',
    'corpusStatus',
  ];
  const missing = new Set<string>();
  let present = 0;
  let total = 0;

  for (const result of results) {
    for (const field of fields) {
      total++;
      if (result[field] === undefined || result[field] === null || result[field] === '') {
        missing.add(field);
      } else {
        present++;
      }
    }
  }

  return {
    score: total === 0 ? 0 : Number((present / total).toFixed(3)),
    missingFields: Array.from(missing).sort(),
  };
}

export function evaluateRetrievalResults(
  item: SourceVerificationEvalItem,
  results: SearchResult[],
): RetrievalEvalResult {
  const expectedById = new Set(item.expectedDocumentIds ?? []);
  const forbiddenById = new Set(item.forbiddenDocumentIds ?? []);
  const expectedSourceHit = results.some((result) =>
    expectedById.has(result.documentId) ||
    includesAny(result.documentTitle, item.expectedSourceTitles) ||
    includesAny(result.source, item.expectedSourceTitles)
  );
  const forbiddenSourceHit = results.some((result) =>
    forbiddenById.has(result.documentId) ||
    includesAny(result.documentTitle, item.forbiddenSourceTitles) ||
    includesAny(result.source, item.forbiddenSourceTitles)
  );
  const abstainSatisfied = item.expectedBehavior === 'ABSTAIN' ? results.length === 0 || !expectedSourceHit : true;
  const relevantHits = results.filter((result) =>
    expectedById.has(result.documentId) ||
    includesAny(result.documentTitle, item.expectedSourceTitles) ||
    includesAny(result.source, item.expectedSourceTitles)
  ).length;
  const completeness = scoreSourceMetadataCompleteness(results);

  return {
    id: item.id,
    expectedBehavior: item.expectedBehavior,
    retrievedCount: results.length,
    expectedSourceHit,
    forbiddenSourceHit,
    abstainSatisfied,
    precisionSignal: results.length === 0 ? 0 : Number((relevantHits / results.length).toFixed(3)),
    metadataCompleteness: completeness.score,
    missingMetadataFields: completeness.missingFields,
  };
}
