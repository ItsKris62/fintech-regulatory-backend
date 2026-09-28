import { describe, it, expect, vi, beforeEach } from 'vitest';
import { heuristicRerank, rerankChunks } from '../reranker.service';
import {
  compressChunkRuleBased,
  compressContextChunks,
  containsCitationAnchors,
  estimateTokens,
} from '../compression.service';
import type { SearchResult } from '../rag.service';

describe('RAG Reranking Service', () => {
  const sampleChunks: SearchResult[] = [
    {
      vectorId: 'vec-1',
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentTitle: 'National Payment System Act',
      chunkText: 'General preamble about financial stability in Kenya.',
      section: 'Preliminary',
      score: 0.85,
      rank: 1,
    },
    {
      vectorId: 'vec-2',
      chunkId: 'chunk-2',
      documentId: 'doc-2',
      documentTitle: 'Data Protection Act 2019',
      chunkText: 'Section 25: Principles of data protection. Every data controller must ensure personal data is processed lawfully, fairly and transparently.',
      section: 'Section 25 - Principles of Data Protection',
      sectionNumber: 'Section 25',
      citation: 'Data Protection Act 2019, s. 25',
      score: 0.80,
      rank: 2,
    },
    {
      vectorId: 'vec-3',
      chunkId: 'chunk-3',
      documentId: 'doc-3',
      documentTitle: 'CBK Prudential Guidelines',
      chunkText: 'Section 4: Capital adequacy requirements for commercial banks operating in Kenya.',
      section: 'Section 4 - Capital Requirements',
      sectionNumber: 'Section 4',
      score: 0.78,
      rank: 3,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('heuristicRerank', () => {
    it('boosts chunks with matching query terms, citations, and section names', () => {
      const query = 'data protection principles controller';
      const reranked = heuristicRerank(query, sampleChunks, 2);

      expect(reranked).toHaveLength(2);
      // chunk-2 has term matches ('data', 'protection', 'principles', 'controller'), citation, and matching section
      expect(reranked[0].chunkId).toBe('chunk-2');
      expect(reranked[0].rank).toBe(1);
      expect(reranked[0].score).toBeGreaterThan(sampleChunks[1].score);
    });

    it('returns empty array when given empty input', () => {
      const res = heuristicRerank('test query', [], 5);
      expect(res).toEqual([]);
    });
  });

  describe('rerankChunks with Cohere and Fallback', () => {
    it('calls Cohere API when configured and reorders results based on relevance_score', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { index: 1, relevance_score: 0.98 }, // chunk-2
            { index: 0, relevance_score: 0.82 }, // chunk-1
          ],
        }),
      });
      global.fetch = mockFetch;

      const outcome = await rerankChunks('data privacy obligations', sampleChunks, {
        provider: 'cohere',
        apiKey: 'test-cohere-key',
        model: 'rerank-v3.5',
        topN: 2,
      });

      expect(outcome.provider).toBe('cohere');
      expect(outcome.fallbackTriggered).toBe(false);
      expect(outcome.results).toHaveLength(2);
      expect(outcome.results[0].chunkId).toBe('chunk-2');
      expect(outcome.results[0].score).toBe(0.98);
      expect(outcome.scoreDistribution.max).toBe(0.98);
    });

    it('falls back to heuristic reranking when Cohere API times out or fails', async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error('Network timeout after 1500ms'));
      global.fetch = mockFetch;

      const outcome = await rerankChunks('data privacy principles', sampleChunks, {
        provider: 'cohere',
        apiKey: 'test-cohere-key',
        topN: 2,
      });

      expect(outcome.fallbackTriggered).toBe(true);
      expect(outcome.provider).toBe('heuristic');
      expect(outcome.results).toHaveLength(2);
      expect(outcome.results[0].chunkId).toBe('chunk-2'); // Heuristic still ranks chunk-2 highest
    });

    it('falls back to heuristic when Cohere API key is missing', async () => {
      const outcome = await rerankChunks('compliance requirements', sampleChunks, {
        provider: 'cohere',
        apiKey: '',
        topN: 3,
      });

      expect(outcome.fallbackTriggered).toBe(true);
      expect(outcome.provider).toBe('heuristic');
      expect(outcome.results).toHaveLength(3);
    });
  });
});

describe('RAG Context Compression Service', () => {
  const longLegalChunk: SearchResult = {
    vectorId: 'vec-10',
    chunkId: 'chunk-10',
    documentId: 'doc-10',
    documentTitle: 'Kenya Data Protection Act',
    section: 'Section 29 - Processing of sensitive personal data',
    sectionNumber: 'Section 29',
    chunkText:
      'Section 29. A data controller or data processor shall not process sensitive personal data unless the data subject has given explicit consent. In addition, the processing must be necessary for the purpose of carrying out the obligations and exercising specific rights of the controller. Furthermore, statistical records shall be anonymised and general administrative notices must be published quarterly in accordance with regulatory filing guidelines.',
    score: 0.9,
    rank: 1,
  };

  it('estimates token counts accurately using 4 chars per token heuristic', () => {
    expect(estimateTokens('Hello world! 1234')).toBe(5);
    expect(estimateTokens('')).toBe(0);
  });

  it('checks and verifies preservation of citation anchors', () => {
    expect(containsCitationAnchors(longLegalChunk, longLegalChunk.chunkText)).toBe(true);
    expect(containsCitationAnchors(longLegalChunk, 'Unrelated text without section markers')).toBe(false);
  });

  it('compresses long chunks into operative clauses containing query terms and regulatory keywords', () => {
    const query = 'sensitive personal data explicit consent';
    const compressed = compressChunkRuleBased(longLegalChunk, query, 50);

    expect(compressed.length).toBeLessThan(longLegalChunk.chunkText.length);
    expect(compressed).toContain('sensitive personal data');
    expect(compressed).toContain('Section 29');
  });

  it('preserves full chunk if compression would otherwise remove critical citation anchors', () => {
    const strictChunk: SearchResult = {
      ...longLegalChunk,
      sectionNumber: 'Section 999-XYZ-SPECIAL',
      chunkText: 'Opening sentence. Middle text with Section 999-XYZ-SPECIAL required anchor. Concluding sentence with lots of extra text.',
    };

    // When compression selects only the opening sentence due to tight budget (10 tokens), it drops the anchor and must fallback to full chunkText
    const result = compressChunkRuleBased(strictChunk, 'Opening query', 10);
    expect(result).toBe(strictChunk.chunkText);
  });

  it('compresses context chunks and computes compression ratio telemetry', async () => {
    const outcome = await compressContextChunks('consent requirements', [longLegalChunk], {
      enabled: true,
      strategy: 'rule-based',
      maxOutputTokensPerChunk: 50,
      currentPipelineLatencyMs: 200,
    });

    expect(outcome.enabled).toBe(true);
    expect(outcome.strategy).toBe('rule-based');
    expect(outcome.compressedTokens).toBeLessThanOrEqual(outcome.originalTokens);
    expect(outcome.compressionRatio).toBeLessThanOrEqual(1.0);
    expect(outcome.compressedResults).toHaveLength(1);
  });

  it('returns original chunks unmodified when compression is disabled', async () => {
    const outcome = await compressContextChunks('test query', [longLegalChunk], {
      enabled: false,
    });

    expect(outcome.enabled).toBe(false);
    expect(outcome.compressionRatio).toBe(1.0);
    expect(outcome.compressedResults[0].chunkText).toBe(longLegalChunk.chunkText);
  });

  it('skips compression if the pipeline latency budget is already exhausted', async () => {
    const outcome = await compressContextChunks('test query', [longLegalChunk], {
      enabled: true,
      currentPipelineLatencyMs: 3000, // Exceeds default 2500ms budget
    });

    expect(outcome.skippedDueToLatencyBudget).toBe(true);
    expect(outcome.compressionRatio).toBe(1.0);
    expect(outcome.compressedResults[0].chunkText).toBe(longLegalChunk.chunkText);
  });
});
