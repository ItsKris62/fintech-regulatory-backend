import type { BlogRevisionPriority, BlogRevisionRequest, BlogRevisionStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

/**
 * Phase D Part 3 - durable editorial revision tasks. Pure persistence, no AI
 * call, no AgentRun. See docs/editorial-intelligence/freshness-and-revision-policy.md.
 *
 * Idempotency is always caller-supplied - never a server-synthesized key
 * (the original design's `<blogPostId>:manual` fallback silently collapsed
 * every manual revision request for a post into one shared bucket; corrected
 * per phase-b-data-model.md §5). A duplicate insert is handled through the
 * `idempotencyKey` unique constraint (insert-then-catch-P2002), the same
 * pattern AutomationApprovalService.createApproval already uses.
 */

export class RevisionRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionRequestValidationError';
  }
}

export interface CreateRevisionRequestInput {
  blogPostId: string;
  freshnessReviewId?: string;
  reason: string;
  priority: BlogRevisionPriority;
  recommendedChanges?: Prisma.InputJsonValue;
  evidence?: Prisma.InputJsonValue;
  /** Required, caller-supplied. Never synthesized here. */
  idempotencyKey: string;
  /** Set only when a human filed this directly; absent for system/freshness-originated requests. */
  requestedById?: string;
}

export interface CreateRevisionRequestResult {
  revisionRequestId: string;
  status: BlogRevisionStatus;
  replayed: boolean;
}

export type RevisionRequestPrisma = {
  blogPost: Pick<typeof defaultPrisma.blogPost, 'findUnique'>;
  blogFreshnessReview: Pick<typeof defaultPrisma.blogFreshnessReview, 'findUnique'>;
  blogRevisionRequest: Pick<typeof defaultPrisma.blogRevisionRequest, 'create' | 'findUnique'>;
};

export interface RevisionRequestServiceDependencies {
  prisma?: RevisionRequestPrisma;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
}

/** Derives the internal, deterministic key runFreshnessReview uses - safe because freshnessReviewId is always a real, unique id in this path. */
export function deriveFreshnessOriginatedIdempotencyKey(blogPostId: string, freshnessReviewId: string): string {
  return `W-CONTENT-07:revision:${blogPostId}:${freshnessReviewId}:v1`;
}

export class RevisionRequestService {
  private readonly prisma: RevisionRequestPrisma;

  constructor(dependencies: RevisionRequestServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as RevisionRequestPrisma);
  }

  async createRevisionRequest(input: CreateRevisionRequestInput): Promise<CreateRevisionRequestResult> {
    const post = await this.prisma.blogPost.findUnique({ where: { id: input.blogPostId } });
    if (!post || post.deletedAt) {
      throw new RevisionRequestValidationError(`blogPostId not found: ${input.blogPostId}`);
    }
    if (input.freshnessReviewId) {
      const review = await this.prisma.blogFreshnessReview.findUnique({ where: { id: input.freshnessReviewId } });
      if (!review) throw new RevisionRequestValidationError(`freshnessReviewId not found: ${input.freshnessReviewId}`);
    }

    try {
      const created = await this.prisma.blogRevisionRequest.create({
        data: {
          blogPostId: input.blogPostId,
          freshnessReviewId: input.freshnessReviewId,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
          priority: input.priority,
          recommendedChanges: input.recommendedChanges,
          evidence: input.evidence,
          status: 'PENDING_REVIEW',
          requestedById: input.requestedById,
        },
      });
      logger.info({ type: 'revision_recommended', blogPostId: input.blogPostId, revisionRequestId: created.id, priority: created.priority });
      return { revisionRequestId: created.id, status: created.status, replayed: false };
    } catch (error: unknown) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.prisma.blogRevisionRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!existing) throw error;
      logger.info({ type: 'revision_recommended_replayed', blogPostId: input.blogPostId, revisionRequestId: existing.id });
      return { revisionRequestId: existing.id, status: existing.status, replayed: true };
    }
  }
}

export const revisionRequestService = new RevisionRequestService();

export type { BlogRevisionRequest };
