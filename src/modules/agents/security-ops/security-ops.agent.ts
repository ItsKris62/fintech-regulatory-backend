import { prisma as defaultPrisma } from '@/lib/prisma/client';
import {
  AgentBudgetHalt,
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { logger } from '@/utils/logger';
import { opsHealthSnapshotService, type OpsHealthSnapshotService } from './ops-health-snapshot.service';
import { securityOpsAlertSynthesisService, type SecurityOpsAlertSynthesisService } from './alert-synthesis.service';
import { securityOpsAlertService, type SecurityOpsAlertService } from './ops-alert.service';
import type { GroundedOpsSnapshot, OpsNarrative, SecurityOpsRunResult } from './types';
import { SECURITY_OPS_AGENT_TYPE, isoDateIdentifier, toJsonValue } from './types';

const DEFAULT_WINDOW_DAYS = 1;

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

interface SecurityOpsPrisma {
  agentReport: {
    findFirst(args: object): Promise<LatestReportRow | null>;
    findMany(args: object): Promise<LatestReportRow[]>;
    count(args: object): Promise<number>;
  };
}

export interface SecurityOpsAgentDependencies {
  prisma?: SecurityOpsPrisma;
  healthSnapshot?: OpsHealthSnapshotService;
  alertSynthesis?: SecurityOpsAlertSynthesisService;
  opsAlert?: SecurityOpsAlertService;
  agentRuns?: AgentRunService;
  now?: () => Date;
}

export interface RunSecurityOpsInput {
  idempotencyKey?: string;
  windowDays?: number;
}

function reportSummary(narrative: OpsNarrative | null): string {
  return narrative?.summary ?? 'Security/ops report run halted before narrative synthesis completed.';
}

// Alert only on evidence already in the snapshot - a down service or a
// budget/failure halt in the window - never on an inferred or synthesized signal.
function shouldAlert(snapshot: GroundedOpsSnapshot): boolean {
  if (snapshot.serviceHealth.some((check) => check.status === 'down')) return true;
  return snapshot.workforceCosts.some((cost) => cost.haltedBudgetCount > 0 || cost.failedCount > 0);
}

export class SecurityOpsAgent {
  private readonly prisma: SecurityOpsPrisma;
  private readonly healthSnapshot: OpsHealthSnapshotService;
  private readonly alertSynthesis: SecurityOpsAlertSynthesisService;
  private readonly opsAlert: SecurityOpsAlertService;
  private readonly agentRuns: AgentRunService;
  private readonly now: () => Date;

  constructor(dependencies: SecurityOpsAgentDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SecurityOpsPrisma);
    this.healthSnapshot = dependencies.healthSnapshot ?? opsHealthSnapshotService;
    this.alertSynthesis = dependencies.alertSynthesis ?? securityOpsAlertSynthesisService;
    this.opsAlert = dependencies.opsAlert ?? securityOpsAlertService;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async runReport(input: RunSecurityOpsInput = {}): Promise<SecurityOpsRunResult> {
    const idempotencyKey = input.idempotencyKey ?? `security-ops:${isoDateIdentifier(this.now())}`;
    const begin = await this.agentRuns.beginRun({
      agentType: SECURITY_OPS_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ providerRouting: { synthesis: 'anthropic', allowFallback: false } }),
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { runId: null, status: 'SKIPPED_DISABLED' };
    if (begin.duplicate) return { runId: begin.run.id, status: 'DUPLICATE' };
    if (begin.run.status === 'HALTED_BUDGET') return { runId: begin.run.id, status: 'HALTED_BUDGET' };

    const agentRunId = begin.run.id;
    let snapshot: GroundedOpsSnapshot | null = null;
    let narrative: OpsNarrative | null = null;

    try {
      logger.info({ type: 'security_ops_report_run_started', agentRunId });
      snapshot = await this.healthSnapshot.computeSnapshot({ windowDays: input.windowDays ?? DEFAULT_WINDOW_DAYS });
      logger.info({
        type: 'security_ops_snapshot_computed',
        agentRunId,
        serviceHealth: snapshot.serviceHealth,
        totalUniqueErrors: snapshot.errorSummary.totalUniqueErrors,
      });

      narrative = await this.alertSynthesis.synthesize(snapshot);
      await this.captureUsage(agentRunId, narrative);

      const report = await this.createReport(agentRunId, snapshot, narrative);
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: toJsonValue({ reportId: report.id }) });
      logger.info({ type: 'security_ops_report_completed', agentRunId, reportId: report.id });

      if (shouldAlert(snapshot)) {
        await this.opsAlert.sendAlert({
          subject: 'SheriaBot security/ops alert',
          summary: narrative.summary,
          risks: narrative.risks,
          agentRunId,
        });
      }

      return { runId: agentRunId, status: 'COMPLETED', reportId: report.id };
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) {
        const report = snapshot ? await this.createReport(agentRunId, snapshot, narrative) : undefined;
        logger.warn({ type: 'security_ops_report_failed', agentRunId, reason: error.reason, reportId: report?.id });
        return { runId: agentRunId, status: 'HALTED_BUDGET', reportId: report?.id };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: toJsonValue({ step: 'security_ops_report' }) });
      logger.error({ type: 'security_ops_report_failed', agentRunId, error: message });
      return { runId: agentRunId, status: 'FAILED' };
    }
  }

  async getLatestReport(): Promise<LatestReportRow | null> {
    return this.prisma.agentReport.findFirst({
      where: { run: { agentType: SECURITY_OPS_AGENT_TYPE } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listReports(input: ListReportsInput): Promise<{ reports: LatestReportRow[]; pagination: { page: number; limit: number; total: number; pages: number } }> {
    const where = { run: { agentType: SECURITY_OPS_AGENT_TYPE } };
    const skip = (input.page - 1) * input.limit;
    const [reports, total] = await Promise.all([
      this.prisma.agentReport.findMany({ where, skip, take: input.limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.agentReport.count({ where }),
    ]);
    return { reports, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
  }

  private async captureUsage(agentRunId: string, narrative: OpsNarrative): Promise<void> {
    await this.agentRuns.advanceRun({
      runId: agentRunId,
      inputTokens: narrative.usage.inputTokens,
      outputTokens: narrative.usage.outputTokens,
      costUsd: narrative.usage.costUsd,
      metadata: toJsonValue({ step: 'security_ops_synthesis', provider: narrative.usage.provider, model: narrative.usage.model }),
    });
  }

  private async createReport(agentRunId: string, snapshot: GroundedOpsSnapshot, narrative: OpsNarrative | null): Promise<{ id: string }> {
    return this.agentRuns.createReport({
      agentRunId,
      summary: reportSummary(narrative),
      signals: toJsonValue(snapshot),
      recommendedActions: toJsonValue({ version: 1, notes: ['No individual drafts to review - this report is a synthesized digest.'] }),
      risks: toJsonValue({ version: 1, risks: narrative?.risks ?? [] }),
      humanApproved: false,
    });
  }
}

export const securityOpsAgent = new SecurityOpsAgent();
