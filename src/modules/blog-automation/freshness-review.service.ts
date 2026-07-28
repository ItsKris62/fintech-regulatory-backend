import {
  BlogFreshnessAction,
  BlogFreshnessRiskTier,
  type BlogPost,
  type BlogPostSource,
  type BlogFreshnessReview,
  type BlogArticleSuggestion,
} from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { aiConfig } from '@/config/ai.config';
import { logger } from '@/utils/logger';
import {
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { completeStructured as defaultCompleteStructured } from '@/lib/ai/structured/completeStructured';
import type { CompleteStructuredDependencies } from '@/lib/ai/structured/completeStructured';
import {
  contentOpsAlertService as defaultContentOpsAlertService,
  type ContentOpsAlertService,
} from '@/modules/agents/automation/content-ops-alert.service';
import { revisionRequestService as defaultRevisionRequestService, deriveFreshnessOriginatedIdempotencyKey, type RevisionRequestService } from './revision-request.service';
import { computeContentHash, computeFallbackSourceSetHash } from './editorial-input-hash';
import {
  FRESHNESS_REVIEW_PROMPT_VERSION,
  FreshnessAssessmentSchema,
  buildFreshnessSystemPrompt,
  buildFreshnessUserPrompt,
  type DeterministicFreshnessSignals,
} from './freshness-review-prompt';

/**
 * Phase D Part 2 - proactive freshness review for published content. See
 * docs/editorial-intelligence/freshness-and-revision-policy.md for the full
 * cadence/evidence-guardrail/idempotency policy this file implements.
 *
 * Simplification disclosed here and in the policy doc: "new linked
 * RegulatorySignal" detection uses jurisdiction-string matching
 * (BlogPost.jurisdiction vs RegulatorySignal.jurisdiction, normalized)
 * rather than an exact FK-chain match, since BlogPost carries no direct FK to
 * BlogSourceItem/RegulatorySignal. This uses only already-stored data (no new
 * fetch), consistent with the "no new web-fetch" rule, but is a coarser
 * signal than an exact chain match would be - see the policy doc.
 */

export const FRESHNESS_REVIEW_AGENT_TYPE = 'freshness-review';

export const HIGH_RISK_CADENCE_DAYS = 30;
export const NORMAL_CADENCE_DAYS = 90;
export const EVERGREEN_CADENCE_DAYS = 180;
export const SOURCE_STALENESS_THRESHOLD_DAYS = 730;

const HIGH_RISK_CATEGORIES: readonly string[] = ['Regulatory Updates', 'Enforcement & Penalties'];
const QUALIFYING_SIGNAL_SEVERITIES: string[] = ['critical', 'high'];

/** Mirrors relevance-scoring.service.ts's countryMap (KE/MW/RW/NG/REGIONAL/GLOBAL -> label) - duplicated locally rather than exported from that unrelated, already-shipped file for this one extra consumer. */
const JURISDICTION_CODE_TO_LABEL: Record<string, string> = {
  KE: 'Kenya',
  MW: 'Malawi',
  RW: 'Rwanda',
  NG: 'Nigeria',
  REGIONAL: 'Africa',
  GLOBAL: 'Global',
};

export function determineRiskTier(
  post: Pick<BlogPost, 'category'>,
  sources: readonly Pick<BlogPostSource, 'sourceType'>[],
  suggestionArticleType?: string | null,
): BlogFreshnessRiskTier {
  if (HIGH_RISK_CATEGORIES.includes(post.category) || sources.some((s) => s.sourceType === 'OFFICIAL')) {
    return BlogFreshnessRiskTier.HIGH_RISK;
  }
  if (suggestionArticleType === 'EVERGREEN_EXPLAINER') return BlogFreshnessRiskTier.EVERGREEN;
  return BlogFreshnessRiskTier.NORMAL;
}

export function cadenceDaysFor(tier: BlogFreshnessRiskTier): number {
  switch (tier) {
    case BlogFreshnessRiskTier.HIGH_RISK:
      return HIGH_RISK_CADENCE_DAYS;
    case BlogFreshnessRiskTier.NORMAL:
      return NORMAL_CADENCE_DAYS;
    case BlogFreshnessRiskTier.EVERGREEN:
      return EVERGREEN_CADENCE_DAYS;
  }
}

export function computeNextReviewAt(lastReviewedAt: Date | null, publishedAt: Date | null, tier: BlogFreshnessRiskTier, now: Date): Date {
  const base = lastReviewedAt ?? publishedAt ?? now;
  return new Date(base.getTime() + cadenceDaysFor(tier) * 24 * 60 * 60 * 1000);
}

export class FreshnessReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreshnessReviewValidationError';
  }
}

/** Raised when the AI's non-FRESH action lacks required evidence, or its rationale doesn't cite any - a safety invariant, never silently downgraded. */
export class FreshnessEvidenceGuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreshnessEvidenceGuardrailError';
  }
}

export interface RunFreshnessReviewInput {
  blogPostId: string;
  idempotencyKey: string;
  triggeredBy?: 'SCHEDULE' | 'SIGNAL' | 'MANUAL';
}

export type RunFreshnessReviewResult =
  | { outcome: 'agents_disabled' }
  | { outcome: 'budget_halted'; agentRunId: string }
  | {
      outcome: 'completed';
      freshnessReviewId: string;
      action: BlogFreshnessAction;
      freshnessScore: number;
      revisionRequestId?: string;
      replayed: boolean;
    };

export interface FreshnessCandidate {
  blogPostId: string;
  riskTier: BlogFreshnessRiskTier;
  reason: 'SCHEDULED' | 'SIGNAL_TRIGGERED';
  nextReviewAt: Date | null;
}

type PostWithRelations = BlogPost & {
  sources: BlogPostSource[];
  automationSuggestion: BlogArticleSuggestion | null;
  freshnessReviews: BlogFreshnessReview[];
};

export type FreshnessReviewPrisma = {
  blogPost: Pick<typeof defaultPrisma.blogPost, 'findUnique' | 'findMany'>;
  blogFreshnessReview: Pick<typeof defaultPrisma.blogFreshnessReview, 'findFirst' | 'create'>;
  regulatorySignal: Pick<typeof defaultPrisma.regulatorySignal, 'findMany'>;
  blogResearchPack: Pick<typeof defaultPrisma.blogResearchPack, 'findFirst'>;
};

type CompleteStructuredFn = typeof defaultCompleteStructured;

export interface FreshnessReviewServiceDependencies {
  prisma?: FreshnessReviewPrisma;
  agentRuns?: Pick<AgentRunService, 'beginRun' | 'completeRun' | 'failRun'>;
  completeStructuredFn?: CompleteStructuredFn;
  llmGateway?: CompleteStructuredDependencies['llmGateway'];
  contentOpsAlert?: ContentOpsAlertService;
  revisionRequests?: Pick<RevisionRequestService, 'createRevisionRequest'>;
  now?: () => Date;
}

const REVISION_PRIORITY_FOR_ACTION: Partial<Record<BlogFreshnessAction, 'MEDIUM' | 'HIGH' | 'URGENT'>> = {
  REVISION_REQUIRED: 'MEDIUM',
  URGENT_REVISION: 'URGENT',
  ARCHIVE_RECOMMENDED: 'HIGH',
};

export class FreshnessReviewService {
  private readonly prisma: FreshnessReviewPrisma;
  private readonly agentRuns: Pick<AgentRunService, 'beginRun' | 'completeRun' | 'failRun'>;
  private readonly completeStructuredFn: CompleteStructuredFn;
  private readonly llmGateway: CompleteStructuredDependencies['llmGateway'];
  private readonly contentOpsAlert: ContentOpsAlertService;
  private readonly revisionRequests: Pick<RevisionRequestService, 'createRevisionRequest'>;
  private readonly now: () => Date;

  constructor(dependencies: FreshnessReviewServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as FreshnessReviewPrisma);
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.completeStructuredFn = dependencies.completeStructuredFn ?? defaultCompleteStructured;
    this.llmGateway = dependencies.llmGateway;
    this.contentOpsAlert = dependencies.contentOpsAlert ?? defaultContentOpsAlertService;
    this.revisionRequests = dependencies.revisionRequests ?? defaultRevisionRequestService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async selectFreshnessCandidates(maxItems: number): Promise<FreshnessCandidate[]> {
    const posts = await this.prisma.blogPost.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      include: { sources: true, automationSuggestion: true, freshnessReviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    const now = this.now();
    const candidates: FreshnessCandidate[] = [];

    for (const post of posts as PostWithRelations[]) {
      if (candidates.length >= maxItems) break;
      const tier = determineRiskTier(post, post.sources, post.automationSuggestion?.articleType);
      const lastReview = post.freshnessReviews[0];
      const nextReviewAt = lastReview?.nextReviewAt ?? computeNextReviewAt(post.lastReviewedAt, post.publishedAt, tier, now);
      const scheduled = nextReviewAt !== null && nextReviewAt <= now;

      if (scheduled) {
        candidates.push({ blogPostId: post.id, riskTier: tier, reason: 'SCHEDULED', nextReviewAt });
        continue;
      }

      const since = lastReview?.createdAt ?? post.publishedAt ?? new Date(0);
      const newSignals = await this.prisma.regulatorySignal.findMany({
        where: { jurisdiction: { in: this.jurisdictionCodesFor(post.jurisdiction) }, severity: { in: QUALIFYING_SIGNAL_SEVERITIES }, createdAt: { gt: since } },
      });
      if (newSignals.length > 0) {
        candidates.push({ blogPostId: post.id, riskTier: tier, reason: 'SIGNAL_TRIGGERED', nextReviewAt });
      }
    }

    return candidates;
  }

  private jurisdictionCodesFor(postJurisdiction: string): string[] {
    return Object.entries(JURISDICTION_CODE_TO_LABEL)
      .filter(([, label]) => label.toLowerCase() === postJurisdiction.trim().toLowerCase())
      .map(([code]) => code);
  }

  async runFreshnessReview(input: RunFreshnessReviewInput): Promise<RunFreshnessReviewResult> {
    const post = await this.prisma.blogPost.findUnique({
      where: { id: input.blogPostId },
      include: { sources: true, automationSuggestion: true, freshnessReviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!post || post.deletedAt || post.status !== 'PUBLISHED') {
      throw new FreshnessReviewValidationError(`blogPostId not found or not published: ${input.blogPostId}`);
    }

    const begin = await this.agentRuns.beginRun({
      agentType: FRESHNESS_REVIEW_AGENT_TYPE,
      idempotencyKey: input.idempotencyKey,
      metadata: { blogPostId: post.id },
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { outcome: 'agents_disabled' };
    if (begin.run.status === 'HALTED_BUDGET') return { outcome: 'budget_halted', agentRunId: begin.run.id };

    const agentRunId = begin.run.id;

    if (begin.duplicate) {
      const existingId = (begin.run.metadata as Record<string, unknown> | null)?.freshnessReviewId;
      if (typeof existingId === 'string') {
        const existing = await this.prisma.blogFreshnessReview.findFirst({ where: { id: existingId } });
        if (existing) {
          return {
            outcome: 'completed',
            freshnessReviewId: existing.id,
            action: existing.action,
            freshnessScore: existing.freshnessScore,
            replayed: true,
          };
        }
      }
      throw new Error(`Duplicate agent run ${agentRunId} has no resolvable freshnessReviewId in its metadata.`);
    }

    logger.info({ type: 'freshness_review_started', agentRunId, blogPostId: post.id });

    try {
      const result = await this.runReview(post as PostWithRelations, input, agentRunId);
      logger.info({ type: 'freshness_review_completed', agentRunId, freshnessReviewId: result.freshnessReviewId, action: result.action });
      if (result.revisionRequestId) {
        logger.info({ type: 'revision_recommended', agentRunId, freshnessReviewId: result.freshnessReviewId, revisionRequestId: result.revisionRequestId });
      }
      return { outcome: 'completed', ...result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: { step: 'freshness_review' } });
      throw error;
    }
  }

  private async runReview(
    post: PostWithRelations,
    input: RunFreshnessReviewInput,
    agentRunId: string,
  ): Promise<{
    freshnessReviewId: string;
    action: BlogFreshnessAction;
    freshnessScore: number;
    revisionRequestId?: string;
    replayed: boolean;
  }> {
    const now = this.now();
    const contentHash = computeContentHash(post.content);
    const sourceSetHash = computeFallbackSourceSetHash(post.sources.map((s) => ({ url: s.url, updatedAt: s.updatedAt })));
    const lastReview = post.freshnessReviews[0] as BlogFreshnessReview | undefined;

    const isSameCalendarDay = lastReview && lastReview.createdAt.toDateString() === now.toDateString();
    if (isSameCalendarDay && lastReview!.contentHash === contentHash && lastReview!.sourceSetHash === sourceSetHash) {
      const since = lastReview!.createdAt;
      const newerSignals = await this.prisma.regulatorySignal.findMany({
        where: { jurisdiction: { in: this.jurisdictionCodesFor(post.jurisdiction) }, severity: { in: QUALIFYING_SIGNAL_SEVERITIES }, createdAt: { gt: since } },
      });
      if (newerSignals.length === 0) {
        await this.agentRuns.completeRun({ runId: agentRunId, metadata: { freshnessReviewId: lastReview!.id, reused: true } });
        return {
          freshnessReviewId: lastReview!.id,
          action: lastReview!.action,
          freshnessScore: lastReview!.freshnessScore,
          replayed: true,
        };
      }
    }

    const tier = determineRiskTier(post, post.sources, post.automationSuggestion?.articleType);
    const since = lastReview?.createdAt ?? post.publishedAt ?? new Date(0);

    const changedSources = post.sources
      .filter((s) => s.updatedAt > since)
      .map((s, i) => ({ ref: `SRC${i + 1}`, title: s.title, id: s.id }));

    const rawSignals = await this.prisma.regulatorySignal.findMany({
      where: { jurisdiction: { in: this.jurisdictionCodesFor(post.jurisdiction) }, severity: { in: QUALIFYING_SIGNAL_SEVERITIES }, createdAt: { gt: since } },
    });
    const newSignals = rawSignals.map((s, i) => ({ ref: `SIG${i + 1}`, title: s.title, severity: s.severity, id: s.id }));

    const activePack = await this.prisma.blogResearchPack.findFirst({
      where: { blogPostId: post.id, status: 'COMPLETE' },
      orderBy: { version: 'desc' },
      include: { sources: true },
    });
    // Reuses Stage C7's already-computed per-source availability - never a new fetch/check.
    const brokenSourceCount = (activePack?.sources ?? []).filter((s) => !s.isAvailable).length;

    const staleThreshold = new Date(now.getTime() - SOURCE_STALENESS_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const staleSourceCount = post.sources.filter((s) => !s.publishedAt || s.publishedAt < staleThreshold).length;

    const sourceSetHashChanged = lastReview ? lastReview.sourceSetHash !== sourceSetHash : false;

    const hasDeterministicSignal =
      changedSources.length > 0 || newSignals.length > 0 || brokenSourceCount > 0 || staleSourceCount > 0 || sourceSetHashChanged;

    let action: BlogFreshnessAction;
    let freshnessScore: number;
    let rationale: string;
    let changedSourceIds: string[] = [];
    let newSignalIds: string[] = [];
    let modelProvider: string | undefined;
    let modelName: string | undefined;

    if (!hasDeterministicSignal) {
      action = BlogFreshnessAction.FRESH;
      freshnessScore = 100;
      rationale = 'No changed sources, new regulatory signals, or broken/stale sources detected since the last review.';
    } else {
      const signals: DeterministicFreshnessSignals = {
        ageDays: Math.floor((now.getTime() - (post.publishedAt?.getTime() ?? now.getTime())) / (24 * 60 * 60 * 1000)),
        riskTier: tier,
        changedSources: changedSources.map((c) => ({ ref: c.ref, title: c.title })),
        newSignals: newSignals.map((s) => ({ ref: s.ref, title: s.title, severity: s.severity })),
        brokenSourceCount,
        staleSourceCount,
        sourceSetHashChanged,
      };

      const completion = await this.completeStructuredFn(
        {
          useCase: 'checklist',
          schema: FreshnessAssessmentSchema,
          schemaName: 'FreshnessAssessment',
          systemPrompt: buildFreshnessSystemPrompt(),
          userPrompt: buildFreshnessUserPrompt(signals),
          overrideTimeoutMs: aiConfig.timeout.checklistTier3,
        },
        { llmGateway: this.llmGateway },
      );

      const assessment = completion.data;
      this.assertEvidenceGuardrail(assessment);

      action = assessment.action;
      freshnessScore = assessment.freshnessScore;
      rationale = assessment.rationale;
      changedSourceIds = changedSources.filter((c) => assessment.changedSourceRefs.includes(c.ref)).map((c) => c.id);
      newSignalIds = newSignals.filter((s) => assessment.relevantSignalRefs.includes(s.ref)).map((s) => s.id);
      modelProvider = completion.providerUsed;
      modelName = completion.modelUsed;
    }

    const nextReviewAt = computeNextReviewAt(post.lastReviewedAt, post.publishedAt, tier, now);

    const created = await this.prisma.blogFreshnessReview.create({
      data: {
        blogPostId: post.id,
        agentRunId,
        triggeredBy: input.triggeredBy ?? 'SCHEDULE',
        contentHash,
        sourceSetHash,
        riskTier: tier,
        freshnessScore,
        action,
        rationale,
        changedSourceIds,
        newSignalIds,
        brokenSourceCount,
        staleSourceCount,
        nextReviewAt,
        modelProvider,
        modelName,
        promptVersion: FRESHNESS_REVIEW_PROMPT_VERSION,
        status: 'COMPLETE',
        completedAt: now,
      },
    });

    if (action === 'URGENT_REVISION' || action === 'ARCHIVE_RECOMMENDED') {
      await this.contentOpsAlert.createOrIncrementAlert({
        type: 'freshness_urgent_revision',
        severity: 'HIGH',
        entityType: 'BlogPost',
        entityId: post.id,
        title: 'Urgent content freshness action required',
        summary: `Freshness review recommended ${action} (score ${freshnessScore}).`,
        metadata: { freshnessReviewId: created.id, blogPostId: post.id, action, freshnessScore, brokenSourceCount, staleSourceCount },
      });
    }

    let revisionRequestId: string | undefined;
    const priority = REVISION_PRIORITY_FOR_ACTION[action];
    if (priority) {
      const revision = await this.revisionRequests.createRevisionRequest({
        blogPostId: post.id,
        freshnessReviewId: created.id,
        reason: `Freshness review recommended ${action}: ${rationale}`.slice(0, 2000),
        priority,
        evidence: { signalIds: newSignalIds, sourceItemIds: changedSourceIds, researchPackId: activePack?.id },
        idempotencyKey: deriveFreshnessOriginatedIdempotencyKey(post.id, created.id),
      });
      revisionRequestId = revision.revisionRequestId;
    }

    await this.agentRuns.completeRun({ runId: agentRunId, metadata: { freshnessReviewId: created.id } });

    return { freshnessReviewId: created.id, action, freshnessScore, revisionRequestId, replayed: false };
  }

  private assertEvidenceGuardrail(assessment: { action: BlogFreshnessAction; changedSourceRefs: string[]; relevantSignalRefs: string[]; brokenSourceCount: number; staleSourceCount: number; rationale: string }): void {
    if (assessment.action === 'FRESH') return;

    const evidenceTokens: string[] = [
      ...assessment.changedSourceRefs,
      ...assessment.relevantSignalRefs,
      ...(assessment.brokenSourceCount > 0 ? ['broken'] : []),
      ...(assessment.staleSourceCount > 0 ? ['stale'] : []),
    ];

    if (evidenceTokens.length === 0) {
      throw new FreshnessEvidenceGuardrailError(
        `Non-FRESH action "${assessment.action}" was returned with no evidence pointers (changedSourceRefs/relevantSignalRefs/brokenSourceCount/staleSourceCount all empty). Age alone must never produce a stale/revision action.`,
      );
    }

    const rationaleLower = assessment.rationale.toLowerCase();
    const citesEvidence = evidenceTokens.some((token) => rationaleLower.includes(token.toLowerCase()));
    if (!citesEvidence) {
      throw new FreshnessEvidenceGuardrailError(
        `Non-FRESH action "${assessment.action}"'s rationale does not cite any of the evidence pointers it reported.`,
      );
    }
  }
}

export const freshnessReviewService = new FreshnessReviewService();
