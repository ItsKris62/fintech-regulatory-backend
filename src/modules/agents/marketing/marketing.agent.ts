import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import {
  AgentBudgetHalt,
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { logger } from '@/utils/logger';
import { marketingContentDrafterService, type MarketingContentDrafterService } from './content-drafter.service';
import { marketingSignalSelectorService, sourceFingerprintFor, type MarketingSignalSelectorService } from './signal-selector.service';
import type { DraftContent, GroundedMarketingSignal, MarketingContentType, MarketingDraftStatus, MarketingRunResult, PersistedMarketingDraft } from './types';
import { MARKETING_AGENT_TYPE, toJsonValue } from './types';

interface MarketingDraftCreateInput {
  contentType: MarketingContentType;
  sourceSignalIds: Prisma.InputJsonValue;
  sourceFingerprint: string;
  title: string;
  body: string;
  brief: string;
  agentRunId: string;
  metadata: Prisma.InputJsonValue;
}

interface MarketingDraftListInput {
  page: number;
  limit: number;
  status?: MarketingDraftStatus;
  contentType?: MarketingContentType;
}

interface ReviewDraftInput {
  draftId: string;
  status: Extract<MarketingDraftStatus, 'REVIEWED' | 'DISMISSED'>;
  reviewedBy: string;
  editedBody?: string;
}

interface MarketingPrisma {
  marketingDraft: {
    create(args: { data: MarketingDraftCreateInput }): Promise<PersistedMarketingDraft>;
    findMany(args: object): Promise<PersistedMarketingDraft[]>;
    count(args: object): Promise<number>;
    findUnique(args: object): Promise<PersistedMarketingDraft | null>;
    update(args: object): Promise<PersistedMarketingDraft>;
  };
}

export interface MarketingAgentDependencies {
  prisma?: MarketingPrisma;
  selector?: MarketingSignalSelectorService;
  drafter?: MarketingContentDrafterService;
  agentRuns?: AgentRunService;
  now?: () => Date;
}

export interface RunMarketingInput {
  idempotencyKey?: string;
  maxSignals?: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function reportSummary(draftsCreated: number): string {
  if (draftsCreated === 0) return 'Marketing drafting completed with no new eligible RegulatorySignal rows.';
  return `Marketing drafting completed with ${draftsCreated} draft(s) created for Chris review.`;
}

export class MarketingAgent {
  private readonly prisma: MarketingPrisma;
  private readonly selector: MarketingSignalSelectorService;
  private readonly drafter: MarketingContentDrafterService;
  private readonly agentRuns: AgentRunService;
  private readonly now: () => Date;

  constructor(dependencies: MarketingAgentDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as MarketingPrisma);
    this.selector = dependencies.selector ?? marketingSignalSelectorService;
    this.drafter = dependencies.drafter ?? marketingContentDrafterService;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async runDrafting(input: RunMarketingInput = {}): Promise<MarketingRunResult> {
    const idempotencyKey = input.idempotencyKey ?? `marketing:${this.now().toISOString().slice(0, 10)}`;
    const begin = await this.agentRuns.beginRun({
      agentType: MARKETING_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ providerRouting: { drafting: 'anthropic', allowFallback: false } }),
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { runId: null, status: 'SKIPPED_DISABLED', draftsCreated: 0 };
    if (begin.duplicate) return { runId: begin.run.id, status: 'DUPLICATE', draftsCreated: 0 };
    if (begin.run.status === 'HALTED_BUDGET') return { runId: begin.run.id, status: 'HALTED_BUDGET', draftsCreated: 0 };

    const agentRunId = begin.run.id;
    const createdDrafts: PersistedMarketingDraft[] = [];

    try {
      logger.info({ type: 'marketing_draft_run_started', agentRunId });
      const maxSignals = Math.min(Math.max(input.maxSignals ?? 10, 1), 50);
      const newsletterSignals = await this.selector.selectSignals({ contentType: 'newsletter_item', limit: maxSignals });
      const linkedinSignals = await this.selector.selectSignals({ contentType: 'linkedin_post', limit: maxSignals });

      for (const signal of newsletterSignals) {
        logger.info({ type: 'marketing_signal_selected', agentRunId, signalId: signal.id, contentType: 'newsletter_item' });
        const draft = await this.drafter.draftNewsletterItem(signal);
        const persisted = await this.persistDraft(agentRunId, 'newsletter_item', signal, draft);
        if (persisted) createdDrafts.push(persisted);
        await this.captureUsage(agentRunId, 'newsletter_item', signal.id, draft);
      }

      for (const signal of linkedinSignals) {
        logger.info({ type: 'marketing_signal_selected', agentRunId, signalId: signal.id, contentType: 'linkedin_post' });
        const draft = await this.drafter.draftLinkedInPost(signal);
        const persisted = await this.persistDraft(agentRunId, 'linkedin_post', signal, draft);
        if (persisted) createdDrafts.push(persisted);
        await this.captureUsage(agentRunId, 'linkedin_post', signal.id, draft);
      }

      const report = await this.createReport(agentRunId, createdDrafts);
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: toJsonValue({ reportId: report.id, draftsCreated: createdDrafts.length }) });
      logger.info({ type: 'marketing_draft_run_completed', agentRunId, reportId: report.id, draftsCreated: createdDrafts.length });
      return { runId: agentRunId, status: 'COMPLETED', reportId: report.id, draftsCreated: createdDrafts.length };
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) {
        const report = await this.createReport(agentRunId, createdDrafts);
        logger.warn({ type: 'marketing_draft_run_failed', agentRunId, reason: error.reason, reportId: report.id });
        return { runId: agentRunId, status: 'HALTED_BUDGET', reportId: report.id, draftsCreated: createdDrafts.length };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: toJsonValue({ step: 'marketing_drafting' }) });
      logger.error({ type: 'marketing_draft_run_failed', agentRunId, error: message });
      return { runId: agentRunId, status: 'FAILED', draftsCreated: createdDrafts.length };
    }
  }

  async listDrafts(input: MarketingDraftListInput): Promise<{ drafts: PersistedMarketingDraft[]; pagination: { page: number; limit: number; total: number; pages: number } }> {
    const where: Record<string, unknown> = {};
    if (input.status) where.status = input.status;
    if (input.contentType) where.contentType = input.contentType;
    const skip = (input.page - 1) * input.limit;
    const [drafts, total] = await Promise.all([
      this.prisma.marketingDraft.findMany({ where, skip, take: input.limit, orderBy: { generatedAt: 'desc' } }),
      this.prisma.marketingDraft.count({ where }),
    ]);
    return { drafts, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
  }

  async getDraft(draftId: string): Promise<PersistedMarketingDraft | null> {
    return this.prisma.marketingDraft.findUnique({ where: { id: draftId } });
  }

  async reviewDraft(input: ReviewDraftInput): Promise<PersistedMarketingDraft> {
    return this.prisma.marketingDraft.update({
      where: { id: input.draftId },
      data: {
        status: input.status,
        reviewedAt: this.now(),
        reviewedBy: input.reviewedBy,
        ...(input.editedBody !== undefined ? { editedBody: input.editedBody } : {}),
      },
    });
  }

  private async persistDraft(agentRunId: string, contentType: MarketingContentType, signal: GroundedMarketingSignal, draft: DraftContent): Promise<PersistedMarketingDraft | null> {
    try {
      const sourceSignalIds = [signal.id];
      const persisted = await this.prisma.marketingDraft.create({
        data: {
          contentType,
          sourceSignalIds: toJsonValue(sourceSignalIds),
          sourceFingerprint: sourceFingerprintFor(sourceSignalIds),
          title: draft.title,
          body: draft.body,
          brief: draft.brief,
          agentRunId,
          metadata: draft.metadata,
        },
      });
      logger.info({ type: 'marketing_draft_created', agentRunId, draftId: persisted.id, signalId: signal.id, contentType });
      return persisted;
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        logger.info({ type: 'marketing_draft_dedup_skipped', agentRunId, signalId: signal.id, contentType });
        return null;
      }
      throw error;
    }
  }

  private async captureUsage(agentRunId: string, contentType: MarketingContentType, signalId: string, draft: DraftContent): Promise<void> {
    await this.agentRuns.advanceRun({
      runId: agentRunId,
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
      costUsd: draft.usage.costUsd,
      metadata: toJsonValue({ step: 'marketing_draft', provider: draft.usage.provider, model: draft.usage.model, contentType, signalId }),
    });
  }

  private async createReport(agentRunId: string, drafts: PersistedMarketingDraft[]): Promise<{ id: string }> {
    return this.agentRuns.createReport({
      agentRunId,
      summary: reportSummary(drafts.length),
      signals: toJsonValue({ version: 1, draftIds: drafts.map((draft) => draft.id), sourceSignalIds: drafts.map((draft) => draft.sourceSignalIds) }),
      recommendedActions: toJsonValue({ version: 1, humanReviewQueue: drafts.map((draft) => ({ draftId: draft.id, contentType: draft.contentType, status: draft.status })) }),
      risks: toJsonValue({ version: 1, notes: ['Drafts require Chris review before campaign or social use.'] }),
      humanApproved: false,
    });
  }
}

export const marketingAgent = new MarketingAgent();