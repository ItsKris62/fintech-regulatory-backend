import { aiConfig } from '@/config/ai.config';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import type { DecisionNeeded, RankedAction, SourceAgentType, SourceReportExtract, WeeklyBrief } from './types';
import { SOURCE_AGENT_TYPES } from './types';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface BriefSynthesisDependencies {
  llmGateway?: GatewayLike;
}

interface BriefResponse {
  summary: string;
  wins: string[];
  rankedActions: RankedAction[];
  decisionsNeeded: DecisionNeeded[];
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

function isSourceAgentType(value: unknown): value is SourceAgentType {
  return typeof value === 'string' && (SOURCE_AGENT_TYPES as readonly string[]).includes(value);
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
    throw new Error('Weekly brief response was not JSON.');
  }
}

/**
 * Validates every ranked action / decision needed positively cites a real
 * source report - sourceAgentType must be one of the five known types, and
 * sourceReportId must exactly match a reportId actually present in the
 * sources passed in (never a reportId Claude could have invented, and never
 * a citation of a source that had no report available). Throws rather than
 * silently dropping a malformed item - evidence over summary is a hard
 * constraint here, not a best-effort one.
 */
function parseAndValidateItems<TField extends string>(
  raw: unknown,
  textField: TField,
  validReportIdsByAgentType: ReadonlyMap<SourceAgentType, string>,
): Array<{ [K in TField]: string } & { sourceAgentType: SourceAgentType; sourceReportId: string }> {
  if (!Array.isArray(raw)) throw new Error('Weekly brief response field was not an array.');

  return raw.map((rawItem) => {
    if (!isRecord(rawItem)) throw new Error('Weekly brief item was not an object.');
    const text = stringValue(rawItem[textField]);
    if (!text) throw new Error(`Weekly brief item missing ${textField}.`);

    const sourceAgentType = rawItem.sourceAgentType;
    if (!isSourceAgentType(sourceAgentType)) {
      throw new Error(`Weekly brief item cited an unknown sourceAgentType: ${String(sourceAgentType)}.`);
    }

    const expectedReportId = validReportIdsByAgentType.get(sourceAgentType);
    const sourceReportId = stringValue(rawItem.sourceReportId);
    if (!expectedReportId || sourceReportId !== expectedReportId) {
      throw new Error(`Weekly brief item cited sourceReportId "${String(rawItem.sourceReportId)}" for ${sourceAgentType}, which does not match a real available report.`);
    }

    return { [textField]: text, sourceAgentType, sourceReportId } as { [K in TField]: string } & { sourceAgentType: SourceAgentType; sourceReportId: string };
  });
}

function parseBriefResponse(content: string, sources: SourceReportExtract[]): BriefResponse {
  const parsed = parseJsonObject(content);
  if (!isRecord(parsed)) throw new Error('Weekly brief response was not an object.');
  const summary = stringValue(parsed.summary);
  if (!summary) throw new Error('Weekly brief response missing summary.');

  const validReportIdsByAgentType = new Map<SourceAgentType, string>();
  for (const source of sources) {
    if (source.reportId) validReportIdsByAgentType.set(source.agentType, source.reportId);
  }

  return {
    summary,
    wins: stringArray(parsed.wins),
    rankedActions: parseAndValidateItems(parsed.rankedActions ?? [], 'action', validReportIdsByAgentType),
    decisionsNeeded: parseAndValidateItems(parsed.decisionsNeeded ?? [], 'decision', validReportIdsByAgentType),
  };
}

function usageFrom(result: LLMCompletionResult): WeeklyBrief['usage'] {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens).cost,
  };
}

function systemPrompt(): string {
  return `You write SheriaBot's weekly Chief of Staff brief for Chris, synthesizing the latest report from each of five specialist agents into one digest: wins, risks, decisions needed from Chris, and ranked actions.

Grounding rules (evidence over summary):
- Use only the summary text, note strings, and item counts provided for each source - never invent a number, win, or risk not traceable to a given field.
- Every entry in rankedActions and decisionsNeeded MUST include sourceAgentType (exactly one of: regulatory-intelligence, marketing, sales-growth, product-bi, security-ops) and sourceReportId (the exact reportId given for that source in the input - never invent, guess, or reuse a different source's reportId).
- If a source's reportId is null (no report available yet for that agent), you may mention it exists but has no report yet in the summary, but you must NEVER cite it in rankedActions or decisionsNeeded - there is nothing real to cite.
- Phrase any correlation you notice across sources as an observation worth investigating, never as a causal claim.
- Omit a claim entirely if it cannot be traced to a field in the provided sources.

Return JSON only with keys: summary (string), wins (string array), rankedActions (array of {action, sourceAgentType, sourceReportId}), decisionsNeeded (array of {decision, sourceAgentType, sourceReportId}).`;
}

function promptFor(sources: SourceReportExtract[]): string {
  return JSON.stringify({
    task: 'Synthesize this week\'s Chief of Staff brief from these five source-agent report extracts.',
    outputSchema: {
      summary: 'string',
      wins: 'string array',
      rankedActions: '[{action, sourceAgentType, sourceReportId}]',
      decisionsNeeded: '[{decision, sourceAgentType, sourceReportId}]',
    },
    sources,
  });
}

export class ChiefOfStaffBriefSynthesisService {
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: BriefSynthesisDependencies = {}) {
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  async synthesize(sources: SourceReportExtract[]): Promise<WeeklyBrief> {
    const result = await this.llmGateway.complete({
      provider: 'anthropic',
      model: aiConfig.models.complexAnalysis,
      allowFallback: false,
      useCase: 'analysis',
      temperature: 0.2,
      maxTokens: 2000,
      systemPrompt: systemPrompt(),
      prompt: promptFor(sources),
      metadata: { agent: 'chief-of-staff' },
    });

    const parsed = parseBriefResponse(result.content, sources);
    return {
      summary: parsed.summary,
      wins: parsed.wins,
      rankedActions: parsed.rankedActions,
      decisionsNeeded: parsed.decisionsNeeded,
      usage: usageFrom(result),
    };
  }
}

export const chiefOfStaffBriefSynthesisService = new ChiefOfStaffBriefSynthesisService();
