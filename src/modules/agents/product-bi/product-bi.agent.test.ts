import { describe, expect, it, vi } from 'vitest';
import { AgentBudgetHalt, type AgentRunService } from '@/modules/agents/agent-run.service';
import { ProductBiAgent, type ProductBiAgentDependencies } from './product-bi.agent';
import type { GroundedMetricsSnapshot, InsightNarrative } from './types';

function snapshot(): GroundedMetricsSnapshot {
  return {
    version: 1,
    windowStart: '2026-06-26T00:00:00.000Z',
    windowEnd: '2026-07-03T00:00:00.000Z',
    organizationCountsByPlan: [],
    workforceCosts: [],
    upgradeMomentCandidates: [],
    churnRiskOrgs: [],
    pilotCohorts: [],
    engagement: { available: false, reason: 'posthog_not_configured' },
  };
}

function narrative(): InsightNarrative {
  return {
    summary: 'Weekly BI summary.',
    opportunities: [],
    risks: [],
    usage: { inputTokens: 200, outputTokens: 100, costUsd: 0.03, provider: 'anthropic', model: 'claude-opus-4-6' },
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

describe('ProductBiAgent', () => {
  it('respects the kill switch before computing metrics or synthesizing', async () => {
    const metricsComputation = { computeSnapshot: vi.fn() };
    const insightSynthesis = { synthesize: vi.fn() };
    const runs = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' }) });
    const agent = new ProductBiAgent({
      metricsComputation: metricsComputation as unknown as ProductBiAgentDependencies['metricsComputation'],
      insightSynthesis: insightSynthesis as unknown as ProductBiAgentDependencies['insightSynthesis'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'bi-report-disabled' });

    expect(result.status).toBe('SKIPPED_DISABLED');
    expect(metricsComputation.computeSnapshot).not.toHaveBeenCalled();
    expect(insightSynthesis.synthesize).not.toHaveBeenCalled();
  });

  it('computes metrics, synthesizes a narrative, captures usage, and creates a report', async () => {
    const runs = agentRunService();
    const agent = new ProductBiAgent({
      metricsComputation: { computeSnapshot: vi.fn().mockResolvedValue(snapshot()) } as unknown as ProductBiAgentDependencies['metricsComputation'],
      insightSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as ProductBiAgentDependencies['insightSynthesis'],
      agentRuns: runs,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    const result = await agent.runReport({ idempotencyKey: 'bi-report-complete' });

    expect(result).toMatchObject({ status: 'COMPLETED', reportId: 'report-1', runId: 'run-1' });
    expect(runs.advanceRun).toHaveBeenCalledTimes(1);
    expect(runs.createReport).toHaveBeenCalledWith(expect.objectContaining({ humanApproved: false }));
    expect(runs.completeRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
  });

  it('returns HALTED_BUDGET when usage capture halts, but still creates a report from the already-computed snapshot and narrative', async () => {
    const runs = agentRunService({ advanceRun: vi.fn().mockRejectedValue(new AgentBudgetHalt('daily_cost_exceeded')) });
    const agent = new ProductBiAgent({
      metricsComputation: { computeSnapshot: vi.fn().mockResolvedValue(snapshot()) } as unknown as ProductBiAgentDependencies['metricsComputation'],
      insightSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as ProductBiAgentDependencies['insightSynthesis'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'bi-report-budget' });

    expect(result).toMatchObject({ status: 'HALTED_BUDGET', reportId: 'report-1' });
    expect(runs.createReport).toHaveBeenCalledWith(expect.objectContaining({ humanApproved: false }));
  });

  it('passes through a duplicate result from beginRun without recomputing anything', async () => {
    const metricsComputation = { computeSnapshot: vi.fn() };
    const runs = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: true, duplicate: true, run: { id: 'run-1', status: 'COMPLETED' } }) });
    const agent = new ProductBiAgent({
      metricsComputation: metricsComputation as unknown as ProductBiAgentDependencies['metricsComputation'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'bi-report-dup' });

    expect(result).toMatchObject({ status: 'DUPLICATE', runId: 'run-1' });
    expect(metricsComputation.computeSnapshot).not.toHaveBeenCalled();
  });

  it('defaults the idempotency key to a stable per-ISO-week identifier', async () => {
    const runs = agentRunService();
    const agent = new ProductBiAgent({
      metricsComputation: { computeSnapshot: vi.fn().mockResolvedValue(snapshot()) } as unknown as ProductBiAgentDependencies['metricsComputation'],
      insightSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as ProductBiAgentDependencies['insightSynthesis'],
      agentRuns: runs,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await agent.runReport();

    expect(runs.beginRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.stringMatching(/^bi-report:2026-W\d{2}$/) }));
  });
});
