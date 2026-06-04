import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ragService } from '@/lib/rag/rag.service';
import { prisma } from '@/lib/prisma/client';
import { extractPdfText } from '@/lib/pdf/extract-text';
import { executeGapAnalysisPipeline } from './compliance.module';

// --- External Service Mocks ---
vi.mock('@/lib/rag/rag.service', () => ({
  ragService: {
    search: vi.fn().mockResolvedValue([
      {
        documentId: 'bench-doc-1',
        documentTitle: 'Mocked Benchmark Policy',
        chunkText: 'This is a mocked retrieved chunk from the benchmark document.',
        score: 0.95,
        rank: 1,
      },
    ]),
  },
}));

vi.mock('@/lib/pdf/extract-text', () => ({
  extractPdfText: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    gapAnalysis: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock AI Service to prevent actual Anthropic API calls during the test
vi.mock('@/lib/ai/ai.service', () => ({
  aiService: {
    performGapAnalysis: vi.fn().mockResolvedValue({
      overallScore: 85,
      executiveSummary: 'Mock summary',
      frameworks: [],
      crossCuttingStrengths: [],
      actionPlan: [],
      metadata: {
        documentName: 'test.pdf',
        analysisDepth: 'standard',
        frameworksAnalysed: [],
        totalGaps: 0,
        criticalGaps: 0,
        highGaps: 0,
        analysisDate: new Date().toISOString(),
      },
    }),
  },
}));

describe('Gap Analysis Pipeline Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails early and updates DB status to FAILED if extraction yields empty or insufficient text', async () => {
    // Arrange: Mock the extractor to return a string below the 100 char threshold (or empty)
    vi.mocked(extractPdfText).mockResolvedValueOnce('   \n  Tiny snippet.  ');

    // Act
    await executeGapAnalysisPipeline({
      analysisId: 'gap-fail-test',
      documentUrl: 'https://fake-storage-url.com/doc.pdf',
      documentType: 'pdf',
      documentName: 'ScannedDoc.pdf',
      regulatoryFrameworks: ['DPA_2019'],
      analysisDepth: 'standard',
    });

    // Assert: Pipeline should have aborted and updated the DB
    expect(extractPdfText).toHaveBeenCalled();
    expect(prisma.gapAnalysis.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gap-fail-test' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringContaining('insufficient readable text'),
        }),
      })
    );
    
    // Ensure RAG and AI pipelines were completely skipped
    expect(ragService.search).not.toHaveBeenCalled();
  });

  it('constructs correct RAG filters using benchmarkDocumentIds and regulatoryFrameworks', async () => {
    // Arrange: Provide valid long text to bypass the extraction guard
    vi.mocked(extractPdfText).mockResolvedValueOnce('Valid substantive text that safely surpasses the 100 character guard threshold. '.repeat(10));

    // Act
    await executeGapAnalysisPipeline({
      analysisId: 'gap-success-test',
      documentUrl: 'https://fake-storage-url.com/doc.pdf',
      documentType: 'pdf',
      documentName: 'ValidPolicy.pdf',
      regulatoryFrameworks: ['DPA_2019', 'CBK_PG'],
      benchmarkDocumentIds: ['corp-policy-id-1', 'corp-policy-id-2'],
      analysisDepth: 'standard',
    });

    // Assert: Pinecone filter must combine frameworks and document IDs using an $or operator
    expect(ragService.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          $or: [
            { framework: { $in: ['DPA_2019', 'CBK_PG'] } },
            { documentId: { $in: ['corp-policy-id-1', 'corp-policy-id-2'] } },
          ],
        },
      })
    );
  });
});