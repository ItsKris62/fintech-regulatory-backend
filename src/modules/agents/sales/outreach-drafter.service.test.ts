import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionRequest } from '@/lib/ai/gateway/types';
import { SalesOutreachDrafterService } from './outreach-drafter.service';
import type { EngagementContext, GroundedSalesProspect } from './types';

function prospect(): GroundedSalesProspect {
  return {
    signalId: 'sig-1',
    organizationId: 'org-1',
    sourceUrl: 'https://centralbank.go.ke/notice',
    jurisdiction: 'Kenya',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK reporting notice',
    summary: 'CBK issued a notice about payment reporting expectations.',
    severity: 'high',
    effectiveDate: null,
    complianceWindowDays: null,
    reason: 'Acme Fintech processes payments affected by this notice.',
    cohort: 'PILOT_COHORT_001',
    organizationName: 'Acme Fintech',
    organizationType: 'startup',
    industry: 'payments',
    cbkLicenseNumber: 'CBK-1234',
    plan: 'STARTUP',
    contactPerson: 'Jane Doe',
    contactEmail: 'jane@acme.test',
    contactPhone: null,
    pilotStatus: 'ACTIVE',
    pilotStartsAt: '2026-06-01T00:00:00.000Z',
    pilotExpiresAt: '2026-07-15T00:00:00.000Z',
  };
}

function unavailableEngagement(): EngagementContext {
  return { available: false, reason: 'posthog_not_configured' };
}

describe('SalesOutreachDrafterService', () => {
  it('uses Claude only and sends a source-only grounded prompt', async () => {
    const requests: LLMCompletionRequest[] = [];
    const complete = vi.fn(async (request: LLMCompletionRequest) => {
      requests.push(request);
      return {
        content: JSON.stringify({
          subject: 'CBK reporting update affecting Acme Fintech',
          body: 'Hi Jane, CBK issued a notice about payment reporting expectations that affects Acme Fintech...',
          priority: 'high',
        }),
        provider: 'anthropic' as const,
        model: 'claude-opus-4-6',
        usage: { inputTokens: 120, outputTokens: 60 },
        stopReason: 'end_turn',
      };
    });
    const service = new SalesOutreachDrafterService({ llmGateway: { complete } });

    await service.draftOutreach(prospect(), unavailableEngagement());

    expect(requests[0]).toMatchObject({ provider: 'anthropic', allowFallback: false, useCase: 'analysis' });
    expect(requests[0].systemPrompt).toContain('docs/blog-launch-seed.md only as a brand-voice reference');
    expect(requests[0].systemPrompt).toContain('exactly ONE clear next step');
    expect(requests[0].systemPrompt).toContain('Never propose a hard close');
    expect(requests[0].systemPrompt).toContain('If engagement.available is false, do not mention login activity');
    expect(requests[0].prompt).toContain('Acme Fintech processes payments affected by this notice.');
    expect(requests[0].prompt).not.toContain('example.com');
  });

  it('never mentions engagement details when engagement is unavailable', async () => {
    const complete = vi.fn(async (request: LLMCompletionRequest) => {
      expect(JSON.parse(request.prompt).engagement).toEqual({ available: false, reason: 'posthog_not_configured' });
      return {
        content: JSON.stringify({ subject: 'CBK update', body: 'Body with no engagement claims.', priority: 'medium' }),
        provider: 'anthropic' as const,
        model: 'claude-opus-4-6',
        usage: { inputTokens: 90, outputTokens: 40 },
        stopReason: 'end_turn',
      };
    });
    const service = new SalesOutreachDrafterService({ llmGateway: { complete } });

    const draft = await service.draftOutreach(prospect(), unavailableEngagement());

    expect(draft.metadata).toMatchObject({ engagementAvailable: false });
    expect(draft.priority).toBe('medium');
  });

  it('throws when the model returns an invalid priority', async () => {
    const complete = vi.fn(async () => ({
      content: JSON.stringify({ subject: 'x', body: 'y', priority: 'urgent' }),
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    }));
    const service = new SalesOutreachDrafterService({ llmGateway: { complete } });

    await expect(service.draftOutreach(prospect(), unavailableEngagement())).rejects.toThrow('valid priority');
  });
});
