import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/client', () => ({
  complete: vi.fn(),
  stream: vi.fn(),
}));

import { complete } from '@/lib/ai/client';
import { aiService } from '@/lib/ai/ai.service';
import { generateGapAnalysisUserPrompt } from '@/lib/ai/prompts/gap-analysis';
import { generatePolicyUserPrompt } from '@/lib/ai/prompts/policy-generation';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
import {
  extractAnswerClaims,
  persistClaimVerification,
  verifyAnswerClaims,
} from './claim-verification';
import {
  buildCitationsFromAcceptedRefs,
  buildCitationsFromChunks,
  hasUsableCitations,
} from './citations';
import {
  buildComplianceSourceInsufficiencyAnswer,
  hasUsableSourceContext,
} from './source-insufficiency';
import type { SearchResult } from '@/lib/rag/rag.service';

const unsafePhrases = [
  'use your knowledge',
  'broader knowledge',
  'general knowledge',
  'training knowledge',
  'current kenyan regulations',
  'supplement with',
  'answer anyway',
];

function expectNoUnsafePhrases(text: string) {
  const lower = text.toLowerCase();
  for (const phrase of unsafePhrases) {
    expect(lower).not.toContain(phrase);
  }
}

describe('source insufficiency guards', () => {
  it('requires both retrieved chunks and formatted source context', () => {
    expect(hasUsableSourceContext({ results: [], context: '' })).toBe(false);
    expect(hasUsableSourceContext({ results: [{ documentId: 'd1' } as never], context: '' })).toBe(false);
    expect(hasUsableSourceContext({ results: [], context: 'source text' })).toBe(false);
    expect(hasUsableSourceContext({ results: [{ documentId: 'd1' } as never], context: 'source text' })).toBe(true);
  });

  it('builds a compliance abstain answer without legal conclusions', () => {
    const answer = buildComplianceSourceInsufficiencyAnswer();

    expect(answer).toContain('SheriaBot could not find a sufficiently verified source');
    expect(answer).toContain('I have not stated legal obligations');
    expectNoUnsafePhrases(answer);
  });

  it('distinguishes upstream verification service blockers from evidence insufficiency', () => {
    const answer = buildComplianceSourceInsufficiencyAnswer('EXTERNAL_PROVIDER_BILLING_BLOCKER');

    expect(answer).toContain('source verification could not be completed');
    expect(answer).toContain('upstream AI verification service is temporarily unavailable');
    expect(answer).not.toContain('not strong enough');
    expect(answer).not.toContain('No sufficiently relevant indexed documents');
    expectNoUnsafePhrases(answer);
  });

  it('removes model-memory fallback language from no-context gap analysis prompt', () => {
    const prompt = generateGapAnalysisUserPrompt({
      policyText: 'Internal policy text',
      documentName: 'policy.pdf',
      documentType: 'pdf',
      regulatoryFrameworks: ['Data Protection Act 2019'],
      analysisDepth: 'standard',
    });

    expect(prompt).toContain('SOURCE INSUFFICIENCY');
    expect(prompt).toContain('Do not identify legal gaps');
    expectNoUnsafePhrases(prompt);
  });

  it('removes model-memory fallback language from no-context policy generation prompt', () => {
    const prompt = generatePolicyUserPrompt({
      scenario: 'Generate a data protection policy for a Kenyan fintech.',
      organizationType: 'FINTECH',
      regulatoryAreas: ['DATA_PROTECTION'],
    });

    expect(prompt).toContain('SOURCE INSUFFICIENCY');
    expect(prompt).toContain('Do not generate legal obligations');
    expectNoUnsafePhrases(prompt);
  });

  it('does not call the model for compliance answers without RAG context', async () => {
    const result = await aiService.answerComplianceQuery({
      question: 'What are the AML obligations for a PSP?',
    });

    expect(result.model).toBe('source-insufficiency-guard');
    expect(result.inputTokens).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model for policy generation without RAG context', async () => {
    const result = await aiService.generatePolicy({
      scenario: 'Generate an AML policy for a payment provider.',
      organizationType: 'FINTECH',
      regulatoryAreas: ['AML_CFT'],
    });

    expect(result.model).toBe('source-insufficiency-guard');
    expect(result.sections.citations).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model for gap analysis without RAG context', async () => {
    await expect(
      aiService.performGapAnalysis({
        policyText: 'Internal AML policy text',
        documentName: 'aml-policy.pdf',
        documentType: 'pdf',
        regulatoryFrameworks: ['AML/CFT'],
        analysisDepth: 'standard',
      }),
    ).rejects.toThrow('do not provide enough verified regulatory evidence');

    expect(complete).not.toHaveBeenCalled();
  });
});

describe('source citation enforcement', () => {
  const chunks: SearchResult[] = [
    {
      vectorId: 'doc-1-chunk-0',
      chunkId: 'doc-1-chunk-0',
      documentId: 'doc-1',
      documentTitle: 'Data Protection Act',
      jurisdictionCode: 'KE',
      jurisdiction: 'Kenya',
      section: 'Section 25',
      chunkText: 'A data controller shall ensure personal data is processed lawfully.',
      score: 0.91,
      rank: 1,
      source: 'ODPC',
      version: '2019',
      authorityStatus: 'IN_FORCE',
      isBinding: true,
    },
    {
      vectorId: 'doc-2-chunk-0',
      chunkId: 'doc-2-chunk-0',
      documentId: 'doc-2',
      documentTitle: 'Rejected Guidance',
      jurisdictionCode: 'KE',
      jurisdiction: 'Kenya',
      section: 'Part 2',
      chunkText: 'Rejected source text.',
      score: 0.72,
      rank: 2,
    },
  ];

  it('builds citations only from accepted chunk references', () => {
    const citations = buildCitationsFromAcceptedRefs(
      [{ documentId: 'doc-1', documentTitle: 'Data Protection Act', section: 'Section 25', rank: 1 }],
      chunks,
      'verified',
    );

    expect(citations).toHaveLength(1);
    expect(citations[0].documentId).toBe('doc-1');
    expect(citations[0].verified).toBe(true);
    expect(citations[0].verificationStatus).toBe('verified');
  });

  it('does not cite rejected or missing chunks', () => {
    const citations = buildCitationsFromAcceptedRefs(
      [{ documentId: 'missing-doc', documentTitle: 'Missing', section: 'Section 1', rank: 1 }],
      chunks,
      'verified',
    );

    expect(citations).toEqual([]);
    expect(hasUsableCitations(citations)).toBe(false);
  });

  it('keeps citations unverified when verifier did not pass', () => {
    const citations = buildCitationsFromChunks([chunks[0]], 'unverified');

    expect(citations[0].verified).toBe(false);
    expect(citations[0].verificationStatus).toBe('unverified');
  });

  it('does not accept chunks when the grader response cannot be parsed', async () => {
    vi.mocked(complete).mockResolvedValueOnce({
      content: 'not json',
      inputTokens: 10,
      outputTokens: 2,
      model: 'test-model',
      cached: false,
    } as never);

    const result = await runGraderAgent('What does the DPA require?', chunks, 2);

    expect(result.gradeFailed).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });

  it('extracts citation-required legal claims from an answer', () => {
    const claims = extractAnswerClaims(
      'A payment service provider must notify the regulator within 72 hours. This is a practical implementation note.',
    );

    expect(claims.some((claim) => claim.requiresCitation)).toBe(true);
    expect(claims[0].claimType).toBe('deadline');
  });

  it('verifies legal claims against accepted chunk text', () => {
    const result = verifyAnswerClaims(
      'A data controller shall ensure personal data is processed lawfully.',
      [chunks[0]],
    );

    expect(result.verdict).toBe('PASS');
    expect(result.supportedClaims).toHaveLength(1);
    expect(result.unsupportedClaims).toHaveLength(0);
    expect(result.supportedClaims[0].supportExcerpt).toContain('processed lawfully');
  });

  it('flags legal claims unsupported by accepted chunks', () => {
    const result = verifyAnswerClaims(
      'A payment service provider must notify the regulator within 24 hours of every customer complaint.',
      [chunks[0]],
    );

    expect(result.verdict).toBe('FAIL');
    expect(result.unsupportedClaims).toHaveLength(1);
  });

  it('does not throw when claim verification tables are unavailable', async () => {
    const result = verifyAnswerClaims(
      'A data controller shall ensure personal data is processed lawfully.',
      [chunks[0]],
    );

    await expect(
      persistClaimVerification({} as never, 'query-1', result),
    ).resolves.toBeUndefined();
  });
});
