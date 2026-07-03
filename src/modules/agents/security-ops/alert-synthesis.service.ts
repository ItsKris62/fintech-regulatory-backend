import { aiConfig } from '@/config/ai.config';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import type { GroundedOpsSnapshot, OpsNarrative } from './types';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface AlertSynthesisDependencies {
  llmGateway?: GatewayLike;
}

interface NarrativeResponse {
  summary: string;
  risks: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
    throw new Error('Security/ops narrative response was not JSON.');
  }
}

function parseNarrativeResponse(content: string): NarrativeResponse {
  const parsed = parseJsonObject(content);
  if (!isRecord(parsed)) throw new Error('Security/ops narrative response was not an object.');
  const summary = stringValue(parsed.summary);
  if (!summary) throw new Error('Security/ops narrative response missing summary.');
  return { summary, risks: stringArray(parsed.risks) };
}

function usageFrom(result: LLMCompletionResult): OpsNarrative['usage'] {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens).cost,
  };
}

function systemPrompt(): string {
  return `You write a short operational digest for Chris, synthesizing SheriaBot's own service-health and agent-workforce metrics.

Grounding rules (evidence over summary):
- Describe only the metrics present in the provided snapshot. Never invent a status, latency figure, error count, or cost that is not directly computable from the given fields.
- Every risk you list must cite the specific field it comes from (e.g. "database check reported status: down", or "sales-growth had 2 HALTED_BUDGET runs this window") - never a vague or generic risk statement.
- If you notice a correlation between two metrics, phrase it as an observation worth investigating, never as a causal claim.
- Omit a claim entirely if it cannot be traced to a field in the snapshot.

PII minimization rule (hard constraint):
- The error summary you are given has already been through two rounds of sanitization and contains no stack traces, connection strings, SQL fragments, emails, or phone numbers - only a short truncated message, an error code, and a count.
- Never reference, request, invent, or imply a customer's personal data, contact detail, or identity in your output, even if an error message seems to hint at one.
- Refer to errors only by their code and truncated message, never by an inferred customer identity.

Return JSON only with keys: summary (string), risks (string array).`;
}

function promptFor(snapshot: GroundedOpsSnapshot): string {
  return JSON.stringify({
    task: 'Synthesize a short operational digest from this service-health and workforce-cost snapshot.',
    outputSchema: { summary: 'string', risks: 'string array' },
    snapshot,
  });
}

export class SecurityOpsAlertSynthesisService {
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: AlertSynthesisDependencies = {}) {
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  async synthesize(snapshot: GroundedOpsSnapshot): Promise<OpsNarrative> {
    const result = await this.llmGateway.complete({
      provider: 'anthropic',
      model: aiConfig.models.complexAnalysis,
      allowFallback: false,
      useCase: 'analysis',
      temperature: 0.2,
      maxTokens: 1000,
      systemPrompt: systemPrompt(),
      prompt: promptFor(snapshot),
      metadata: { agent: 'security-ops', windowStart: snapshot.windowStart, windowEnd: snapshot.windowEnd },
    });

    const parsed = parseNarrativeResponse(result.content);
    return {
      summary: parsed.summary,
      risks: parsed.risks,
      usage: usageFrom(result),
    };
  }
}

export const securityOpsAlertSynthesisService = new SecurityOpsAlertSynthesisService();
