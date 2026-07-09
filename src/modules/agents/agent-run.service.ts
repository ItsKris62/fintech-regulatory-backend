import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AgentReport, AgentRun } from '@prisma/client';
import type { Redis } from '@upstash/redis';
import { appConfig } from '@/config/app.config';
import { sendEmail as defaultSendEmail } from '@/lib/email/client';
import type { EmailOptions, EmailResult } from '@/lib/email/client';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { redis as defaultRedis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

const RUN_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const DAILY_COST_TTL_SECONDS = 8 * 24 * 60 * 60;

export const AGENT_RUN_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'HALTED_BUDGET',
  'HALTED_ITERATIONS',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentBudgetConfig {
  maxCostPerRunUsd: number;
  maxCostPerDayUsd: number;
  maxIterationsPerRun: number;
}

export interface BeginAgentRunInput {
  agentType: string;
  idempotencyKey: string;
  organizationId?: string;
  metadata?: Prisma.InputJsonValue;
  estimatedCostUsd?: number;
  retryFailed?: boolean;
}

export interface AdvanceAgentRunInput {
  runId: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface CompleteAgentRunInput {
  runId: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface FailAgentRunInput {
  runId: string;
  error: string;
  metadata?: Prisma.InputJsonValue;
}

export interface CreateAgentReportInput {
  agentRunId: string;
  summary?: string;
  signals?: Prisma.InputJsonValue;
  recommendedActions?: Prisma.InputJsonValue;
  risks?: Prisma.InputJsonValue;
  humanApproved?: boolean;
}

export type BeginAgentRunResult =
  | { started: false; reason: 'agents_disabled' }
  | { started: true; duplicate: boolean; run: AgentRun };

interface LLMCostGuard {
  checkCostLimit(estimatedCost: number): Promise<void>;
}

type SendEmail = (options: EmailOptions) => Promise<EmailResult>;
type AgentRunPrisma = {
  agentRun: Pick<typeof defaultPrisma.agentRun, 'create' | 'findUnique' | 'update' | 'updateMany'>;
  agentReport: Pick<typeof defaultPrisma.agentReport, 'create'>;
};
type AgentRunRedis = Pick<Redis, 'get' | 'set' | 'incrbyfloat' | 'expire'>;

export interface AgentRunServiceDependencies {
  prisma?: AgentRunPrisma;
  redis?: AgentRunRedis;
  llmGateway?: LLMCostGuard;
  sendEmail?: SendEmail;
  budgetConfigProvider?: () => AgentBudgetConfig;
  agentsEnabledProvider?: () => boolean;
  now?: () => Date;
}

export class AgentBudgetHalt extends Error {
  constructor(public readonly reason: string) {
    super(`Agent budget halted: ${reason}`);
    this.name = 'AgentBudgetHalt';
  }
}

export class AgentIterationHalt extends Error {
  constructor(public readonly maxIterations: number) {
    super(`Agent iteration limit exceeded: ${maxIterations}`);
    this.name = 'AgentIterationHalt';
  }
}

function runIdempotencyKey(idempotencyKey: string): string {
  return `sheriabot:agents:run:${idempotencyKey}`;
}

function dailyCostKey(now: Date): string {
  return `sheriabot:agents:cost:${now.toISOString().slice(0, 10)}`;
}

function asNonNegativeNumber(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new AgentBudgetHalt('invalid_cost_or_token_delta');
  return value;
}

function validateBudgetConfig(config: AgentBudgetConfig): AgentBudgetConfig {
  if (!Number.isFinite(config.maxCostPerRunUsd) || config.maxCostPerRunUsd <= 0) {
    throw new AgentBudgetHalt('unreadable_max_cost_per_run');
  }
  if (!Number.isFinite(config.maxCostPerDayUsd) || config.maxCostPerDayUsd <= 0) {
    throw new AgentBudgetHalt('unreadable_max_cost_per_day');
  }
  if (!Number.isInteger(config.maxIterationsPerRun) || config.maxIterationsPerRun <= 0) {
    throw new AgentBudgetHalt('unreadable_max_iterations');
  }
  return config;
}

function defaultBudgetConfig(): AgentBudgetConfig {
  return {
    maxCostPerRunUsd: appConfig.agents.maxCostPerRunUsd,
    maxCostPerDayUsd: appConfig.agents.maxCostPerDayUsd,
    maxIterationsPerRun: appConfig.agents.maxIterationsPerRun,
  };
}

function metadataWithPatch(existing: Prisma.JsonValue, patch: Prisma.InputJsonValue | undefined): Prisma.InputJsonValue | undefined {
  if (patch === undefined) return undefined;
  if (
    existing !== null &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    patch !== null &&
    typeof patch === 'object' &&
    !Array.isArray(patch)
  ) {
    return { ...(existing as Prisma.JsonObject), ...(patch as Prisma.InputJsonObject) };
  }
  return patch;
}

export class AgentRunService {
  private readonly prisma: AgentRunPrisma;
  private readonly redis: AgentRunRedis;
  private readonly llmGateway: LLMCostGuard;
  private readonly sendEmail: SendEmail;
  private readonly budgetConfigProvider: () => AgentBudgetConfig;
  private readonly agentsEnabledProvider: () => boolean;
  private readonly now: () => Date;

  constructor(dependencies: AgentRunServiceDependencies = {}) {
    this.prisma = dependencies.prisma ?? defaultPrisma;
    this.redis = dependencies.redis ?? defaultRedis;
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
    this.sendEmail = dependencies.sendEmail ?? defaultSendEmail;
    this.budgetConfigProvider = dependencies.budgetConfigProvider ?? defaultBudgetConfig;
    this.agentsEnabledProvider = dependencies.agentsEnabledProvider ?? (() => appConfig.features.agentsEnabled);
    this.now = dependencies.now ?? (() => new Date());
  }

  async beginRun(input: BeginAgentRunInput): Promise<BeginAgentRunResult> {
    if (!this.agentsEnabledProvider()) {
      logger.info({ type: 'agent_run_skipped_disabled', agentType: input.agentType, idempotencyKey: input.idempotencyKey });
      return { started: false, reason: 'agents_disabled' };
    }

    const acquired = await this.redis.set(runIdempotencyKey(input.idempotencyKey), '1', {
      ex: RUN_IDEMPOTENCY_TTL_SECONDS,
      nx: true,
    });

    if (acquired === null) {
      const existing = await this.prisma.agentRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (!existing) throw new Error('Agent run idempotency key exists without a persisted run.');

      if (input.retryFailed && existing.status === 'FAILED') {
        const retry = await this.prisma.agentRun.updateMany({
          where: { id: existing.id, status: 'FAILED' },
          data: {
            status: 'RUNNING',
            completedAt: null,
            error: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: new Prisma.Decimal(0),
            iterations: 0,
            metadata: input.metadata,
          },
        });

        if (retry.count === 1) {
          const restarted = await this.prisma.agentRun.findUnique({ where: { id: existing.id } });
          if (!restarted) throw new Error(`Agent run disappeared during retry: ${existing.id}`);
          logger.info({ type: 'agent_run_failed_retry_started', agentRunId: restarted.id, idempotencyKey: input.idempotencyKey });
          return { started: true, duplicate: false, run: restarted };
        }

        const active = await this.prisma.agentRun.findUnique({ where: { id: existing.id } });
        if (active) {
          logger.info({ type: 'agent_run_duplicate_noop', agentRunId: active.id, idempotencyKey: input.idempotencyKey });
          return { started: true, duplicate: true, run: active };
        }
      }

      logger.info({ type: 'agent_run_duplicate_noop', agentRunId: existing.id, idempotencyKey: input.idempotencyKey });
      return { started: true, duplicate: true, run: existing };
    }

    const run = await this.prisma.agentRun.create({
      data: {
        id: randomUUID(),
        agentType: input.agentType,
        status: 'RUNNING',
        idempotencyKey: input.idempotencyKey,
        organizationId: input.organizationId,
        metadata: input.metadata,
      },
    });

    logger.info({ type: 'agent_run_started', agentRunId: run.id, agentType: run.agentType, organizationId: run.organizationId });

    try {
      await this.assertBudgetBeforeWork(input.estimatedCostUsd ?? 0);
    } catch (error: unknown) {
      const reason = error instanceof AgentBudgetHalt ? error.reason : error instanceof Error ? error.message : String(error);
      const halted = await this.markRunStatus(run.id, 'HALTED_BUDGET', reason);
      await this.alertOperator('Agent run halted by budget guard', halted, reason);
      return { started: true, duplicate: false, run: halted };
    }

    return { started: true, duplicate: false, run };
  }

  async advanceRun(input: AdvanceAgentRunInput): Promise<AgentRun> {
    const run = await this.requireRun(input.runId);
    const budget = this.readBudgetConfig();
    const nextIterations = run.iterations + 1;

    if (nextIterations > budget.maxIterationsPerRun) {
      const halted = await this.markRunStatus(run.id, 'HALTED_ITERATIONS', `max_iterations_${budget.maxIterationsPerRun}`);
      await this.alertOperator('Agent run halted by iteration guard', halted, `max_iterations_${budget.maxIterationsPerRun}`);
      throw new AgentIterationHalt(budget.maxIterationsPerRun);
    }

    await this.assertBudgetBeforeWork(input.costUsd ?? 0);
    const updated = await this.updateUsage(run, input, nextIterations, 'RUNNING');
    logger.info({ type: 'agent_run_step', agentRunId: updated.id, iterations: updated.iterations });
    return updated;
  }

  async completeRun(input: CompleteAgentRunInput): Promise<AgentRun> {
    const run = await this.requireRun(input.runId);
    const updated = await this.updateUsage(run, input, run.iterations, 'COMPLETED', this.now());
    logger.info({ type: 'agent_run_completed', agentRunId: updated.id, inputTokens: updated.inputTokens, outputTokens: updated.outputTokens, costUsd: updated.costUsd.toString() });
    return updated;
  }

  async failRun(input: FailAgentRunInput): Promise<AgentRun> {
    const updated = await this.markRunStatus(input.runId, 'FAILED', input.error, input.metadata);
    logger.error({ type: 'agent_run_failed', agentRunId: updated.id, error: input.error });
    await this.alertOperator('Agent run failed', updated, input.error);
    return updated;
  }

  async createReport(input: CreateAgentReportInput): Promise<AgentReport> {
    const report = await this.prisma.agentReport.create({
      data: {
        id: randomUUID(),
        agentRunId: input.agentRunId,
        summary: input.summary,
        signals: input.signals,
        recommendedActions: input.recommendedActions,
        risks: input.risks,
        humanApproved: input.humanApproved ?? false,
      },
    });
    logger.info({ type: 'agent_report_created', agentRunId: input.agentRunId, agentReportId: report.id });
    return report;
  }

  async getRun(runId: string): Promise<(AgentRun & { reports: AgentReport[] }) | null> {
    return this.prisma.agentRun.findUnique({ where: { id: runId }, include: { reports: true } });
  }

  private readBudgetConfig(): AgentBudgetConfig {
    try {
      return validateBudgetConfig(this.budgetConfigProvider());
    } catch (error: unknown) {
      if (error instanceof AgentBudgetHalt) throw error;
      throw new AgentBudgetHalt('unreadable_budget_config');
    }
  }

  private async assertBudgetBeforeWork(estimatedCostUsd: number): Promise<void> {
    const estimatedCost = asNonNegativeNumber(estimatedCostUsd);
    const budget = this.readBudgetConfig();

    if (estimatedCost > budget.maxCostPerRunUsd) {
      throw new AgentBudgetHalt('per_run_cost_exceeded');
    }

    let todayCost: number;
    try {
      const raw = await this.redis.get<string>(dailyCostKey(this.now()));
      todayCost = raw === null ? 0 : Number(raw);
    } catch (error: unknown) {
      logger.error({ type: 'agent_budget_daily_read_failed', error: error instanceof Error ? error.message : String(error) });
      throw new AgentBudgetHalt('daily_cost_unreadable');
    }

    if (!Number.isFinite(todayCost)) throw new AgentBudgetHalt('daily_cost_unreadable');
    if (todayCost + estimatedCost > budget.maxCostPerDayUsd) {
      throw new AgentBudgetHalt('daily_cost_exceeded');
    }

    try {
      await this.llmGateway.checkCostLimit(estimatedCost);
    } catch (error: unknown) {
      logger.error({ type: 'agent_gateway_budget_check_failed', error: error instanceof Error ? error.message : String(error) });
      throw new AgentBudgetHalt('gateway_cost_limit_exceeded');
    }
  }

  private async updateUsage(
    run: AgentRun,
    input: AdvanceAgentRunInput | CompleteAgentRunInput,
    iterations: number,
    status: AgentRunStatus,
    completedAt?: Date,
  ): Promise<AgentRun> {
    const inputTokens = asNonNegativeNumber(input.inputTokens);
    const outputTokens = asNonNegativeNumber(input.outputTokens);
    const costUsd = asNonNegativeNumber(input.costUsd);
    const totalCost = Number(run.costUsd) + costUsd;

    if (costUsd > 0) {
      await this.redis.incrbyfloat(dailyCostKey(this.now()), costUsd);
      await this.redis.expire(dailyCostKey(this.now()), DAILY_COST_TTL_SECONDS);
    }

    return this.prisma.agentRun.update({
      where: { id: run.id },
      data: {
        inputTokens: run.inputTokens + inputTokens,
        outputTokens: run.outputTokens + outputTokens,
        costUsd: new Prisma.Decimal(totalCost.toFixed(6)),
        iterations,
        status,
        completedAt,
        metadata: metadataWithPatch(run.metadata, input.metadata),
      },
    });
  }

  private async markRunStatus(
    runId: string,
    status: AgentRunStatus,
    error: string,
    metadata?: Prisma.InputJsonValue,
  ): Promise<AgentRun> {
    const existing = await this.requireRun(runId);
    return this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        status,
        completedAt: this.now(),
        error,
        metadata: metadataWithPatch(existing.metadata, metadata),
      },
    });
  }

  private async requireRun(runId: string): Promise<AgentRun> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    return run;
  }

  private async alertOperator(subject: string, run: AgentRun, reason: string): Promise<void> {
    try {
      await this.sendEmail({
        to: appConfig.marketing.adminNotificationEmail,
        subject,
        html: `<p>${subject}</p><p>Run: ${run.id}</p><p>Reason: ${reason}</p>`,
        text: `${subject}\nRun: ${run.id}\nReason: ${reason}`,
        tags: [
          { name: 'category', value: 'security' },
          { name: 'type', value: 'agent_failure_alert' },
        ],
      });
      logger.info({ type: 'agent_operator_alert_sent', agentRunId: run.id });
    } catch (error: unknown) {
      logger.error({ type: 'agent_operator_alert_failed', agentRunId: run.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const agentRunService = new AgentRunService();
