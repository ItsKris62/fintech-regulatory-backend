import { prisma as defaultPrisma } from '@/lib/prisma/client';
import {
  AgentBudgetHalt,
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { logger } from '@/utils/logger';
import { chiefOfStaffSourceReportsService, type ChiefOfStaffSourceReportsService } from './source-reports.service';
import { chiefOfStaffBriefSynthesisService, type ChiefOfStaffBriefSynthesisService } from './brief-synthesis.service';
import { weeklyBriefDeliveryService, type WeeklyBriefDeliveryService } from './weekly-brief-delivery.service';
import type { ChiefOfStaffRunResult, SourceReportExtract, WeeklyBrief } from './types';
import { CHIEF_OF_STAFF_AGENT_TYPE, isoWeekIdentifier, toJsonValue } from './types';

export interface LatestReportRow {
  id: string;
  agentRunId: string;
  summary: string | null;
  signals: unknown;
  recommendedActions: unknown;
  risks: unknown;
  humanApproved: boolean;
  createdAt: Date;
}

interface ListReportsInput {
  page: number;
  limit: number;
}

interface ChiefOfStaffPrisma {
  agentReport: {
    findFirst(args: object): Promise<LatestReportRow | null>;
    findMany(args: object): Promise<LatestReportRow[]>;
    count(args: object): Promise<number>;
  };
}

export interface ChiefOfStaffAgentDependencies {
  prisma?: ChiefOfStaffPrisma;
  sourceReports?: ChiefOfStaffSourceReportsService;
  briefSynthesis?: ChiefOfStaffBriefSynthesisService;
  delivery?: WeeklyBriefDeliveryService;
  agentRuns?: AgentRunService;
  now?: () => Date;
}

export interface RunChiefOfStaffInput {
  idempotencyKey?: string;
}

function reportSummary(brief: WeeklyBrief | null): string {
  return brief?.summary ?? 'Chief of Staff brief run halted before synthesis completed.';
}

export class ChiefOfStaffAgent {
  private readonly prisma: ChiefOfStaffPrisma;
  private readonly sourceReports: ChiefOfStaffSourceReportsService;
  private readonly briefSynthesis: ChiefOfStaffBriefSynthesisService;
  private readonly delivery: WeeklyBriefDeliveryService;
  private readonly agentRuns: AgentRunService;
  private readonly now: () => Date;

  constructor(dependencies: ChiefOfStaffAgentDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as ChiefOfStaffPrisma);
    this.sourceReports = dependencies.sourceReports ?? chiefOfStaffSourceReportsService;
    this.briefSynthesis = dependencies.briefSynthesis ?? chiefOfStaffBriefSynthesisService;
    this.delivery = dependencies.delivery ?? weeklyBriefDeliveryService;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async runBrief(input: RunChiefOfStaffInput = {}): Promise<ChiefOfStaffRunResult> {
    const idempotencyKey = input.idempotencyKey ?? `chief-of-staff:${isoWeekIdentifier(this.now())}`;
    const begin = await this.agentRuns.beginRun({
      agentType: CHIEF_OF_STAFF_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ providerRouting: { synthesis: 'anthropic', allowFallback: false } }),
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { runId: null, status: 'SKIPPED_DISABLED' };
    if (begin.duplicate) return { runId: begin.run.id, status: 'DUPLICATE' };
    if (begin.run.status === 'HALTED_BUDGET') return { runId: begin.run.id, status: 'HALTED_BUDGET' };

    const agentRunId = begin.run.id;
    let sources: SourceReportExtract[] | null = null;
    let brief: WeeklyBrief | null = null;

    try {
      logger.info({ type: 'chief_of_staff_run_started', agentRunId });
      sources = await this.sourceReports.fetchAllSourceReports();
      logger.info({
        type: 'chief_of_staff_sources_fetched',
        agentRunId,
        sourcesWithReport: sources.filter((source) => source.reportId !== null).length,
        sourcesMissing: sources.filter((source) => source.reportId === null).map((source) => source.agentType),
      });

      brief = await this.briefSynthesis.synthesize(sources);
      await this.captureUsage(agentRunId, brief);

      const report = await this.createReport(agentRunId, sources, brief);
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: toJsonValue({ reportId: report.id }) });
      logger.info({ type: 'chief_of_staff_run_completed', agentRunId, reportId: report.id });

      await this.delivery.send({
        subject: 'SheriaBot Weekly Brief',
        summary: brief.summary,
        wins: brief.wins,
        rankedActions: brief.rankedActions,
        decisionsNeeded: brief.decisionsNeeded,
        agentRunId,
      });

      return { runId: agentRunId, status: 'COMPLETED', reportId: report.id };
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) {
        const report = sources ? await this.createReport(agentRunId, sources, brief) : undefined;
        logger.warn({ type: 'chief_of_staff_run_failed', agentRunId, reason: error.reason, reportId: report?.id });
        return { runId: agentRunId, status: 'HALTED_BUDGET', reportId: report?.id };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: toJsonValue({ step: 'chief_of_staff_brief' }) });
      logger.error({ type: 'chief_of_staff_run_failed', agentRunId, error: message });
      return { runId: agentRunId, status: 'FAILED' };
    }
  }

  async getLatestReport(): Promise<LatestReportRow | null> {
    return this.prisma.agentReport.findFirst({
      where: { run: { agentType: CHIEF_OF_STAFF_AGENT_TYPE } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listReports(input: ListReportsInput): Promise<{ reports: LatestReportRow[]; pagination: { page: number; limit: number; total: number; pages: number } }> {
    const where = { run: { agentType: CHIEF_OF_STAFF_AGENT_TYPE } };
    const skip = (input.page - 1) * input.limit;
    const [reports, total] = await Promise.all([
      this.prisma.agentReport.findMany({ where, skip, take: input.limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.agentReport.count({ where }),
    ]);
    return { reports, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
  }

  private async captureUsage(agentRunId: string, brief: WeeklyBrief): Promise<void> {
    await this.agentRuns.advanceRun({
      runId: agentRunId,
      inputTokens: brief.usage.inputTokens,
      outputTokens: brief.usage.outputTokens,
      costUsd: brief.usage.costUsd,
      metadata: toJsonValue({ step: 'chief_of_staff_synthesis', provider: brief.usage.provider, model: brief.usage.model }),
    });
  }

  private async createReport(agentRunId: string, sources: SourceReportExtract[], brief: WeeklyBrief | null): Promise<{ id: string }> {
    return this.agentRuns.createReport({
      agentRunId,
      summary: reportSummary(brief),
      signals: toJsonValue({
        version: 1,
        sources: sources.map((source) => ({ agentType: source.agentType, reportId: source.reportId, createdAt: source.createdAt, summary: source.summary })),
      }),
      recommendedActions: toJsonValue({ version: 1, rankedActions: brief?.rankedActions ?? [] }),
      risks: toJsonValue({ version: 1, decisionsNeeded: brief?.decisionsNeeded ?? [] }),
      humanApproved: false,
    });
  }
}

export const chiefOfStaffAgent = new ChiefOfStaffAgent();
