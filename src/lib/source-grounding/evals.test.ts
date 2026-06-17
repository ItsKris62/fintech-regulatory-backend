import { describe, expect, it } from 'vitest';
import { evaluateRetrievalResults, scoreSourceMetadataCompleteness } from './evals';
import type { SearchResult } from '@/lib/rag/rag.service';

const result = (overrides: Partial<SearchResult>): SearchResult => ({
  documentId: 'doc-1',
  documentTitle: 'Data Protection Act',
  chunkText: 'source text',
  score: 0.9,
  rank: 1,
  ...overrides,
});

describe('source verification eval helpers', () => {
  it('identifies expected source hits and forbidden source hits', () => {
    const evaluation = evaluateRetrievalResults(
      {
        id: 'item-1',
        question: 'DPA question',
        expectedBehavior: 'ANSWER',
        expectedSourceTitles: ['Data Protection Act'],
        forbiddenSourceTitles: ['POCAMLA'],
      },
      [
        result({ documentTitle: 'Data Protection Act' }),
        result({ documentId: 'doc-2', documentTitle: 'POCAMLA' }),
      ],
    );

    expect(evaluation.expectedSourceHit).toBe(true);
    expect(evaluation.forbiddenSourceHit).toBe(true);
    expect(evaluation.precisionSignal).toBe(0.5);
  });

  it('handles abstain/trap items without retrieved support', () => {
    const evaluation = evaluateRetrievalResults(
      {
        id: 'trap',
        question: 'Unavailable source',
        expectedBehavior: 'ABSTAIN',
        expectedSourceTitles: ['Missing Act'],
      },
      [],
    );

    expect(evaluation.abstainSatisfied).toBe(true);
    expect(evaluation.expectedSourceHit).toBe(false);
  });

  it('scores v2 metadata completeness', () => {
    const completeness = scoreSourceMetadataCompleteness([
      result({
        contentHash: 'hash',
        indexVersion: 'v2',
        sourceDocumentVersionId: 'sdv-1',
        officialUrl: 'https://example.com/doc.pdf',
        sectionNumber: '1',
        provisionId: 'prov-1',
        authorityStatus: 'IN_FORCE',
        corpusStatus: 'ACTIVE',
      }),
    ]);

    expect(completeness.score).toBe(1);
    expect(completeness.missingFields).toEqual([]);
  });
});
