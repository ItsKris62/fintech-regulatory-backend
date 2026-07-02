import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import {
  AgentBudgetHalt,
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { logger } from '@/utils/logger';
import { salesEngagementLookupService, type SalesEngagementLookupService } from './engagement-lookup.service';
import { salesOutreachDrafterService, type SalesOutreachDrafterService } from './outreach-drafter.service';
import { salesSignalSelectorService, sourceFingerprintFor, type SalesSignalSelectorService } from './signal-selector.service';
import type { GroundedSalesProspect, OutreachDraftContent, PersistedSalesOutreachDraft, SalesDraftStatus, SalesRunResult } from './types';
import { SALES_AGENT_TYPE, toJsonValue } from './types';

interface SalesOutreachDraftCreateInput {
  sourceSignalId: string;
  organizationId: string;
  triggerReason: string;
  engagementContext: Prisma.InputJsonValue;
  subject: string;
  body: string;
  priority: string;
  agentRunId: string;
  sourceFingerprint: string;
  metadata: Prisma.InputJsonValue;
}

interface SalesOutreachDraftListInput {
  page: number;
  limit: number;
  status?: SalesDraftStatus;
}

interface ReviewDraftInput {
  draftId: string;
  status: Extract<SalesDraftStatus, 'REVIEWED' | 'DISMISSED'>;
  reviewedBy: string;
  editedBody?: string;
}

interface SalesPrisma {
  salesOutreachDraft: {
    create(args: { data: SalesOutreachDraftCreateInput }): Promise<PersistedSalesOutreachDraft>;
    findMany(args: object): Promise<PersistedSalesOutreachDraft[]>;
    count(args: object): Promise<number>;
    findUnique(args: object): Promise<PersistedSalesOutreachDraft | null>;
    update(args: object): Promise<PersistedSalesOutreachDraft>;
  };
}

export interface SalesGrowthAgentDependencies {
  prisma?: SalesPrisma;
  selector?: SalesSignalSelectorService;
  engagementLookup?: SalesEngagementLookupService;
  drafter?: SalesOutreachDrafterService;
  agentRuns?: AgentRunService;
  now?: () => Date;
}

export interface RunSalesDraftingInput {
  idempotencyKey?: string;
  maxProspects?: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function reportSummary(draftsCreated: number): string {
  if (draftsCreated === 0) return 'Sales outreach drafting completed with no new eligible pilot fintech signals.';
  return `Sales outreach drafting completed with ${draftsCreated} draft(s) created for Chris review.`;
}

export class SalesGrowthAgent {
  private readonly prisma: SalesPrisma;
  private readonly selector: SalesSignalSelectorService;
  private readonly engagementLookup: SalesEngagementLookupService;
  private readonly drafter: SalesOutreachDrafterService;
  private readonly agentRuns: AgentRunService;
  private readonly now: () => Date;

  constructor(dependencies: SalesGrowthAgentDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SalesPrisma);
    this.selector = dependencies.selector ?? salesSignalSelectorService;
    this.engagementLookup = dependencies.engagementLookup ?? salesEngagementLookupService;
    this.drafter = dependencies.drafter ?? salesOutreachDrafterService;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async runDrafting(input: RunSalesDraftingInput = {}): Promise<SalesRunResult> {
    const idempotencyKey = input.idempotencyKey ?? `sales:${this.now().toISOString().slice(0, 10)}`;
    const begin = await this.agentRuns.beginRun({
      agentType: SALES_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ providerRouting: { drafting: 'anthropic', allowFallback: false } }),
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { runId: null, status: 'SKIPPED_DISABLED', draftsCreated: 0 };
    if (begin.duplicate) return { runId: begin.run.id, status: 'DUPLICATE', draftsCreated: 0 };
    if (begin.run.status === 'HALTED_BUDGET') return { runId: begin.run.id, status: 'HALTED_BUDGET', draftsCreated: 0 };

    const agentRunId = begin.run.id;
    const createdDrafts: PersistedSalesOutreachDraft[] = [];

    try {
      logger.info({ type: 'sales_draft_run_started', agentRunId });
      const maxProspects = Math.min(Math.max(input.maxProspects ?? 10, 1), 50);
      const prospects = await this.selector.selectProspects({ limit: maxProspects });

      for (const prospect of prospects) {
        logger.info({ type: 'sales_prospect_selected', agentRunId, signalId: prospect.signalId, organizationId: prospect.organizationId });
        const engagement = await this.engagementLookup.lookup(prospect.organizationId, prospect.contactEmail);
        logger.info({ type: 'sales_engagement_lookup', agentRunId, organizationId: prospect.organizationId, available: engagement.available });

        const draft = await this.drafter.draftOutreach(prospect, engagement);
        const persisted = await this.persistDraft(agentRunId, prospect, engagement, draft);
        if (persisted) createdDrafts.push(persisted);
        await this.captureUsage(agentRunId, prospect, draft);
      }

      const report = await this.createReport(agentRunId, createdDrafts);
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: toJsonValue({ reportId: report.id, draftsCreated: createdDrafts.length }) });
      logger.info({ type: 'sales_draft_run_completed', agentRunId, reportId: report.id, draftsCreated: createdDrafts.length });
      return { runId: agentRunId, status: 'COMPLETED', reportId: report.id, draftsCreated: createdDrafts.length };
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) {
        const report = await this.createReport(agentRunId, createdDrafts);
        logger.warn({ type: 'sales_draft_run_failed', agentRunId, reason: error.reason, reportId: report.id });
        return { runId: agentRunId, status: 'HALTED_BUDGET', reportId: report.id, draftsCreated: createdDrafts.length };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: toJsonValue({ step: 'sales_drafting' }) });
      logger.error({ type: 'sales_draft_run_failed', agentRunId, error: message });
      return { runId: agentRunId, status: 'FAILED', draftsCreated: createdDrafts.length };
    }
  }

  async listDrafts(input: SalesOutreachDraftListInput): Promise<{ drafts: PersistedSalesOutreachDraft[]; pagination: { page: number; limit: number; total: number; pages: number } }> {
    const where: Record<string, unknown> = {};
    if (input.status) where.status = input.status;
    const skip = (input.page - 1) * input.limit;
    const [drafts, total] = await Promise.all([
      this.prisma.salesOutreachDraft.findMany({ where, skip, take: input.limit, orderBy: { generatedAt: 'desc' } }),
      this.prisma.salesOutreachDraft.count({ where }),
    ]);
    return { drafts, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
  }

  async getDraft(draftId: string): Promise<PersistedSalesOutreachDraft | null> {
    return this.prisma.salesOutreachDraft.findUnique({ where: { id: draftId } });
  }

  async reviewDraft(input: ReviewDraftInput): Promise<PersistedSalesOutreachDraft> {
    return this.prisma.salesOutreachDraft.update({
      where: { id: input.draftId },
      data: {
        status: input.status,
        reviewedAt: this.now(),
        reviewedBy: input.reviewedBy,
        ...(input.editedBody !== undefined ? { editedBody: input.editedBody } : {}),
      },
    });
  }

  private async persistDraft(
    agentRunId: string,
    prospect: GroundedSalesProspect,
    engagement: Awaited<ReturnType<SalesEngagementLookupService['lookup']>>,
    draft: OutreachDraftContent,
  ): Promise<PersistedSalesOutreachDraft | null> {
    try {
      const persisted = await this.prisma.salesOutreachDraft.create({
        data: {
          sourceSignalId: prospect.signalId,
          organizationId: prospect.organizationId,
          triggerReason: prospect.reason,
          engagementContext: toJsonValue(engagement),
          subject: draft.subject,
          body: draft.body,
          priority: draft.priority,
          agentRunId,
          sourceFingerprint: sourceFingerprintFor(prospect.signalId, prospect.organizationId),
          metadata: draft.metadata,
        },
      });
      logger.info({ type: 'sales_draft_created', agentRunId, draftId: persisted.id, signalId: prospect.signalId, organizationId: prospect.organizationId });
      return persisted;
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        logger.info({ type: 'sales_draft_dedup_skipped', agentRunId, signalId: prospect.signalId, organizationId: prospect.organizationId });
        return null;
      }
      throw error;
    }
  }

  private async captureUsage(agentRunId: string, prospect: GroundedSalesProspect, draft: OutreachDraftContent): Promise<void> {
    await this.agentRuns.advanceRun({
      runId: agentRunId,
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
      costUsd: draft.usage.costUsd,
      metadata: toJsonValue({ step: 'sales_draft', provider: draft.usage.provider, model: draft.usage.model, signalId: prospect.signalId, organizationId: prospect.organizationId }),
    });
  }

  private async createReport(agentRunId: string, drafts: PersistedSalesOutreachDraft[]): Promise<{ id: string }> {
    return this.agentRuns.createReport({
      agentRunId,
      summary: reportSummary(drafts.length),
      signals: toJsonValue({ version: 1, draftIds: drafts.map((draft) => draft.id), sourceSignalIds: drafts.map((draft) => draft.sourceSignalId) }),
      recommendedActions: toJsonValue({ version: 1, humanReviewQueue: drafts.map((draft) => ({ draftId: draft.id, organizationId: draft.organizationId, priority: draft.priority, status: draft.status })) }),
      risks: toJsonValue({ version: 1, notes: ['Drafts require Chris review and manual send before any outreach leaves SheriaBot.'] }),
      humanApproved: false,
    });
  }
}

export const salesGrowthAgent = new SalesGrowthAgent();
