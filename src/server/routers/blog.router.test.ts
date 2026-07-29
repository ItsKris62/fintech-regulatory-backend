import { describe, it, expect, vi, afterEach } from 'vitest';
import { blogRouter } from './blog.router';
import * as publishReadiness from '../utils/publish-readiness';
import { publicBlogOrderBy, publicBlogWhere } from '@/modules/blog/public-blog-visibility';

vi.mock('../utils/publish-readiness', () => ({
  runPublishReadinessShadowCheck: vi.fn(),
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('blog.router.ts adminSetStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockPrisma = {
    blogPost: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  const mockCtx = {
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    req: { ip: '127.0.0.1' },
    prisma: mockPrisma,
  };

  const caller = blogRouter.createCaller(mockCtx as any);

  it('invokes runPublishReadinessShadowCheck during PUBLISHED attempts and does not block on evaluator failure', async () => {
    const post = {
      id: 'post_1',
      status: 'DRAFT',
      title: 'A title',
      slug: 'a-title',
      excerpt: 'excerpt',
      category: 'Compliance Guides',
      content: 'content',
      sources: [{ id: 's1' }],
      verificationRuns: [{ id: 'v1', status: 'PASSED' }],
      draftGenerationRuns: []
    };
    
    mockPrisma.blogPost.findUnique.mockResolvedValue(post);
    mockPrisma.blogPost.update.mockResolvedValue({ ...post, status: 'PUBLISHED' });
    
    vi.mocked(publishReadiness.runPublishReadinessShadowCheck).mockResolvedValue({
      evaluated: true,
      shouldBlock: false,
      mode: 'shadow',
      result: {
        ready: false,
        blockers: [{ code: 'NO_CONTENT', message: 'Failed' }],
        warnings: [],
        evaluatedAt: new Date(),
        isStale: false,
        isAiStale: false
      }
    });

    await caller.adminSetStatus({ id: 'post_1', status: 'PUBLISHED' });

    expect(publishReadiness.runPublishReadinessShadowCheck).toHaveBeenCalledWith(
      mockPrisma,
      'post_1',
      true, 
      'adminSetStatus'
    );
    expect(mockPrisma.blogPost.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'post_1' },
      data: expect.objectContaining({ status: 'PUBLISHED' })
    }));
  });

  it('authoritative inline checks remain authoritative (e.g., throwing error if blocked)', async () => {
    const post = {
      id: 'post_1',
      status: 'DRAFT',
      title: '', 
      category: 'Compliance Guides',
      content: '',
      sources: [],
      verificationRuns: [],
      draftGenerationRuns: []
    };
    
    mockPrisma.blogPost.findUnique.mockResolvedValue(post);
    
    vi.mocked(publishReadiness.runPublishReadinessShadowCheck).mockResolvedValue({
      evaluated: true,
      shouldBlock: false,
      mode: 'shadow'
    });

    await expect(caller.adminSetStatus({ id: 'post_1', status: 'PUBLISHED' }))
      .rejects.toThrowError(/Missing required fields for publishing/);

    expect(publishReadiness.runPublishReadinessShadowCheck).toHaveBeenCalledWith(
      mockPrisma,
      'post_1',
      false, 
      'adminSetStatus'
    );
  });
});

describe('public Blog visibility contract', () => {
  const NOW = new Date('2026-07-22T12:00:00.000Z');

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the documented public predicate boundary', () => {
    expect(publicBlogWhere(NOW)).toEqual({
      status: 'PUBLISHED',
      deletedAt: null,
      archivedAt: null,
      publishedAt: { not: null, lte: NOW },
    });
  });

  it('uses stable public ordering', () => {
    expect(publicBlogOrderBy()).toEqual([{ publishedAt: 'desc' }, { id: 'desc' }]);
  });

  it('publicList uses shared visibility, stable ordering, and public-visible totals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await caller.publicList({ page: 1, limit: 10 });

    const query = mockPrisma.blogPost.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject(publicBlogWhere(NOW));
    expect(query.orderBy).toEqual(publicBlogOrderBy());
    expect(mockPrisma.blogPost.count).toHaveBeenCalledWith({ where: query.where });
  });

  it('publicList combines filters with the same visibility predicate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await caller.publicList({ page: 2, limit: 5, category: ' Regulatory Updates ', search: ' CBK ', tag: ' AML ', featured: true });

    const query = mockPrisma.blogPost.findMany.mock.calls[0][0];
    expect(query.skip).toBe(5);
    expect(query.take).toBe(5);
    expect(query.where).toMatchObject({
      ...publicBlogWhere(NOW),
      category: 'Regulatory Updates',
      tags: { has: 'AML' },
      featured: true,
    });
    expect(query.where.OR).toEqual([
      { title: { contains: 'CBK', mode: 'insensitive' } },
      { excerpt: { contains: 'CBK', mode: 'insensitive' } },
      { content: { contains: 'CBK', mode: 'insensitive' } },
    ]);
  });

  it('publicGetBySlug uses shared visibility rules', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.publicGetBySlug({ slug: 'future-post' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockPrisma.blogPost.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...publicBlogWhere(NOW), slug: 'future-post' },
    }));
  });

  it('getFeatured is bounded and uses shared visibility/order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await caller.getFeatured({ limit: 10 });
    const query = mockPrisma.blogPost.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ ...publicBlogWhere(NOW), featured: true });
    expect(query.take).toBe(10);
    expect(query.orderBy).toEqual(publicBlogOrderBy());
    await expect(caller.getFeatured({ limit: 11 })).rejects.toBeDefined();
  });

  it('publicSlugs uses shared visibility and order for sitemap source data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await caller.publicSlugs();
    expect(mockPrisma.blogPost.findMany).toHaveBeenCalledWith({
      where: publicBlogWhere(NOW),
      orderBy: publicBlogOrderBy(),
      select: { slug: true, updatedAt: true, publishedAt: true },
    });
  });

  it('publicTaxonomy derives categories and tags only from public visible posts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findMany: vi.fn().mockResolvedValue([
          { category: 'Regulatory Updates', tags: ['CBK', 'Licensing'] },
          { category: 'Regulatory Updates', tags: ['CBK', 'AML/CFT'] },
          { category: 'Data Protection', tags: ['ODPC'] },
        ]),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.publicTaxonomy()).resolves.toEqual({
      categories: [
        { name: 'Regulatory Updates', count: 2 },
        { name: 'Data Protection', count: 1 },
      ],
      tags: [
        { name: 'CBK', count: 2 },
        { name: 'AML/CFT', count: 1 },
        { name: 'Licensing', count: 1 },
        { name: 'ODPC', count: 1 },
      ],
    });
    expect(mockPrisma.blogPost.findMany).toHaveBeenCalledWith({
      where: publicBlogWhere(NOW),
      orderBy: publicBlogOrderBy(),
      select: { category: true, tags: true },
    });
  });
});

describe('public Blog Phase 1 contracts', () => {
  const NOW = new Date('2026-07-22T12:00:00.000Z');

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('submitFeedback upserts anonymous feedback against a public BlogPost without exposing prior votes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const mockPrisma = {
      blogPost: {
        findFirst: vi.fn().mockResolvedValue({ id: 'post_1' }),
      },
      blogPostFeedback: {
        upsert: vi.fn().mockResolvedValue({ id: 'fb_1' }),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.submitFeedback({
      postId: 'post_1',
      value: 'HELPFUL',
      readerSessionId: 'session_1',
    })).resolves.toEqual({ success: true });

    expect(mockPrisma.blogPost.findFirst).toHaveBeenCalledWith({
      where: { ...publicBlogWhere(NOW), id: 'post_1' },
      select: { id: true },
    });
    const call = mockPrisma.blogPostFeedback.upsert.mock.calls[0][0];
    expect(call.where.blogPostId_anonymousKeyHash.blogPostId).toBe('post_1');
    expect(call.where.blogPostId_anonymousKeyHash.anonymousKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(call.create.value).toBe('HELPFUL');
    expect(call.create.anonymousKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(call.create.userId).toBeNull();
  });

  it('submitFeedback upserts authenticated feedback by user id', async () => {
    const mockPrisma = {
      blogPost: {
        findFirst: vi.fn().mockResolvedValue({ id: 'post_1' }),
      },
      blogPostFeedback: {
        upsert: vi.fn().mockResolvedValue({ id: 'fb_1' }),
      },
    };
    const caller = blogRouter.createCaller({
      req: { ip: '127.0.0.1' },
      user: { id: 'user_1', role: 'STARTUP' },
      prisma: mockPrisma,
    } as any);

    await caller.submitFeedback({ postId: 'post_1', value: 'NOT_HELPFUL' });

    expect(mockPrisma.blogPostFeedback.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { blogPostId_userId: { blogPostId: 'post_1', userId: 'user_1' } },
      create: expect.objectContaining({ userId: 'user_1', anonymousKeyHash: null }),
    }));
  });

  it('submitFeedback requires a reader session for anonymous feedback', async () => {
    const mockPrisma = {
      blogPost: {
        findFirst: vi.fn().mockResolvedValue({ id: 'post_1' }),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.submitFeedback({ postId: 'post_1', value: 'HELPFUL' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('getPublicFeedbackSummary returns aggregate counts only', async () => {
    const mockPrisma = {
      blogPost: {
        findFirst: vi.fn().mockResolvedValue({ id: 'post_1' }),
      },
      blogPostFeedback: {
        count: vi.fn()
          .mockResolvedValueOnce(7)
          .mockResolvedValueOnce(2),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.getPublicFeedbackSummary({ postId: 'post_1' })).resolves.toEqual({
      helpfulCount: 7,
      notHelpfulCount: 2,
      totalResponses: 9,
    });
  });

  it('submitTopicRequest stores bounded sanitized requests in the editorial queue', async () => {
    const mockPrisma = {
      blogTopicRequest: {
        create: vi.fn().mockResolvedValue({ id: 'topic_1' }),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.submitTopicRequest({
      topic: '  <script>alert(1)</script> ODPC breach notices  ',
      category: 'Data Protection',
      jurisdiction: 'Kenya',
      sourcePage: '/blog',
      readerSessionId: 'session_1',
    })).resolves.toEqual({ success: true });

    const data = mockPrisma.blogTopicRequest.create.mock.calls[0][0].data;
    expect(data.topic).toBe('alert(1) ODPC breach notices');
    expect(data.status).toBe('PENDING');
    expect(data.anonymousKeyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('submitTopicRequest accepts honeypot submissions without publishing or drafting', async () => {
    const mockPrisma = {
      blogTopicRequest: {
        create: vi.fn().mockResolvedValue({ id: 'topic_1' }),
      },
    };
    const caller = blogRouter.createCaller({ req: { ip: '127.0.0.1' }, prisma: mockPrisma } as any);

    await expect(caller.submitTopicRequest({
      topic: 'A bounded compliance topic',
      spamTrap: 'bot-filled-value',
    })).resolves.toEqual({ success: true });
    expect(mockPrisma.blogTopicRequest.create.mock.calls[0][0].data.status).toBe('SPAM');
  });

  it('adminGetEditorialMetricsContract documents sources and keeps public trending disabled', async () => {
    const caller = blogRouter.createCaller({
      req: { ip: '127.0.0.1' },
      user: { id: 'admin_1', role: 'ADMIN' },
      prisma: {},
    } as any);

    const contract = await caller.adminGetEditorialMetricsContract();
    expect(contract.publicTrendingEnabled).toBe(false);
    expect(contract.sources.some((source) => source.eventName === 'blog_article_engaged')).toBe(true);
    expect(contract.sources.some((source) => source.tableName === 'BlogPostFeedback')).toBe(true);
  });
});
