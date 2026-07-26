import { TRPCError } from '@trpc/server';
import type { AgentRun } from '@prisma/client';
import { appConfig } from '@/config/app.config';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { createSuggestionFromSourceItem } from '@/modules/blog-automation/suggestion-builder';
import { createBlogDraftFromSuggestion } from '@/modules/blog-automation/draft-creation.service';
import { generateAiDraftForBlogPost } from '@/modules/blog-automation/ai-draft-generation.service';
import { agentRunService as defaultAgentRunService, type AgentRunService } from '@/modules/agents/agent-run.service';
import { contentOpsAlertService as defaultContentOpsAlertService, type ContentOpsAlertService } from './content-ops-alert.service';
import { AUTOMATION_AGENT_TYPE, toJsonValue } from './types';

const HIGH_PRIORITY_SUGGESTION_LEVELS = new Set(['HIGH', 'URGENT']);

type FullPrisma = typeof defaultPrisma;

export interface CreateDraftFromCandidateInput {
  sourceItemId: string;
}

export type CreateDraftFromCandidateResult =
  | { status: 'created'; suggestionId: string; blogPostId: string; slug: string }
  | { status: 'below_threshold' | 'duplicate' };

export interface GenerateDraftContentInput {
  blogPostId: string;
  idempotencyKey: string;
}

export interface GenerateDraftContentResult {
  blogPostId: string;
  generationRunId: string;
  reviewerNotes: string;
  uncertaintyFlags: string[];
}

interface CompletedDraftGenerationRunMetadata {
  blogPostId: string;
  generationRunId: string;
  reviewerNotes: string;
  uncertaintyFlags: string[];
}

function isCompletedDraftGenerationRunMetadata(
  value: unknown,
): value is CompletedDraftGenerationRunMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.blogPostId === 'string' &&
    typeof candidate.generationRunId === 'string' &&
    typeof candidate.reviewerNotes === 'string' &&
    Array.isArray(candidate.uncertaintyFlags) &&
    candidate.uncertaintyFlags.every((flag) => typeof flag === 'string')
  );
}

export interface AutomationBlogDraftServiceDependencies {
  prisma?: FullPrisma;
  createSuggestion?: typeof createSuggestionFromSourceItem;
  createDraft?: typeof createBlogDraftFromSuggestion;
  generateDraft?: typeof generateAiDraftForBlogPost;
  agentRuns?: AgentRunService;
  contentOpsAlert?: ContentOpsAlertService;
  now?: () => Date;
}

/**
 * Bridges W-CONTENT-01's queueContentCandidate handoff to the existing
 * blog-automation suggestion/draft pipeline (Gap 2). Delegates entirely to
 * createSuggestionFromSourceItem (scoring/classification, unmodified) and
 * createBlogDraftFromSuggestion (the same transactional block
 * adminCreateDraftFromSuggestion uses) - no new templating or scoring logic.
 *
 * Automation-originated suggestions skip the PENDING_REVIEW human
 * suggestion-review step and are promoted straight to APPROVED_FOR_DRAFT:
 * the meaningful human checkpoint for this pipeline is the later
 * AutomationApproval gate (createApproval / recordApprovalDecision)
 * reviewing the actual generated draft content, not a pre-draft suggestion
 * idea - requiring both would mean two human touchpoints per candidate
 * instead of one. BlogArticleSuggestion.requiresHumanReview defaults true
 * but is not read/enforced anywhere else in this codebase (confirmed via
 * full-tree grep), so this does not bypass an active control.
 *
 * Notification delivery for automation-originated events (HIGH/URGENT
 * suggestions, drafts ready for verification) goes through
 * ContentOpsAlertService - a fixed-address email
 * (appConfig.marketing.adminNotificationEmail), not the in-app
 * notificationModule keyed to a per-monitor createdById. Deliberately
 * decoupled from attribution: createdById/approvedById still record who
 * created/approved each row for audit, but the actual delivery target
 * doesn't depend on that id staying valid, so it keeps working if a source
 * monitor's creator account is ever deactivated or the monitor reassigned.
 */
export class AutomationBlogDraftService {
  private readonly prisma: FullPrisma;
  private readonly createSuggestion: typeof createSuggestionFromSourceItem;
  private readonly createDraft: typeof createBlogDraftFromSuggestion;
  private readonly generateDraft: typeof generateAiDraftForBlogPost;
  private readonly agentRuns: AgentRunService;
  private readonly contentOpsAlert: ContentOpsAlertService;
  private readonly now: () => Date;

  constructor(dependencies: AutomationBlogDraftServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? defaultPrisma;
    this.createSuggestion = dependencies.createSuggestion ?? createSuggestionFromSourceItem;
    this.createDraft = dependencies.createDraft ?? createBlogDraftFromSuggestion;
    this.generateDraft = dependencies.generateDraft ?? generateAiDraftForBlogPost;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.contentOpsAlert = dependencies.contentOpsAlert ?? defaultContentOpsAlertService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async createDraftFromCandidate(
    input: CreateDraftFromCandidateInput,
    agentUserId: string,
  ): Promise<CreateDraftFromCandidateResult> {
    // createdByUserId intentionally omitted here: createSuggestionFromSourceItem
    // only uses it as a fallback target for its own internal, in-app,
    // per-monitor-derived HIGH/URGENT notification (const adminId =
    // createdByUserId || sourceItem.monitor.createdById) - that side effect
    // still fires unmodified and is harmless, but is not the reliable
    // channel: the explicit contentOpsAlert.sendAlert call below (fixed
    // address, not derived per-monitor) is.
    const result = await this.createSuggestion({
      prisma: this.prisma,
      sourceItemId: input.sourceItemId,
    });

    if (!result.createdSuggestion || !result.suggestion) {
      const reason = result.reason === 'Duplicate' ? 'duplicate' : 'below_threshold';
      logger.info({
        type: 'automation_blog_draft_suggestion_skipped',
        sourceItemId: input.sourceItemId,
        reason,
      });
      return { status: reason };
    }

    const suggestion = result.suggestion;

    await this.prisma.blogArticleSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'APPROVED_FOR_DRAFT',
        approvedAt: this.now(),
        approvedById: agentUserId,
      },
    });

    logger.info({
      type: 'automation_blog_suggestion_auto_approved',
      suggestionId: suggestion.id,
      sourceItemId: input.sourceItemId,
      approvedById: agentUserId,
    });

    const draft = await this.createDraft({
      prisma: this.prisma,
      suggestionId: suggestion.id,
      createdById: agentUserId,
    });

    logger.info({
      type: 'automation_blog_draft_created',
      suggestionId: suggestion.id,
      blogPostId: draft.blogPostId,
      sourceItemId: input.sourceItemId,
    });

    if (HIGH_PRIORITY_SUGGESTION_LEVELS.has(suggestion.priority)) {
      await this.contentOpsAlert.sendAlert({
        subject: 'High Priority Blog Suggestion',
        summary: `A ${suggestion.priority.toLowerCase()}-priority suggestion "${suggestion.title}" was auto-approved and drafted from an automation candidate.`,
        details: [`Suggestion: ${suggestion.id}`, `BlogPost: ${draft.blogPostId}`],
        link: new URL(`/admin/content/blog/${draft.blogPostId}`, appConfig.appUrl).toString(),
      });
    }

    return { status: 'created', suggestionId: suggestion.id, blogPostId: draft.blogPostId, slug: draft.slug };
  }

  /**
   * Gap 1 (W-CONTENT-02 Phase B, Batch 2). Delegates directly to
   * generateAiDraftForBlogPost - the same function adminGenerateAiDraft
   * already calls - no new templating logic. Wraps it with the same
   * agentRunService.beginRun/completeRun/failRun idempotency primitive
   * automation.service.ts's own generate() uses, since
   * generateAiDraftForBlogPost has no idempotency guard of its own: a
   * caller-supplied idempotencyKey (required body field, not a header)
   * prevents a network retry / duplicate n8n delivery from triggering a
   * second real LLM call and silently re-overwriting the post's content a
   * second time.
   */
  async generateDraftContent(
    input: GenerateDraftContentInput,
    agentUserId: string,
  ): Promise<GenerateDraftContentResult> {
    const begin = await this.agentRuns.beginRun({
      agentType: AUTOMATION_AGENT_TYPE,
      idempotencyKey: input.idempotencyKey,
      metadata: toJsonValue({ blogPostId: input.blogPostId }),
      estimatedCostUsd: 0,
      retryFailed: true,
    });

    if (!begin.started) {
      logger.info({ type: 'automation_blog_generate_draft_rejected', reason: begin.reason, blogPostId: input.blogPostId });
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Automation blog draft generation is currently unavailable.' });
    }

    if (begin.duplicate) {
      return this.resolveDuplicateDraftGeneration(begin.run, input.blogPostId);
    }

    if (begin.run.status === 'HALTED_BUDGET') {
      logger.warn({ type: 'automation_blog_generate_draft_halted_budget', agentRunId: begin.run.id, blogPostId: input.blogPostId });
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Automation blog draft generation budget exceeded. Try again later.' });
    }

    const agentRunId = begin.run.id;

    // No notifyUserId passed: generateAiDraftForBlogPost's optional third
    // parameter defaults to adminUserId (the sys-automation-orchestrator
    // service principal for this call path), which harmlessly lands an
    // in-app notification nobody logs in to see. The reliable channel is
    // the explicit contentOpsAlert.sendAlert call below (fixed address)
    // after a successful generation.
    let result: Awaited<ReturnType<typeof generateAiDraftForBlogPost>>;
    try {
      result = await this.generateDraft(input.blogPostId, agentUserId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({
        runId: agentRunId,
        error: message,
        metadata: toJsonValue({ blogPostId: input.blogPostId }),
      });
      logger.error({ type: 'automation_blog_generate_draft_failed', agentRunId, blogPostId: input.blogPostId, error: message });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Automation blog draft generation failed.' });
    }

    await this.agentRuns.completeRun({
      runId: agentRunId,
      metadata: toJsonValue({
        blogPostId: result.post.id,
        generationRunId: result.runId,
        reviewerNotes: result.reviewerNotes,
        uncertaintyFlags: result.uncertaintyFlags,
      }),
    });

    logger.info({
      type: 'automation_blog_generate_draft_completed',
      agentRunId,
      blogPostId: result.post.id,
      generationRunId: result.runId,
    });

    await this.contentOpsAlert.sendAlert({
      subject: 'Blog Draft Ready for Verification',
      summary: `An AI-generated draft for "${result.post.title}" is ready for compliance verification.`,
      details: result.uncertaintyFlags.length > 0 ? [`Uncertainty flags: ${result.uncertaintyFlags.join(', ')}`] : undefined,
      link: new URL(`/admin/content/blog/${result.post.id}`, appConfig.appUrl).toString(),
    });

    return {
      blogPostId: result.post.id,
      generationRunId: result.runId,
      reviewerNotes: result.reviewerNotes,
      uncertaintyFlags: result.uncertaintyFlags,
    };
  }

  /**
   * A duplicate beginRun() result means an identical (blogPostId,
   * idempotencyKey) request already exists. Mirrors
   * AutomationService.resolveDuplicate's shape exactly: replay a completed
   * run's stashed result, reject anything else so a second generation is
   * never triggered for the same idempotency key.
   */
  private resolveDuplicateDraftGeneration(run: AgentRun, requestedBlogPostId: string): GenerateDraftContentResult {
    if (run.status !== 'COMPLETED') {
      logger.warn({ type: 'automation_blog_generate_draft_duplicate_not_completed', agentRunId: run.id, status: run.status });
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A matching blog draft generation request is already in progress or did not complete. Retry later.',
      });
    }

    if (!isCompletedDraftGenerationRunMetadata(run.metadata)) {
      logger.error({ type: 'automation_blog_generate_draft_duplicate_missing_result', agentRunId: run.id });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Blog draft generation result unavailable for replay.' });
    }

    if (run.metadata.blogPostId !== requestedBlogPostId) {
      logger.error({
        type: 'automation_blog_generate_draft_duplicate_blog_post_mismatch',
        agentRunId: run.id,
        requestedBlogPostId,
        storedBlogPostId: run.metadata.blogPostId,
      });
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Idempotency key was already used for a different blog post.',
      });
    }

    logger.info({ type: 'automation_blog_generate_draft_duplicate_replay', agentRunId: run.id });
    return {
      blogPostId: run.metadata.blogPostId,
      generationRunId: run.metadata.generationRunId,
      reviewerNotes: run.metadata.reviewerNotes,
      uncertaintyFlags: run.metadata.uncertaintyFlags,
    };
  }
}

export const automationBlogDraftService = new AutomationBlogDraftService();
