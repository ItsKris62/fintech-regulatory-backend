import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contentRouter } from './content.router';

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

describe('content.router.ts listPublishedKnowledgeBase', () => {
  const mockPrisma = {
    legalDocument: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

describe('content.router.ts legacy BLOG_POST controls', () => {
  const mockPrisma = {
    legalDocument: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as any;

  const nonAdminCtx = {
    user: { id: 'user-1', email: 'editor@example.com', role: 'STARTUP', organizationId: 'org-1' },
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };
  const adminCtx = {
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN', organizationId: 'org-1' },
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects creating a legacy LegalDocument BLOG_POST for a non-admin', async () => {
    const caller = contentRouter.createCaller(nonAdminCtx as any);

    await expect(caller.create({
      contentType: 'BLOG_POST' as any,
      title: 'Legacy blog post',
      slug: 'legacy-blog-post',
      content: 'Body',
    })).rejects.toBeDefined();
    expect(mockPrisma.legalDocument.create).not.toHaveBeenCalled();
  });

  it('also rejects creating a legacy LegalDocument BLOG_POST for an admin under the canonical BlogPost policy', async () => {
    const caller = contentRouter.createCaller(adminCtx as any);

    await expect(caller.create({
      contentType: 'BLOG_POST' as any,
      title: 'Legacy blog post',
      slug: 'legacy-blog-post',
      content: 'Body',
    })).rejects.toBeDefined();
    expect(mockPrisma.legalDocument.create).not.toHaveBeenCalled();
  });

  it('prevents non-admin updates to existing legacy BLOG_POST rows', async () => {
    mockPrisma.legalDocument.findUnique.mockResolvedValue({
      id: 'doc-1',
      contentType: 'BLOG_POST',
      authorId: 'user-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deletedAt: null,
    });
    const caller = contentRouter.createCaller(nonAdminCtx as any);

    await expect(caller.update({ id: 'doc-1', title: 'Changed title' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockPrisma.legalDocument.update).not.toHaveBeenCalled();
  });

  it('prevents publishing an existing legacy BLOG_POST row', async () => {
    mockPrisma.legalDocument.findUnique.mockResolvedValue({
      id: 'doc-1',
      contentType: 'BLOG_POST',
      contentStatus: 'DRAFT',
      slug: 'legacy-blog-post',
      authorId: 'user-1',
      userId: 'user-1',
      deletedAt: null,
    });
    const caller = contentRouter.createCaller(adminCtx as any);

    await expect(caller.publish({ id: 'doc-1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockPrisma.legalDocument.update).not.toHaveBeenCalled();
  });

  it('keeps Knowledge Base creation working through the legacy content domain', async () => {
    mockPrisma.legalDocument.findUnique.mockResolvedValue(null);
    mockPrisma.legalDocument.create.mockResolvedValue({
      id: 'kb-1',
      slug: 'aml-guide',
      contentType: 'KNOWLEDGE_BASE_ARTICLE',
      contentStatus: 'DRAFT',
      title: 'AML guide',
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
    });
    const caller = contentRouter.createCaller(nonAdminCtx as any);

    const result = await caller.create({
      contentType: 'KNOWLEDGE_BASE_ARTICLE',
      title: 'AML guide',
      slug: 'aml-guide',
      content: 'Knowledge base body',
    });

    expect(result).toMatchObject({ id: 'kb-1', contentType: 'KNOWLEDGE_BASE_ARTICLE' });
    expect(mockPrisma.legalDocument.create).toHaveBeenCalled();
  });

  it('keeps Knowledge Base editing and publication working for the author', async () => {
    mockPrisma.legalDocument.findUnique.mockResolvedValue({
      id: 'kb-1',
      contentType: 'KNOWLEDGE_BASE_ARTICLE',
      contentStatus: 'DRAFT',
      slug: 'aml-guide',
      authorId: 'user-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deletedAt: null,
    });
    mockPrisma.legalDocument.update
      .mockResolvedValueOnce({
        id: 'kb-1',
        slug: 'aml-guide',
        contentStatus: 'DRAFT',
        title: 'AML guide updated',
        updatedAt: new Date('2026-07-22T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'kb-1',
        slug: 'aml-guide',
        contentStatus: 'PUBLISHED',
        publishedAt: new Date('2026-07-22T00:00:00.000Z'),
      });
    const caller = contentRouter.createCaller(nonAdminCtx as any);

    await expect(caller.update({ id: 'kb-1', title: 'AML guide updated' })).resolves.toMatchObject({ title: 'AML guide updated' });
    await expect(caller.publish({ id: 'kb-1' })).resolves.toMatchObject({ contentStatus: 'PUBLISHED' });
  });
});

describe('content.router.ts public slug scope', () => {
  const mockPrisma = {
    legalDocument: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  const caller = contentRouter.createCaller({
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  } as any);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retrieves only explicitly public Knowledge Base content by slug', async () => {
    const publishedAt = new Date('2026-07-22T00:00:00.000Z');
    mockPrisma.legalDocument.findFirst.mockResolvedValue({
      id: 'kb-1',
      contentType: 'KNOWLEDGE_BASE_ARTICLE',
      title: 'AML guide',
      slug: 'aml-guide',
      excerpt: 'Summary',
      htmlContent: '<p>Body</p>',
      content: 'Body',
      category: 'AML',
      subcategory: null,
      tags: [],
      seoTitle: 'AML guide',
      seoDescription: 'Summary',
      seoKeywords: [],
      publishedAt,
      updatedAt: publishedAt,
      viewCount: 0,
      helpfulCount: 0,
      notHelpfulCount: 0,
      deletedAt: null,
      contentStatus: 'PUBLISHED',
      author: null,
    });

    const result = await caller.getBySlug({ slug: 'aml-guide' });

    expect(mockPrisma.legalDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        slug: 'aml-guide',
        contentType: 'KNOWLEDGE_BASE_ARTICLE',
        isLatestVersion: true,
      }),
    }));
    expect(result).toMatchObject({ id: 'kb-1', contentType: 'KNOWLEDGE_BASE_ARTICLE' });
  });

  it.each([
    ['draft', { contentStatus: 'DRAFT', deletedAt: null, publishedAt: new Date('2026-07-22T00:00:00.000Z') }],
    ['archived', { contentStatus: 'ARCHIVED', deletedAt: null, publishedAt: new Date('2026-07-22T00:00:00.000Z') }],
    ['deleted', { contentStatus: 'PUBLISHED', deletedAt: new Date('2026-07-23T00:00:00.000Z'), publishedAt: new Date('2026-07-22T00:00:00.000Z') }],
  ])('does not return %s content publicly', async (_label, overrides) => {
    mockPrisma.legalDocument.findFirst.mockResolvedValue({
      id: 'kb-1',
      contentType: 'KNOWLEDGE_BASE_ARTICLE',
      title: 'AML guide',
      slug: 'aml-guide',
      ...overrides,
    });

    await expect(caller.getBySlug({ slug: 'aml-guide' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not retrieve legacy BLOG_POST rows through the public slug endpoint', async () => {
    mockPrisma.legalDocument.findFirst.mockResolvedValue(null);

    await expect(caller.getBySlug({ slug: 'legacy-blog-post' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockPrisma.legalDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ contentType: 'KNOWLEDGE_BASE_ARTICLE' }),
    }));
  });
});
