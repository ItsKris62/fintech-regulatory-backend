import { Prisma } from '@prisma/client';
import type { AgentRun, BlogArticleSuggestion, BlogFreshnessReview, BlogPost, BlogPostSource } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AIStructuredOutputError } from '@/lib/ai/structured/errors';
import {
  FreshnessReviewService,
  FreshnessReviewValidationError,
  FreshnessEvidenceGuardrailError,
  determineRiskTier,
  cadenceDaysFor,
  computeNextReviewAt,
  HIGH_RISK_CADENCE_DAYS,
  NORMAL_CADENCE_DAYS,
  EVERGREEN_CADENCE_DAYS,
} from './freshness-review.service';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const PUBLISHED_LONG_AGO = new Date('2024-01-01T00:00:00.000Z');

function makePost(overrides: Record<string, unknown> = {}): BlogPost & {
  sources: BlogPostSource[];
  automationSuggestion: BlogArticleSuggestion | null;
  freshnessReviews: BlogFreshnessReview[];
} {
  return {
    id: 'post_1',
    title: 'Kenya CBK Circular Update',
    slug: 'kenya-cbk-circular',
    excerpt: null,
    content: 'Some published content.',
    htmlContent: null,
    coverImageUrl: null,
    category: 'Regulatory Updates',
    tags: [],
    status: 'PUBLISHED',
    featured: false,
    jurisdiction: 'Kenya',
    relatedRegulations: [],
    seoTitle: null,
    seoDescription: null,
    canonicalUrl: null,
    ogImageUrl: null,
    authorId: 'admin_1',
    reviewerId: null,
    updatedById: null,
    publishedAt: PUBLISHED_LONG_AGO,
    lastReviewedAt: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: PUBLISHED_LONG_AGO,
    updatedAt: PUBLISHED_LONG_AGO,
    sources: [],
    automationSuggestion: null,
    freshnessReviews: [],
    ...overrides,
  } as unknown as BlogPost & { sources: BlogPostSource[]; automationSuggestion: BlogArticleSuggestion | null; freshnessReviews: BlogFreshnessReview[] };
}

function makePostSource(overrides: Record<string, unknown> = {}): BlogPostSource {
  return {
    id: 'ps_1',
    postId: 'post_1',
    sourceType: 'OFFICIAL',
    title: 'CBK Circular',
    publisher: 'CBK',
    url: 'https://centralbank.example/circular-1',
    publishedAt: PUBLISHED_LONG_AGO,
    accessedAt: PUBLISHED_LONG_AGO,
    notes: null,
    createdAt: PUBLISHED_LONG_AGO,
    updatedAt: PUBLISHED_LONG_AGO,
    ...overrides,
  } as unknown as BlogPostSource;
}

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'agentrun_1',
    agentType: 'freshness-review',
    status: 'RUNNING',
    idempotencyKey: 'idem_1',
    organizationId: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: new Prisma.Decimal('0'),
    iterations: 0,
    startedAt: NOW,
    completedAt: null,
    error: null,
    metadata: null,
    ...overrides,
  } as unknown as AgentRun;
}

function makeFreshnessRow(overrides: Record<string, unknown> = {}): BlogFreshnessReview {
  return {
    id: 'fresh_1',
    blogPostId: 'post_1',
    agentRunId: 'agentrun_1',
    triggeredBy: 'SCHEDULE',
    contentHash: 'hash_content',
    sourceSetHash: 'hash_sources',
    riskTier: 'HIGH_RISK',
    freshnessScore: 100,
    action: 'FRESH',
    rationale: 'No changes detected.',
    changedSourceIds: [],
    newSignalIds: [],
    brokenSourceCount: 0,
    staleSourceCount: 0,
    nextReviewAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    modelProvider: null,
    modelName: null,
    promptVersion: 'freshness-review-v1',
    status: 'COMPLETE',
    errorMessage: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  } as unknown as BlogFreshnessReview;
}

interface BuildOptions {
  post?: ReturnType<typeof makePost> | null;
  beginRunResult?: { started: false; reason: 'agents_disabled' } | { started: true; duplicate: boolean; run: AgentRun };
  completeStructuredFn?: ReturnType<typeof vi.fn>;
  newSignals?: Array<Record<string, unknown>>;
  activePack?: Record<string, unknown> | null;
  createRevisionRequest?: ReturnType<typeof vi.fn>;
}

function buildService(options: BuildOptions = {}) {
  const findUniqueBlogPost = vi.fn().mockResolvedValue(options.post === undefined ? makePost() : options.post);
  const findManyBlogPost = vi.fn().mockResolvedValue([]);
  const findFirstFreshnessReview = vi.fn();
  const createFreshnessReview = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    makeFreshnessRow({ id: 'fresh_created', ...data }),
  );
  const findManySignals = vi.fn().mockResolvedValue(options.newSignals ?? []);
  const findFirstResearchPack = vi.fn().mockResolvedValue(options.activePack === undefined ? null : options.activePack);

  const prisma = {
    blogPost: { findUnique: findUniqueBlogPost, findMany: findManyBlogPost },
    blogFreshnessReview: { findFirst: findFirstFreshnessReview, create: createFreshnessReview },
    regulatorySignal: { findMany: findManySignals },
    blogResearchPack: { findFirst: findFirstResearchPack },
  };

  const beginRun = vi.fn().mockResolvedValue(options.beginRunResult ?? { started: true, duplicate: false, run: makeAgentRun() });
  const completeRun = vi.fn().mockResolvedValue(makeAgentRun({ status: 'COMPLETED' }));
  const failRun = vi.fn().mockResolvedValue(makeAgentRun({ status: 'FAILED' }));

  const completeStructuredFn =
    options.completeStructuredFn ??
    vi.fn().mockResolvedValue({
      data: {
        freshnessScore: 60,
        action: 'REVIEW_SOON',
        rationale: 'Source SRC1 changed recently.',
        changedSourceRefs: ['SRC1'],
        relevantSignalRefs: [],
        brokenSourceCount: 0,
        staleSourceCount: 0,
      },
      providerUsed: 'anthropic',
      modelUsed: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.002,
      validationAttempts: 1,
      rawResponseHash: 'h',
    });

  const createOrIncrementAlert = vi.fn().mockResolvedValue(undefined);
  const createRevisionRequest = options.createRevisionRequest ?? vi.fn().mockResolvedValue({ revisionRequestId: 'rev_1', status: 'PENDING_REVIEW', replayed: false });

  const service = new FreshnessReviewService({
    prisma: prisma as never,
    agentRuns: { beginRun, completeRun, failRun },
    completeStructuredFn: completeStructuredFn as never,
    contentOpsAlert: { createOrIncrementAlert } as never,
    revisionRequests: { createRevisionRequest } as never,
    now: () => NOW,
  });

  return {
    service,
    prisma,
    beginRun,
    completeRun,
    failRun,
    completeStructuredFn,
    createFreshnessReview,
    findFirstFreshnessReview,
    findManySignals,
    createOrIncrementAlert,
    createRevisionRequest,
  };
}

describe('determineRiskTier', () => {
  it('classifies Regulatory Updates category as HIGH_RISK', () => {
    expect(determineRiskTier({ category: 'Regulatory Updates' }, [])).toBe('HIGH_RISK');
  });
  it('classifies a post with an OFFICIAL source as HIGH_RISK regardless of category', () => {
    expect(determineRiskTier({ category: 'Compliance Guides' }, [{ sourceType: 'OFFICIAL' }])).toBe('HIGH_RISK');
  });
  it('classifies EVERGREEN_EXPLAINER-originated posts as EVERGREEN', () => {
    expect(determineRiskTier({ category: 'Compliance Guides' }, [], 'EVERGREEN_EXPLAINER')).toBe('EVERGREEN');
  });
  it('defaults to NORMAL otherwise', () => {
    expect(determineRiskTier({ category: 'Compliance Guides' }, [{ sourceType: 'THIRD_PARTY' }])).toBe('NORMAL');
  });
});

describe('cadenceDaysFor / computeNextReviewAt', () => {
  it('uses the correct cadence per tier', () => {
    expect(cadenceDaysFor('HIGH_RISK')).toBe(HIGH_RISK_CADENCE_DAYS);
    expect(cadenceDaysFor('NORMAL')).toBe(NORMAL_CADENCE_DAYS);
    expect(cadenceDaysFor('EVERGREEN')).toBe(EVERGREEN_CADENCE_DAYS);
  });

  it('computes nextReviewAt from lastReviewedAt when present', () => {
    const last = new Date('2026-01-01T00:00:00.000Z');
    const next = computeNextReviewAt(last, null, 'HIGH_RISK', NOW);
    expect(next.getTime()).toBe(last.getTime() + 30 * 24 * 60 * 60 * 1000);
  });

  it('falls back to publishedAt when lastReviewedAt is null', () => {
    const published = new Date('2026-01-01T00:00:00.000Z');
    const next = computeNextReviewAt(null, published, 'NORMAL', NOW);
    expect(next.getTime()).toBe(published.getTime() + 90 * 24 * 60 * 60 * 1000);
  });
});

describe('FreshnessReviewService.runFreshnessReview', () => {
  it('rejects when the post does not exist', async () => {
    const { service } = buildService({ post: null });
    await expect(service.runFreshnessReview({ blogPostId: 'missing', idempotencyKey: 'idem_1' })).rejects.toThrow(FreshnessReviewValidationError);
  });

  it('rejects when the post is not PUBLISHED', async () => {
    const post = makePost({ status: 'DRAFT' });
    const { service } = buildService({ post });
    await expect(service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' })).rejects.toThrow(FreshnessReviewValidationError);
  });

  it('fresh recent content: no deterministic signals, action is FRESH without an AI call', async () => {
    // publishedAt must be recent enough to not itself trip the source-staleness
    // threshold - this test isolates "no evidence at all", not staleness specifically.
    const recentSource = makePostSource({ publishedAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: PUBLISHED_LONG_AGO });
    const post = makePost({ sources: [recentSource] });
    const completeStructuredFn = vi.fn();
    const { service, createFreshnessReview } = buildService({ post, completeStructuredFn });

    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(completeStructuredFn).not.toHaveBeenCalled();
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') expect(result.action).toBe('FRESH');
    expect(createFreshnessReview.mock.calls[0][0].data.action).toBe('FRESH');
  });

  it('old but unchanged content remains FRESH - age alone never triggers a stale/revision action', async () => {
    const veryOld = new Date('2020-01-01T00:00:00.000Z');
    // The POST is old, but its source is NOT itself stale/changed - isolates
    // "post age alone" from the separate, legitimate source-staleness signal.
    const post = makePost({
      publishedAt: veryOld,
      sources: [makePostSource({ publishedAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: veryOld })],
    });
    const completeStructuredFn = vi.fn();
    const { service } = buildService({ post, completeStructuredFn });

    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(completeStructuredFn).not.toHaveBeenCalled();
    if (result.outcome === 'completed') expect(result.action).toBe('FRESH');
  });

  it('a new high-impact (critical/high severity) regulatory signal triggers an AI-assisted review', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const { service, completeStructuredFn } = buildService({
      post,
      newSignals: [{ id: 'sig_1', title: 'New CBK directive', severity: 'critical', jurisdiction: 'KE', createdAt: NOW }],
    });

    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(completeStructuredFn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('completed');
  });

  it('a broken source (from the active research pack) contributes to brokenSourceCount and triggers review', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const { service, completeStructuredFn, createFreshnessReview } = buildService({
      post,
      activePack: { id: 'pack_1', sources: [{ isAvailable: false }, { isAvailable: true }] },
    });

    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(completeStructuredFn).toHaveBeenCalledTimes(1);
    expect(createFreshnessReview.mock.calls[0][0].data.brokenSourceCount).toBe(1);
    expect(result.outcome).toBe('completed');
  });

  it('handles a post with no sources at all without crashing', async () => {
    const post = makePost({ sources: [] });
    const { service } = buildService({ post });
    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(result.outcome).toBe('completed');
  });

  it('a missing publication date contributes to staleSourceCount', async () => {
    const post = makePost({ sources: [makePostSource({ publishedAt: null })] });
    const { service, createFreshnessReview } = buildService({ post });
    await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(createFreshnessReview.mock.calls[0][0].data.staleSourceCount).toBe(1);
  });

  it('an unchanged duplicate review on the same day reuses the existing result without a new AI call', async () => {
    const post = makePost({
      sources: [makePostSource()],
      freshnessReviews: [
        makeFreshnessRow({
          id: 'existing_review',
          createdAt: NOW,
          contentHash: undefined, // set below to match the real computed hash
        }),
      ],
    });
    const { computeContentHash, computeFallbackSourceSetHash } = await import('./editorial-input-hash');
    const contentHash = computeContentHash(post.content);
    const sourceSetHash = computeFallbackSourceSetHash(post.sources.map((s) => ({ url: s.url, updatedAt: s.updatedAt })));
    post.freshnessReviews[0] = makeFreshnessRow({ id: 'existing_review', createdAt: NOW, contentHash, sourceSetHash });

    const completeStructuredFn = vi.fn();
    const { service, createFreshnessReview } = buildService({ post, completeStructuredFn });

    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_2' });
    expect(completeStructuredFn).not.toHaveBeenCalled();
    expect(createFreshnessReview).not.toHaveBeenCalled();
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.replayed).toBe(true);
      expect(result.freshnessReviewId).toBe('existing_review');
    }
  });

  it('a changed source-set hash (even same day) still triggers a new review, not a reuse', async () => {
    const post = makePost({
      sources: [makePostSource()],
      freshnessReviews: [makeFreshnessRow({ id: 'existing_review', createdAt: NOW, contentHash: 'stale', sourceSetHash: 'stale-source-hash' })],
    });
    const { service, createFreshnessReview } = buildService({ post });
    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_2' });
    expect(createFreshnessReview).toHaveBeenCalledTimes(1);
    if (result.outcome === 'completed') expect(result.replayed).toBe(false);
  });

  it('throws when the AI returns a non-FRESH action with no evidence pointers (guardrail)', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const completeStructuredFn = vi.fn().mockResolvedValue({
      data: {
        freshnessScore: 40,
        action: 'REVISION_REQUIRED',
        rationale: 'Something seems off.',
        changedSourceRefs: [],
        relevantSignalRefs: [],
        brokenSourceCount: 0,
        staleSourceCount: 0,
      },
      providerUsed: 'anthropic',
      modelUsed: 'm',
      validationAttempts: 1,
      rawResponseHash: 'h',
    });
    const { service, failRun } = buildService({
      post,
      completeStructuredFn,
      activePack: { id: 'pack_1', sources: [{ isAvailable: false }] },
    });

    await expect(service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' })).rejects.toThrow(FreshnessEvidenceGuardrailError);
    expect(failRun).toHaveBeenCalled();
  });

  it('throws when the AI cites evidence fields but its rationale text never mentions them (guardrail)', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const completeStructuredFn = vi.fn().mockResolvedValue({
      data: {
        freshnessScore: 40,
        action: 'REVIEW_SOON',
        rationale: 'This content needs a look.',
        changedSourceRefs: ['SRC1'],
        relevantSignalRefs: [],
        brokenSourceCount: 0,
        staleSourceCount: 0,
      },
      providerUsed: 'anthropic',
      modelUsed: 'm',
      validationAttempts: 1,
      rawResponseHash: 'h',
    });
    const { service } = buildService({ post, completeStructuredFn });
    await expect(service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' })).rejects.toThrow(FreshnessEvidenceGuardrailError);
  });

  it('propagates a malformed structured-output AI failure and fails the run', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const completeStructuredFn = vi.fn().mockRejectedValue(new AIStructuredOutputError('SCHEMA_VALIDATION_FAILED', 'invalid', {}));
    const { service, failRun } = buildService({ post, completeStructuredFn });
    await expect(service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' })).rejects.toThrow(AIStructuredOutputError);
    expect(failRun).toHaveBeenCalled();
  });

  it('returns budget_halted outcome without throwing when the AgentRun begins in a HALTED_BUDGET state', async () => {
    const post = makePost();
    const haltedRun = makeAgentRun({ status: 'HALTED_BUDGET' });
    const { service } = buildService({ post, beginRunResult: { started: true, duplicate: false, run: haltedRun } });
    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(result).toEqual({ outcome: 'budget_halted', agentRunId: haltedRun.id });
  });

  it('returns agents_disabled outcome when agents are globally disabled', async () => {
    const post = makePost();
    const { service } = buildService({ post, beginRunResult: { started: false, reason: 'agents_disabled' } });
    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(result).toEqual({ outcome: 'agents_disabled' });
  });

  it('creates a ContentOpsAlert only for URGENT_REVISION/ARCHIVE_RECOMMENDED, not for REVIEW_SOON', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const { service, createOrIncrementAlert } = buildService({ post }); // default mock returns REVIEW_SOON
    await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(createOrIncrementAlert).not.toHaveBeenCalled();
  });

  it('creates a ContentOpsAlert with compact metadata for URGENT_REVISION', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const completeStructuredFn = vi.fn().mockResolvedValue({
      data: {
        freshnessScore: 20,
        action: 'URGENT_REVISION',
        rationale: 'A broken source requires urgent attention.',
        changedSourceRefs: [],
        relevantSignalRefs: [],
        brokenSourceCount: 1,
        staleSourceCount: 0,
      },
      providerUsed: 'anthropic',
      modelUsed: 'm',
      validationAttempts: 1,
      rawResponseHash: 'h',
    });
    const { service, createOrIncrementAlert } = buildService({ post, completeStructuredFn, activePack: { id: 'p', sources: [{ isAvailable: false }] } });

    await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(createOrIncrementAlert).toHaveBeenCalledTimes(1);
    const alertInput = createOrIncrementAlert.mock.calls[0][0];
    expect(JSON.stringify(alertInput.metadata)).not.toContain('urgent attention');
  });

  it('creates a BlogRevisionRequest for REVISION_REQUIRED/URGENT_REVISION/ARCHIVE_RECOMMENDED actions', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const completeStructuredFn = vi.fn().mockResolvedValue({
      data: {
        freshnessScore: 30,
        action: 'REVISION_REQUIRED',
        rationale: 'Source SRC1 has changed materially.',
        changedSourceRefs: ['SRC1'],
        relevantSignalRefs: [],
        brokenSourceCount: 0,
        staleSourceCount: 0,
      },
      providerUsed: 'anthropic',
      modelUsed: 'm',
      validationAttempts: 1,
      rawResponseHash: 'h',
    });
    const { service, createRevisionRequest } = buildService({ post, completeStructuredFn });

    const result = await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(createRevisionRequest).toHaveBeenCalledTimes(1);
    if (result.outcome === 'completed') expect(result.revisionRequestId).toBe('rev_1');
  });

  it('does not create a BlogRevisionRequest for FRESH/REVIEW_SOON actions', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const { service, createRevisionRequest } = buildService({ post }); // default REVIEW_SOON
    await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect(createRevisionRequest).not.toHaveBeenCalled();
  });

  it('never calls any BlogPost update - freshness review never changes publication status or content', async () => {
    const post = makePost({ sources: [makePostSource()] });
    const { service, prisma } = buildService({ post });
    await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    expect('update' in prisma.blogPost).toBe(false);
  });

  it('never logs full article content', async () => {
    const post = makePost({ content: 'CONFIDENTIAL_FRESHNESS_MARKER', sources: [makePostSource()] });
    const { logger } = await import('@/utils/logger');
    const infoSpy = vi.spyOn(logger, 'info');
    const { service } = buildService({ post });
    await service.runFreshnessReview({ blogPostId: post.id, idempotencyKey: 'idem_1' });
    const payloads = infoSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    for (const payload of payloads) expect(payload).not.toContain('CONFIDENTIAL_FRESHNESS_MARKER');
  });
});
