import { prisma as defaultPrisma } from '@/lib/prisma/client';
import {
  AgentBudgetHalt,
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { logger } from '@/utils/logger';
import { productBiMetricsComputationService, type ProductBiMetricsComputationService } from './metrics-computation.service';
import { productBiInsightSynthesisService, type ProductBiInsightSynthesisService } from './insight-synthesis.service';
import type { GroundedMetricsSnapshot, InsightNarrative, ProductBiRunResult } from './types';
import { PRODUCT_BI_AGENT_TYPE, isoWeekIdentifier, toJsonValue } from './types';

const DEFAULT_WINDOW_DAYS = 7;

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

interface ProductBiPrisma {
  agentReport: {
    findFirst(args: object): Promise<LatestReportRow | null>;
    findMany(args: object): Promise<LatestReportRow[]>;
    count(args: object): Promise<number>;
  };
}

export interface ProductBiAgentDependencies {
  prisma?: ProductBiPrisma;
  metricsComputation?: ProductBiMetricsComputationService;
  insightSynthesis?: ProductBiInsightSynthesisService;
  agentRuns?: AgentRunService;
  now?: () => Date;
}

export interface RunProductBiInput {
  idempotencyKey?: string;
  windowDays?: number;
}

function reportSummary(narrative: InsightNarrative | null): string {
  return narrative?.summary ?? 'Product/BI report run halted before narrative synthesis completed.';
}

export class ProductBiAgent {
  private readonly prisma: ProductBiPrisma;
  private readonly metricsComputation: ProductBiMetricsComputationService;
  private readonly insightSynthesis: ProductBiInsightSynthesisService;
  private readonly agentRuns: AgentRunService;
  private readonly now: () => Date;

  constructor(dependencies: ProductBiAgentDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as ProductBiPrisma);
    this.metricsComputation = dependencies.metricsComputation ?? productBiMetricsComputationService;
    this.insightSynthesis = dependencies.insightSynthesis ?? productBiInsightSynthesisService;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async runReport(input: RunProductBiInput = {}): Promise<ProductBiRunResult> {
    const idempotencyKey = input.idempotencyKey ?? `bi-report:${isoWeekIdentifier(this.now())}`;
    const begin = await this.agentRuns.beginRun({
      agentType: PRODUCT_BI_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ providerRouting: { synthesis: 'anthropic', allowFallback: false } }),
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { runId: null, status: 'SKIPPED_DISABLED' };
    if (begin.duplicate) return { runId: begin.run.id, status: 'DUPLICATE' };
    if (begin.run.status === 'HALTED_BUDGET') return { runId: begin.run.id, status: 'HALTED_BUDGET' };

    const agentRunId = begin.run.id;
    let snapshot: GroundedMetricsSnapshot | null = null;
    let narrative: InsightNarrative | null = null;

    try {
      logger.info({ type: 'bi_report_run_started', agentRunId });
      snapshot = await this.metricsComputation.computeSnapshot({ windowDays: input.windowDays ?? DEFAULT_WINDOW_DAYS });
      logger.info({
        type: 'bi_metrics_computed',
        agentRunId,
        upgradeMomentCandidates: snapshot.upgradeMomentCandidates.length,
        churnRiskOrgs: snapshot.churnRiskOrgs.length,
      });

      narrative = await this.insightSynthesis.synthesize(snapshot);
      await this.captureUsage(agentRunId, narrative);

      const report = await this.createReport(agentRunId, snapshot, narrative);
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: toJsonValue({ reportId: report.id }) });
      logger.info({ type: 'bi_report_completed', agentRunId, reportId: report.id });
      return { runId: agentRunId, status: 'COMPLETED', reportId: report.id };
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) {
        const report = snapshot ? await this.createReport(agentRunId, snapshot, narrative) : undefined;
        logger.warn({ type: 'bi_report_failed', agentRunId, reason: error.reason, reportId: report?.id });
        return { runId: agentRunId, status: 'HALTED_BUDGET', reportId: report?.id };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: toJsonValue({ step: 'bi_report' }) });
      logger.error({ type: 'bi_report_failed', agentRunId, error: message });
      return { runId: agentRunId, status: 'FAILED' };
    }
  }

  async getLatestReport(): Promise<LatestReportRow | null> {
    return this.prisma.agentReport.findFirst({
      where: { run: { agentType: PRODUCT_BI_AGENT_TYPE } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listReports(input: ListReportsInput): Promise<{ reports: LatestReportRow[]; pagination: { page: number; limit: number; total: number; pages: number } }> {
    const where = { run: { agentType: PRODUCT_BI_AGENT_TYPE } };
    const skip = (input.page - 1) * input.limit;
    const [reports, total] = await Promise.all([
      this.prisma.agentReport.findMany({ where, skip, take: input.limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.agentReport.count({ where }),
    ]);
    return { reports, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
  }

  private async captureUsage(agentRunId: string, narrative: InsightNarrative): Promise<void> {
    await this.agentRuns.advanceRun({
      runId: agentRunId,
      inputTokens: narrative.usage.inputTokens,
      outputTokens: narrative.usage.outputTokens,
      costUsd: narrative.usage.costUsd,
      metadata: toJsonValue({ step: 'bi_synthesis', provider: narrative.usage.provider, model: narrative.usage.model }),
    });
  }

  private async createReport(agentRunId: string, snapshot: GroundedMetricsSnapshot, narrative: InsightNarrative | null): Promise<{ id: string }> {
    return this.agentRuns.createReport({
      agentRunId,
      summary: reportSummary(narrative),
      signals: toJsonValue(snapshot),
      recommendedActions: toJsonValue({
        version: 1,
        upgradeMomentCandidates: snapshot.upgradeMomentCandidates,
        opportunities: narrative?.opportunities ?? [],
      }),
      risks: toJsonValue({
        version: 1,
        churnRiskOrgs: snapshot.churnRiskOrgs,
        risks: narrative?.risks ?? [],
      }),
      humanApproved: false,
    });
  }
}

export const productBiAgent = new ProductBiAgent();
