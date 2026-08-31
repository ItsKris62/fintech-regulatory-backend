import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completeMock, retrieveMock, verifierMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  retrieveMock: vi.fn(),
  verifierMock: vi.fn(),
}));

vi.mock('@/lib/ai/client', () => ({ complete: completeMock }));
vi.mock('@/modules/regulatory-intelligence/regulatory-intelligence.service', () => ({
  regulatoryIntelligenceService: { retrieveAndGrade: retrieveMock },
}));
vi.mock('@/modules/compliance/orchestrator/verifier.agent', () => ({
  runVerifierAgent: verifierMock,
}));

import { generateCustomFramework } from './custom-framework-generation.service';

const jurisdictionContext = {
  mode: 'SINGLE' as const,
  jurisdictions: ['NG'] as const,
  primaryJurisdiction: 'NG' as const,
  jurisdictionSource: 'REQUEST' as const,
};

describe('custom framework control-level verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retrieveMock.mockResolvedValue({
      grounded: true,
      abstained: false,
      evidence: [
        { vectorId: 'v1', chunkId: 'c1', documentId: 'd1', documentTitle: 'Rule One', chunkText: 'Maintain access controls.', jurisdictionCode: 'NG', score: 0.9 },
        { vectorId: 'v2', chunkId: 'c2', documentId: 'd2', documentTitle: 'Rule Two', chunkText: 'Keep incident records.', jurisdictionCode: 'NG', score: 0.9 },
      ],
      runId: 'run-1', retrievedCount: 2, acceptedCount: 2, rejectedCount: 0,
      corpusVersionSnapshot: { NG: 'v1' }, retrievalVersion: 'r1',
    });
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        name: 'NG Controls',
        sections: [{
          title: 'Operations',
          controls: [
            { code: 'NG-1', title: 'Access', requirement: 'Maintain access controls.', evidenceRequired: [], sourceIndex: 1 },
            { code: 'NG-2', title: 'Incidents', requirement: 'Keep incident records.', evidenceRequired: [], sourceIndex: 2 },
          ],
        }],
      }),
      inputTokens: 100, outputTokens: 100, cost: 0.01,
    });
    verifierMock.mockResolvedValue({ verdict: 'PASS', unsupportedClaims: [], parseFailed: false, tokens: { input: 1, output: 1 } });
  });

  it('verifies each generated control only against its mapped evidence chunk', async () => {
    const result = await generateCustomFramework({
      intent: 'Create a Nigerian operational compliance control framework.',
      organizationId: 'org-1',
      jurisdictionContext,
    });

    expect(verifierMock).toHaveBeenCalledTimes(2);
    expect(verifierMock.mock.calls[0][1]).toEqual([expect.objectContaining({ chunkId: 'c1' })]);
    expect(verifierMock.mock.calls[1][1]).toEqual([expect.objectContaining({ chunkId: 'c2' })]);
    expect(result.metadata).toMatchObject({ controlsVerified: 2, controlsRejected: 0 });
  });
});
