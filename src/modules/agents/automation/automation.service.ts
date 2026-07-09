import { TRPCError } from '@trpc/server';
import type { AgentRun, Prisma } from '@prisma/client';
import { agentRunService as defaultAgentRunService, type AgentRunService } from '@/modules/agents/agent-run.service';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { logger } from '@/utils/logger';
import { deriveGenerateIdempotencyKey } from './idempotency';
import { AUTOMATION_AGENT_TYPE, mapTaskTypeToUseCase, toJsonValue } from './types';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface LogAutomationEventInput {
  workflowKey: string;
  event: string;
  payload: Record<string, unknown>;
  executionId: string;
}

export interface GenerateAutomationContentInput {
  workflowKey: string;
  taskType: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

export interface GenerateAutomationContentResult {
  result: string;
  providerUsed: string;
  modelUsed: string;
}

interface CompletedRunMetadata {
  result: string;
  providerUsed: string;
  modelUsed: string;
}

function isCompletedRunMetadata(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject & CompletedRunMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.result === 'string' &&
    typeof candidate.providerUsed === 'string' &&
    typeof candidate.modelUsed === 'string'
  );
}

export interface AutomationServiceDependencies {
  agentRuns?: AgentRunService;
  llmGateway?: GatewayLike;
}

export class AutomationService {
  private readonly agentRuns: AgentRunService;
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: AutomationServiceDependencies = {}) {
    this.agentRuns = dependencies.agentRuns ?? defaultAgentRunService;
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  /**
   * Writes exactly one structured log line for n8n automation activity.
   *
   * This does NOT call agentRunService or llmGateway in any form: it is a
   * log write only, not an LLM-invoking capability, so it never goes through
   * AGENTS_ENABLED or the agent budget/iteration guards that gate beginRun().
   */
  logEvent(input: LogAutomationEventInput): { received: true } {
    logger.info({
      type: 'automation_event',
      workflowKey: input.workflowKey,
      event: input.event,
      executionId: input.executionId,
      payload: input.payload,
    });
    return { received: true };
  }

  async generate(input: GenerateAutomationContentInput): Promise<GenerateAutomationContentResult> {
    const idempotencyKey = deriveGenerateIdempotencyKey(input);

    const begin = await this.agentRuns.beginRun({
      agentType: AUTOMATION_AGENT_TYPE,
      idempotencyKey,
      metadata: toJsonValue({ workflowKey: input.workflowKey, taskType: input.taskType }),
      estimatedCostUsd: 0,
      retryFailed: true,
    });

    if (!begin.started) {
      logger.info({ type: 'automation_generate_rejected', reason: begin.reason, workflowKey: input.workflowKey });
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Automation generation is currently unavailable.' });
    }

    if (begin.duplicate) {
      return this.resolveDuplicate(begin.run);
    }

    if (begin.run.status === 'HALTED_BUDGET') {
      logger.warn({ type: 'automation_generate_halted_budget', agentRunId: begin.run.id, workflowKey: input.workflowKey });
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Automation generation budget exceeded. Try again later.' });
    }

    const agentRunId = begin.run.id;
    const useCase = mapTaskTypeToUseCase(input.taskType);

    let result: LLMCompletionResult;
    try {
      result = await this.llmGateway.complete({
        provider: 'anthropic',
        useCase,
        allowFallback: false,
        systemPrompt: input.systemPrompt,
        prompt: input.userPrompt,
        maxTokens: input.maxTokens,
        metadata: { agent: AUTOMATION_AGENT_TYPE, workflowKey: input.workflowKey, taskType: input.taskType },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.agentRuns.failRun({
        runId: agentRunId,
        error: message,
        metadata: toJsonValue({ workflowKey: input.workflowKey, taskType: input.taskType }),
      });
      logger.error({ type: 'automation_generate_failed', agentRunId, workflowKey: input.workflowKey, error: message });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Automation generation failed.' });
    }

    const { cost } = calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens);

    await this.agentRuns.completeRun({
      runId: agentRunId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: cost,
      metadata: toJsonValue({
        workflowKey: input.workflowKey,
        taskType: input.taskType,
        providerUsed: result.provider,
        modelUsed: result.model,
        result: result.content,
      }),
    });

    logger.info({
      type: 'automation_generate_completed',
      agentRunId,
      workflowKey: input.workflowKey,
      taskType: input.taskType,
      provider: result.provider,
      model: result.model,
    });

    return { result: result.content, providerUsed: result.provider, modelUsed: result.model };
  }

  /**
   * A duplicate beginRun() result means an identical request already exists.
   * This branch never calls llmGateway  -  a completed run replays its stored
   * result; any other status is rejected so a second generation is never
   * triggered for the same idempotency key.
   */
  private resolveDuplicate(run: AgentRun): GenerateAutomationContentResult {
    if (run.status !== 'COMPLETED') {
      logger.warn({ type: 'automation_generate_duplicate_not_completed', agentRunId: run.id, status: run.status });
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A matching automation generation request is already in progress or did not complete. Retry later.',
      });
    }

    if (!isCompletedRunMetadata(run.metadata)) {
      logger.error({ type: 'automation_generate_duplicate_missing_result', agentRunId: run.id });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Automation generation result unavailable for replay.' });
    }

    logger.info({ type: 'automation_generate_duplicate_replay', agentRunId: run.id });
    return {
      result: run.metadata.result,
      providerUsed: run.metadata.providerUsed,
      modelUsed: run.metadata.modelUsed,
    };
  }
}

export const automationService = new AutomationService();
