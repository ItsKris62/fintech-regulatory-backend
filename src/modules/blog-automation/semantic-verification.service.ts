import {
  BlogClaimCategory,
  BlogClaimVerificationStatus,
  BlogVerificationIssueSeverity,
  BlogVerificationStatus,
  type BlogArticleSuggestion,
  type BlogPost,
  type BlogPostSource,
  type BlogVerificationRun,
  type Prisma,
} from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import {
  agentRunService as defaultAgentRunService,
  AgentBudgetHalt,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { completeStructured as defaultCompleteStructured } from '@/lib/ai/structured/completeStructured';
import type { CompleteStructuredDependencies } from '@/lib/ai/structured/completeStructured';
import type { LLMProviderName } from '@/lib/ai/gateway/types';
import {
  contentOpsAlertService as defaultContentOpsAlertService,
  type ContentOpsAlertService,
} from '@/modules/agents/automation/content-ops-alert.service';
import { runBlogPostVerification } from './blog-verification.service';
import { computeRequiresHumanReview, OFFICIAL_SOURCE_REQUIRED_CATEGORIES } from './human-review-policy';
import { computeClaimHash, computeContentHash } from './editorial-input-hash';
import { resolveVerificationEvidence, type VerificationEvidence, type VerificationEvidencePrisma } from './verification-evidence';
import {
  SEMANTIC_VERIFICATION_PROMPT_VERSION,
  SemanticVerificationSchema,
  SecondaryClaimReviewSchema,
  buildPrimarySystemPrompt,
  buildPrimaryUserPrompt,
  buildSecondarySystemPrompt,
  buildSecondaryUserPrompt,
  type SemanticClaim,
} from './semantic-verification-prompt';

/**
 * Phase D Part 1 - semantic claim verification. EXTENDS the existing
 * runBlogPostVerification structural pass (called, never duplicated) with an
 * AI-assisted semantic layer that grounds every legal/factual claim against
 * research-pack (or BlogPostSource-fallback) evidence. See
 * docs/editorial-intelligence/semantic-verification-policy.md.
 */

export const SEMANTIC_VERIFICATION_AGENT_TYPE = 'semantic-verification';

/**
 * Exhaustive over all 13 BlogClaimCategory values (10 high-stakes + 3
 * low-stakes here = 13). NUMERICAL_CLAIM/FACTUAL_EVENT are not named in
 * either bucket by phase-b-data-model.md §3's mapping table; they default to
 * high-stakes here (conservative) - a documented gap-fill, not a silent guess.
 */
export const HIGH_STAKES_CLAIM_CATEGORIES: readonly BlogClaimCategory[] = [
  BlogClaimCategory.LEGAL_OBLIGATION,
  BlogClaimCategory.DEADLINE,
  BlogClaimCategory.PENALTY,
  BlogClaimCategory.LICENSING_REQUIREMENT,
  BlogClaimCategory.REPORTING_REQUIREMENT,
  BlogClaimCategory.SECURITY_REQUIREMENT,
  BlogClaimCategory.DATA_PROTECTION_REQUIREMENT,
  BlogClaimCategory.REGULATOR_AUTHORITY,
  BlogClaimCategory.NUMERICAL_CLAIM,
  BlogClaimCategory.FACTUAL_EVENT,
];
export const LOW_STAKES_CLAIM_CATEGORIES: readonly BlogClaimCategory[] = [
  BlogClaimCategory.INTERPRETATION,
  BlogClaimCategory.RECOMMENDATION,
  BlogClaimCategory.MARKETING_STATEMENT,
];

/**
 * The exact, code-authoritative severity mapping from
 * phase-b-data-model.md §3 - never taken from the model's own
 * severityOpinion field. Returns null for VERIFIED (no issue row).
 */
export function computeClaimSeverity(
  status: BlogClaimVerificationStatus,
  category: BlogClaimCategory,
): BlogVerificationIssueSeverity | null {
  const highStakes = HIGH_STAKES_CLAIM_CATEGORIES.includes(category);
  switch (status) {
    case BlogClaimVerificationStatus.VERIFIED:
      return null;
    case BlogClaimVerificationStatus.PARTIALLY_SUPPORTED:
      return highStakes ? 'WARNING' : 'INFO';
    case BlogClaimVerificationStatus.UNSUPPORTED:
      return highStakes ? 'BLOCKING' : 'WARNING';
    case BlogClaimVerificationStatus.CONTRADICTED:
      return 'BLOCKING';
    case BlogClaimVerificationStatus.STALE_SOURCE:
      return 'WARNING';
    case BlogClaimVerificationStatus.HUMAN_REVIEW_REQUIRED:
      return 'WARNING';
  }
}

export class SemanticVerificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticVerificationValidationError';
  }
}

export interface RunSemanticVerificationInput {
  blogPostId: string;
  idempotencyKey: string;
  requestedByUserId?: string;
  /** Forces second-model review even for claims whose primary severity isn't BLOCKING. */
  requestSecondReview?: boolean;
}

export type RunSemanticVerificationResult =
  | { outcome: 'agents_disabled' }
  | { outcome: 'budget_halted'; agentRunId: string }
  | {
      outcome: 'completed';
      verificationRunId: string;
      status: BlogVerificationStatus;
      blockingIssueCount: number;
      requiresHumanReview: boolean;
      replayed: boolean;
    };

interface PreparedIssueRow {
  severity: BlogVerificationIssueSeverity;
  issueType: 'SEMANTIC_CLAIM_ISSUE';
  title: string;
  description: string;
  recommendation: string | null;
  claimText: string;
  paragraphIndex: number | null;
  sentenceIndex: number | null;
  sourceId: string | null;
  sourceUrl: string | null;
  claimCategory: BlogClaimCategory;
  claimVerificationStatus: BlogClaimVerificationStatus;
  confidence: number;
  claimHash: string;
  reviewProvenance: Prisma.InputJsonValue;
}

export type SemanticVerificationPrisma = VerificationEvidencePrisma & {
  blogPost: Pick<typeof defaultPrisma.blogPost, 'findUnique'>;
  blogVerificationRun: Pick<typeof defaultPrisma.blogVerificationRun, 'findFirst' | 'update'>;
  blogVerificationIssue: Pick<typeof defaultPrisma.blogVerificationIssue, 'createMany'>;
  blogArticleSuggestion: Pick<typeof defaultPrisma.blogArticleSuggestion, 'update'>;
};

type CompleteStructuredFn = typeof defaultCompleteStructured;

export interface SemanticVerificationServiceDependencies {
  prisma?: SemanticVerificationPrisma;
  agentRuns?: Pick<AgentRunService, 'beginRun' | 'advanceRun' | 'completeRun' | 'failRun'>;
  completeStructuredFn?: CompleteStructuredFn;
  llmGateway?: CompleteStructuredDependencies['llmGateway'];
  contentOpsAlert?: ContentOpsAlertService;
  runStructuralVerification?: typeof runBlogPostVerification;
}

function selectSecondaryProvider(primary: LLMProviderName): LLMProviderName {
  return primary === 'openai' ? 'gemini' : 'openai';
}

export class SemanticVerificationService {
  private readonly prisma: SemanticVerificationPrisma;
  private readonly agentRuns: Pick<AgentRunService, 'beginRun' | 'advanceRun' | 'completeRun' | 'failRun'>;
  private readonly completeStructuredFn: CompleteStructuredFn;
  private readonly llmGateway: CompleteStructuredDependencies['llmGateway'];
  private readonly contentOpsAlert: ContentOpsAlertService;
  private readonly runStructuralVerification: typeof runBlogPostVerification;

  constructor(dependencies: SemanticVerificationServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SemanticVerificationPrisma);
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.completeStructuredFn = dependencies.completeStructuredFn ?? defaultCompleteStructured;
    this.llmGateway = dependencies.llmGateway;
    this.contentOpsAlert = dependencies.contentOpsAlert ?? defaultContentOpsAlertService;
    this.runStructuralVerification = dependencies.runStructuralVerification ?? runBlogPostVerification;
  }

  async runSemanticVerification(input: RunSemanticVerificationInput): Promise<RunSemanticVerificationResult> {
    const post = await this.prisma.blogPost.findUnique({
      where: { id: input.blogPostId },
      include: { sources: true, automationSuggestion: true },
    });
    if (!post || post.deletedAt) {
      throw new SemanticVerificationValidationError(`blogPostId not found: ${input.blogPostId}`);
    }

    const begin = await this.agentRuns.beginRun({
      agentType: SEMANTIC_VERIFICATION_AGENT_TYPE,
      idempotencyKey: input.idempotencyKey,
      metadata: { blogPostId: post.id },
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { outcome: 'agents_disabled' };
    if (begin.run.status === 'HALTED_BUDGET') return { outcome: 'budget_halted', agentRunId: begin.run.id };

    const agentRunId = begin.run.id;

    if (begin.duplicate) {
      const existingId = (begin.run.metadata as Record<string, unknown> | null)?.verificationRunId;
      if (typeof existingId === 'string') {
        const existing = await this.prisma.blogVerificationRun.findFirst({ where: { id: existingId } });
        if (existing) {
          return {
            outcome: 'completed',
            verificationRunId: existing.id,
            status: existing.status,
            blockingIssueCount: existing.blockingIssueCount,
            requiresHumanReview: existing.status !== 'PASSED',
            replayed: true,
          };
        }
      }
      throw new Error(`Duplicate agent run ${agentRunId} has no resolvable verificationRunId in its metadata.`);
    }

    logger.info({ type: 'verification_started', agentRunId, blogPostId: post.id });

    try {
      const result = await this.runVerification(post, input, agentRunId);
      logger.info({
        type: 'verification_completed',
        agentRunId,
        verificationRunId: result.verificationRunId,
        status: result.status,
        blockingIssueCount: result.blockingIssueCount,
      });
      if (result.status === 'BLOCKED') {
        logger.info({ type: 'verification_blocked', agentRunId, verificationRunId: result.verificationRunId });
      }
      return { outcome: 'completed', ...result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: { step: 'semantic_verification' } });
      throw error;
    }
  }

  private async findLatestReusable(blogPostId: string): Promise<BlogVerificationRun | null> {
    return this.prisma.blogVerificationRun.findFirst({
      where: { blogPostId, status: { in: ['PASSED', 'NEEDS_REVIEW', 'BLOCKED'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async runVerification(
    post: BlogPost & { sources: BlogPostSource[]; automationSuggestion: BlogArticleSuggestion | null },
    input: RunSemanticVerificationInput,
    agentRunId: string,
  ): Promise<{
    verificationRunId: string;
    status: BlogVerificationStatus;
    blockingIssueCount: number;
    requiresHumanReview: boolean;
    replayed: boolean;
  }> {
    const contentHash = computeContentHash(post.content);
    const evidence = await resolveVerificationEvidence(this.prisma, post);

    const latest = await this.findLatestReusable(post.id);
    if (latest && latest.contentHash === contentHash && latest.sourceSetHash === evidence.sourceSetHash) {
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: { verificationRunId: latest.id, reused: true } });
      return {
        verificationRunId: latest.id,
        status: latest.status,
        blockingIssueCount: latest.blockingIssueCount,
        requiresHumanReview: latest.status !== 'PASSED',
        replayed: false,
      };
    }

    const structuralRun = await this.runStructuralVerification({
      prisma: this.prisma as never,
      blogPostId: post.id,
      requestedByUserId: input.requestedByUserId,
      runType: 'MANUAL',
    });

    await this.agentRuns.advanceRun({ runId: agentRunId, metadata: { step: 'structural_verification', runId: structuralRun.id } });

    let semanticIssues: PreparedIssueRow[] = [];
    let hasUnverifiedSemanticClaim = false;
    let secondaryReviewInconclusive = false;

    if (evidence.mode !== 'no_evidence' && post.content && post.content.trim().length > 0) {
      const completion = await this.completeStructuredFn(
        {
          useCase: 'verification',
          schema: SemanticVerificationSchema,
          schemaName: 'SemanticVerification',
          systemPrompt: buildPrimarySystemPrompt(),
          userPrompt: buildPrimaryUserPrompt(post.content, evidence),
        },
        { llmGateway: this.llmGateway },
      );
      await this.agentRuns.advanceRun({
        runId: agentRunId,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        costUsd: completion.estimatedCostUsd,
        metadata: { step: 'semantic_extraction_and_verification' },
      });

      const knownRefs = new Set(evidence.items.map((e) => e.sourceRef));
      const built = await this.buildIssueRows(
        completion.data.claims,
        knownRefs,
        evidence,
        completion.providerUsed,
        completion.modelUsed,
        agentRunId,
        input.requestSecondReview ?? false,
      );
      semanticIssues = built.rows;
      hasUnverifiedSemanticClaim = built.hasUnverifiedSemanticClaim;
      secondaryReviewInconclusive = built.secondaryReviewInconclusive;
    }

    if (semanticIssues.length > 0) {
      await this.prisma.blogVerificationIssue.createMany({
        data: semanticIssues.map((row) => ({ ...row, runId: structuralRun.id })),
      });
    }

    const semanticBlocking = semanticIssues.filter((r) => r.severity === 'BLOCKING').length;
    const semanticWarning = semanticIssues.filter((r) => r.severity === 'WARNING').length;
    const semanticInfo = semanticIssues.filter((r) => r.severity === 'INFO').length;

    const finalBlockingCount = structuralRun.blockingIssueCount + semanticBlocking;
    const finalWarningCount = structuralRun.warningIssueCount + semanticWarning;
    const finalInfoCount = structuralRun.infoIssueCount + semanticInfo;

    let finalStatus: BlogVerificationStatus = 'PASSED';
    if (finalBlockingCount > 0) finalStatus = 'BLOCKED';
    else if (finalWarningCount > 0 || structuralRun.qualityScore < 85) finalStatus = 'NEEDS_REVIEW';

    const updated = await this.prisma.blogVerificationRun.update({
      where: { id: structuralRun.id },
      data: {
        status: finalStatus,
        blockingIssueCount: finalBlockingCount,
        warningIssueCount: finalWarningCount,
        infoIssueCount: finalInfoCount,
        contentHash,
        sourceSetHash: evidence.sourceSetHash,
        promptVersion: SEMANTIC_VERIFICATION_PROMPT_VERSION,
        completedAt: new Date(),
      },
    });

    const suggestion = post.automationSuggestion;
    const category = suggestion?.category ?? post.category;
    const hasOfficialSource = post.sources.some((s) => s.sourceType === 'OFFICIAL' || s.sourceType === 'INTERNATIONAL_STANDARD');
    const humanReview = computeRequiresHumanReview({
      categoryRequiresOfficialSource: OFFICIAL_SOURCE_REQUIRED_CATEGORIES.includes(category),
      hasOfficialSource: suggestion ? !suggestion.requiresOfficialSource : hasOfficialSource,
      sourceQuality: suggestion?.sourceQuality ?? (hasOfficialSource ? 'OFFICIAL' : 'MEDIUM'),
      priority: suggestion?.priority ?? 'MEDIUM',
      jurisdiction: suggestion?.jurisdiction ?? post.jurisdiction,
      verification: {
        status: finalStatus,
        hasUnverifiedSemanticClaim: hasUnverifiedSemanticClaim || secondaryReviewInconclusive,
      },
    });

    if (suggestion && appConfig.editorial.humanReviewPolicyEnabled) {
      await this.prisma.blogArticleSuggestion.update({
        where: { id: suggestion.id },
        data: { requiresHumanReview: humanReview.required },
      });
    }

    if (finalStatus === 'BLOCKED') {
      await this.contentOpsAlert.createOrIncrementAlert({
        type: 'verification_blocked',
        severity: 'HIGH',
        entityType: 'BlogPost',
        entityId: post.id,
        title: 'Blog post verification blocked',
        summary: `Verification found ${finalBlockingCount} blocking issue(s).`,
        metadata: { verificationRunId: updated.id, blogPostId: post.id, blockingIssueCount: finalBlockingCount },
      });
    }

    await this.agentRuns.completeRun({ runId: agentRunId, metadata: { verificationRunId: updated.id } });

    return {
      verificationRunId: updated.id,
      status: finalStatus,
      blockingIssueCount: finalBlockingCount,
      requiresHumanReview: humanReview.required,
      replayed: false,
    };
  }

  private async buildIssueRows(
    claims: readonly SemanticClaim[],
    knownRefs: ReadonlySet<string>,
    evidence: VerificationEvidence,
    primaryProvider: LLMProviderName,
    primaryModel: string,
    agentRunId: string,
    forceSecondReview: boolean,
  ): Promise<{ rows: PreparedIssueRow[]; hasUnverifiedSemanticClaim: boolean; secondaryReviewInconclusive: boolean }> {
    const rows: PreparedIssueRow[] = [];
    let hasUnverifiedSemanticClaim = false;
    let secondaryReviewInconclusive = false;

    for (const claim of claims) {
      const validRefs = claim.sourceRefs.filter((r) => knownRefs.has(r));
      const droppedRefs = claim.sourceRefs.length - validRefs.length;
      if (droppedRefs > 0) {
        logger.warn({ type: 'verification_unknown_source_ref_dropped', agentRunId, droppedCount: droppedRefs });
      }

      // A claim citing zero real evidence cannot be VERIFIED/PARTIALLY_SUPPORTED,
      // regardless of what the model asserted - a poisoned/unverified source
      // cannot verify a claim. Mirrors the C7 high-stakes-obligation downgrade.
      let status = claim.verificationStatus;
      if (
        validRefs.length === 0 &&
        (status === BlogClaimVerificationStatus.VERIFIED || status === BlogClaimVerificationStatus.PARTIALLY_SUPPORTED)
      ) {
        status = BlogClaimVerificationStatus.UNSUPPORTED;
      }

      let severity = computeClaimSeverity(status, claim.category);
      if (severity === null) continue; // VERIFIED - no issue row
      if (severity !== 'INFO') hasUnverifiedSemanticClaim = true;

      const claimHash = computeClaimHash(claim.claimText);
      const firstValidRef = validRefs[0];
      const evidenceItem = evidence.items.find((e) => e.sourceRef === firstValidRef);

      const primaryRow: PreparedIssueRow = {
        severity,
        issueType: 'SEMANTIC_CLAIM_ISSUE',
        title: `Semantic claim: ${claim.category}`,
        description: claim.explanation,
        recommendation: claim.recommendation ?? null,
        claimText: claim.claimText,
        paragraphIndex: claim.paragraphIndex ?? null,
        sentenceIndex: claim.sentenceIndex ?? null,
        sourceId: evidenceItem?.sourceId ?? null,
        sourceUrl: evidenceItem?.sourceUrl ?? null,
        claimCategory: claim.category,
        claimVerificationStatus: status,
        confidence: claim.confidence,
        claimHash,
        reviewProvenance: { pass: 'PRIMARY', provider: primaryProvider, model: primaryModel, promptVersion: SEMANTIC_VERIFICATION_PROMPT_VERSION },
      };

      const shouldSecondReview = severity === 'BLOCKING' || forceSecondReview;
      if (!shouldSecondReview) {
        rows.push(primaryRow);
        continue;
      }

      try {
        const secondaryProvider = selectSecondaryProvider(primaryProvider);
        const secondary = await this.completeStructuredFn(
          {
            useCase: 'verification',
            provider: secondaryProvider,
            schema: SecondaryClaimReviewSchema,
            schemaName: 'SecondaryClaimReview',
            systemPrompt: buildSecondarySystemPrompt(),
            userPrompt: buildSecondaryUserPrompt(claim.claimText, evidence),
          },
          { llmGateway: this.llmGateway },
        );
        await this.agentRuns.advanceRun({
          runId: agentRunId,
          inputTokens: secondary.inputTokens,
          outputTokens: secondary.outputTokens,
          costUsd: secondary.estimatedCostUsd,
          metadata: { step: 'secondary_review', claimHash },
        });

        if (secondary.data.verificationStatus !== status) {
          // Disagreement: no model's verdict is silently preferred - both rows
          // forced BLOCKING and human review is required unconditionally.
          primaryRow.severity = 'BLOCKING';
          const secondaryRow: PreparedIssueRow = {
            ...primaryRow,
            severity: 'BLOCKING',
            description: secondary.data.explanation,
            claimVerificationStatus: secondary.data.verificationStatus,
            confidence: secondary.data.confidence,
            reviewProvenance: {
              pass: 'SECONDARY_REVIEW',
              provider: secondaryProvider,
              model: secondary.modelUsed,
              promptVersion: SEMANTIC_VERIFICATION_PROMPT_VERSION,
            },
          };
          rows.push(primaryRow, secondaryRow);
          hasUnverifiedSemanticClaim = true;
          continue;
        }

        rows.push(primaryRow);
      } catch (error: unknown) {
        // Second provider unavailable or budget halted - never silently
        // preferred, never a hard failure of the whole run: route to human review.
        const reason = error instanceof AgentBudgetHalt ? error.reason : error instanceof Error ? error.message : String(error);
        logger.warn({ type: 'verification_secondary_review_inconclusive', agentRunId, claimHash, reason });
        secondaryReviewInconclusive = true;
        rows.push(primaryRow);
      }
    }

    return { rows, hasUnverifiedSemanticClaim, secondaryReviewInconclusive };
  }
}

export const semanticVerificationService = new SemanticVerificationService();
