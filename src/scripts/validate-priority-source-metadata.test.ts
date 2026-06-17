import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { validatePrioritySourceMetadata } from './validate-priority-source-metadata';
import { prisma } from '../lib/prisma/client';

vi.mock('fs');
vi.mock('../lib/prisma/client', () => ({
  prisma: {
    regulatoryDocument: {
      findUnique: vi.fn(),
    },
    approvedSource: {
      findUnique: vi.fn(),
    },
  },
}));

describe('validatePrioritySourceMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('should validate a correct intake JSON', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([validRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['valid.com'],
    });

    const { summary, results } = await validatePrioritySourceMetadata({ inputFile: 'dummy.json' });
    expect(summary.errors).toBe(0);
    expect(summary.valid).toBe(1);
    expect(results[0].isValid).toBe(true);
  });

  it('should fail on missing officialUrl for APPROVED rows', async () => {
    const invalidRow = { ...validRow, officialUrl: null };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([invalidRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['valid.com'],
    });

    const { summary, results } = await validatePrioritySourceMetadata({ inputFile: 'dummy.json' });
    expect(summary.errors).toBe(1);
    expect(results[0].isValid).toBe(false);
    expect(results[0].errors).toContain('officialUrl is required for APPROVED rows.');
  });

  it('should fail on example placeholder URLs', async () => {
    const invalidRow = { ...validRow, officialUrl: 'https://example.com/test.pdf' };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([invalidRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['example.com'],
    });

    const { summary, results } = await validatePrioritySourceMetadata({ inputFile: 'dummy.json' });
    expect(summary.errors).toBe(1);
    expect(results[0].isValid).toBe(false);
    expect(results[0].errors).toContain('Placeholder or example URL detected.');
  });

  it('should fail if allowed domains do not match', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([validRow]));
    vi.mocked(prisma.regulatoryDocument.findUnique as any).mockResolvedValue({
      id: 'doc_1',
      title: 'Title 1',
      jurisdiction: 'KENYA',
    });
    vi.mocked(prisma.approvedSource.findUnique as any).mockResolvedValue({
      id: 'source_1',
      allowedDomains: ['different.com'], // does not match valid.com
    });

    const { summary, results } = await validatePrioritySourceMetadata({ inputFile: 'dummy.json' });
    expect(summary.errors).toBe(1);
    expect(results[0].isValid).toBe(false);
    expect(results[0].errors.some(e => e.includes('not allowed by ApprovedSource'))).toBe(true);
  });
});
