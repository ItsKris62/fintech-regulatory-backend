import { aiConfig } from '@/config/ai.config';
import { calculateCost } from '@/lib/ai/gateway/pricing';
import { llmGateway as defaultLlmGateway } from '@/lib/ai/gateway/llm-gateway';
import type { LLMCompletionRequest, LLMCompletionResult } from '@/lib/ai/gateway/types';
import type { DraftContent, GroundedMarketingSignal, MarketingContentType } from './types';
import { toJsonValue } from './types';

interface GatewayLike {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResult>;
}

export interface ContentDrafterDependencies {
  llmGateway?: GatewayLike;
}

interface DraftResponse {
  title: string;
  body: string;
  brief: string;
  templateVariables?: {
    updateTitle?: string;
    regulatorName?: string;
    publishedDate?: string;
    summary?: string;
    whoAffected?: string;
    ctaUrl?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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
    throw new Error('Marketing draft response was not JSON.');
  }
}

function parseDraftResponse(content: string): DraftResponse {
  const parsed = parseJsonObject(content);
  if (!isRecord(parsed)) throw new Error('Marketing draft response was not an object.');
  const title = stringValue(parsed.title);
  const body = stringValue(parsed.body);
  const brief = stringValue(parsed.brief);
  if (!title || !body || !brief) throw new Error('Marketing draft response missing title, body, or brief.');

  const response: DraftResponse = { title, body, brief };
  if (isRecord(parsed.templateVariables)) {
    response.templateVariables = {
      updateTitle: stringValue(parsed.templateVariables.updateTitle) ?? undefined,
      regulatorName: stringValue(parsed.templateVariables.regulatorName) ?? undefined,
      publishedDate: stringValue(parsed.templateVariables.publishedDate) ?? undefined,
      summary: stringValue(parsed.templateVariables.summary) ?? undefined,
      whoAffected: stringValue(parsed.templateVariables.whoAffected) ?? undefined,
      ctaUrl: stringValue(parsed.templateVariables.ctaUrl) ?? undefined,
    };
  }
  return response;
}

function usageFrom(result: LLMCompletionResult): DraftContent['usage'] {
  return {
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: calculateCost(result.provider, result.model, result.usage.inputTokens, result.usage.outputTokens).cost,
  };
}

function systemPrompt(contentType: MarketingContentType): string {
  return `You draft SheriaBot marketing copy for Kenyan fintech founders and compliance teams.

Tone reference: use docs/blog-launch-seed.md only as a brand-voice reference: plain-English, founder-facing, direct, practical, and suitable for a soft "Pro Tip" style SheriaBot mention. The facts, figures, dates, URLs, examples, and claims in that file are placeholders and unapproved. Do not use or repeat any fact from that file.

Grounding rules:
- Use only facts present in the provided RegulatorySignal fields.
- Cite the regulatory body and jurisdiction by name when drafting.
- Do not invent publication dates, effective dates, deadlines, affected sectors, obligations, penalties, or figures.
- Never state a specific fine or penalty amount unless that exact amount appears verbatim in signal.summary or signal.affectedObligations.
- If effectiveDate is null, do not imply a date.
- If complianceWindowDays is null, do not imply a deadline.
- Omit a claim if it cannot be traced to one of the provided signal fields.
- Keep the tone informational and not alarmist.
- End with a soft, non-pushy SheriaBot mention only where natural.

Return JSON only. Content type: ${contentType}.`;
}

function promptFor(contentType: MarketingContentType, signal: GroundedMarketingSignal): string {
  const task = contentType === 'newsletter_item'
    ? 'Draft a newsletter item for The Kenyan Compliance Brief. Also include templateVariables matching the existing COMPLIANCE_UPDATE campaign template shape.'
    : 'Draft a plain-text LinkedIn post ready to copy and paste. Do not include markdown tables or campaign template variables.';

  return JSON.stringify({
    task,
    outputSchema: contentType === 'newsletter_item'
      ? {
        title: 'string',
        body: 'string',
        brief: 'string',
        templateVariables: {
          updateTitle: 'string',
          regulatorName: 'string',
          publishedDate: 'string; use "Not specified" if the signal has no effectiveDate or publication date field',
          summary: 'string',
          whoAffected: 'string',
          ctaUrl: 'string; use https://sheriabot.ai only if a CTA URL is needed',
        },
      }
      : { title: 'string', body: 'string', brief: 'string' },
    signal,
  });
}

export class MarketingContentDrafterService {
  private readonly llmGateway: GatewayLike;

  constructor(dependencies: ContentDrafterDependencies = {}) {
    this.llmGateway = dependencies.llmGateway ?? defaultLlmGateway;
  }

  async draftNewsletterItem(signal: GroundedMarketingSignal): Promise<DraftContent> {
    return this.draft('newsletter_item', signal);
  }

  async draftLinkedInPost(signal: GroundedMarketingSignal): Promise<DraftContent> {
    return this.draft('linkedin_post', signal);
  }

  private async draft(contentType: MarketingContentType, signal: GroundedMarketingSignal): Promise<DraftContent> {
    const result = await this.llmGateway.complete({
      provider: 'anthropic',
      model: aiConfig.models.complexAnalysis,
      allowFallback: false,
      useCase: 'analysis',
      temperature: 0.2,
      maxTokens: contentType === 'newsletter_item' ? 1800 : 1200,
      systemPrompt: systemPrompt(contentType),
      prompt: promptFor(contentType, signal),
      metadata: { agent: 'marketing', contentType, sourceSignalIds: [signal.id] },
    });

    const parsed = parseDraftResponse(result.content);
    return {
      title: parsed.title,
      body: parsed.body,
      brief: parsed.brief,
      metadata: toJsonValue({
        contentType,
        sourceSignalIds: [signal.id],
        templateKey: contentType === 'newsletter_item' ? 'COMPLIANCE_UPDATE' : null,
        templateVariables: parsed.templateVariables ?? null,
        groundingFields: ['title', 'summary', 'affectedSectors', 'affectedObligations', 'severity', 'effectiveDate', 'complianceWindowDays', 'regulatoryBody', 'jurisdiction'],
      }),
      usage: usageFrom(result),
    };
  }
}

export const marketingContentDrafterService = new MarketingContentDrafterService();