import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contentRouter } from './content.router';

describe('content.router.ts listPublishedKnowledgeBase', () => {
  const mockPrisma = {
    legalDocument: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as any;

  const mockCtx = {
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };

  const caller = contentRouter.createCaller(mockCtx as any);

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.legalDocument.findMany.mockResolvedValue([]);
    mockPrisma.legalDocument.count.mockResolvedValue(0);
  });

  it('queries only published, current, non-deleted Knowledge Base articles', async () => {
    await caller.listPublishedKnowledgeBase({});

    const where = mockPrisma.legalDocument.findMany.mock.calls[0][0].where;

    expect(where).toMatchObject({
      deletedAt: null,
      isLatestVersion: true,
      contentType: 'KNOWLEDGE_BASE_ARTICLE',
      contentStatus: 'PUBLISHED',
      slug: { not: null },
    });
    expect(where.AND[0].OR).toEqual([
      { publishedAt: null },
      { publishedAt: { lte: expect.any(Date) } },
    ]);
    expect(mockPrisma.legalDocument.count).toHaveBeenCalledWith({ where });
  });

  it('uses an explicit select and omits internal content fields from the response', async () => {
    mockPrisma.legalDocument.findMany.mockResolvedValue([
      {
        id: 'doc-1',
        title: 'AML reporting guide',
        slug: 'aml-reporting-guide',
        excerpt: 'How to prepare an AML report.',
        category: 'AML',
        subcategory: 'Reporting',
        tags: ['CBK'],
        publishedAt: new Date('2026-01-10T00:00:00.000Z'),
        updatedAt: new Date('2026-01-12T00:00:00.000Z'),
        viewCount: 12,
        content: 'Short article content.',
        author: {
          id: 'user-1',
          fullName: 'Editor Name',
          avatar: null,
        },
      },
    ]);
    mockPrisma.legalDocument.count.mockResolvedValue(1);

    const result = await caller.listPublishedKnowledgeBase({});
    const select = mockPrisma.legalDocument.findMany.mock.calls[0][0].select;

    expect(select).toEqual({
      id: true,
      title: true,
      slug: true,
      excerpt: true,
      category: true,
      subcategory: true,
      tags: true,
      publishedAt: true,
      updatedAt: true,
      viewCount: true,
      content: true,
      author: {
        select: {
          id: true,
          fullName: true,
          avatar: true,
        },
      },
    });
    expect(result.items[0]).toEqual({
      id: 'doc-1',
      title: 'AML reporting guide',
      slug: 'aml-reporting-guide',
      excerpt: 'How to prepare an AML report.',
      category: 'AML',
      subcategory: 'Reporting',
      tags: ['CBK'],
      publishedAt: new Date('2026-01-10T00:00:00.000Z'),
      updatedAt: new Date('2026-01-12T00:00:00.000Z'),
      viewCount: 12,
      readingTime: 1,
      author: {
        id: 'user-1',
        name: 'Editor Name',
        avatar: null,
      },
    });
    expect(result.items[0]).not.toHaveProperty('content');
    expect(result.items[0]).not.toHaveProperty('htmlContent');
    expect(result.items[0]).not.toHaveProperty('organizationId');
    expect(result.items[0]).not.toHaveProperty('userId');
  });

  it('applies search, category, tag, sorting and pagination', async () => {
    await caller.listPublishedKnowledgeBase({
      page: 2,
      limit: 10,
      search: 'data protection',
      category: 'AML',
      tag: 'CBK',
    });

    const query = mockPrisma.legalDocument.findMany.mock.calls[0][0];

    expect(query.skip).toBe(10);
    expect(query.take).toBe(10);
    expect(query.orderBy).toEqual([{ publishedAt: 'desc' }, { updatedAt: 'desc' }]);
    expect(query.where.category).toBe('AML');
    expect(query.where.tags).toEqual({ has: 'CBK' });
    expect(query.where.AND[1]).toEqual({
      OR: [
        { title: { contains: 'data protection', mode: 'insensitive' } },
        { excerpt: { contains: 'data protection', mode: 'insensitive' } },
        { content: { contains: 'data protection', mode: 'insensitive' } },
      ],
    });
  });

  it('returns totalPages in the public pagination model', async () => {
    mockPrisma.legalDocument.count.mockResolvedValue(23);

    const result = await caller.listPublishedKnowledgeBase({ limit: 10 });

    expect(result.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 23,
      totalPages: 3,
    });
  });
});
