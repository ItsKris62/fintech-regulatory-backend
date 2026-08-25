import { describe, it, expect, vi, beforeEach } from 'vitest';
import { archiveExpiredQueries, REDACTED_TEXT } from './archive-expired-queries';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/prisma/client', () => {
  const mockPrisma = {
    complianceQuery: {
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    queryFeedback: {
      deleteMany: vi.fn(),
    },
    savedResponse: {
      deleteMany: vi.fn(),
    },
    complianceAnswerClaim: {
      deleteMany: vi.fn(),
    },
    corpusGapFeedback: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (arr) => {
      if (typeof arr === 'function') {
        return arr(mockPrisma);
      }
      return Array.isArray(arr) ? Promise.all(arr) : arr;
    }),
    $disconnect: vi.fn(),
  };
  return { prisma: mockPrisma };
});

describe('archiveExpiredQueries (Retention, Free-Text Scrubbing & Deep Purge)', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const expiredDate = new Date('2026-01-01T12:00:00Z'); // ~236 days old (180-365d)
  const ancientDate = new Date('2025-01-01T12:00:00Z'); // >365 days old

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scans candidate queries and performs free-text scrubbing on 180-365 day old queries', async () => {
    vi.mocked(prisma.complianceQuery.findMany).mockResolvedValueOnce([
      {
        id: 'query-old-1',
        userId: 'user-1',
        organizationId: 'org-1',
        query: 'What are the CBK AML limits for mobile wallets in Kenya?',
        response: 'Pursuant to CBK Prudential Guidelines...',
        createdAt: expiredDate,
      } as any,
    ]);

    const result = await archiveExpiredQueries({ now, dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.anonymized).toBe(1);
    expect(result.purged).toBe(0);
    expect(result.failed).toBe(0);

    expect(prisma.complianceQuery.update).toHaveBeenCalledWith({
      where: { id: 'query-old-1' },
      data: {
        query: REDACTED_TEXT,
        response: REDACTED_TEXT,
        summary: null,
      },
    });
  });

  it('performs deep purge with child record cleanup on queries older than 365 days', async () => {
    vi.mocked(prisma.complianceQuery.findMany).mockResolvedValueOnce([
      {
        id: 'query-ancient-1',
        userId: 'user-1',
        organizationId: 'org-1',
        query: REDACTED_TEXT,
        response: REDACTED_TEXT,
        createdAt: ancientDate,
      } as any,
    ]);

    const result = await archiveExpiredQueries({ now, dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.anonymized).toBe(0);

    expect(prisma.complianceQuery.delete).toHaveBeenCalledWith({ where: { id: 'query-ancient-1' } });
  });

  it('dry-run mode produces zero database mutations', async () => {
    vi.mocked(prisma.complianceQuery.findMany).mockResolvedValueOnce([
      {
        id: 'query-dry-1',
        userId: 'user-1',
        organizationId: 'org-1',
        query: 'Dry run test prompt',
        response: 'Dry run test answer',
        createdAt: expiredDate,
      } as any,
    ]);

    const result = await archiveExpiredQueries({ now, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.anonymized).toBe(1);
    expect(prisma.complianceQuery.update).not.toHaveBeenCalled();
    expect(prisma.complianceQuery.delete).not.toHaveBeenCalled();
  });

  it('is idempotent on repeated execution', async () => {
    // Second execution finds no unredacted or eligible ancient queries
    vi.mocked(prisma.complianceQuery.findMany).mockResolvedValueOnce([]);

    const result = await archiveExpiredQueries({ now, dryRun: false });

    expect(result.scanned).toBe(0);
    expect(result.anonymized).toBe(0);
    expect(result.purged).toBe(0);
    expect(result.failed).toBe(0);
  });
});
