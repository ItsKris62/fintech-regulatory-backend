import { describe, expect, it, vi, afterEach } from 'vitest';
import { appConfig } from '@/config/app.config';
import { AutomationContentService } from './content.service';
import type { AutomationApprovalService } from './approval.service';
import { computeBlogPublicationSnapshot, type BlogPublicationSnapshot } from '@/modules/blog-automation/publication-snapshot';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function basePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post_1',
    title: 'Title',
    slug: 'title',
    excerpt: 'Excerpt',
    category: 'General',
    content: 'old content',
    updatedAt: NOW,
    publishedAt: null,
    lastReviewedAt: null,
    deletedAt: null,
    archivedAt: null,
    tags: [],
    relatedRegulations: [],
    jurisdiction: 'Kenya',
    sources: [{ sourceType: 'OFFICIAL', url: 'https://regulator.example/source', updatedAt: NOW }],
    verificationRuns: [],
    draftGenerationRuns: [],
    ...overrides,
  };
}

function approvalServiceStub(overrides: {
  status?: 'pending' | 'approved' | 'rejected';
  metadata?: Record<string, unknown>;
  snapshot?: BlogPublicationSnapshot;
  expiresAt?: Date | null;
} = {}) {
  const snapshot = overrides.snapshot ?? computeBlogPublicationSnapshot(basePost() as never, NOW);
  return {
    getApproval: vi.fn().mockResolvedValue({ status: overrides.status ?? 'approved' }),
    requireMetadataField: vi.fn().mockImplementation(async (_id: string, field: string) => {
      const value = overrides.metadata?.[field];
      if (typeof value !== 'string') throw Object.assign(new Error('missing'), { code: 'BAD_REQUEST' });
      return value;
    }),
    requireBlogPublicationSnapshot: vi.fn().mockResolvedValue({ snapshot, expiresAt: overrides.expiresAt ?? new Date('2026-07-23T12:00:00.000Z') }),
  } as unknown as AutomationApprovalService;
}

describe('AutomationContentService.publishContent', () => {
  it('rejects when the approval is not approved', async () => {
    const service = new AutomationContentService({ approvalService: approvalServiceStub({ status: 'pending' }), now: () => NOW });
    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects when approval metadata has no blogPostId', async () => {
    const service = new AutomationContentService({ approvalService: approvalServiceStub({ metadata: {} }), now: () => NOW });
    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('publishes an approved unchanged draft by flipping status/publishedAt only - never overwrites the live content column', async () => {
    const update = vi.fn();
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost()), update }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    const result = await service.publishContent({ approvalId: 'appr_1' });

    expect(result).toEqual({ blogPostId: 'post_1', publishedAt: NOW.toISOString() });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'post_1' },
      data: { status: 'PUBLISHED', publishedAt: NOW, lastReviewedAt: NOW },
    });
    const updateCall = update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('content');
  });

  it('rejects when markdown content changed after approval', async () => {
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost({ content: 'human-edited final content' })), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVED_CONTENT_CHANGED/);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('rejects when a source is added after approval', async () => {
    const prisma = {
      blogPost: {
        findUnique: vi.fn().mockResolvedValue(basePost({
          sources: [
            { sourceType: 'OFFICIAL', url: 'https://regulator.example/source', updatedAt: NOW },
            { sourceType: 'OFFICIAL', url: 'https://regulator.example/extra', updatedAt: NOW },
          ],
        })),
        update: vi.fn(),
      },
      blogSourceItem: { findUnique: vi.fn() },
      regulatorySignal: { findMany: vi.fn() },
      contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new AutomationContentService({ prisma: prisma as never, approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }), now: () => NOW });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVED_SOURCES_CHANGED/);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('rejects when a source is removed after approval', async () => {
    const approvedPost = basePost({
      sources: [
        { sourceType: 'OFFICIAL', url: 'https://regulator.example/source', updatedAt: NOW },
        { sourceType: 'OFFICIAL', url: 'https://regulator.example/extra', updatedAt: NOW },
      ],
    });
    const snapshot = computeBlogPublicationSnapshot(approvedPost as never, NOW);
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost()), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({ prisma: prisma as never, approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' }, snapshot }), now: () => NOW });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVED_SOURCES_CHANGED/);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('rejects when a source URL changed after approval', async () => {
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost({ sources: [{ sourceType: 'OFFICIAL', url: 'https://regulator.example/changed', updatedAt: NOW }] })), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({ prisma: prisma as never, approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }), now: () => NOW });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVED_SOURCES_CHANGED/);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('rejects when approval metadata and snapshot point at different posts', async () => {
    const snapshot = computeBlogPublicationSnapshot(basePost({ id: 'post_2' }) as never, NOW);
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost()), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({ prisma: prisma as never, approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' }, snapshot }), now: () => NOW });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVAL_POST_MISMATCH/);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('rejects expired publication approvals', async () => {
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost()), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' }, expiresAt: new Date('2026-07-22T11:59:59.000Z') }),
      now: () => NOW,
    });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVAL_EXPIRED/);
    expect(prisma.blogPost.findUnique).not.toHaveBeenCalled();
  });

  it('rejects when the approved verification run is no longer the current verification', async () => {
    const snapshot = computeBlogPublicationSnapshot(basePost({ verificationRuns: [{ id: 'verify_old' }] }) as never, NOW);
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost({ verificationRuns: [{ id: 'verify_new', status: 'PASSED', createdAt: NOW, completedAt: NOW }] })), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({ prisma: prisma as never, approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' }, snapshot }), now: () => NOW });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/VERIFICATION_REQUIRED/);
    expect(prisma.blogPost.update).not.toHaveBeenCalled();
  });

  it('rejects replaying an approval after a later material edit', async () => {
    const update = vi.fn();
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(basePost())
      .mockResolvedValueOnce(basePost())
      .mockResolvedValueOnce(basePost({ title: 'A later title edit' }));
    const prisma = { blogPost: { findUnique, update }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({ prisma: prisma as never, approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }), now: () => NOW });

    await expect(service.publishContent({ approvalId: 'appr_1' })).resolves.toEqual({ blogPostId: 'post_1', publishedAt: NOW.toISOString() });
    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toThrow(/APPROVED_PUBLICATION_PAYLOAD_CHANGED/);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('refuses to publish when verification is BLOCKED, same gate as adminSetStatus', async () => {
    const post = basePost({ verificationRuns: [{ status: 'BLOCKED', createdAt: NOW, completedAt: NOW }] });
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(post), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses to publish a Regulatory Updates post without an OFFICIAL source', async () => {
    const post = basePost({ category: 'Regulatory Updates', sources: [{ sourceType: 'NEWS', url: 'https://news.example/story', updatedAt: NOW }] });
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(post), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() }, contentOpsAlert: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  describe('publish-readiness shadow integration (Pack 1 Stage C5)', () => {
    afterEach(() => {
      (appConfig.editorial as any).publishReadinessMode = 'shadow';
    });

    it('shadow mode (default): a legacy-accepted publish still succeeds even if the new evaluator would have found a blocker', async () => {
      (appConfig.editorial as any).publishReadinessMode = 'shadow';
      const update = vi.fn();
      // Legacy gates pass (title/slug/excerpt/category/sources all present), but
      // the new evaluator's own "no open ContentOpsAlert" pass will still find
      // this one, since it's marked blocksPublication.
      const post = basePost();
      const prisma = {
        blogPost: { findUnique: vi.fn().mockResolvedValue(post), update },
        blogSourceItem: { findUnique: vi.fn() },
        regulatorySignal: { findMany: vi.fn() },
        contentOpsAlert: { findMany: vi.fn().mockResolvedValue([{ id: 'alert_1', metadata: { blocksPublication: true } }]) },
      };
      const service = new AutomationContentService({
        prisma: prisma as never,
        approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
        now: () => NOW,
      });

      const result = await service.publishContent({ approvalId: 'appr_1' });

      expect(result).toEqual({ blogPostId: 'post_1', publishedAt: NOW.toISOString() });
      expect(update).toHaveBeenCalled();
    });

    it('enforce mode: the same divergence now blocks publication (not enabled by default)', async () => {
      (appConfig.editorial as any).publishReadinessMode = 'enforce';
      const update = vi.fn();
      const post = basePost();
      const prisma = {
        blogPost: { findUnique: vi.fn().mockResolvedValue(post), update },
        blogSourceItem: { findUnique: vi.fn() },
        regulatorySignal: { findMany: vi.fn() },
        contentOpsAlert: { findMany: vi.fn().mockResolvedValue([{ id: 'alert_1', metadata: { blocksPublication: true } }]) },
      };
      const service = new AutomationContentService({
        prisma: prisma as never,
        approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
        now: () => NOW,
      });

      await expect(service.publishContent({ approvalId: 'appr_1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(update).not.toHaveBeenCalled();
    });
  });
});

describe('AutomationContentService.queueContentCandidate', () => {
  it('forwards to the n8n webhook with the timestamp and ingress headers, enriching summary from BlogSourceItem', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const prisma = {
      blogPost: { findUnique: vi.fn() },
      blogSourceItem: { findUnique: vi.fn().mockResolvedValue({ summary: 'Real summary from the source item.' }) },
      regulatorySignal: { findMany: vi.fn() },
    };
    const service = new AutomationContentService({ prisma: prisma as never, fetchImpl, now: () => NOW });

    const result = await service.queueContentCandidate({ sourceItemId: 'item_1', title: 'New CBK notice', score: 0.9, jurisdiction: 'KE' });

    expect(result).toEqual({ forwarded: true });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://agents.sheriabot.com/webhook/sheriabot-content-candidate');
    expect(JSON.parse(init.body as string)).toEqual({
      sourceItemId: 'item_1',
      title: 'New CBK notice',
      summary: 'Real summary from the source item.',
      score: 0.9,
      jurisdiction: 'KE',
    });
  });

  it('reports forwarded:false, without throwing, when the webhook call fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const prisma = { blogPost: { findUnique: vi.fn() }, blogSourceItem: { findUnique: vi.fn().mockResolvedValue(null) }, regulatorySignal: { findMany: vi.fn() } };
    const service = new AutomationContentService({ prisma: prisma as never, fetchImpl, now: () => NOW });

    const result = await service.queueContentCandidate({ sourceItemId: 'item_1', title: 'X', score: 0.5, jurisdiction: 'KE' });
    expect(result).toEqual({ forwarded: false });
  });
});

describe('AutomationContentService.getRecentHighImpactRegulatoryItems', () => {
  it('maps severity to a documented numeric score and passes through jurisdiction/summary', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'sig_1', title: 'Critical notice', severity: 'critical', jurisdiction: 'KE', summary: 'Summary text', sourceItemId: null },
      { id: 'sig_2', title: 'High notice', severity: 'high', jurisdiction: 'KE', summary: null, sourceItemId: null },
    ]);
    const prisma = { blogPost: { findUnique: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany } };
    const service = new AutomationContentService({ prisma: prisma as never, now: () => NOW });

    const result = await service.getRecentHighImpactRegulatoryItems({ window: '7d', jurisdictions: 'KE' });

    expect(result).toEqual({
      items: [
        { id: 'sig_1', title: 'Critical notice', score: 100, jurisdiction: 'KE', summary: 'Summary text', sourceItemId: undefined },
        { id: 'sig_2', title: 'High notice', score: 75, jurisdiction: 'KE', summary: undefined, sourceItemId: undefined },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ severity: { in: ['critical', 'high'] } }) }));
  });

  it('exposes the BlogSourceItem.id each signal was classified from, so W-CONTENT-01 can hand a real sourceItemId to queueContentCandidate', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'sig_1', title: 'Critical notice', severity: 'critical', jurisdiction: 'KE', summary: 'Summary text', sourceItemId: 'item_1' },
    ]);
    const prisma = { blogPost: { findUnique: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany } };
    const service = new AutomationContentService({ prisma: prisma as never, now: () => NOW });

    const result = await service.getRecentHighImpactRegulatoryItems({ window: '7d', jurisdictions: 'KE' });

    expect(result.items[0]).toMatchObject({ id: 'sig_1', sourceItemId: 'item_1' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ sourceItemId: true }) }));
  });
});

describe('AutomationContentService.getApprovedContentThisWeek', () => {
  it('passes through excerpt when present, and selects it from BlogPost', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'post_1', title: 'CBK Circular Summary', jurisdiction: 'Kenya', publishedAt: NOW, excerpt: 'A real excerpt of the published post.' },
    ]);
    const prisma = { blogPost: { findUnique: vi.fn(), findMany }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() } };
    const service = new AutomationContentService({ prisma: prisma as never, now: () => NOW });

    const result = await service.getApprovedContentThisWeek({ jurisdictions: 'Kenya' });

    expect(result).toEqual({
      items: [
        { id: 'post_1', title: 'CBK Circular Summary', jurisdiction: 'Kenya', publishedAt: NOW.toISOString(), excerpt: 'A real excerpt of the published post.' },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: [
          expect.objectContaining({
            status: 'PUBLISHED',
            deletedAt: null,
            archivedAt: null,
            publishedAt: { not: null, lte: NOW },
          }),
          { publishedAt: { gte: new Date('2026-07-15T12:00:00.000Z') } },
        ],
      }),
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({ excerpt: true }),
    }));
  });

  it('returns excerpt: undefined (not null, not a fabricated fallback) for the anomalous case of a PUBLISHED post with no excerpt', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'post_2', title: 'Legacy Post', jurisdiction: 'Kenya', publishedAt: NOW, excerpt: null },
    ]);
    const prisma = { blogPost: { findUnique: vi.fn(), findMany }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() } };
    const service = new AutomationContentService({ prisma: prisma as never, now: () => NOW });

    const result = await service.getApprovedContentThisWeek({ jurisdictions: 'Kenya' });

    expect(result.items[0]).toEqual(
      expect.objectContaining({ id: 'post_2', excerpt: undefined }),
    );
  });
});
