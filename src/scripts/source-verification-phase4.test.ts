import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    approvedSource: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    regulatoryDocument: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    sourceDocumentVersion: {
      upsert: vi.fn(),
    },
    regulatoryDocumentChunk: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $disconnect: vi.fn(),
  },
  storage: {
    downloadFile: vi.fn(),
  },
  extractPdfText: vi.fn(),
  mammothExtractRawText: vi.fn(),
  upsertVectors: vi.fn(),
}));

vi.mock('@/lib/prisma/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/storage/client', () => ({ createStorageService: () => mocks.storage }));
vi.mock('@/lib/pdf/extract-text', () => ({ extractPdfText: mocks.extractPdfText }));
vi.mock('mammoth', () => ({
  default: { extractRawText: mocks.mammothExtractRawText },
  extractRawText: mocks.mammothExtractRawText,
}));
vi.mock('@/lib/rag/client', () => ({ upsertVectors: mocks.upsertVectors }));

import { seedApprovedSources } from './seed-approved-sources';
import { linkPrioritySourceVersions } from './link-priority-source-versions';
import { reindexPriorityDocumentsV2 } from './reindex-priority-documents-v2';

describe('Phase 4 source verification scripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seedApprovedSources is dry-run safe and idempotency-oriented', async () => {
    mocks.prisma.approvedSource.findUnique.mockResolvedValue(null);

    const summary = await seedApprovedSources({ dryRun: true });

    expect(summary.created).toBeGreaterThan(0);
    expect(mocks.prisma.approvedSource.create).not.toHaveBeenCalled();
    expect(mocks.prisma.approvedSource.update).not.toHaveBeenCalled();
  });

  it('linkPrioritySourceVersions does not invent official URLs', async () => {
    mocks.prisma.regulatoryDocument.findMany.mockResolvedValue([
      {
        id: 'doc-1',
        title: 'Data Protection Act',
        source: 'ODPC',
        category: 'DATA_PROTECTION',
        documentType: 'Act',
        officialUrl: null,
        checksum: 'abc',
        authorityStatus: 'IN_FORCE',
        isBinding: true,
        status: 'ACTIVE',
      },
    ]);

    const summary = await linkPrioritySourceVersions({ dryRun: false });

    expect(summary.missingOfficialUrl).toEqual(['doc-1']);
    expect(mocks.prisma.sourceDocumentVersion.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.regulatoryDocument.update).not.toHaveBeenCalled();
  });

  it('reindexPriorityDocumentsV2 prepares v2 chunks without deleting or writing during dry run', async () => {
    mocks.prisma.regulatoryDocument.findMany.mockResolvedValue([
      {
        id: 'doc-2',
        title: 'National Payment System Act',
        source: 'Central Bank of Kenya',
        category: 'PAYMENTS',
        documentType: 'Act',
        fileType: 'pdf',
        fileName: 'nps.pdf',
        storageKey: 'regulations/nps.pdf',
        checksum: 'checksum',
        officialUrl: 'https://www.centralbank.go.ke/nps.pdf',
        sourceDocumentVersionId: 'sdv-1',
        sourceDocumentVersion: {
          id: 'sdv-1',
          officialUrl: 'https://www.centralbank.go.ke/nps.pdf',
          status: 'ACTIVE',
        },
        jurisdiction: 'Kenya',
        effectiveDate: new Date('2024-01-01'),
        effectiveEndDate: null,
        version: '2024',
        authorityStatus: 'IN_FORCE',
        isBinding: true,
        status: 'ACTIVE',
        supersededByDocumentId: null,
      },
    ]);
    mocks.prisma.regulatoryDocumentChunk.findMany.mockResolvedValue([]);
    mocks.storage.downloadFile.mockResolvedValue(Buffer.from('%PDF'));
    mocks.extractPdfText.mockResolvedValue('SECTION 1\nPayment system duties.\fSECTION 2\nLicensing duties.');

    const summary = await reindexPriorityDocumentsV2({
      dryRun: true,
      documentIds: [],
      upsertVectors: false,
    });

    expect(summary.processed).toBe(1);
    expect(summary.chunksCreated).toBe(2);
    expect(summary.vectorsPrepared).toBe(2);
    expect(mocks.prisma.regulatoryDocumentChunk.create).not.toHaveBeenCalled();
    expect(mocks.upsertVectors).not.toHaveBeenCalled();
  });
});
