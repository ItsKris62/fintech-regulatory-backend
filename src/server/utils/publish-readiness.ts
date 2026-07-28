import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { calculateBlogStaleness } from './blog-staleness';

/**
 * Shared, read-only publication-readiness evaluator (Pack 1 Stage C5). Never
 * mutates BlogPost or any other row. Consolidates the three existing inline
 * gate implementations (blog.router.ts::adminSetStatus,
 * content.service.ts::publishContent, blog-automation.router.ts::
 * adminGetLatestBlogVerification's own staleness computation) without yet
 * replacing any of them - see docs/editorial-intelligence/
 * publish-readiness-burn-in-runbook.md for the shadow-mode rollout this feeds.
 */

export interface PublishReadinessFinding {
  code: string;
  message: string;
}

export interface PublishReadinessResult {
  ready: boolean;
  blockers: PublishReadinessFinding[];
  warnings: PublishReadinessFinding[];
  evaluatedAt: Date;
  latestVerificationRunId?: string;
  isStale: boolean;
  isAiStale: boolean;
}

const OFFICIAL_ONLY_CATEGORIES = ['Regulatory Updates', 'Enforcement & Penalties'];
const OFFICIAL_OR_INTERNATIONAL_CATEGORIES = ['International Standards'];

// Derived from the actual instantiated singleton's type (matching this
// codebase's DI convention elsewhere, e.g. content.service.ts's ContentPrisma)
// rather than the raw `PrismaClient` import - the singleton is created via
// `base.$extends({...})` (src/lib/prisma/client.ts), which produces a
// structurally different "ExtendedPrismaClient" type that a plain
// `Pick<PrismaClient, ...>` is not assignable from.
export type ReadinessPrisma = Pick<typeof defaultPrisma, 'blogPost' | 'contentOpsAlert'>;

export async function evaluateBlogPublishReadiness(
  prisma: ReadinessPrisma,
  blogPostId: string,
): Promise<PublishReadinessResult> {
  const evaluatedAt = new Date();
  const blockers: PublishReadinessFinding[] = [];
  const warnings: PublishReadinessFinding[] = [];

  const post = await prisma.blogPost.findUnique({
    where: { id: blogPostId },
    include: {
      sources: true,
      verificationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
      draftGenerationRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
      automationSuggestion: { select: { requiresHumanReview: true, approvedById: true } },
    },
  });

  if (!post || post.deletedAt) {
    return {
      ready: false,
      blockers: [{ code: 'POST_NOT_FOUND', message: 'BlogPost not found or deleted.' }],
      warnings: [],
      evaluatedAt,
      isStale: false,
      isAiStale: false,
    };
  }

  if (!post.title) blockers.push({ code: 'MISSING_TITLE', message: 'Title is missing.' });
  if (!post.slug) blockers.push({ code: 'MISSING_SLUG', message: 'Slug is missing.' });
  if (!post.excerpt) blockers.push({ code: 'MISSING_EXCERPT', message: 'Excerpt is missing.' });
  if (!post.category) blockers.push({ code: 'MISSING_CATEGORY', message: 'Category is missing.' });
  if (!post.content || post.content.trim().length === 0) {
    blockers.push({ code: 'MISSING_CONTENT', message: 'Content is empty or missing.' });
  }

  if (post.sources.length === 0) {
    blockers.push({ code: 'NO_SOURCES', message: 'At least one source is required.' });
  }

  const hasOfficial = post.sources.some((s) => s.sourceType === 'OFFICIAL');
  const hasOfficialOrIntl = post.sources.some((s) => s.sourceType === 'OFFICIAL' || s.sourceType === 'INTERNATIONAL_STANDARD');
  if (OFFICIAL_ONLY_CATEGORIES.includes(post.category) && !hasOfficial) {
    blockers.push({ code: 'MISSING_REQUIRED_OFFICIAL_SOURCE', message: `${post.category} requires an OFFICIAL source.` });
  } else if (OFFICIAL_OR_INTERNATIONAL_CATEGORIES.includes(post.category) && !hasOfficialOrIntl) {
    blockers.push({ code: 'MISSING_REQUIRED_OFFICIAL_SOURCE', message: `${post.category} requires an OFFICIAL or INTERNATIONAL_STANDARD source.` });
  }

  const latestVerification = post.verificationRuns[0];
  if (latestVerification?.status === 'BLOCKED') {
    blockers.push({ code: 'VERIFICATION_BLOCKED', message: 'Latest verification run is BLOCKED.' });
  }

  // Reuses the existing, tested staleness definition - never a fifth inline
  // re-derivation. isAiStale here is already applied-draft-only (see
  // calculateBlogStaleness), which is the corrected definition from
  // Foundation D, stricter than both existing inline gates' "any draft run"
  // check.
  const { isStale, isAiStale } = calculateBlogStaleness(post);

  const latestAiDraft = post.draftGenerationRuns[0];
  if (latestAiDraft?.appliedToPost && latestAiDraft.appliedAt) {
    const verificationTime = latestVerification ? (latestVerification.completedAt ?? latestVerification.createdAt) : null;
    if (!verificationTime || latestAiDraft.appliedAt > verificationTime) {
      blockers.push({ code: 'AI_DRAFT_NEWER_THAN_VERIFICATION', message: 'An applied AI draft postdates the latest verification.' });
    }
  }

  if (isStale) {
    warnings.push({ code: 'POST_OR_SOURCE_UPDATED_SINCE_VERIFICATION', message: 'The post or one of its sources was updated after the latest verification.' });
  }

  if (post.automationSuggestion?.requiresHumanReview && !post.automationSuggestion.approvedById) {
    blockers.push({ code: 'HUMAN_REVIEW_REQUIRED', message: 'The linked suggestion requires human review and has not yet been approved.' });
  }

  const openAlerts = await prisma.contentOpsAlert.findMany({
    where: { entityType: 'BlogPost', entityId: blogPostId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    select: { id: true, metadata: true },
  });
  const blockingAlert = openAlerts.find(
    (alert) => alert.metadata && typeof alert.metadata === 'object' && !Array.isArray(alert.metadata) && (alert.metadata as Record<string, unknown>).blocksPublication === true,
  );
  if (blockingAlert) {
    blockers.push({ code: 'BLOCKING_CONTENT_OPS_ALERT', message: `Open ContentOpsAlert ${blockingAlert.id} is explicitly marked as blocking publication.` });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    evaluatedAt,
    latestVerificationRunId: latestVerification?.id,
    isStale,
    isAiStale,
  };
}

export interface PublishReadinessShadowCheckResult {
  mode: 'off' | 'shadow' | 'enforce';
  evaluated: boolean;
  result?: PublishReadinessResult;
  divergedFromLegacy?: boolean;
  /** Only ever true when mode === 'enforce' AND the evaluator found blockers - see the burn-in runbook for the cutover criteria before this is acted on anywhere. */
  shouldBlock: boolean;
}

/**
 * Runs the shared evaluator alongside an existing inline gate's own decision,
 * for burn-in comparison. Never throws - a bug in the new evaluator must
 * never break an existing publish path. Logs only BlogPost ID and finding
 * codes, never article content.
 */
export async function runPublishReadinessShadowCheck(
  prisma: ReadinessPrisma,
  blogPostId: string,
  legacyReady: boolean,
  callSite: string,
): Promise<PublishReadinessShadowCheckResult> {
  const mode = appConfig.editorial.publishReadinessMode;

  if (mode === 'off') {
    return { mode, evaluated: false, shouldBlock: false };
  }

  try {
    const result = await evaluateBlogPublishReadiness(prisma, blogPostId);
    const diverged = result.ready !== legacyReady;

    if (diverged) {
      logger.warn({
        type: 'blog_publish_readiness_divergence',
        blogPostId,
        callSite,
        mode,
        legacyReady,
        newReady: result.ready,
        blockerCodes: result.blockers.map((b) => b.code),
        warningCodes: result.warnings.map((w) => w.code),
      });
    } else {
      logger.info({
        type: 'blog_publish_readiness_shadow_check',
        blogPostId,
        callSite,
        mode,
        ready: result.ready,
      });
    }

    return {
      mode,
      evaluated: true,
      result,
      divergedFromLegacy: diverged,
      shouldBlock: mode === 'enforce' && !result.ready,
    };
  } catch (error: unknown) {
    logger.error({
      type: 'blog_publish_readiness_shadow_check_failed',
      blogPostId,
      callSite,
      mode,
      error: error instanceof Error ? error.message : String(error),
    });
    return { mode, evaluated: false, shouldBlock: false };
  }
}
