import { describe, it, expect, vi, afterEach } from 'vitest';
import { blogRouter } from './blog.router';
import * as publishReadiness from '../utils/publish-readiness';

vi.mock('../utils/publish-readiness', () => ({
  runPublishReadinessShadowCheck: vi.fn(),
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
