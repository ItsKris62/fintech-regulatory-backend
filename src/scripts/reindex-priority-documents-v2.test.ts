import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reindexPriorityDocumentsV2 } from './reindex-priority-documents-v2';
import { prisma } from '../lib/prisma/client';
import { upsertVectors } from '../lib/rag/client';
import * as storageClient from '../lib/storage/client';
import * as v2Chunking from '../lib/source-grounding/v2-chunking';

vi.mock('../lib/pdf/extract-text', () => ({
  extractPdfText: vi.fn().mockResolvedValue('dummy pdf text'),
}));

vi.mock('../lib/prisma/client', () => ({
  prisma: {
    regulatoryDocument: {
      findMany: vi.fn(),
    },
    regulatoryDocumentChunk: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../lib/rag/client', () => ({
  upsertVectors: vi.fn(),
}));

vi.mock('../lib/storage/client', () => ({
  createStorageService: vi.fn(() => ({
    downloadFile: vi.fn(),
  })),
}));

vi.mock('../lib/source-grounding/v2-chunking', () => ({
  buildPageAwareText: vi.fn(),
  chunkPageAwareLegalText: vi.fn(),
}));

describe('reindexPriorityDocumentsV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockDoc = {
    id: 'doc_1',
    title: 'Test Doc',
    status: 'ACTIVE',
    storageKey: 'test.pdf',
    fileType: 'pdf',
    jurisdiction: 'KENYA',
    sourceDocumentVersion: null,
  };

  const generateChunks = (count: number) => {
    return Array.from({ length: count }).map((_, i) => ({
      index: i,
      text: `Chunk ${i}`,
      metadata: {
        contentHash: `hash_${i}`,
        provisionId: `prov_${i}`,
        parser: 'v2-legal-structure',
        pageMetadataReliable: true,
      },
    }));
  };

  it('should be idempotent and not delete/recreate DB chunks if they already exist, but still prepare vectors', async () => {
    vi.mocked(prisma.regulatoryDocument.findMany as any).mockResolvedValue([mockDoc]);
    vi.mocked(storageClient.createStorageService().downloadFile).mockResolvedValue(Buffer.from('dummy'));
    vi.mocked(v2Chunking.buildPageAwareText).mockReturnValue({ pageMetadataReliable: true } as any);
    
    const chunks = generateChunks(5);
    vi.mocked(v2Chunking.chunkPageAwareLegalText).mockReturnValue(chunks as any);
    
    // Mock that all chunks already exist in DB
    vi.mocked(prisma.regulatoryDocumentChunk.findMany as any).mockResolvedValue(
      chunks.map(c => ({ contentHash: c.metadata.contentHash }))
    );

    const summary = await reindexPriorityDocumentsV2({
      dryRun: false,
      documentIds: ['doc_1'],
      upsertVectors: false,
    });

    expect(prisma.regulatoryDocumentChunk.create).not.toHaveBeenCalled();
    expect(summary.chunksCreated).toBe(0);
    expect(summary.chunksSkipped).toBe(5);
    expect(summary.vectorsPrepared).toBe(5);
    expect(summary.vectorsUpserted).toBe(0);
  });

  it('should upsert vectors for existing v2 chunks without creating DB chunks', async () => {
    vi.mocked(prisma.regulatoryDocument.findMany as any).mockResolvedValue([mockDoc]);
    vi.mocked(storageClient.createStorageService().downloadFile).mockResolvedValue(Buffer.from('dummy'));
    vi.mocked(v2Chunking.buildPageAwareText).mockReturnValue({ pageMetadataReliable: true } as any);
    
    const chunks = generateChunks(5);
    vi.mocked(v2Chunking.chunkPageAwareLegalText).mockReturnValue(chunks as any);
    
    // Mock that all chunks already exist in DB
    vi.mocked(prisma.regulatoryDocumentChunk.findMany as any).mockResolvedValue(
      chunks.map(c => ({ contentHash: c.metadata.contentHash }))
    );

    const summary = await reindexPriorityDocumentsV2({
      dryRun: false,
      documentIds: ['doc_1'],
      upsertVectors: true,
    });

    expect(prisma.regulatoryDocumentChunk.create).not.toHaveBeenCalled();
    expect(upsertVectors).toHaveBeenCalledTimes(1);
    expect(upsertVectors).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ chunk_text: 'Chunk 0' })]));
    
    expect(summary.chunksCreated).toBe(0);
    expect(summary.chunksSkipped).toBe(5);
    expect(summary.vectorsPrepared).toBe(5);
    expect(summary.vectorsUpserted).toBe(5);
  });

  it('should batch upserts at <= 90 records', async () => {
    vi.mocked(prisma.regulatoryDocument.findMany as any).mockResolvedValue([mockDoc]);
    vi.mocked(storageClient.createStorageService().downloadFile).mockResolvedValue(Buffer.from('dummy'));
    vi.mocked(v2Chunking.buildPageAwareText).mockReturnValue({ pageMetadataReliable: true } as any);
    
    const chunks = generateChunks(200); // 200 chunks should result in 3 batches (90, 90, 20)
    vi.mocked(v2Chunking.chunkPageAwareLegalText).mockReturnValue(chunks as any);
    
    // Mock that NO chunks exist in DB so we create them AND upsert
    vi.mocked(prisma.regulatoryDocumentChunk.findMany as any).mockResolvedValue([]);

    const summary = await reindexPriorityDocumentsV2({
      dryRun: false,
      documentIds: ['doc_1'],
      upsertVectors: true,
    });

    expect(prisma.regulatoryDocumentChunk.create).toHaveBeenCalledTimes(200);
    expect(upsertVectors).toHaveBeenCalledTimes(3);
    
    expect(vi.mocked(upsertVectors).mock.calls[0][0]).toHaveLength(90);
    expect(vi.mocked(upsertVectors).mock.calls[1][0]).toHaveLength(90);
    expect(vi.mocked(upsertVectors).mock.calls[2][0]).toHaveLength(20);
    
    expect(summary.chunksCreated).toBe(200);
    expect(summary.chunksSkipped).toBe(0);
    expect(summary.vectorsPrepared).toBe(200);
    expect(summary.vectorsUpserted).toBe(200);
  });
});
