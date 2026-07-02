import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AgentBudgetHalt, type AgentRunService } from '@/modules/agents/agent-run.service';
import { MarketingAgent, type MarketingAgentDependencies } from './marketing.agent';
import type { DraftContent, GroundedMarketingSignal, PersistedMarketingDraft } from './types';

function signal(id = 'sig-1'): GroundedMarketingSignal {
  return {
    id,
    sourceUrl: 'https://centralbank.go.ke/notice',
    jurisdiction: 'Kenya',
    regulatoryBody: 'CBK',
    documentType: 'notice',
    title: 'CBK notice',
    summary: 'CBK updated reporting expectations.',
    severity: 'high',
    affectedSectors: ['payments'],
    affectedObligations: ['reporting'],
    effectiveDate: null,
    complianceWindowDays: null,
    status: 'NEW',
  };
}

function draft(): DraftContent {
  return {
    title: 'CBK notice',
    body: 'CBK in Kenya updated reporting expectations.',
    brief: 'A CBK reporting update.',
    metadata: { sourceSignalIds: ['sig-1'] },
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01, provider: 'anthropic', model: 'claude-opus-4-6' },
  };
}

function persisted(id: string): PersistedMarketingDraft {
  return {
    id,
    contentType: 'newsletter_item',
    sourceSignalIds: ['sig-1'],
    sourceFingerprint: 'sig-1',
    title: 'CBK notice',
    body: 'CBK in Kenya updated reporting expectations.',
    brief: 'A CBK reporting update.',
    status: 'DRAFT',
    agentRunId: 'run-1',
    generatedAt: new Date('2026-07-02T00:00:00.000Z'),
    reviewedAt: null,
    reviewedBy: null,
    editedBody: null,
    metadata: null,
  };
}

function agentRunService(overrides: Partial<Record<keyof AgentRunService, unknown>> = {}): AgentRunService {
  const service = {
    beginRun: vi.fn().mockResolvedValue({ started: true, duplicate: false, run: { id: 'run-1', status: 'RUNNING' } }),
    advanceRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'RUNNING' }),
    completeRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'COMPLETED' }),
    failRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'FAILED' }),
    createReport: vi.fn().mockResolvedValue({ id: 'report-1' }),
    getRun: vi.fn(),
    ...overrides,
  };
  return service as unknown as AgentRunService;
}

describe('MarketingAgent', () => {
  it('respects the kill switch before selecting or drafting', async () => {
    const selector = { selectSignals: vi.fn() };
    const runs = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' }) });
    const agent = new MarketingAgent({ selector: selector as unknown as MarketingAgentDependencies['selector'], agentRuns: runs });

    const result = await agent.runDrafting({ idempotencyKey: 'marketing-disabled' });

    expect(result.status).toBe('SKIPPED_DISABLED');
    expect(selector.selectSignals).not.toHaveBeenCalled();
  });

  it('creates newsletter and LinkedIn drafts and captures usage', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(persisted('draft-newsletter'))
      .mockResolvedValueOnce({ ...persisted('draft-linkedin'), contentType: 'linkedin_post' });
    const runs = agentRunService();
    const agent = new MarketingAgent({
      prisma: {
        marketingDraft: { create, findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      },
      selector: {
        selectSignals: vi.fn()
          .mockResolvedValueOnce([signal('sig-1')])
          .mockResolvedValueOnce([signal('sig-1')]),
      } as unknown as MarketingAgentDependencies['selector'],
      drafter: {
        draftNewsletterItem: vi.fn().mockResolvedValue(draft()),
        draftLinkedInPost: vi.fn().mockResolvedValue(draft()),
      } as unknown as MarketingAgentDependencies['drafter'],
      agentRuns: runs,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const result = await agent.runDrafting({ idempotencyKey: 'marketing-complete' });

    expect(result).toMatchObject({ status: 'COMPLETED', draftsCreated: 2, reportId: 'report-1' });
    expect(create.mock.calls[0][0].data).toMatchObject({ contentType: 'newsletter_item', sourceFingerprint: 'sig-1' });
    expect(create.mock.calls[1][0].data).toMatchObject({ contentType: 'linkedin_post', sourceFingerprint: 'sig-1' });
    expect(runs.advanceRun).toHaveBeenCalledTimes(2);
    expect(runs.completeRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
  });

  it('returns HALTED_BUDGET when budget guards halt after usage capture', async () => {
    const runs = agentRunService({ advanceRun: vi.fn().mockRejectedValue(new AgentBudgetHalt('daily_cost_exceeded')) });
    const agent = new MarketingAgent({
      prisma: {
        marketingDraft: { create: vi.fn().mockResolvedValue(persisted('draft-1')), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      },
      selector: {
        selectSignals: vi.fn()
          .mockResolvedValueOnce([signal('sig-1')])
          .mockResolvedValueOnce([]),
      } as unknown as MarketingAgentDependencies['selector'],
      drafter: {
        draftNewsletterItem: vi.fn().mockResolvedValue(draft()),
        draftLinkedInPost: vi.fn(),
      } as unknown as MarketingAgentDependencies['drafter'],
      agentRuns: runs,
    });

    const result = await agent.runDrafting({ idempotencyKey: 'marketing-budget' });

    expect(result).toMatchObject({ status: 'HALTED_BUDGET', reportId: 'report-1', draftsCreated: 1 });
    expect(runs.createReport).toHaveBeenCalledWith(expect.objectContaining({ humanApproved: false }));
  });

  it('skips duplicate draft inserts caused by the unique source fingerprint', async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const runs = agentRunService();
    const agent = new MarketingAgent({
      prisma: {
        marketingDraft: { create: vi.fn().mockRejectedValue(uniqueError), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      },
      selector: {
        selectSignals: vi.fn()
          .mockResolvedValueOnce([signal('sig-1')])
          .mockResolvedValueOnce([]),
      } as unknown as MarketingAgentDependencies['selector'],
      drafter: {
        draftNewsletterItem: vi.fn().mockResolvedValue(draft()),
        draftLinkedInPost: vi.fn(),
      } as unknown as MarketingAgentDependencies['drafter'],
      agentRuns: runs,
    });

    const result = await agent.runDrafting({ idempotencyKey: 'marketing-dedup' });

    expect(result).toMatchObject({ status: 'COMPLETED', draftsCreated: 0 });
  });
});