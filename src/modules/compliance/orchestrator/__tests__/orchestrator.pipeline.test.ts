import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOrchestrator } from '../orchestrator';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    complianceQueryRun: {
      create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    },
    complianceQuery: {
      findUnique: vi.fn().mockResolvedValue({ id: 'query-1', metadata: {} }),
      update: vi.fn().mockResolvedValue({ id: 'query-1' }),
    },
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mockPrisma,
}));

vi.mock('../router.agent', () => ({
  runRouterAgent: vi.fn().mockResolvedValue({
    route: 'simple',
    confidence: 0.95,
    subQuestions: [],
    tokens: { input: 100, output: 50 },
    parseFailed: false,
  }),
}));

vi.mock('../grader.agent', () => ({
  runGraderAgent: vi.fn().mockResolvedValue({
    accepted: [
      {
        vectorId: 'vec-1',
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentTitle: 'National Payment System Act',
        chunkText: 'Payment service providers must be authorized by CBK under Section 12.',
        section: 'Section 12',
        sectionNumber: 'Section 12',
        score: 0.9,
        rank: 1,
      },
    ],
    rejected: [],
    gradeFailed: false,
    tokens: { input: 200, output: 80 },
  }),
}));

vi.mock('../verifier.agent', () => ({
  runVerifierAgent: vi.fn().mockResolvedValue({
    verdict: 'PASS',
    unsupportedClaims: [],
    tokens: { input: 150, output: 40 },
    parseFailed: false,
  }),
}));

describe('Orchestrator End-to-End Pipeline Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs complete pipeline (Router -> Reranker -> Grader -> Compression -> Verifier) and creates trace', async () => {
    await runOrchestrator({
      complianceQueryId: 'query-1',
      question: 'Do payment service providers require CBK licensing?',
      answer: 'Yes, payment service providers must be authorized by CBK under Section 12.',
      ragResults: [
        {
          vectorId: 'vec-1',
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          documentTitle: 'National Payment System Act',
          chunkText: 'Payment service providers must be authorized by CBK under Section 12.',
          section: 'Section 12',
          sectionNumber: 'Section 12',
          score: 0.85,
          rank: 1,
        },
      ],
      agenticComplexityLevel: 'simple',
      shadow: false,
    });

    expect(mockPrisma.complianceQueryRun.create).toHaveBeenCalledTimes(1);
    const traceData = mockPrisma.complianceQueryRun.create.mock.calls[0][0].data;
    expect(traceData.status).toBe('completed');
    expect(traceData.route).toBe('simple');
    expect(traceData.grounded).toBe(true);
    expect(traceData.verifierVerdict).toBe('PASS');
    expect(traceData.gradeChunksInspected).toBe(1);
  });
});
