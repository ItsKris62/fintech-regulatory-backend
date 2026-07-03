import { describe, expect, it, vi } from 'vitest';
import { AgentBudgetHalt, type AgentRunService } from '@/modules/agents/agent-run.service';
import { ChiefOfStaffAgent, type ChiefOfStaffAgentDependencies } from './chief-of-staff.agent';
import type { SourceReportExtract, WeeklyBrief } from './types';

function sources(): SourceReportExtract[] {
  return [
    { agentType: 'regulatory-intelligence', reportId: 'report-ri', createdAt: '2026-07-01T00:00:00.000Z', summary: 'ok', riskNotes: [], actionNotes: [], itemCounts: {} },
    { agentType: 'marketing', reportId: 'report-mk', createdAt: '2026-07-01T00:00:00.000Z', summary: 'ok', riskNotes: [], actionNotes: [], itemCounts: {} },
    { agentType: 'sales-growth', reportId: null, createdAt: null, summary: null, riskNotes: [], actionNotes: [], itemCounts: {} },
    { agentType: 'product-bi', reportId: 'report-bi', createdAt: '2026-07-01T00:00:00.000Z', summary: 'ok', riskNotes: [], actionNotes: [], itemCounts: {} },
    { agentType: 'security-ops', reportId: 'report-ops', createdAt: '2026-07-01T00:00:00.000Z', summary: 'ok', riskNotes: [], actionNotes: [], itemCounts: {} },
  ];
}

function brief(): WeeklyBrief {
  return {
    summary: 'Quiet week.',
    wins: ['All healthy.'],
    rankedActions: [{ action: 'Review draft.', sourceAgentType: 'marketing', sourceReportId: 'report-mk' }],
    decisionsNeeded: [],
    usage: { inputTokens: 300, outputTokens: 150, costUsd: 0.04, provider: 'anthropic', model: 'claude-opus-4-6' },
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

describe('ChiefOfStaffAgent', () => {
  it('respects the kill switch before fetching source reports or synthesizing', async () => {
    const sourceReports = { fetchAllSourceReports: vi.fn() };
    const runs = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' }) });
    const agent = new ChiefOfStaffAgent({
      sourceReports: sourceReports as unknown as ChiefOfStaffAgentDependencies['sourceReports'],
      agentRuns: runs,
    });

    const result = await agent.runBrief({ idempotencyKey: 'cos-disabled' });

    expect(result.status).toBe('SKIPPED_DISABLED');
    expect(sourceReports.fetchAllSourceReports).not.toHaveBeenCalled();
  });

  it('fetches source reports, synthesizes, creates a report, and unconditionally delivers the brief', async () => {
    const runs = agentRunService();
    const delivery = { send: vi.fn() };
    const agent = new ChiefOfStaffAgent({
      sourceReports: { fetchAllSourceReports: vi.fn().mockResolvedValue(sources()) } as unknown as ChiefOfStaffAgentDependencies['sourceReports'],
      briefSynthesis: { synthesize: vi.fn().mockResolvedValue(brief()) } as unknown as ChiefOfStaffAgentDependencies['briefSynthesis'],
      delivery: delivery as unknown as ChiefOfStaffAgentDependencies['delivery'],
      agentRuns: runs,
    });

    const result = await agent.runBrief({ idempotencyKey: 'cos-complete' });

    expect(result).toMatchObject({ status: 'COMPLETED', reportId: 'report-1' });
    expect(delivery.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'SheriaBot Weekly Brief', agentRunId: 'run-1' }));
  });

  it('returns HALTED_BUDGET when usage capture halts, still creates a report, and does not deliver', async () => {
    const runs = agentRunService({ advanceRun: vi.fn().mockRejectedValue(new AgentBudgetHalt('daily_cost_exceeded')) });
    const delivery = { send: vi.fn() };
    const agent = new ChiefOfStaffAgent({
      sourceReports: { fetchAllSourceReports: vi.fn().mockResolvedValue(sources()) } as unknown as ChiefOfStaffAgentDependencies['sourceReports'],
      briefSynthesis: { synthesize: vi.fn().mockResolvedValue(brief()) } as unknown as ChiefOfStaffAgentDependencies['briefSynthesis'],
      delivery: delivery as unknown as ChiefOfStaffAgentDependencies['delivery'],
      agentRuns: runs,
    });

    const result = await agent.runBrief({ idempotencyKey: 'cos-budget' });

    expect(result).toMatchObject({ status: 'HALTED_BUDGET', reportId: 'report-1' });
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('defaults the idempotency key to a stable per-ISO-week identifier', async () => {
    const runs = agentRunService();
    const agent = new ChiefOfStaffAgent({
      sourceReports: { fetchAllSourceReports: vi.fn().mockResolvedValue(sources()) } as unknown as ChiefOfStaffAgentDependencies['sourceReports'],
      briefSynthesis: { synthesize: vi.fn().mockResolvedValue(brief()) } as unknown as ChiefOfStaffAgentDependencies['briefSynthesis'],
      delivery: { send: vi.fn() } as unknown as ChiefOfStaffAgentDependencies['delivery'],
      agentRuns: runs,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await agent.runBrief();

    expect(runs.beginRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.stringMatching(/^chief-of-staff:2026-W\d{2}$/) }));
  });
});
