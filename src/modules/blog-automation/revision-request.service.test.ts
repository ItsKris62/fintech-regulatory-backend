import { describe, it, expect, vi } from 'vitest';
import {
  RevisionRequestService,
  RevisionRequestValidationError,
  deriveFreshnessOriginatedIdempotencyKey,
} from './revision-request.service';

const NOW = new Date('2026-07-28T00:00:00.000Z');

function makePost(overrides: Record<string, unknown> = {}) {
  return { id: 'post_1', deletedAt: null, ...overrides };
}

function makeFreshnessReview(overrides: Record<string, unknown> = {}) {
  return { id: 'fresh_1', blogPostId: 'post_1', ...overrides };
}

function makeRevisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev_1',
    blogPostId: 'post_1',
    freshnessReviewId: null,
    idempotencyKey: 'key_1',
    reason: 'Reason',
    priority: 'MEDIUM',
    recommendedChanges: null,
    evidence: null,
    status: 'PENDING_REVIEW',
    requestedById: null,
    assignedToId: null,
    approvedById: null,
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

interface BuildOptions {
  post?: ReturnType<typeof makePost> | null;
  freshnessReview?: ReturnType<typeof makeFreshnessReview> | null;
  existingByKey?: Record<string, ReturnType<typeof makeRevisionRow>>;
  createThrowsUniqueConflict?: boolean;
}

function buildService(options: BuildOptions = {}) {
  const findUniquePost = vi.fn().mockResolvedValue(options.post === undefined ? makePost() : options.post);
  const findUniqueFreshnessReview = vi.fn().mockResolvedValue(options.freshnessReview === undefined ? null : options.freshnessReview);

  const createdRows: Record<string, ReturnType<typeof makeRevisionRow>> = { ...(options.existingByKey ?? {}) };
  let nextId = 1;
  const create = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    if (options.createThrowsUniqueConflict || (data.idempotencyKey && createdRows[data.idempotencyKey as string])) {
      const error = new Error('Unique constraint failed') as Error & { code: string };
      error.code = 'P2002';
      throw error;
    }
    const row = makeRevisionRow({ id: `rev_${nextId++}`, ...data });
    createdRows[data.idempotencyKey as string] = row;
    return row;
  });
  const findUniqueRevision = vi.fn().mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) => {
    return createdRows[where.idempotencyKey] ?? null;
  });

  const prisma = {
    blogPost: { findUnique: findUniquePost },
    blogFreshnessReview: { findUnique: findUniqueFreshnessReview },
    blogRevisionRequest: { create, findUnique: findUniqueRevision },
  };

  const service = new RevisionRequestService({ prisma: prisma as never });
  return { service, prisma, create, findUniqueRevision };
}

describe('RevisionRequestService.createRevisionRequest', () => {
  it('rejects when blogPostId does not exist', async () => {
    const { service } = buildService({ post: null });
    await expect(
      service.createRevisionRequest({ blogPostId: 'missing', reason: 'x', priority: 'MEDIUM', idempotencyKey: 'k1' }),
    ).rejects.toThrow(RevisionRequestValidationError);
  });

  it('rejects when freshnessReviewId is given but does not exist', async () => {
    const { service } = buildService({ freshnessReview: null });
    await expect(
      service.createRevisionRequest({ blogPostId: 'post_1', freshnessReviewId: 'missing', reason: 'x', priority: 'MEDIUM', idempotencyKey: 'k1' }),
    ).rejects.toThrow(RevisionRequestValidationError);
  });

  it('creates a revision request for REVISION_REQUIRED-equivalent input with MEDIUM priority', async () => {
    const { service } = buildService();
    const result = await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'Source superseded', priority: 'MEDIUM', idempotencyKey: 'k1' });
    expect(result.status).toBe('PENDING_REVIEW');
    expect(result.replayed).toBe(false);
  });

  it('creates an URGENT priority revision request', async () => {
    const { service, create } = buildService();
    await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'Urgent regulatory change', priority: 'URGENT', idempotencyKey: 'k1' });
    expect(create.mock.calls[0][0].data.priority).toBe('URGENT');
  });

  it('always starts PENDING_REVIEW regardless of priority (guardrail: nothing about input can cause an auto-approved state)', async () => {
    for (const priority of ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const) {
      const { service } = buildService();
      const result = await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'x', priority, idempotencyKey: `k_${priority}` });
      expect(result.status).toBe('PENDING_REVIEW');
    }
  });

  it('replays a duplicate idempotencyKey rather than creating a second row', async () => {
    const existing = makeRevisionRow({ idempotencyKey: 'dup_key', id: 'rev_existing' });
    const { service } = buildService({ existingByKey: { dup_key: existing } });
    const result = await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'x', priority: 'MEDIUM', idempotencyKey: 'dup_key' });
    expect(result.replayed).toBe(true);
    expect(result.revisionRequestId).toBe('rev_existing');
  });

  it('two independent manual revision requests for the SAME post with two different caller-supplied keys both succeed as two separate rows (regression test for the corrected manual-collapse defect)', async () => {
    const { service, create } = buildService();
    const first = await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'First issue', priority: 'MEDIUM', idempotencyKey: 'manual_key_1' });
    const second = await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'Second, unrelated issue', priority: 'HIGH', idempotencyKey: 'manual_key_2' });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(first.revisionRequestId).not.toBe(second.revisionRequestId);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('creation from a freshness review links freshnessReviewId correctly', async () => {
    const review = makeFreshnessReview();
    const { service, create } = buildService({ freshnessReview: review });
    await service.createRevisionRequest({
      blogPostId: 'post_1',
      freshnessReviewId: review.id,
      reason: 'Freshness-triggered',
      priority: 'HIGH',
      idempotencyKey: deriveFreshnessOriginatedIdempotencyKey('post_1', review.id),
    });
    expect(create.mock.calls[0][0].data.freshnessReviewId).toBe(review.id);
  });

  it('sets requestedById only when explicitly provided (human-originated)', async () => {
    const { service, create } = buildService();
    await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'x', priority: 'LOW', idempotencyKey: 'k1', requestedById: 'user_1' });
    expect(create.mock.calls[0][0].data.requestedById).toBe('user_1');
  });

  it('never touches BlogPost - no blogPost.update dependency exists in this service at all', async () => {
    const { service, prisma } = buildService();
    await service.createRevisionRequest({ blogPostId: 'post_1', reason: 'x', priority: 'LOW', idempotencyKey: 'k1' });
    expect('update' in prisma.blogPost).toBe(false);
  });
});

describe('deriveFreshnessOriginatedIdempotencyKey', () => {
  it('produces a stable, deterministic key for the same inputs', () => {
    expect(deriveFreshnessOriginatedIdempotencyKey('post_1', 'fresh_1')).toBe(deriveFreshnessOriginatedIdempotencyKey('post_1', 'fresh_1'));
  });

  it('differs for different freshnessReviewIds (never a shared literal)', () => {
    expect(deriveFreshnessOriginatedIdempotencyKey('post_1', 'fresh_1')).not.toBe(deriveFreshnessOriginatedIdempotencyKey('post_1', 'fresh_2'));
  });
});
