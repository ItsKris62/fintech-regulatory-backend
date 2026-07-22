import { describe, expect, it, vi } from 'vitest';
import { AutomationContentService } from './content.service';
import type { AutomationApprovalService } from './approval.service';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function approvalServiceStub(overrides: { status?: 'pending' | 'approved' | 'rejected'; metadata?: Record<string, unknown> } = {}) {
  return {
    getApproval: vi.fn().mockResolvedValue({ status: overrides.status ?? 'approved' }),
    requireMetadataField: vi.fn().mockImplementation(async (_id: string, field: string) => {
      const value = overrides.metadata?.[field];
      if (typeof value !== 'string') throw Object.assign(new Error('missing'), { code: 'BAD_REQUEST' });
      return value;
    }),
  } as unknown as AutomationApprovalService;
}

function basePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post_1',
    title: 'Title',
    slug: 'title',
    excerpt: 'Excerpt',
    category: 'General',
    content: 'old content',
    publishedAt: null,
    lastReviewedAt: null,
    deletedAt: null,
    sources: [{ sourceType: 'OFFICIAL' }],
    verificationRuns: [],
    draftGenerationRuns: [],
    ...overrides,
  };
}

describe('AutomationContentService.publishContent', () => {
  it('rejects when the approval is not approved', async () => {
    const service = new AutomationContentService({ approvalService: approvalServiceStub({ status: 'pending' }), now: () => NOW });
    await expect(service.publishContent({ approvalId: 'appr_1', content: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects when approval metadata has no blogPostId', async () => {
    const service = new AutomationContentService({ approvalService: approvalServiceStub({ metadata: {} }), now: () => NOW });
    await expect(service.publishContent({ approvalId: 'appr_1', content: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('publishes a valid post, applying the given content and setting publishedAt', async () => {
    const update = vi.fn();
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(basePost()), update }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    const result = await service.publishContent({ approvalId: 'appr_1', content: 'final edited content' });

    expect(result).toEqual({ blogPostId: 'post_1', publishedAt: NOW.toISOString() });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'post_1' },
      data: { content: 'final edited content', status: 'PUBLISHED', publishedAt: NOW, lastReviewedAt: NOW },
    });
  });

  it('refuses to publish when verification is BLOCKED, same gate as adminSetStatus', async () => {
    const post = basePost({ verificationRuns: [{ status: 'BLOCKED', createdAt: NOW, completedAt: NOW }] });
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(post), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    await expect(service.publishContent({ approvalId: 'appr_1', content: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses to publish a Regulatory Updates post without an OFFICIAL source', async () => {
    const post = basePost({ category: 'Regulatory Updates', sources: [{ sourceType: 'NEWS' }] });
    const prisma = { blogPost: { findUnique: vi.fn().mockResolvedValue(post), update: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany: vi.fn() } };
    const service = new AutomationContentService({
      prisma: prisma as never,
      approvalService: approvalServiceStub({ metadata: { blogPostId: 'post_1' } }),
      now: () => NOW,
    });

    await expect(service.publishContent({ approvalId: 'appr_1', content: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
      { id: 'sig_1', title: 'Critical notice', severity: 'critical', jurisdiction: 'KE', summary: 'Summary text' },
      { id: 'sig_2', title: 'High notice', severity: 'high', jurisdiction: 'KE', summary: null },
    ]);
    const prisma = { blogPost: { findUnique: vi.fn() }, blogSourceItem: { findUnique: vi.fn() }, regulatorySignal: { findMany } };
    const service = new AutomationContentService({ prisma: prisma as never, now: () => NOW });

    const result = await service.getRecentHighImpactRegulatoryItems({ window: '7d', jurisdictions: 'KE' });

    expect(result).toEqual({
      items: [
        { id: 'sig_1', title: 'Critical notice', score: 100, jurisdiction: 'KE', summary: 'Summary text' },
        { id: 'sig_2', title: 'High notice', score: 75, jurisdiction: 'KE', summary: undefined },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ severity: { in: ['critical', 'high'] } }) }));
  });
});
