import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionRequest } from '@/lib/ai/gateway/types';
import { MarketingContentDrafterService } from './content-drafter.service';
import type { GroundedMarketingSignal } from './types';

function signal(): GroundedMarketingSignal {
  return {
    id: 'sig-1',
    sourceUrl: 'https://centralbank.go.ke/notice',
    jurisdiction: 'Kenya',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK reporting notice',
    summary: 'CBK issued a notice about payment reporting expectations.',
    severity: 'high',
    affectedSectors: ['payments'],
    affectedObligations: ['reporting'],
    effectiveDate: null,
    complianceWindowDays: null,
    status: 'NEW',
  };
}

describe('MarketingContentDrafterService', () => {
  it('uses Claude only and sends a source-only grounded prompt', async () => {
    const requests: LLMCompletionRequest[] = [];
    const complete = vi.fn(async (request: LLMCompletionRequest) => {
      requests.push(request);
      return {
        content: JSON.stringify({
          title: 'CBK reporting notice',
          body: 'CBK in Kenya issued a notice about payment reporting expectations.',
          brief: 'A short CBK reporting update.',
          templateVariables: {
            updateTitle: 'CBK reporting notice',
            regulatorName: 'CBK',
            publishedDate: 'Not specified',
            summary: 'CBK in Kenya issued a notice about payment reporting expectations.',
            whoAffected: 'payments',
            ctaUrl: 'https://sheriabot.ai',
          },
        }),
        provider: 'anthropic' as const,
        model: 'claude-opus-4-6',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    });
    const service = new MarketingContentDrafterService({ llmGateway: { complete } });

    await service.draftNewsletterItem(signal());

    expect(requests[0]).toMatchObject({ provider: 'anthropic', allowFallback: false, useCase: 'analysis' });
    expect(requests[0].systemPrompt).toContain('docs/blog-launch-seed.md only as a brand-voice reference');
    expect(requests[0].systemPrompt).toContain('Do not use or repeat any fact from that file');
    expect(requests[0].systemPrompt).toContain('Never state a specific fine or penalty amount unless that exact amount appears verbatim');
    expect(requests[0].prompt).toContain('CBK issued a notice about payment reporting expectations.');
    expect(requests[0].prompt).not.toContain('example.com');
    expect(requests[0].prompt).not.toContain('thousands of shillings');
  });

  it('keeps LinkedIn drafts plain text in the body field', async () => {
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        title: 'CBK reporting notice',
        body: 'CBK in Kenya issued a notice about payment reporting expectations. Pro Tip: keep an eye on the obligations SheriaBot tracks for review.',
        brief: 'LinkedIn draft for CBK reporting notice.',
      }),
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      usage: { inputTokens: 90, outputTokens: 45 },
      stopReason: 'end_turn',
    }));
    const service = new MarketingContentDrafterService({ llmGateway: { complete } });

    const draft = await service.draftLinkedInPost(signal());

    expect(draft.body).toContain('CBK in Kenya');
    expect(draft.metadata).toMatchObject({ contentType: 'linkedin_post', templateKey: null });
  });
});