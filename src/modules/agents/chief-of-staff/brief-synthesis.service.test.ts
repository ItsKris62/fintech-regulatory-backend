import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionRequest } from '@/lib/ai/gateway/types';
import { ChiefOfStaffBriefSynthesisService } from './brief-synthesis.service';
import type { SourceReportExtract } from './types';

function sources(): SourceReportExtract[] {
  return [
    { agentType: 'regulatory-intelligence', reportId: 'report-ri', createdAt: '2026-07-01T00:00:00.000Z', summary: 'Two new CBK notices classified.', riskNotes: [], actionNotes: [], itemCounts: { sales: 2 } },
    { agentType: 'marketing', reportId: 'report-mk', createdAt: '2026-07-01T00:00:00.000Z', summary: 'One newsletter draft ready for review.', riskNotes: ['Drafts require Chris review.'], actionNotes: [], itemCounts: {} },
    { agentType: 'sales-growth', reportId: null, createdAt: null, summary: null, riskNotes: [], actionNotes: [], itemCounts: {} },
    { agentType: 'product-bi', reportId: 'report-bi', createdAt: '2026-07-01T00:00:00.000Z', summary: 'Twelve STARTUP orgs active.', riskNotes: [], actionNotes: ['Acme Fintech is an upgrade candidate.'], itemCounts: { upgradeMomentCandidates: 1 } },
    { agentType: 'security-ops', reportId: 'report-ops', createdAt: '2026-07-01T00:00:00.000Z', summary: 'All services healthy.', riskNotes: [], actionNotes: [], itemCounts: {} },
  ];
}

function validResponseJson(): string {
  return JSON.stringify({
    summary: 'Quiet week overall; one marketing draft needs review and Acme Fintech looks upgrade-ready.',
    wins: ['All services healthy this week.'],
    rankedActions: [
      { action: 'Review the pending newsletter draft.', sourceAgentType: 'marketing', sourceReportId: 'report-mk' },
      { action: 'Follow up with Acme Fintech about a Business-tier upgrade.', sourceAgentType: 'product-bi', sourceReportId: 'report-bi' },
    ],
    decisionsNeeded: [
      { decision: 'Approve or dismiss the marketing draft.', sourceAgentType: 'marketing', sourceReportId: 'report-mk' },
    ],
  });
}

describe('ChiefOfStaffBriefSynthesisService', () => {
  it('uses Claude only and sends a source-only grounded prompt', async () => {
    const requests: LLMCompletionRequest[] = [];
    const complete = vi.fn(async (request: LLMCompletionRequest) => {
      requests.push(request);
      return { content: validResponseJson(), provider: 'anthropic' as const, model: 'claude-opus-4-6', usage: { inputTokens: 300, outputTokens: 150 }, stopReason: 'end_turn' };
    });
    const service = new ChiefOfStaffBriefSynthesisService({ llmGateway: { complete } });

    await service.synthesize(sources());

    expect(requests[0]).toMatchObject({ provider: 'anthropic', allowFallback: false, useCase: 'analysis' });
    expect(requests[0].systemPrompt).toContain('evidence over summary');
    expect(requests[0].systemPrompt).toContain('sourceReportId');
    expect(requests[0].prompt).toContain('report-mk');
  });

  it('parses a well-formed response and positively confirms every ranked action and decision cites a real source report', async () => {
    const complete = vi.fn(async () => ({ content: validResponseJson(), provider: 'anthropic' as const, model: 'claude-opus-4-6', usage: { inputTokens: 300, outputTokens: 150 }, stopReason: 'end_turn' }));
    const service = new ChiefOfStaffBriefSynthesisService({ llmGateway: { complete } });

    const brief = await service.synthesize(sources());

    expect(brief.rankedActions).toHaveLength(2);
    expect(brief.decisionsNeeded).toHaveLength(1);
    for (const item of [...brief.rankedActions, ...brief.decisionsNeeded]) {
      const matchingSource = sources().find((s) => s.agentType === item.sourceAgentType);
      expect(matchingSource, `no known source agent type "${item.sourceAgentType}"`).toBeDefined();
      expect(item.sourceReportId, `sourceReportId for ${item.sourceAgentType} must match the real report`).toBe(matchingSource?.reportId);
    }
  });

  it('rejects a ranked action citing an unknown sourceAgentType', async () => {
    const badResponse = JSON.stringify({
      summary: 'x',
      wins: [],
      rankedActions: [{ action: 'y', sourceAgentType: 'not-a-real-agent', sourceReportId: 'report-mk' }],
      decisionsNeeded: [],
    });
    const complete = vi.fn(async () => ({ content: badResponse, provider: 'anthropic' as const, model: 'claude-opus-4-6', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' }));
    const service = new ChiefOfStaffBriefSynthesisService({ llmGateway: { complete } });

    await expect(service.synthesize(sources())).rejects.toThrow('unknown sourceAgentType');
  });

  it('rejects a ranked action whose sourceReportId does not match the real reportId for that agent type', async () => {
    const badResponse = JSON.stringify({
      summary: 'x',
      wins: [],
      rankedActions: [{ action: 'y', sourceAgentType: 'marketing', sourceReportId: 'report-invented' }],
      decisionsNeeded: [],
    });
    const complete = vi.fn(async () => ({ content: badResponse, provider: 'anthropic' as const, model: 'claude-opus-4-6', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' }));
    const service = new ChiefOfStaffBriefSynthesisService({ llmGateway: { complete } });

    await expect(service.synthesize(sources())).rejects.toThrow('does not match a real available report');
  });

  it('rejects a decision citing sales-growth, which has no report available (reportId null) in this fixture', async () => {
    const badResponse = JSON.stringify({
      summary: 'x',
      wins: [],
      rankedActions: [],
      decisionsNeeded: [{ decision: 'y', sourceAgentType: 'sales-growth', sourceReportId: 'anything' }],
    });
    const complete = vi.fn(async () => ({ content: badResponse, provider: 'anthropic' as const, model: 'claude-opus-4-6', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' }));
    const service = new ChiefOfStaffBriefSynthesisService({ llmGateway: { complete } });

    await expect(service.synthesize(sources())).rejects.toThrow('does not match a real available report');
  });

  it('throws when the model omits a summary', async () => {
    const complete = vi.fn(async () => ({ content: JSON.stringify({ wins: [], rankedActions: [], decisionsNeeded: [] }), provider: 'anthropic' as const, model: 'claude-opus-4-6', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' }));
    const service = new ChiefOfStaffBriefSynthesisService({ llmGateway: { complete } });

    await expect(service.synthesize(sources())).rejects.toThrow('missing summary');
  });
});
