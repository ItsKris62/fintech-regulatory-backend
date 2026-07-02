import { aiConfig } from '@/config/ai.config';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import type { EngagementContext, GroundedSalesProspect, OutreachDraftContent, SalesDraftPriority } from './types';
import { SALES_DRAFT_PRIORITIES, toJsonValue } from './types';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface OutreachDrafterDependencies {
  llmGateway?: GatewayLike;
}

interface DraftResponse {
  subject: string;
  body: string;
  priority: SalesDraftPriority;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isPriority(value: unknown): value is SalesDraftPriority {
  return typeof value === 'string' && (SALES_DRAFT_PRIORITIES as readonly string[]).includes(value);
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
    throw new Error('Sales outreach draft response was not JSON.');
  }
}

function parseDraftResponse(content: string): DraftResponse {
  const parsed = parseJsonObject(content);
  if (!isRecord(parsed)) throw new Error('Sales outreach draft response was not an object.');
  const subject = stringValue(parsed.subject);
  const body = stringValue(parsed.body);
  if (!subject || !body) throw new Error('Sales outreach draft response missing subject or body.');
  if (!isPriority(parsed.priority)) throw new Error('Sales outreach draft response missing a valid priority.');
  return { subject, body, priority: parsed.priority };
}

function usageFrom(result: LLMCompletionResult): OutreachDraftContent['usage'] {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens).cost,
  };
}

function systemPrompt(): string {
  return `You draft SheriaBot sales outreach copy for Chris to review and send manually to pilot fintech founders and compliance leads.

Tone reference: use docs/blog-launch-seed.md only as a brand-voice reference: plain-English, founder-facing, direct, practical. The facts, figures, dates, URLs, examples, and claims in that file are placeholders and unapproved. Do not use or repeat any fact from that file.

Grounding rules:
- Use only facts present in the provided prospect fields (regulatory signal, organization, engagement).
- Reference the specific regulatory trigger by name (regulatoryBody, jurisdiction, title).
- Do not invent effective dates, deadlines, penalties, engagement history, contact history, or urgency not present in the provided fields.
- If effectiveDate is null, do not imply a date. If complianceWindowDays is null, do not imply a deadline.
- If engagement.available is false, do not mention login activity, usage, or engagement at all.
- If engagement.available is true, you may reference eventCount7d or lastSeenAt only as given, never embellished.
- Omit a claim if it cannot be traced to one of the provided fields.
- Keep the tone informational and consultative, never alarmist or pushy.
- Suggest exactly ONE clear next step (e.g. a short gap-analysis walkthrough). Never propose a hard close, discount, or contract ask.
- priority must be exactly one of "high", "medium", "low", matching the prospect's signal severity as given.

Return JSON only with keys: subject, body, priority.`;
}

function promptFor(prospect: GroundedSalesProspect, engagement: EngagementContext): string {
  return JSON.stringify({
    task: 'Draft a short personalized outreach email for Chris to review and send manually. Do not include a signature block beyond a plain sign-off.',
    outputSchema: { subject: 'string', body: 'string', priority: 'high | medium | low' },
    prospect,
    engagement,
  });
}

export class SalesOutreachDrafterService {
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: OutreachDrafterDependencies = {}) {
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  async draftOutreach(prospect: GroundedSalesProspect, engagement: EngagementContext): Promise<OutreachDraftContent> {
    const result = await this.llmGateway.complete({
      provider: 'anthropic',
      model: aiConfig.models.complexAnalysis,
      allowFallback: false,
      useCase: 'analysis',
      temperature: 0.2,
      maxTokens: 900,
      systemPrompt: systemPrompt(),
      prompt: promptFor(prospect, engagement),
      metadata: { agent: 'sales', signalId: prospect.signalId, organizationId: prospect.organizationId },
    });

    const parsed = parseDraftResponse(result.content);
    return {
      subject: parsed.subject,
      body: parsed.body,
      priority: parsed.priority,
      metadata: toJsonValue({
        signalId: prospect.signalId,
        organizationId: prospect.organizationId,
        engagementAvailable: engagement.available,
        groundingFields: [
          'title', 'summary', 'severity', 'regulatoryBody', 'jurisdiction', 'effectiveDate',
          'complianceWindowDays', 'reason', 'organizationName', 'organizationType', 'industry',
        ],
      }),
      usage: usageFrom(result),
    };
  }
}

export const salesOutreachDrafterService = new SalesOutreachDrafterService();
