import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ragService } from '@/lib/rag/rag.service';
import { prisma } from '@/lib/prisma/client';
import { extractPdfText } from '@/lib/pdf/extract-text';
import { aiService } from '@/lib/ai/ai.service';
import { executeGapAnalysisPipeline } from './compliance.module';

vi.mock('@/lib/rag/rag.service', () => ({
  ragService: {
    search: vi.fn().mockResolvedValue([
      {
        documentId: 'bench-doc-1',
        documentTitle: 'Data Protection Act 2019',
        chunkText: 'DPA context about privacy rights, breach notification, consent, and data subject access.',
        frameworkSlug: 'dpa_2019',
        score: 0.95,
        rank: 1,
      },
    ]),
  },
}));

vi.mock('@/modules/regulatory-intelligence/regulatory-intelligence.service', () => ({
  regulatoryIntelligenceService: {
    retrieveAndGrade: vi.fn().mockResolvedValue({
      evidence: [
        {
          vectorId: 'bench-doc-1:chunk-1',
          chunkId: 'chunk-1',
          documentId: 'bench-doc-1',
          documentTitle: 'Data Protection Act 2019',
          chunkText: 'DPA context about privacy rights, breach notification, consent, and data subject access.',
          frameworkSlug: 'dpa_2019',
          jurisdictionCode: 'KE',
          score: 0.95,
          rank: 1,
        },
      ],
    }),
  },
}));

vi.mock('@/modules/compliance/orchestrator/verifier.agent', () => ({
  runVerifierAgent: vi.fn().mockResolvedValue({
    verdict: 'PASS', unsupportedClaims: [], parseFailed: false,
    tokens: { input: 10, output: 5 },
  }),
}));

vi.mock('@/lib/pdf/extract-text', () => ({
  extractPdfText: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    gapAnalysis: {
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@/lib/ai/ai.service', () => ({
  aiService: {
    performGapAnalysis: vi.fn().mockResolvedValue({
      result: {
        overallScore: 85,
        executiveSummary: 'Mock summary',
        frameworks: [
          {
            id: 'DPA_2019',
            name: 'Data Protection Act 2019',
            score: 85,
            gaps: [],
            strengths: ['Privacy controls are documented'],
            summary: 'DPA controls are mostly present.',
          },
        ],
        crossCuttingStrengths: [],
        actionPlan: [],
        metadata: {
          documentName: 'test.pdf',
          analysisDepth: 'standard',
          frameworksAnalysed: ['Data Protection Act 2019'],
          totalGaps: 0,
          criticalGaps: 0,
          highGaps: 0,
          analysisDate: new Date().toISOString(),
        },
      },
      inputTokens: 100,
      outputTokens: 50,
    }),
    performMultiChunkGapAnalysis: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    del: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/modules/notification', () => ({
  notificationModule: {
    createCategorizedNotification: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/modules/trial', () => ({
  incrementTrialUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const basePipelineParams = {
  analysisId: 'gap-analysis-test',
  userId: 'user-1',
  fileName: 'policy.pdf',
  fileContent: Buffer.from('%PDF test content').toString('base64'),
  fileType: 'pdf',
  regulatoryFrameworks: ['Data Protection Act 2019'],
  regulatoryFrameworkSlugs: ['dpa_2019'],
  jurisdictionContext: {
    mode: 'SINGLE' as const,
    jurisdictions: ['KE'] as const,
    primaryJurisdiction: 'KE' as const,
    jurisdictionSource: 'REQUEST' as const,
  },
  analysisDepth: 'standard' as const,
};

function completedUpdate() {
  return vi.mocked(prisma.gapAnalysis.update).mock.calls.find(([arg]) => (
    arg.data?.status === 'COMPLETED'
  ))?.[0];
}

describe('Gap Analysis Pipeline Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails early and updates DB status to FAILED if extraction yields empty or insufficient text', async () => {
    vi.mocked(extractPdfText).mockResolvedValueOnce('   \n  Tiny snippet.  ');

    await expect(executeGapAnalysisPipeline({
      ...basePipelineParams,
      analysisId: 'gap-fail-test',
      fileName: 'ScannedDoc.pdf',
    })).rejects.toThrow('Could not extract meaningful text');

    expect(extractPdfText).toHaveBeenCalled();
    expect(prisma.gapAnalysis.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gap-fail-test' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringContaining('Could not extract meaningful text'),
        }),
      })
    );
    expect(ragService.search).not.toHaveBeenCalled();
    expect(aiService.performGapAnalysis).not.toHaveBeenCalled();
  });

  it('uses strict frameworkSlug and selected benchmarkDocumentIds filters for each RAG retrieval', async () => {
    vi.mocked(extractPdfText).mockResolvedValueOnce(
      'Valid substantive text that safely surpasses the readable text guard threshold. '.repeat(10)
    );

    await executeGapAnalysisPipeline({
      ...basePipelineParams,
      analysisId: 'gap-success-test',
      fileName: 'ValidPolicy.pdf',
      regulatoryFrameworks: ['Data Protection Act 2019', 'CBK Prudential Guidelines'],
      regulatoryFrameworkSlugs: ['dpa_2019', 'cbk_pg'],
      benchmarkDocumentIds: ['bench-doc-1', 'bench-doc-2'],
    });

    const { regulatoryIntelligenceService } = await import('@/modules/regulatory-intelligence/regulatory-intelligence.service');
    expect(regulatoryIntelligenceService.retrieveAndGrade).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('Data Protection Act 2019'),
        feature: 'GAP_ANALYSIS',
        jurisdictionContext: basePipelineParams.jurisdictionContext,
        retrievalProfile: expect.objectContaining({
          filter: {
            frameworkSlug: 'dpa_2019',
            documentId: { $in: ['bench-doc-1', 'bench-doc-2'] },
          },
        }),
      })
    );
    expect(regulatoryIntelligenceService.retrieveAndGrade).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('CBK Prudential Guidelines'),
        feature: 'GAP_ANALYSIS',
        jurisdictionContext: basePipelineParams.jurisdictionContext,
        retrievalProfile: expect.objectContaining({
          filter: {
            frameworkSlug: 'cbk_pg',
            documentId: { $in: ['bench-doc-1', 'bench-doc-2'] },
          },
        }),
      })
    );
    expect(ragService.search).not.toHaveBeenCalled();
  });

  it('passes selected benchmark document metadata into the completed result', async () => {
    vi.mocked(extractPdfText).mockResolvedValueOnce(
      'Valid substantive text that safely surpasses the readable text guard threshold. '.repeat(10)
    );

    await executeGapAnalysisPipeline({
      ...basePipelineParams,
      benchmarkDocumentIds: ['bench-doc-1'],
      benchmarkDocuments: [
        {
          id: 'bench-doc-1',
          title: 'Data Protection Act 2019',
          documentType: 'ACT',
          regulatoryBody: 'ODPC',
        },
      ],
    });

    const update = completedUpdate();
    expect(update).toBeDefined();
    expect(update?.data?.results).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          selectedBenchmarkDocuments: [
            {
              id: 'bench-doc-1',
              title: 'Data Protection Act 2019',
              documentType: 'ACT',
              regulatoryBody: 'ODPC',
            },
          ],
        }),
      })
    );
  });
});
