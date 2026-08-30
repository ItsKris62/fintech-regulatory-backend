import { describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/lib/rag/rag.service';
import { partitionEvidenceBySourceApproval } from './approved-evidence';

function result(documentId: string, jurisdictionCode: 'KE' | 'NG'): SearchResult {
  return {
    vectorId: `${documentId}-vector`,
    chunkId: `${documentId}-chunk`,
    documentId,
    documentTitle: documentId,
    chunkText: 'evidence',
    jurisdictionCode,
    score: 0.9,
    rank: 1,
  };
}

describe('partitionEvidenceBySourceApproval', () => {
  it('fails closed for NG when approval metadata is missing', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const partition = await partitionEvidenceBySourceApproval(
      [result('ng-unapproved', 'NG')],
      ['NG'],
      { regulatoryDocument: { findMany } } as never,
    );

    expect(partition.eligible).toEqual([]);
    expect(partition.ineligible).toHaveLength(1);
    expect(partition.enforcementApplied).toBe(true);
  });

  it('accepts NG evidence only through an active approved source and allowed URL', async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: 'ng-approved',
      sourceDocumentVersion: {
        officialUrl: 'https://www.cbn.gov.ng/out/rule.pdf',
        approvedSource: {
          baseUrl: 'https://www.cbn.gov.ng',
          allowedDomains: ['cbn.gov.ng'],
        },
      },
    }]);
    const partition = await partitionEvidenceBySourceApproval(
      [result('ng-approved', 'NG'), result('ng-unapproved', 'NG')],
      ['NG'],
      { regulatoryDocument: { findMany } } as never,
    );

    expect(partition.eligible.map((item) => item.documentId)).toEqual(['ng-approved']);
    expect(partition.ineligible.map((item) => item.documentId)).toEqual(['ng-unapproved']);
  });

  it('does not change already-certified legacy jurisdiction behavior', async () => {
    const findMany = vi.fn();
    const evidence = [result('ke-document', 'KE')];
    const partition = await partitionEvidenceBySourceApproval(
      evidence,
      ['KE'],
      { regulatoryDocument: { findMany } } as never,
    );

    expect(partition.eligible).toEqual(evidence);
    expect(partition.enforcementApplied).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
