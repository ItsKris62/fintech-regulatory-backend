import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionRequest } from '@/lib/ai/gateway/types';
import { ProductBiInsightSynthesisService } from './insight-synthesis.service';
import type { GroundedMetricsSnapshot } from './types';

function snapshot(): GroundedMetricsSnapshot {
  return {
    version: 1,
    windowStart: '2026-06-26T00:00:00.000Z',
    windowEnd: '2026-07-03T00:00:00.000Z',
    organizationCountsByPlan: [{ plan: 'STARTUP', subscriptionStatus: 'ACTIVE', count: 12 }],
    workforceCosts: [{
      agentType: 'sales-growth', totalCostUsd: 1.5, totalInputTokens: 100, totalOutputTokens: 50,
      runCount: 3, completedCount: 2, failedCount: 1, haltedBudgetCount: 0, haltedIterationsCount: 0,
    }],
    upgradeMomentCandidates: [{
      organizationId: 'org-1', organizationName: 'Acme Fintech', plan: 'STARTUP',
      metric: 'checklistGenerations', periodsAtOrOverLimit: 2,
      latestPeriodStart: '2026-06-01T00:00:00.000Z', latestUsage: 5, latestLimit: 5,
    }],
    churnRiskOrgs: [{
      organizationId: 'org-2', organizationName: 'Beta Co', subscriptionStatus: 'PAST_DUE',
      mpesaFailedRenewalAttempts: 3, reason: '3 failed M-Pesa renewal attempts',
    }],
    pilotCohorts: [{ cohort: 'PILOT_COHORT_001', activeCount: 4, convertedCount: 1, expiredCount: 0 }],
    engagement: { available: false, reason: 'posthog_not_configured' },
  };
}

describe('ProductBiInsightSynthesisService', () => {
  it('uses Claude only and sends a source-only grounded prompt', async () => {
    const requests: LLMCompletionRequest[] = [];
    const complete = vi.fn(async (request: LLMCompletionRequest) => {
      requests.push(request);
      return {
        content: JSON.stringify({
          summary: 'Twelve STARTUP orgs are active; Acme Fintech has hit its checklist cap twice in a row.',
          opportunities: ['Acme Fintech (org-1) is a strong Business-tier upgrade candidate.'],
          risks: ['Beta Co (org-2) has 3 failed M-Pesa renewal attempts.'],
        }),
        provider: 'anthropic' as const,
        model: 'claude-opus-4-6',
        usage: { inputTokens: 200, outputTokens: 100 },
        stopReason: 'end_turn',
      };
    });
    const service = new ProductBiInsightSynthesisService({ llmGateway: { complete } });

    await service.synthesize(snapshot());

    expect(requests[0]).toMatchObject({ provider: 'anthropic', allowFallback: false, useCase: 'analysis' });
    expect(requests[0].systemPrompt).toContain('Never invent a number');
    expect(requests[0].systemPrompt).toContain('PII minimization rule');
    expect(requests[0].systemPrompt).toContain('never contains a contact email, phone number, or a person');
    expect(requests[0].prompt).toContain('Acme Fintech');
    expect(requests[0].prompt).toContain('org-1');
  });

  it('never sends a PII-shaped field (email/phone/personal-name key or an email-looking value) in the prompt payload', async () => {
    const complete = vi.fn(async (_request: LLMCompletionRequest) => ({
      content: JSON.stringify({ summary: 'ok', opportunities: [], risks: [] }),
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      usage: { inputTokens: 50, outputTokens: 20 },
      stopReason: 'end_turn',
    }));
    const service = new ProductBiInsightSynthesisService({ llmGateway: { complete } });

    await service.synthesize(snapshot());

    const request = complete.mock.calls[0][0];
    const fullPayload = request.systemPrompt + request.prompt;

    expect(fullPayload).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    expect(fullPayload).not.toMatch(/"contactEmail"|"contactPerson"|"fullName"|"contactPhone"/);
  });

  it('throws when the model omits a summary', async () => {
    const complete = vi.fn(async () => ({
      content: JSON.stringify({ opportunities: [], risks: [] }),
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    }));
    const service = new ProductBiInsightSynthesisService({ llmGateway: { complete } });

    await expect(service.synthesize(snapshot())).rejects.toThrow('missing summary');
  });
});
