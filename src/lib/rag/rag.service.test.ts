import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RAGService } from './rag.service';
import { queryVectors } from './client';

vi.mock('./client', () => ({
  upsertVectors: vi.fn(),
  queryVectors: vi.fn(),
  deleteByFilter: vi.fn(),
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const queryVectorsMock = vi.mocked(queryVectors);

describe('RAGService.search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to a relaxed metadata filter when strict filtering returns too few chunks', async () => {
    queryVectorsMock
      .mockResolvedValueOnce([
        {
          id: 'doc-1:0',
          score: 0.8,
          metadata: {
            documentId: 'doc-1',
            documentTitle: 'Selected Act',
            documentType: 'LEGAL_DOCUMENT',
            chunkIndex: 0,
            chunk_text: 'strict result',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'doc-2:0',
          score: 0.82,
          metadata: {
            documentId: 'doc-2',
            documentTitle: 'Framework Act',
            documentType: 'LEGAL_DOCUMENT',
            chunkIndex: 0,
            chunk_text: 'relaxed result',
            frameworkSlug: 'data-protection',
          },
        },
        {
          id: 'doc-3:0',
          score: 0.79,
          metadata: {
            documentId: 'doc-3',
            documentTitle: 'Framework Guidance',
            documentType: 'LEGAL_DOCUMENT',
            chunkIndex: 0,
            chunk_text: 'more relaxed result',
            frameworkSlug: 'data-protection',
          },
        },
      ]);

    const service = new RAGService();
    const results = await service.search('data protection obligations', {
      topK: 8,
      minScore: 0.6,
      filter: { frameworkSlug: 'data-protection', documentId: 'doc-1' },
      fallbackIfTooFew: {
        minResults: 2,
        relaxedFilter: { frameworkSlug: 'data-protection' },
      },
    });

    expect(queryVectorsMock).toHaveBeenCalledTimes(2);
    expect(queryVectorsMock).toHaveBeenNthCalledWith(
      2,
      'data protection obligations',
      8,
      undefined,
      { frameworkSlug: 'data-protection' },
    );
    expect(results).toHaveLength(2);
    expect(results[0].chunkText).toBe('relaxed result');
  });

  it('applies v1-compatible active source filters when requested', async () => {
    queryVectorsMock.mockResolvedValueOnce([
      {
        id: 'doc-1:0',
        score: 0.9,
        metadata: {
          documentId: 'doc-1',
          documentTitle: 'Active Act',
          documentType: 'LEGAL_DOCUMENT',
          chunkIndex: 0,
          chunk_text: 'active result',
          corpusStatus: 'ACTIVE',
          authorityStatus: 'IN_FORCE',
        },
      },
    ]);

    const service = new RAGService();
    const results = await service.search('active source query', {
      topK: 5,
      minScore: 0.7,
      preferActiveSources: true,
      filter: { frameworkSlug: 'aml-cft' },
    });

    expect(queryVectorsMock).toHaveBeenCalledWith(
      'active source query',
      5,
      undefined,
      {
        $and: [
          { frameworkSlug: 'aml-cft' },
          { $or: [{ corpusStatus: { $eq: 'ACTIVE' } }, { corpusStatus: { $exists: false } }] },
          { $or: [{ authorityStatus: { $eq: 'IN_FORCE' } }, { authorityStatus: { $exists: false } }] },
        ],
      },
    );
    expect(results[0].corpusStatus).toBe('ACTIVE');
  });

  it('supports v2-only retrieval filters for eval comparison', async () => {
    queryVectorsMock.mockResolvedValueOnce([
      {
        id: 'doc-v2:0',
        score: 0.91,
        metadata: {
          documentId: 'doc-v2',
          documentTitle: 'V2 Act',
          documentType: 'LEGAL_DOCUMENT',
          chunkIndex: 0,
          chunk_text: 'v2 result',
          indexVersion: 'v2',
        },
      },
    ]);

    const service = new RAGService();
    const results = await service.search('v2 query', {
      sourceIndexMode: 'v2',
      filter: { jurisdiction: 'Kenya' },
      minScore: 0.7,
    });

    expect(queryVectorsMock).toHaveBeenCalledWith(
      'v2 query',
      10,
      undefined,
      {
        $and: [
          { jurisdiction: 'Kenya' },
          { indexVersion: { $eq: 'v2' } },
        ],
      },
    );
    expect(results[0].indexVersion).toBe('v2');
  });

  describe('prefer-v2 fallback logic', () => {
    it('falls back to v1 when v2 returns zero results', async () => {
      queryVectorsMock
        .mockResolvedValueOnce([]) // v2
        .mockResolvedValueOnce([ // v1
          {
            id: 'doc-v1:0',
            score: 0.86,
            metadata: {
              documentId: 'doc-v1',
              documentTitle: 'V1 Act',
              documentType: 'LEGAL_DOCUMENT',
              chunkIndex: 0,
              chunk_text: 'v1 fallback',
              indexVersion: 'v1',
            },
          },
        ]);

      const service = new RAGService();
      const results = await service.search('prefer v2 query', {
        sourceIndexMode: 'prefer-v2',
        minScore: 0.7,
      });

      expect(queryVectorsMock).toHaveBeenCalledTimes(2);
      expect(results[0].documentId).toBe('doc-v1');
    });

    it('falls back to v1 when v2 returns low count of results', async () => {
      queryVectorsMock
        .mockResolvedValueOnce([
          {
            id: 'doc-v2:0',
            score: 0.9,
            metadata: {
              documentId: 'doc-v2',
              documentTitle: 'V2 Act',
              documentType: 'LEGAL_DOCUMENT',
              chunkIndex: 0,
              chunk_text: 'v2 result',
              indexVersion: 'v2',
            },
          },
          // Only 1 result >= minScore, default minV2Results is 3
        ])
        .mockResolvedValueOnce([
          {
            id: 'doc-v1:0',
            score: 0.86,
            metadata: { documentId: 'doc-v1', documentTitle: 'V1 Act', indexVersion: 'v1', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0 },
          },
        ]);

      const service = new RAGService();
      const results = await service.search('prefer v2 query low count', {
        sourceIndexMode: 'prefer-v2',
        minScore: 0.7,
      });

      expect(queryVectorsMock).toHaveBeenCalledTimes(2);
      expect(results[0].documentId).toBe('doc-v1');
    });

    it('falls back to v1 when v2 top score is too low', async () => {
      queryVectorsMock
        .mockResolvedValueOnce([
          {
            id: 'doc-v2:0', score: 0.75, metadata: { documentId: 'doc-v2', documentTitle: 'V2 Act 1', indexVersion: 'v2', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0 },
          },
          {
            id: 'doc-v2:1', score: 0.74, metadata: { documentId: 'doc-v2', documentTitle: 'V2 Act 1', indexVersion: 'v2', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0 },
          },
          {
            id: 'doc-v2:2', score: 0.72, metadata: { documentId: 'doc-v3', documentTitle: 'V2 Act 2', indexVersion: 'v2', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0 },
          },
        ]) // 3 results, 2 diverse docs, but top score 0.75 < 0.78
        .mockResolvedValueOnce([
          {
            id: 'doc-v1:0', score: 0.86, metadata: { documentId: 'doc-v1', documentTitle: 'V1 Act', indexVersion: 'v1', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0 },
          },
        ]);

      const service = new RAGService();
      const results = await service.search('prefer v2 query low score', {
        sourceIndexMode: 'prefer-v2',
        minScore: 0.7,
      });

      expect(queryVectorsMock).toHaveBeenCalledTimes(2);
      expect(results[0].documentId).toBe('doc-v1');
    });

    it('does not fall back when v2 returns strong results', async () => {
      queryVectorsMock
        .mockResolvedValueOnce([
          { id: 'v2:0', score: 0.85, metadata: { documentId: 'doc-v2-1', documentTitle: 'Doc', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0, indexVersion: 'v2' } },
          { id: 'v2:1', score: 0.80, metadata: { documentId: 'doc-v2-1', documentTitle: 'Doc', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0, indexVersion: 'v2' } },
          { id: 'v2:2', score: 0.79, metadata: { documentId: 'doc-v2-2', documentTitle: 'Doc', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0, indexVersion: 'v2' } },
        ]); // 3 results, top score 0.85 >= 0.78, 2 diverse docs >= 2

      const service = new RAGService();
      const results = await service.search('prefer v2 strong', {
        sourceIndexMode: 'prefer-v2',
        minScore: 0.7,
      });

      expect(queryVectorsMock).toHaveBeenCalledTimes(1);
      expect(results[0].documentId).toBe('doc-v2-1');
    });

    it('fallback does not mark weak v2 as verified', async () => {
      // If it falls back, the results returned should be exactly what v1 returned.
      queryVectorsMock
        .mockResolvedValueOnce([
          { id: 'v2:0', score: 0.75, metadata: { documentId: 'doc-v2-weak', documentTitle: 'Doc', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0, indexVersion: 'v2' } },
        ])
        .mockResolvedValueOnce([
          { id: 'v1:0', score: 0.86, metadata: { documentId: 'doc-v1-strong', documentTitle: 'Doc', documentType: 'LEGAL_DOCUMENT', chunkIndex: 0, indexVersion: 'v1' } },
        ]);

      const service = new RAGService();
      const results = await service.search('prefer v2 weak', {
        sourceIndexMode: 'prefer-v2',
        minScore: 0.7,
      });

      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe('doc-v1-strong');
      expect(results.some(r => r.documentId === 'doc-v2-weak')).toBe(false);
    });
  });
});
