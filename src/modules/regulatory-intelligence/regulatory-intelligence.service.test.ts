import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/lib/rag/rag.service';
import type { JurisdictionContext } from '@/types/jurisdiction';

const chunks = vi.hoisted(() => ({
  accepted: {
    vectorId: 'doc-1:chunk-2',
    chunkId: 'chunk-2',
    documentId: 'doc-1',
    documentTitle: 'Kenya AML Regulation',
    jurisdictionCode: 'KE',
    jurisdiction: 'Kenya',
    chunkText: 'Customer due diligence is required before onboarding.',
    score: 0.94,
    rank: 2,
  } as SearchResult,
  rejected: {
    vectorId: 'doc-1:chunk-1',
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    documentTitle: 'Kenya AML Regulation',
    jurisdictionCode: 'KE',
    jurisdiction: 'Kenya',
    chunkText: 'Definitions and commencement provisions.',
    score: 0.96,
    rank: 1,
  } as SearchResult,
}));

const searchAndGetRegulatoryEvidenceContext = vi.hoisted(() => vi.fn());
const runGraderAgent = vi.hoisted(() => vi.fn());
const getContextForPrompt = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rag/rag.service', () => ({
  ragService: { getContextForPrompt },
  searchAndGetRegulatoryEvidenceContext,
}));
vi.mock('@/modules/compliance/orchestrator/grader.agent', () => ({ runGraderAgent }));

describe('RegulatoryIntelligenceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchAndGetRegulatoryEvidenceContext.mockResolvedValue({
      results: [chunks.rejected, chunks.accepted],
      context: 'retrieved context',
      citations: [],
      corpusVersions: { KE: 'test-v1' },
      retrievalVersion: 'regulatory-evidence-v1',
    });
    runGraderAgent.mockResolvedValue({
      accepted: [chunks.accepted],
      rejected: [chunks.rejected],
      gradeFailed: false,
      tokens: { inputTokens: 0, outputTokens: 0 },
      diagnostics: { failureClassification: 'NONE' },
    });
    getContextForPrompt.mockReturnValue(chunks.accepted.chunkText);
  });

  it('preserves exact accepted evidence identity when multiple chunks come from one document', async () => {
    const { regulatoryIntelligenceService } = await import('./regulatory-intelligence.service');
    const jurisdictionContext: JurisdictionContext = {
      mode: 'SINGLE',
      jurisdictions: ['KE'],
      primaryJurisdiction: 'KE',
      jurisdictionSource: 'REQUEST',
    };

    const result = await regulatoryIntelligenceService.retrieveAndGrade({
      question: 'What CDD controls are required?',
      feature: 'POLICY_CITATION_VERIFICATION',
      jurisdictionContext,
      organizationContext: { organizationId: 'org-ke' },
    });

    expect(searchAndGetRegulatoryEvidenceContext).toHaveBeenCalledWith(expect.objectContaining({
      jurisdictionContext,
      preferActiveSources: true,
    }));
    expect(result.grounded).toBe(true);
    expect(result.evidence).toEqual([chunks.accepted]);
    expect(result.rejectedEvidence).toEqual([chunks.rejected]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      vectorId: 'doc-1:chunk-2',
      chunkId: 'chunk-2',
      documentId: 'doc-1',
      jurisdictionCode: 'KE',
    });
  });
});
