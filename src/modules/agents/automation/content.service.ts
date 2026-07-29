import { TRPCError } from '@trpc/server';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { automationApprovalService as defaultAutomationApprovalService, type AutomationApprovalService } from './approval.service';
import { parseWindowDays, parseJurisdictionFilter } from './duration';
import { runPublishReadinessShadowCheck } from '@/server/utils/publish-readiness';
import { publicBlogOrderBy, publicBlogWhere } from '@/modules/blog/public-blog-visibility';
import { computeBlogPublicationSnapshot } from '@/modules/blog-automation/publication-snapshot';

const APPROVED_CONTENT_WINDOW_DAYS = 7;
const HIGH_IMPACT_SEVERITIES = ['critical', 'high'] as const;
const HIGH_IMPACT_MAX_ITEMS = 50;
const CANDIDATE_WEBHOOK_TIMEOUT_MS = 5000;

// Real severity -> score mapping (lowercase values confirmed against
// signal-classifier.service.ts's SEVERITIES union) - RegulatorySignal has no
// numeric score field, so this is a documented derived value, not a stored one.
const SEVERITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
  informational: 10,
};

type ContentPrisma = Pick<typeof defaultPrisma, 'blogPost' | 'blogSourceItem' | 'regulatorySignal' | 'contentOpsAlert'>;

export interface PublishContentInput {
  approvalId: string;
}

export interface QueueContentCandidateInput {
  sourceItemId: string;
  title: string;
  score: number;
  jurisdiction: string;
}

export interface GetRecentHighImpactRegulatoryItemsInput {
  window: string;
  jurisdictions: string;
}

export interface GetApprovedContentThisWeekInput {
  jurisdictions: string;
}

export interface RegulatoryItem {
  id: string;
  title: string;
  score: number;
  jurisdiction: string;
  summary?: string;
  sourceItemId?: string;
}

export interface ApprovedContentItem {
  id: string;
  title: string;
  jurisdiction: string;
  publishedAt: string;
  excerpt?: string;
}

type FetchLike = typeof fetch;

export interface AutomationContentServiceDependencies {
  prisma?: ContentPrisma;
  approvalService?: AutomationApprovalService;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export class AutomationContentService {
  private readonly prisma: ContentPrisma;
  private readonly approvalService: AutomationApprovalService;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(dependencies: AutomationContentServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as ContentPrisma);
    this.approvalService = dependencies.approvalService ?? defaultAutomationApprovalService;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * approval.metadata carries { blogPostId } (createApproval's own caller sets
   * this) - publishContent itself only receives {approvalId} per the n8n
   * wire contract, so the BlogPost link has to travel through metadata, the
   * same pattern used for every other "approval gates a pre-existing backend
   * row" case in this module.
   *
   * Gap 3 stale-overwrite fix (W-CONTENT-02 Phase B, Batch 3): publishContent
   * used to accept a caller-supplied `content` string and write it verbatim,
   * which could silently discard a human edit made in the dashboard between
   * draft-generation and the approval decision (the two events can be
   * separated by an arbitrary amount of time, and n8n's own copy of the
   * content - if it ever tried to carry one across executions - has no way
   * to know about a later edit). publishContent now always reads and keeps
   * the post's own live `content` column; publishing only flips
   * status/publishedAt/lastReviewedAt, never mutates the body.
   *
   * Runs the exact same publish gates as blog.router.ts's
   * adminSetStatus('PUBLISHED') (title/slug/excerpt/category present, >=1
   * source, category-specific source-type rule, verification not BLOCKED/stale)
   * - duplicated here rather than calling into blog.router.ts directly, since
   * that logic lives inline in the router, not a separately exported service.
   */
  async publishContent(input: PublishContentInput): Promise<{ blogPostId: string; publishedAt: string }> {
    const approval = await this.approvalService.getApproval({ approvalId: input.approvalId });
    if (approval.status !== 'approved') {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Approval ${input.approvalId} is not approved (status: ${approval.status}).` });
    }

    const blogPostId = await this.approvalService.requireMetadataField(input.approvalId, 'blogPostId');
    const approvalSnapshot = await this.approvalService.requireBlogPublicationSnapshot(input.approvalId);
    if (approvalSnapshot.expiresAt && approvalSnapshot.expiresAt < this.now()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `APPROVAL_EXPIRED: approval ${input.approvalId} expired at ${approvalSnapshot.expiresAt.toISOString()}.` });
    }
    if (approvalSnapshot.snapshot.blogPostId !== blogPostId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'APPROVAL_POST_MISMATCH: approval snapshot does not match approval metadata blogPostId.' });
    }

    const post = await this.prisma.blogPost.findUnique({
      where: { id: blogPostId },
      include: {
        sources: true,
        verificationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
        draftGenerationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!post || post.deletedAt) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `BlogPost ${blogPostId} not found.` });
    }
    if (post.status === 'ARCHIVED' || post.archivedAt) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `POST_ARCHIVED: BlogPost ${blogPostId} is archived and cannot be published.` });
    }

    const currentSnapshot = computeBlogPublicationSnapshot(post, this.now());
    if (currentSnapshot.contentHash !== approvalSnapshot.snapshot.contentHash) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'APPROVED_CONTENT_CHANGED: BlogPost markdown content changed after approval.' });
    }
    if (currentSnapshot.sourceSetHash !== approvalSnapshot.snapshot.sourceSetHash) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'APPROVED_SOURCES_CHANGED: BlogPost source set changed after approval.' });
    }
    if (currentSnapshot.draftGenerationRunId !== approvalSnapshot.snapshot.draftGenerationRunId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'APPROVED_DRAFT_CHANGED: BlogPost draft generation run changed after approval.' });
    }
    if (currentSnapshot.verificationRunId !== approvalSnapshot.snapshot.verificationRunId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'VERIFICATION_REQUIRED: BlogPost verification run changed after approval.' });
    }
    if (currentSnapshot.publicationPayloadHash !== approvalSnapshot.snapshot.publicationPayloadHash) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'APPROVED_PUBLICATION_PAYLOAD_CHANGED: BlogPost title, slug, excerpt, category, jurisdiction, tags or related regulations changed after approval.' });
    }

    // Pack 1 Stage C5: the shared evaluator runs alongside these existing
    // gate checks in burn-in mode - it never changes the outcome below unless
    // BLOG_PUBLISH_READINESS_MODE=enforce is explicitly set (not the
    // default). The inline checks are UNCHANGED and remain fully
    // authoritative for the default (shadow) mode. See
    // docs/editorial-intelligence/publish-readiness-burn-in-runbook.md.
    let legacyError: unknown = null;
    try {
      if (!post.title || !post.slug || !post.excerpt || !post.category) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing required fields for publishing (title/slug/excerpt/category).' });
      }
      if (post.sources.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'At least one source is required for publishing.' });
      }
      if (['Regulatory Updates', 'Enforcement & Penalties'].includes(post.category)) {
        if (!post.sources.some((s) => s.sourceType === 'OFFICIAL')) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `${post.category} requires an OFFICIAL source.` });
        }
      } else if (post.category === 'International Standards') {
        if (!post.sources.some((s) => ['OFFICIAL', 'INTERNATIONAL_STANDARD'].includes(s.sourceType))) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'International Standards requires an OFFICIAL or INTERNATIONAL_STANDARD source.' });
        }
      }

      const latestVerification = post.verificationRuns[0];
      const latestAiDraft = post.draftGenerationRuns[0];
      if (latestVerification?.status === 'BLOCKED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot publish: Source and Claim Verification is BLOCKED.' });
      }
      if (latestAiDraft) {
        const verificationTime = latestVerification ? (latestVerification.completedAt ?? latestVerification.createdAt) : null;
        if (!verificationTime || latestAiDraft.createdAt > verificationTime) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot publish: an AI draft was generated but no verification has been run since then.' });
        }
      }
    } catch (err) {
      legacyError = err;
    }

    const shadowCheck = await runPublishReadinessShadowCheck(this.prisma, blogPostId, legacyError === null, 'publishContent');

    if (legacyError) throw legacyError;

    if (shadowCheck.shouldBlock) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Cannot publish: readiness evaluator blockers: ${shadowCheck.result?.blockers.map((b) => b.code).join(', ')}`,
      });
    }

    const publishedAt = post.publishedAt ?? this.now();
    await this.prisma.blogPost.update({
      where: { id: blogPostId },
      data: {
        status: 'PUBLISHED',
        publishedAt,
        lastReviewedAt: post.lastReviewedAt ?? this.now(),
      },
    });

    logger.info({ type: 'automation_content_published', approvalId: input.approvalId, blogPostId });
    return { blogPostId, publishedAt: publishedAt.toISOString() };
  }

  /**
   * No new persistence layer added for the "candidate queue" itself - the
   * brief describes this procedure's job as fanning the candidate out to n8n,
   * and no read-back procedure for queued candidates exists anywhere else in
   * the brief, so a DB table here would have no consumer. Logged (Pino,
   * type field) and forwarded; if a durable queue is wanted later, that's a
   * new requirement, not an oversight in this pass.
   */
  async queueContentCandidate(input: QueueContentCandidateInput): Promise<{ forwarded: boolean }> {
    const sourceItem = await this.prisma.blogSourceItem.findUnique({
      where: { id: input.sourceItemId },
      select: { summary: true },
    });

    const payload = {
      sourceItemId: input.sourceItemId,
      title: input.title,
      summary: sourceItem?.summary ?? undefined,
      score: input.score,
      jurisdiction: input.jurisdiction,
    };

    logger.info({ type: 'automation_content_candidate_queued', sourceItemId: input.sourceItemId, jurisdiction: input.jurisdiction, score: input.score });

    const timestampSeconds = Math.floor(this.now().getTime() / 1000);
    const { header, secret } = appConfig.agents.automation.webhookIngress;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CANDIDATE_WEBHOOK_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl('https://agents.sheriabot.com/webhook/sheriabot-content-candidate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sheriabot-timestamp': String(timestampSeconds),
          [header]: secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ type: 'automation_content_candidate_forward_failed', sourceItemId: input.sourceItemId, status: response.status });
        return { forwarded: false };
      }
      return { forwarded: true };
    } catch (error: unknown) {
      logger.warn({ type: 'automation_content_candidate_forward_failed', sourceItemId: input.sourceItemId, error: error instanceof Error ? error.message : String(error) });
      return { forwarded: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getRecentHighImpactRegulatoryItems(input: GetRecentHighImpactRegulatoryItemsInput): Promise<{ items: RegulatoryItem[] }> {
    const windowDays = parseWindowDays(input.window);
    const jurisdictionFilter = parseJurisdictionFilter(input.jurisdictions);
    const periodStart = new Date(this.now().getTime() - windowDays * 24 * 60 * 60 * 1000);

    const signals = await this.prisma.regulatorySignal.findMany({
      where: {
        createdAt: { gte: periodStart },
        severity: { in: [...HIGH_IMPACT_SEVERITIES] },
        ...(jurisdictionFilter ? { jurisdiction: { in: jurisdictionFilter } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: HIGH_IMPACT_MAX_ITEMS,
      select: { id: true, title: true, severity: true, jurisdiction: true, summary: true, sourceItemId: true },
    });

    return {
      items: signals.map((signal) => ({
        id: signal.id,
        title: signal.title,
        score: SEVERITY_SCORE[signal.severity] ?? 0,
        jurisdiction: signal.jurisdiction,
        summary: signal.summary ?? undefined,
        sourceItemId: signal.sourceItemId ?? undefined,
      })),
    };
  }

  /**
   * "This week" implemented as a rolling 7-day window (matches Phase 1's
   * BASELINE_WINDOW_DAYS convention), not a calendar ISO week - simpler and
   * avoids a Monday-boundary edge case for a shape the brief left otherwise
   * unspecified (`output: { items: [...] }` gave no field list - this shape
   * is a best-effort guess, flagged for review).
   */
  async getApprovedContentThisWeek(input: GetApprovedContentThisWeekInput): Promise<{ items: ApprovedContentItem[] }> {
    const jurisdictionFilter = parseJurisdictionFilter(input.jurisdictions);
    const periodStart = new Date(this.now().getTime() - APPROVED_CONTENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const posts = await this.prisma.blogPost.findMany({
      where: {
        AND: [
          publicBlogWhere(this.now()),
          { publishedAt: { gte: periodStart } },
        ],
        ...(jurisdictionFilter ? { jurisdiction: { in: jurisdictionFilter } } : {}),
      },
      orderBy: publicBlogOrderBy(),
      select: { id: true, title: true, jurisdiction: true, publishedAt: true, excerpt: true },
    });

    return {
      items: posts
        .filter((post): post is typeof post & { publishedAt: Date } => post.publishedAt !== null)
        .map((post) => ({
          id: post.id,
          title: post.title,
          jurisdiction: post.jurisdiction,
          publishedAt: post.publishedAt.toISOString(),
          // publishContent/adminSetStatus both refuse to set status: PUBLISHED unless
          // excerpt is already non-empty, so a null here on a PUBLISHED row indicates an
          // upstream data-integrity anomaly, not a normal case to paper over with an
          // invented content-slice fallback.
          excerpt: post.excerpt ?? undefined,
        })),
    };
  }

}

export const automationContentService = new AutomationContentService();
