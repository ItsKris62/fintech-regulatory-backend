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
});
