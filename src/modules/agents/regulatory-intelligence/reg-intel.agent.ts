import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import {
  AgentBudgetHalt,
  agentRunService as defaultAgentRunService,
  type AgentRunService,
} from '@/modules/agents/agent-run.service';
import { logger } from '@/utils/logger';
import { corpusGapService, type CorpusGapService } from './corpus-gap.service';
import { impactMatcherService, type ImpactMatcherService } from './impact-matcher.service';
import { signalClassifierService, type SignalClassifierService } from './signal-classifier.service';
import { sourceMonitorService, type SourceMonitorService } from './source-monitor.service';
import type {
  ClassifiedSignalCore,
  CorpusGapResult,
  PilotFintechImpact,
  ProviderUsage,
  RecommendedAction,
  RegIntelRecommendedActionsPayload,
  RegIntelReportPayload,
  RegIntelRisksPayload,
  RegulatorySignalForReport,
  SourceMonitorResult,
} from './types';
import { REG_INTEL_AGENT_TYPE, toJsonValue } from './types';

interface InsertedRegulatorySignalRow {
  id: string;
}

export interface LatestReportRow {
  id: string;
  agentRunId: string;
  summary: string | null;
  signals: Prisma.JsonValue | null;
  recommendedActions: Prisma.JsonValue | null;
  risks: Prisma.JsonValue | null;
  humanApproved: boolean;
  createdAt: Date;
}

export interface RegulatorySignalListRow {
  id: string;
  sourceUrl: string;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: string;
  title: string;
  summary: string;
  severity: string;
  corpusGapDetected: boolean;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
  reviewedAt: Date | null;
}

interface RegIntelPrisma {
  $queryRaw<T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>;
  regulatorySignal: {
    findMany(args: object): Promise<RegulatorySignalListRow[]>;
    count(args: object): Promise<number>;
    update(args: object): Promise<RegulatorySignalListRow>;
  };
  agentReport: {
    findFirst(args: object): Promise<LatestReportRow | null>;
  };
  agentRun: {
    update(args: object): Promise<unknown>;
  };
}

export interface RunRegIntelInput {
  idempotencyKey?: string;
  maxItems?: number;
}

export interface RegIntelRunResult {
  runId: string | null;
  status: 'SKIPPED_DISABLED' | 'DUPLICATE' | 'COMPLETED' | 'HALTED_BUDGET' | 'FAILED';
  reportId?: string;
  signalsCreated: number;
}

export interface ListSignalsInput {
  page: number;
  limit: number;
  jurisdiction?: string;
  severity?: string;
  corpusGap?: boolean;
  status?: string;
}

export interface RegIntelDependencies {
  prisma?: RegIntelPrisma;
  sourceMonitor?: SourceMonitorService;
  classifier?: SignalClassifierService;
  corpusGap?: CorpusGapService;
  impactMatcher?: ImpactMatcherService;
  agentRuns?: AgentRunService;
  now?: () => Date;
}

function usageTotals(usages: ProviderUsage[]): { inputTokens: number; outputTokens: number; costUsd: number } {
  return usages.reduce((totals, usage) => ({
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    costUsd: totals.costUsd + usage.costUsd,
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

function safeDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function severityPriority(severity: string): 'critical' | 'high' | 'medium' | 'low' | 'informational' {
  if (severity === 'critical' || severity === 'high' || severity === 'medium' || severity === 'low') return severity;
  return 'informational';
}

function plainSummary(signals: RegulatorySignalForReport[], sourceResult: SourceMonitorResult): string {
  if (signals.length === 0) {
    return `Regulatory Intelligence scan completed with no new classified regulatory signals. ${sourceResult.unverifiedSourceGaps.length} unverified source gaps require manual review.`;
  }

  const criticalOrHigh = signals.filter((signal) => signal.severityLevel === 'critical' || signal.severityLevel === 'high').length;
  const corpusGaps = signals.filter((signal) => signal.corpusGapDetected).length;
  const affectedPilots = new Set(signals.flatMap((signal) => signal.pilotFintechsAffected.map((impact) => impact.organizationId))).size;
  return `Regulatory Intelligence scan classified ${signals.length} signal(s), including ${criticalOrHigh} critical/high item(s), ${corpusGaps} corpus gap(s), and ${affectedPilots} affected pilot fintech organization(s).`;
}


function serializeSignalForReport(signal: RegulatorySignalForReport): Prisma.InputJsonValue {
  return toJsonValue({
    id: signal.id ?? null,
    sourceUrl: signal.sourceUrl,
    normalizedUrl: signal.normalizedUrl,
    contentHash: signal.contentHash,
    sourceItemId: signal.sourceItem.id,
    sourceMonitorId: signal.sourceItem.monitorId,
    jurisdiction: signal.jurisdiction,
    regulatoryBody: signal.regulatoryBody,
    documentType: signal.documentType,
    title: signal.title,
    summary: signal.summary,
    affectedSectors: signal.affectedSectors,
    affectedObligations: signal.affectedObligations,
    severityLevel: signal.severityLevel,
    effectiveDate: signal.effectiveDate,
    complianceWindowDays: signal.complianceWindowDays,
    corpusGapDetected: signal.corpusGapDetected,
    corpusGapDetails: signal.corpusGapDetails,
    pilotFintechsAffected: signal.pilotFintechsAffected,
    providerTrace: signal.providerTrace,
    status: signal.status,
    sourceItem: {
      publicationDate: signal.sourceItem.publicationDate?.toISOString() ?? null,
      discoveredAt: signal.sourceItem.discoveredAt.toISOString(),
      monitorName: signal.sourceItem.monitorName,
    },
  });
}

function buildRecommendedActions(signals: RegulatorySignalForReport[], sourceResult: SourceMonitorResult, generatedAt: string): RegIntelRecommendedActionsPayload {
  const marketing: RecommendedAction[] = [];
  const sales: RecommendedAction[] = [];
  const corpus: RecommendedAction[] = sourceResult.unverifiedSourceGaps.map((gap) => ({
    category: 'corpus',
    actionType: 'manual_source_verification',
    priority: 'medium',
    brief: `${gap.name} is marked NEEDS_VERIFICATION and was not activated. Chris should verify the source URL/feed manually before monitoring.`,
    sourceUrl: gap.sourceUrl ?? undefined,
  }));

  for (const signal of signals) {
    if (signal.severityLevel === 'critical' || signal.severityLevel === 'high' || signal.severityLevel === 'medium') {
      marketing.push({
        category: 'marketing',
        signalId: signal.id,
        actionType: 'newsletter_item',
        priority: severityPriority(signal.severityLevel),
        brief: `Draft a reviewed newsletter item explaining ${signal.title}.`,
        sourceUrl: signal.sourceUrl,
      });
    }

    for (const impact of signal.pilotFintechsAffected) {
      sales.push({
        category: 'sales',
        signalId: signal.id,
        organizationId: impact.organizationId,
        actionType: 'targeted_outreach',
        priority: severityPriority(signal.severityLevel),
        brief: `Trigger outreach to ${impact.organizationName}: ${impact.reason}`,
        sourceUrl: signal.sourceUrl,
      });
    }

    for (const missing of signal.corpusGapDetails.missingFrameworks) {
      corpus.push({
        category: 'corpus',
        signalId: signal.id,
        actionType: 'missing_framework_review',
        priority: severityPriority(signal.severityLevel),
        brief: `Verify and ingest missing framework: ${missing}.`,
        sourceUrl: signal.sourceUrl,
      });
    }
  }

  return { version: 1, generatedAt, marketing, sales, corpus };
}

function buildRisks(signals: RegulatorySignalForReport[], sourceResult: SourceMonitorResult, generatedAt: string): RegIntelRisksPayload {
  return {
    version: 1,
    generatedAt,
    critical: signals.filter((signal) => signal.severityLevel === 'critical').map((signal) => signal.summary),
    high: signals.filter((signal) => signal.severityLevel === 'high').map((signal) => signal.summary),
    budgetOrCoverageNotes: sourceResult.unverifiedSourceGaps.map((gap) => `${gap.name} is not monitored because it is marked NEEDS_VERIFICATION.`),
    sourceFailures: sourceResult.monitorSummaries
      .filter((summary) => summary.failureCount > 0)
      .map((summary) => `${summary.name}: ${summary.errorMessage ?? summary.status}`),
  };
}

export class RegulatoryIntelligenceAgent {
  private readonly prisma: RegIntelPrisma;
  private readonly sourceMonitor: SourceMonitorService;
  private readonly classifier: SignalClassifierService;
  private readonly corpusGap: CorpusGapService;
  private readonly impactMatcher: ImpactMatcherService;
  private readonly agentRuns: AgentRunService;
  private readonly now: () => Date;

  constructor(dependencies: RegIntelDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as RegIntelPrisma);
    this.sourceMonitor = dependencies.sourceMonitor ?? sourceMonitorService;
    this.classifier = dependencies.classifier ?? signalClassifierService;
    this.corpusGap = dependencies.corpusGap ?? corpusGapService;
    this.impactMatcher = dependencies.impactMatcher ?? impactMatcherService;
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async runScan(input: RunRegIntelInput = {}): Promise<RegIntelRunResult> {
    const idempotencyKey = input.idempotencyKey ?? `reg-intel:${this.now().toISOString().slice(0, 10)}`;
    const begin = await this.agentRuns.beginRun({
      agentType: REG_INTEL_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ providerRouting: { scanning: 'gemini', analysis: 'anthropic', allowFallback: false } }),
      estimatedCostUsd: 0,
    });

    if (!begin.started) return { runId: null, status: 'SKIPPED_DISABLED', signalsCreated: 0 };
    if (begin.duplicate) return { runId: begin.run.id, status: 'DUPLICATE', signalsCreated: 0 };
    if (begin.run.status === 'HALTED_BUDGET') return { runId: begin.run.id, status: 'HALTED_BUDGET', signalsCreated: 0 };

    const agentRunId = begin.run.id;
    const persistedSignals: RegulatorySignalForReport[] = [];
    let sourceResult: SourceMonitorResult = { items: [], unverifiedSourceGaps: [], monitorSummaries: [] };

    try {
      logger.info({ type: 'reg_intel_scan_started', agentRunId });
      sourceResult = await this.sourceMonitor.scanSources(agentRunId);
      await this.agentRuns.advanceRun({ runId: agentRunId, metadata: toJsonValue({ step: 'source_scan', sourceItems: sourceResult.items.length }) });

      const sourceItems = input.maxItems ? sourceResult.items.slice(0, input.maxItems) : sourceResult.items;
      const scan = await this.classifier.scanItems(agentRunId, sourceItems);
      if (scan.usage) {
        await this.agentRuns.advanceRun({
          runId: agentRunId,
          inputTokens: scan.usage.inputTokens,
          outputTokens: scan.usage.outputTokens,
          costUsd: scan.usage.costUsd,
          metadata: toJsonValue({ step: 'gemini_scan', provider: scan.usage.provider, model: scan.usage.model }),
        });
      }

      const analysis = await this.classifier.deepAnalyze(agentRunId, scan.candidates, scan.usage);
      const analysisTotals = usageTotals(analysis.usage);
      if (analysis.usage.length > 0) {
        await this.agentRuns.advanceRun({
          runId: agentRunId,
          inputTokens: analysisTotals.inputTokens,
          outputTokens: analysisTotals.outputTokens,
          costUsd: analysisTotals.costUsd,
          metadata: toJsonValue({ step: 'anthropic_analysis', provider: 'anthropic', calls: analysis.usage.length }),
        });
      }

      for (const signal of analysis.signals) {
        const corpus = await this.corpusGap.checkSignal(agentRunId, signal);
        const impacts = await this.impactMatcher.matchSignal(agentRunId, signal);
        const reportSignal = await this.persistSignal(agentRunId, signal, corpus, impacts);
        if (reportSignal) {
          persistedSignals.push(reportSignal);
          await this.agentRuns.advanceRun({
            runId: agentRunId,
            metadata: toJsonValue({ step: 'signal_persisted', signalId: reportSignal.id }),
          });
        }
      }

      const report = await this.createDraftReport(agentRunId, persistedSignals, sourceResult);
      await this.agentRuns.completeRun({ runId: agentRunId, metadata: toJsonValue({ reportId: report.id, signalsCreated: persistedSignals.length }) });
      logger.info({ type: 'reg_intel_scan_completed', agentRunId, reportId: report.id, signalsCreated: persistedSignals.length });
      return { runId: agentRunId, status: 'COMPLETED', reportId: report.id, signalsCreated: persistedSignals.length };
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) {
        const report = await this.createDraftReport(agentRunId, persistedSignals, sourceResult);
        await this.markBudgetHalted(agentRunId, error.reason, report.id);
        logger.warn({ type: 'reg_intel_scan_halted_budget', agentRunId, reason: error.reason, reportId: report.id });
        return { runId: agentRunId, status: 'HALTED_BUDGET', reportId: report.id, signalsCreated: persistedSignals.length };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({ runId: agentRunId, error: message, metadata: toJsonValue({ step: 'reg_intel_scan' }) });
      logger.error({ type: 'reg_intel_scan_failed', agentRunId, error: message });
      return { runId: agentRunId, status: 'FAILED', signalsCreated: persistedSignals.length };
    }
  }

  async getLatestReport(): Promise<LatestReportRow | null> {
    return this.prisma.agentReport.findFirst({
      where: { run: { agentType: REG_INTEL_AGENT_TYPE } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listSignals(input: ListSignalsInput): Promise<{ signals: RegulatorySignalListRow[]; pagination: { page: number; limit: number; total: number; pages: number } }> {
    const where: Record<string, unknown> = {};
    if (input.jurisdiction) where.jurisdiction = input.jurisdiction;
    if (input.severity) where.severity = input.severity;
    if (input.corpusGap !== undefined) where.corpusGapDetected = input.corpusGap;
    if (input.status) where.status = input.status;
    const skip = (input.page - 1) * input.limit;
    const [signals, total] = await Promise.all([
      this.prisma.regulatorySignal.findMany({ where, skip, take: input.limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.regulatorySignal.count({ where }),
    ]);
    return { signals, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
  }

  async acknowledgeSignal(signalId: string): Promise<RegulatorySignalListRow> {
    return this.prisma.regulatorySignal.update({
      where: { id: signalId },
      data: { status: 'REVIEWED', reviewedAt: this.now() },
    });
  }

  private async persistSignal(
    agentRunId: string,
    signal: ClassifiedSignalCore,
    corpus: CorpusGapResult,
    pilotFintechsAffected: PilotFintechImpact[],
  ): Promise<RegulatorySignalForReport | null> {
    const id = randomUUID();
    const effectiveDate = safeDate(signal.effectiveDate);

    const inserted = await this.prisma.$queryRaw<InsertedRegulatorySignalRow[]>`
      INSERT INTO "RegulatorySignal" (
        "id", "sourceUrl", "normalizedUrl", "contentHash", "sourceItemId", "sourceMonitorId",
        "jurisdiction", "regulatoryBody", "documentType", "title", "summary", "severity",
        "affectedSectors", "affectedObligations", "effectiveDate", "complianceWindowDays",
        "corpusGapDetected", "corpusGapDetails", "pilotFintechsAffected", "rawContent",
        "agentRunId", "status", "providerTrace", "processedAt"
      ) VALUES (
        ${id}, ${signal.sourceUrl}, ${signal.normalizedUrl}, ${signal.contentHash}, ${signal.sourceItem.id}, ${signal.sourceItem.monitorId},
        ${signal.jurisdiction}, ${signal.regulatoryBody}, ${signal.documentType}, ${signal.title}, ${signal.summary}, ${signal.severityLevel},
        ${JSON.stringify(signal.affectedSectors)}::jsonb, ${JSON.stringify(signal.affectedObligations)}::jsonb, ${effectiveDate}, ${signal.complianceWindowDays},
        ${corpus.corpusGapDetected}, ${JSON.stringify(corpus.corpusGapDetails)}::jsonb, ${JSON.stringify(pilotFintechsAffected)}::jsonb, ${signal.rawContent},
        ${agentRunId}, 'NEW', ${JSON.stringify(signal.providerTrace)}::jsonb, ${this.now()}
      )
      ON CONFLICT ("sourceUrl", "contentHash") DO NOTHING
      RETURNING "id"
    `;

    if (inserted.length === 0) {
      logger.info({ type: 'reg_intel_signal_dedup_skipped', agentRunId, sourceUrl: signal.sourceUrl, contentHash: signal.contentHash });
      return null;
    }

    return {
      ...signal,
      ...corpus,
      id: inserted[0].id,
      status: 'NEW',
      pilotFintechsAffected,
    };
  }

  private async createDraftReport(agentRunId: string, signals: RegulatorySignalForReport[], sourceResult: SourceMonitorResult): Promise<{ id: string }> {
    const generatedAt = this.now().toISOString();
    const summary = plainSummary(signals, sourceResult);
    const signalPayload: RegIntelReportPayload = { version: 1, generatedAt, agentRunId, signals: signals.map(serializeSignalForReport) };
    const recommendedActions = buildRecommendedActions(signals, sourceResult, generatedAt);
    const risks = buildRisks(signals, sourceResult, generatedAt);

    return this.agentRuns.createReport({
      agentRunId,
      summary,
      signals: toJsonValue(signalPayload),
      recommendedActions: toJsonValue(recommendedActions),
      risks: toJsonValue(risks),
      humanApproved: false,
    });
  }

  private async markBudgetHalted(agentRunId: string, reason: string, reportId: string): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: agentRunId },
      data: {
        status: 'HALTED_BUDGET',
        completedAt: this.now(),
        error: reason,
        metadata: { budgetHaltReason: reason, partialReportId: reportId },
      },
    });
  }
}

export const regulatoryIntelligenceAgent = new RegulatoryIntelligenceAgent();