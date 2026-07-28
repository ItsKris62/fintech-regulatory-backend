import { describe, it, expect, vi, afterEach } from 'vitest';
import { appConfig } from '@/config/app.config';

const { scoreSourceItemForBlogSuggestion } = vi.hoisted(() => ({
  scoreSourceItemForBlogSuggestion: vi.fn(),
}));

vi.mock('./relevance-scoring.service', () => ({
  scoreSourceItemForBlogSuggestion,
}));

vi.mock('./blog-notification.service', () => ({
  blogNotificationService: { notifyHighPrioritySuggestion: vi.fn().mockResolvedValue(undefined) },
}));

import { createSuggestionFromSourceItem } from './suggestion-builder';

function baseScoringResult(overrides: Record<string, unknown> = {}) {
  return {
    relevanceScore: 80,
    priority: 'MEDIUM',
    category: 'Compliance Guides',
    articleType: 'ANALYSIS',
    sourceQuality: 'MEDIUM',
    recommendedTitle: 'Title',
    suggestedSlug: 'title',
    recommendedTags: [],
    targetAudience: [],
    reason: 'reason',
    suggestedNextAction: 'next',
    requiresOfficialSource: false,
    needsMoreSources: false,
    ...overrides,
  };
}

function buildPrisma(created: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue(created);
  return {
    blogSourceItem: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'src_1',
        deletedAt: null,
        status: 'PENDING',
        jurisdiction: 'KE',
        summary: 'summary',
        monitor: { name: 'Monitor', createdById: 'admin_1' },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    blogSuggestionSource: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    blogArticleSuggestion: { create },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        blogArticleSuggestion: { create },
        blogSuggestionSource: { create: vi.fn().mockResolvedValue({}) },
        blogSourceItem: { update: vi.fn().mockResolvedValue({}) },
      }),
    ),
  };
}

describe('createSuggestionFromSourceItem requiresHumanReview gating (Pack 1 Stage C3)', () => {
  afterEach(() => {
    (appConfig.editorial as any).humanReviewPolicyEnabled = false;
  });

  it('omits requiresHumanReview from the create payload when the policy flag is disabled (default) - preserves the existing Prisma column default', async () => {
    (appConfig.editorial as any).humanReviewPolicyEnabled = false;
    scoreSourceItemForBlogSuggestion.mockReturnValue(baseScoringResult());
    const prisma = buildPrisma({ id: 'sug_1', priority: 'MEDIUM' });

    await createSuggestionFromSourceItem({ prisma: prisma as never, sourceItemId: 'src_1' });

    const createData = prisma.blogArticleSuggestion.create.mock.calls[0][0].data;
    expect(createData).not.toHaveProperty('requiresHumanReview');
  });

  it('persists an explicit computed requiresHumanReview value when the policy flag is enabled', async () => {
    (appConfig.editorial as any).humanReviewPolicyEnabled = true;
    scoreSourceItemForBlogSuggestion.mockReturnValue(
      baseScoringResult({ category: 'Regulatory Updates', requiresOfficialSource: true }),
    );
    const prisma = buildPrisma({ id: 'sug_1', priority: 'MEDIUM' });

    await createSuggestionFromSourceItem({ prisma: prisma as never, sourceItemId: 'src_1' });

    const createData = prisma.blogArticleSuggestion.create.mock.calls[0][0].data;
    expect(createData.requiresHumanReview).toBe(true);
  });

  it('persists an explicit false when the policy flag is enabled and no reason requires review', async () => {
    (appConfig.editorial as any).humanReviewPolicyEnabled = true;
    scoreSourceItemForBlogSuggestion.mockReturnValue(
      baseScoringResult({ category: 'Compliance Guides', sourceQuality: 'HIGH' }),
    );
    const prisma = buildPrisma({ id: 'sug_1', priority: 'MEDIUM' });

    await createSuggestionFromSourceItem({ prisma: prisma as never, sourceItemId: 'src_1' });

    const createData = prisma.blogArticleSuggestion.create.mock.calls[0][0].data;
    expect(createData.requiresHumanReview).toBe(false);
  });
});
