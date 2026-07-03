import { aiConfig } from '@/config/ai.config';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import type { GroundedMetricsSnapshot, InsightNarrative } from './types';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface InsightSynthesisDependencies {
  llmGateway?: GatewayLike;
}

interface NarrativeResponse {
  summary: string;
  opportunities: string[];
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
    throw new Error('Product BI narrative response was not JSON.');
  }
}

function parseNarrativeResponse(content: string): NarrativeResponse {
  const parsed = parseJsonObject(content);
  if (!isRecord(parsed)) throw new Error('Product BI narrative response was not an object.');
  const summary = stringValue(parsed.summary);
  if (!summary) throw new Error('Product BI narrative response missing summary.');
  return { summary, opportunities: stringArray(parsed.opportunities), risks: stringArray(parsed.risks) };
}

function usageFrom(result: LLMCompletionResult): InsightNarrative['usage'] {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens).cost,
  };
}

function systemPrompt(): string {
  return `You write a weekly plain-English business-intelligence summary for Chris, synthesizing SheriaBot's own product and workforce metrics.

Grounding rules:
- Describe only the metrics present in the provided snapshot. Never invent a number, percentage, or trend that is not directly computable from the given fields.
- If you notice a correlation between two metrics, phrase it as an observation worth investigating (e.g. "worth checking whether X relates to Y"), never as a causal claim.
- For every upgrade-moment candidate, cite it by organizationId and organizationName (company name) plus the specific metric/limit/periodsAtOrOverLimit values given - never invent a reason beyond what the candidate object states.
- For every churn-risk org, cite the reason field verbatim or a close paraphrase of it - never invent a new reason.
- Omit a claim entirely if it cannot be traced to a field in the snapshot.

PII minimization rule (hard constraint):
- The snapshot you are given contains only organizationId, organization/company names, and aggregate counts or limits. It never contains a contact email, phone number, or a person's individual name.
- Never reference, request, invent, or imply a contact email, phone number, or personal (non-company) name in your output, even if you believe one would be useful context. If you would naturally want that detail, note that a human should look up the contact separately - do not fabricate one.
- Refer to organizations only by their company name or organizationId, never by an inferred contact person.

Return JSON only with keys: summary (string), opportunities (string array), risks (string array).`;
}

function promptFor(snapshot: GroundedMetricsSnapshot): string {
  return JSON.stringify({
    task: 'Synthesize a weekly plain-English BI summary from this metrics snapshot.',
    outputSchema: { summary: 'string', opportunities: 'string array', risks: 'string array' },
    snapshot,
  });
}

export class ProductBiInsightSynthesisService {
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: InsightSynthesisDependencies = {}) {
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  async synthesize(snapshot: GroundedMetricsSnapshot): Promise<InsightNarrative> {
    const result = await this.llmGateway.complete({
      provider: 'anthropic',
      model: aiConfig.models.complexAnalysis,
      allowFallback: false,
      useCase: 'analysis',
      temperature: 0.2,
      maxTokens: 1500,
      systemPrompt: systemPrompt(),
      prompt: promptFor(snapshot),
      metadata: { agent: 'product-bi', windowStart: snapshot.windowStart, windowEnd: snapshot.windowEnd },
    });

    const parsed = parseNarrativeResponse(result.content);
    return {
      summary: parsed.summary,
      opportunities: parsed.opportunities,
      risks: parsed.risks,
      usage: usageFrom(result),
    };
  }
}

export const productBiInsightSynthesisService = new ProductBiInsightSynthesisService();
