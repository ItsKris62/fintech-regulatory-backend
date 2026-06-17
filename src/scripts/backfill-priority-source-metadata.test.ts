import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { backfillPrioritySourceMetadata } from './backfill-priority-source-metadata';
import { prisma } from '../lib/prisma/client';

vi.mock('fs');
vi.mock('../lib/prisma/client', () => ({
  prisma: {
    regulatoryDocument: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    approvedSource: {
      findUnique: vi.fn(),
    },
  },
}));

describe('backfillPrioritySourceMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const validRow = {
    regulatoryDocumentId: 'doc_1',
    currentTitle: 'Title 1',
    normalizedTitle: 'Title 1',
    approvedSourceId: 'source_1',
    authorityName: 'Auth 1',
    officialUrl: 'https://valid.com/doc.pdf',
    publicationDate: '2024-01-01T00:00:00Z',
    retrievedAt: '2024-01-02T00:00:00Z',
    effectiveDate: null,
    effectiveEndDate: null,
    versionLabel: 'v1',
    checksumSha256: 'abc',
    status: 'ACTIVE',
    authorityStatus: 'IN_FORCE',
    isBinding: true,
    documentType: 'ACT',
    jurisdiction: 'KENYA',
    notes: null,
    reviewStatus: 'APPROVED',
  };

  it('dry-run by default, does not mutate DB', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([validRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
      officialUrl: null,
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['valid.com'],
    });

    await backfillPrioritySourceMetadata({ inputFile: 'dummy.json', write: false, overwrite: false });

    expect(prisma.regulatoryDocument.update).not.toHaveBeenCalled();
  });

  it('writes to DB when --write is provided and reviewStatus is APPROVED', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([validRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
      officialUrl: null,
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['valid.com'],
    });

    await backfillPrioritySourceMetadata({ inputFile: 'dummy.json', write: true, overwrite: false });

    expect(prisma.regulatoryDocument.update).toHaveBeenCalledWith({
      where: { id: 'doc_1' },
      data: expect.objectContaining({
        officialUrl: 'https://valid.com/doc.pdf',
        sourceRegistryId: 'source_1',
      }),
    });
  });

  it('does not overwrite existing officialUrl unless --overwrite is true', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([validRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
      officialUrl: 'https://existing.com/old.pdf',
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['valid.com'],
    });

    // Without overwrite
    await backfillPrioritySourceMetadata({ inputFile: 'dummy.json', write: true, overwrite: false });
    expect(prisma.regulatoryDocument.update).not.toHaveBeenCalled();

    // With overwrite
    await backfillPrioritySourceMetadata({ inputFile: 'dummy.json', write: true, overwrite: true });
    expect(prisma.regulatoryDocument.update).toHaveBeenCalled();
  });
});
