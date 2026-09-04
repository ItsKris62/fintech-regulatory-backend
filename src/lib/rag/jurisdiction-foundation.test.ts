import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JurisdictionContractError,
  resolveJurisdictionContext,
} from '@/types/jurisdiction';
import {
  buildRegulatoryEvidenceFilter,
  ragService,
  searchAndGetRegulatoryEvidenceContext,
} from './rag.service';
import { buildCitationsFromChunks, validateCitationsForJurisdiction } from '@/lib/source-grounding/citations';
import { queryVectors } from './client';
import { redis } from '@/lib/redis/client';
import { prisma } from '@/lib/prisma/client';
import type { SearchResult } from './rag.service';

vi.mock('./client', () => ({
  queryVectors: vi.fn(),
  upsertVectors: vi.fn(),
  deleteByFilter: vi.fn(),
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

describe('jurisdiction foundation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue('OK');
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { jurisdictionCode: 'KE', version: 3 },
      { jurisdictionCode: 'RW', version: 4 },
      { jurisdictionCode: 'MW', version: 5 },
    ]);
  });

  it('resolves enabled single-country contexts', () => {
    expect(resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['RW'] })).toMatchObject({
      mode: 'SINGLE',
      primaryJurisdiction: 'RW',
      jurisdictionSource: 'REQUEST',
    });

    expect(resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['MW'] })).toMatchObject({
      mode: 'SINGLE',
      primaryJurisdiction: 'MW',
      jurisdictionSource: 'REQUEST',
    });

    expect(resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['NG'] })).toMatchObject({
      mode: 'SINGLE',
      primaryJurisdiction: 'NG',
      jurisdictionSource: 'REQUEST',
    });

    expect(() => resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['ZZ'] as any }))
      .toThrow(JurisdictionContractError);
  });

  it('rejects malformed new contract but keeps isolated legacy KE fallback', () => {
    expect(() => resolveJurisdictionContext({ mode: 'SINGLE' }))
      .toThrow(JurisdictionContractError);

    expect(resolveJurisdictionContext({}, { allowLegacyDefault: true })).toMatchObject({
      primaryJurisdiction: 'KE',
      jurisdictionSource: 'LEGACY_DEFAULT',
    });
  });

  it('constructs a mandatory country filter with temporary legacy label compatibility', () => {
    expect(buildRegulatoryEvidenceFilter('MW')).toEqual({
      $and: [
        {
          $or: [
            { jurisdictionCode: { $eq: 'MW' } },
            { jurisdiction: { $eq: 'Malawi' } },
          ],
        },
        {
          $or: [
            { indexVersion: { $eq: 'v1' } },
            { indexVersion: { $exists: false } },
          ],
        },
      ],
    });
  });

  it('filters wrong-country Pinecone hits even if they are returned', async () => {
    vi.mocked(queryVectors).mockResolvedValue([
      {
        id: 'rw-vector-1',
        score: 0.93,
        metadata: {
          documentId: 'rw-doc',
          documentTitle: 'Rwanda Payments Law',
          documentType: 'REGULATION',
          chunkIndex: 0,
          chunk_text: 'Rwanda payment service provider licensing requirements.',
          jurisdiction: 'Rwanda',
        },
      },
      {
        id: 'ke-vector-1',
        score: 0.92,
        metadata: {
          documentId: 'ke-doc',
          documentTitle: 'Kenya Payments Law',
          documentType: 'REGULATION',
          chunkIndex: 0,
          chunk_text: 'Kenya payment service provider licensing requirements.',
          jurisdiction: 'Kenya',
        },
      },
    ]);

    const context = resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['RW'] });
    const results = await ragService.searchRegulatoryEvidence({
      query: 'payment service provider licensing',
      jurisdictionContext: context,
      topK: 2,
      minScore: 0.7,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      vectorId: 'rw-vector-1',
      chunkId: 'rw-vector-1',
      jurisdictionCode: 'RW',
    });
  });

  it('uses separate RAG cache v4 keys for the same question in KE and RW', async () => {
    vi.mocked(queryVectors).mockResolvedValue([
      {
        id: 'vector-1',
        score: 0.93,
        metadata: {
          documentId: 'doc-1',
          documentTitle: 'Payments Law',
          documentType: 'REGULATION',
          chunkIndex: 0,
          chunk_text: 'Payment service provider licensing requirements.',
          jurisdictionCode: 'KE',
        },
      },
    ]);

    await searchAndGetRegulatoryEvidenceContext({
      query: 'payment service provider licensing',
      jurisdictionContext: resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['KE'] }),
    });

    vi.mocked(queryVectors).mockResolvedValue([
      {
        id: 'vector-2',
        score: 0.93,
        metadata: {
          documentId: 'doc-2',
          documentTitle: 'Rwanda Payments Law',
          documentType: 'REGULATION',
          chunkIndex: 0,
          chunk_text: 'Rwanda payment service provider licensing requirements.',
          jurisdictionCode: 'RW',
        },
      },
    ]);

    await searchAndGetRegulatoryEvidenceContext({
      query: 'payment service provider licensing',
      jurisdictionContext: resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['RW'] }),
    });

    const cacheKeys = vi.mocked(redis.set).mock.calls.map(([key]) => key);
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).toMatch(/^sheriabot:rag:ctx:v4:/);
    expect(cacheKeys[1]).toMatch(/^sheriabot:rag:ctx:v4:/);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it('fails citation validation when jurisdiction or provenance is missing', () => {
    const context = resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: ['RW'] });
    const rwChunk: SearchResult = {
      vectorId: 'rw-vector-1',
      chunkId: 'rw-vector-1',
      documentId: 'rw-doc',
      documentTitle: 'Rwanda Payments Law',
      chunkText: 'Rwanda payment service provider licensing requirements.',
      jurisdictionCode: 'RW',
      jurisdiction: 'Rwanda',
      score: 0.91,
      rank: 1,
    };
    const keChunk: SearchResult = {
      ...rwChunk,
      vectorId: 'ke-vector-1',
      chunkId: 'ke-vector-1',
      documentId: 'ke-doc',
      documentTitle: 'Kenya Payments Law',
      jurisdictionCode: 'KE',
      jurisdiction: 'Kenya',
    };

    expect(validateCitationsForJurisdiction(buildCitationsFromChunks([rwChunk]), context).valid).toBe(true);
    expect(validateCitationsForJurisdiction(buildCitationsFromChunks([keChunk]), context).valid).toBe(false);
    expect(validateCitationsForJurisdiction([{ ...buildCitationsFromChunks([rwChunk])[0], vectorId: null }], context).valid).toBe(false);
  });
});
