import { describe, it, expect, vi, afterEach } from 'vitest';
import { appConfig } from '@/config/app.config';
import { evaluateBlogPublishReadiness, runPublishReadinessShadowCheck, type ReadinessPrisma } from './publish-readiness';

const EARLIER = new Date('2026-07-01T00:00:00.000Z');
const LATER = new Date('2026-07-28T00:00:00.000Z');

function fullPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post_1',
    title: 'A Title',
    slug: 'a-title',
    excerpt: 'An excerpt',
    content: 'Enough content here.',
    category: 'Compliance Guides',
    deletedAt: null,
    updatedAt: EARLIER,
    sources: [{ sourceType: 'THIRD_PARTY', updatedAt: EARLIER }],
    verificationRuns: [{ id: 'run_1', status: 'PASSED', completedAt: EARLIER, createdAt: EARLIER }],
    draftGenerationRuns: [],
    automationSuggestion: null,
    ...overrides,
  };
}

function buildPrisma(overrides: { post?: unknown; openAlerts?: unknown[] } = {}): ReadinessPrisma {
  const post = 'post' in overrides ? overrides.post : fullPost();
  return {
    blogPost: { findUnique: vi.fn().mockResolvedValue(post) },
    contentOpsAlert: { findMany: vi.fn().mockResolvedValue(overrides.openAlerts ?? []) },
  } as unknown as ReadinessPrisma;
}

describe('evaluateBlogPublishReadiness', () => {
  it('returns ready: true with no blockers/warnings for a fully valid post', async () => {
    const prisma = buildPrisma();
    const result = await evaluateBlogPublishReadiness(prisma, 'post_1');
    expect(result).toMatchObject({ ready: true, blockers: [], isStale: false, isAiStale: false });
  });

  it('never mutates the post - only findUnique/findMany are called, never update', async () => {
    const prisma = buildPrisma();
    await evaluateBlogPublishReadiness(prisma, 'post_1');
    expect(prisma.blogPost).not.toHaveProperty('update');
  });

  it.each([
    ['title', 'MISSING_TITLE'],
    ['slug', 'MISSING_SLUG'],
    ['excerpt', 'MISSING_EXCERPT'],
    ['category', 'MISSING_CATEGORY'],
  ])('blocks when %s is missing', async (field, code) => {
    const prisma = buildPrisma({ post: fullPost({ [field]: '' }) });
    const result = await evaluateBlogPublishReadiness(prisma, 'post_1');
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain(code);
  });

  it('blocks when content is empty or missing (both admin and agent paths use this evaluator)', async () => {
    const emptyContent = await evaluateBlogPublishReadiness(buildPrisma({ post: fullPost({ content: '' }) }), 'post_1');
    expect(emptyContent.blockers.map((b) => b.code)).toContain('MISSING_CONTENT');

    const nullContent = await evaluateBlogPublishReadiness(buildPrisma({ post: fullPost({ content: null }) }), 'post_1');
    expect(nullContent.blockers.map((b) => b.code)).toContain('MISSING_CONTENT');

    const whitespaceContent = await evaluateBlogPublishReadiness(buildPrisma({ post: fullPost({ content: '   ' }) }), 'post_1');
    expect(whitespaceContent.blockers.map((b) => b.code)).toContain('MISSING_CONTENT');
  });

  it('blocks when there are no sources', async () => {
    const result = await evaluateBlogPublishReadiness(buildPrisma({ post: fullPost({ sources: [] }) }), 'post_1');
    expect(result.blockers.map((b) => b.code)).toContain('NO_SOURCES');
  });

  it('blocks Regulatory Updates / Enforcement & Penalties without an OFFICIAL source', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ category: 'Regulatory Updates', sources: [{ sourceType: 'THIRD_PARTY', updatedAt: EARLIER }] }) }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
  });

  it('accepts Regulatory Updates with an OFFICIAL source', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ category: 'Regulatory Updates', sources: [{ sourceType: 'OFFICIAL', updatedAt: EARLIER }] }) }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).not.toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
  });

  it('accepts International Standards with an INTERNATIONAL_STANDARD source (not just OFFICIAL)', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ category: 'International Standards', sources: [{ sourceType: 'INTERNATIONAL_STANDARD', updatedAt: EARLIER }] }) }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).not.toContain('MISSING_REQUIRED_OFFICIAL_SOURCE');
  });

  it('blocks when the latest verification run is BLOCKED', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ verificationRuns: [{ id: 'run_1', status: 'BLOCKED', completedAt: EARLIER, createdAt: EARLIER }] }) }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).toContain('VERIFICATION_BLOCKED');
    expect(result.latestVerificationRunId).toBe('run_1');
  });

  it('blocks when the linked suggestion requires human review and is not approved', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ automationSuggestion: { requiresHumanReview: true, approvedById: null } }) }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).toContain('HUMAN_REVIEW_REQUIRED');
  });

  it('does not block when the linked suggestion requires human review but has been approved', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ automationSuggestion: { requiresHumanReview: true, approvedById: 'admin_1' } }) }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).not.toContain('HUMAN_REVIEW_REQUIRED');
  });

  it('blocks on an OPEN ContentOpsAlert explicitly marked metadata.blocksPublication=true for this BlogPost', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ openAlerts: [{ id: 'alert_1', metadata: { blocksPublication: true } }] }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).toContain('BLOCKING_CONTENT_OPS_ALERT');
  });

  it('does NOT block on an open alert of any severity that is not explicitly marked blocksPublication=true', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ openAlerts: [{ id: 'alert_1', metadata: { severity: 'CRITICAL' } }, { id: 'alert_2', metadata: {} }] }),
      'post_1',
    );
    expect(result.blockers.map((b) => b.code)).not.toContain('BLOCKING_CONTENT_OPS_ALERT');
  });

  it('warns (does not block) when the post or a source was updated after the latest verification', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({ post: fullPost({ updatedAt: LATER, verificationRuns: [{ id: 'run_1', status: 'PASSED', completedAt: EARLIER, createdAt: EARLIER }] }) }),
      'post_1',
    );
    expect(result.isStale).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('POST_OR_SOURCE_UPDATED_SINCE_VERIFICATION');
    expect(result.blockers).toEqual([]);
  });

  it('blocks when an APPLIED AI draft postdates the latest verification', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({
        post: fullPost({
          verificationRuns: [{ id: 'run_1', status: 'PASSED', completedAt: EARLIER, createdAt: EARLIER }],
          draftGenerationRuns: [{ appliedToPost: true, appliedAt: LATER }],
        }),
      }),
      'post_1',
    );
    expect(result.isAiStale).toBe(true);
    expect(result.blockers.map((b) => b.code)).toContain('AI_DRAFT_NEWER_THAN_VERIFICATION');
  });

  it('does NOT block or flag AI-staleness for an unapplied draft run, even if it postdates verification', async () => {
    const result = await evaluateBlogPublishReadiness(
      buildPrisma({
        post: fullPost({
          verificationRuns: [{ id: 'run_1', status: 'PASSED', completedAt: EARLIER, createdAt: EARLIER }],
          draftGenerationRuns: [{ appliedToPost: false, appliedAt: null }],
        }),
      }),
      'post_1',
    );
    expect(result.isAiStale).toBe(false);
    expect(result.blockers.map((b) => b.code)).not.toContain('AI_DRAFT_NEWER_THAN_VERIFICATION');
  });

  it('returns POST_NOT_FOUND for a missing or soft-deleted post', async () => {
    const result = await evaluateBlogPublishReadiness(buildPrisma({ post: null }), 'missing');
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(['POST_NOT_FOUND']);
  });
});

describe('runPublishReadinessShadowCheck', () => {
  afterEach(() => {
    (appConfig.editorial as any).publishReadinessMode ='shadow';
  });

  it('does nothing (mode: off) and never evaluates', async () => {
    (appConfig.editorial as any).publishReadinessMode ='off';
    const prisma = buildPrisma();
    const result = await runPublishReadinessShadowCheck(prisma, 'post_1', true, 'adminSetStatus');
    expect(result).toEqual({ mode: 'off', evaluated: false, shouldBlock: false });
  });

  it('shadow mode never blocks even when the evaluator disagrees with the legacy outcome (default mode)', async () => {
    (appConfig.editorial as any).publishReadinessMode ='shadow';
    const prisma = buildPrisma({ post: fullPost({ content: '' }) }); // evaluator says not ready
    const result = await runPublishReadinessShadowCheck(prisma, 'post_1', true, 'adminSetStatus'); // legacy said ready
    expect(result.divergedFromLegacy).toBe(true);
    expect(result.shouldBlock).toBe(false); // never blocks in shadow mode
  });

  it('logs a divergence with only the BlogPost ID and finding codes, never content', async () => {
    const warnSpy = vi.spyOn((await import('@/utils/logger')).logger, 'warn');
    (appConfig.editorial as any).publishReadinessMode ='shadow';
    const prisma = buildPrisma({ post: fullPost({ content: '' }) });

    await runPublishReadinessShadowCheck(prisma, 'post_1', true, 'adminSetStatus');

    const call = warnSpy.mock.calls.find((c) => (c[0] as { type?: string }).type === 'blog_publish_readiness_divergence');
    expect(call).toBeDefined();
    const payload = call![0] as Record<string, unknown>;
    expect(payload.blogPostId).toBe('post_1');
    expect(payload.blockerCodes).toContain('MISSING_CONTENT');
    expect(JSON.stringify(payload)).not.toContain('Enough content here');
  });

  it('enforce mode is implemented (shouldBlock becomes true) but is never the default', async () => {
    expect(appConfig.editorial.publishReadinessMode).toBe('shadow'); // default in this test env

    (appConfig.editorial as any).publishReadinessMode ='enforce';
    const prisma = buildPrisma({ post: fullPost({ content: '' }) });
    const result = await runPublishReadinessShadowCheck(prisma, 'post_1', true, 'adminSetStatus');
    expect(result.shouldBlock).toBe(true);
  });

  it('never throws even if the underlying evaluator fails', async () => {
    const prisma = {
      blogPost: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) },
      contentOpsAlert: { findMany: vi.fn() },
    } as unknown as ReadinessPrisma;

    await expect(runPublishReadinessShadowCheck(prisma, 'post_1', true, 'adminSetStatus')).resolves.toMatchObject({ evaluated: false, shouldBlock: false });
  });
});
