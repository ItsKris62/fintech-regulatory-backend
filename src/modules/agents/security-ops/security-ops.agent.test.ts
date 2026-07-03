import { describe, expect, it, vi } from 'vitest';
import { AgentBudgetHalt, type AgentRunService } from '@/modules/agents/agent-run.service';
import { SecurityOpsAgent, type SecurityOpsAgentDependencies } from './security-ops.agent';
import type { GroundedOpsSnapshot, OpsNarrative } from './types';

function healthySnapshot(): GroundedOpsSnapshot {
  return {
    version: 1,
    windowStart: '2026-07-02T00:00:00.000Z',
    windowEnd: '2026-07-03T00:00:00.000Z',
    workforceCosts: [],
    serviceHealth: [
      { service: 'database', status: 'healthy', latencyMs: 5 },
      { service: 'redis', status: 'healthy', latencyMs: 3 },
    ],
    errorSummary: { totalUniqueErrors: 0, topErrors: [] },
  };
}

function degradedSnapshot(): GroundedOpsSnapshot {
  return {
    ...healthySnapshot(),
    serviceHealth: [{ service: 'database', status: 'down' }, { service: 'redis', status: 'healthy', latencyMs: 3 }],
  };
}

function narrative(): OpsNarrative {
  return {
    summary: 'All services healthy.',
    risks: [],
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01, provider: 'anthropic', model: 'claude-opus-4-6' },
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

describe('SecurityOpsAgent', () => {
  it('respects the kill switch before computing a snapshot or synthesizing', async () => {
    const healthSnapshot = { computeSnapshot: vi.fn() };
    const runs = agentRunService({ beginRun: vi.fn().mockResolvedValue({ started: false, reason: 'agents_disabled' }) });
    const agent = new SecurityOpsAgent({
      healthSnapshot: healthSnapshot as unknown as SecurityOpsAgentDependencies['healthSnapshot'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'ops-disabled' });

    expect(result.status).toBe('SKIPPED_DISABLED');
    expect(healthSnapshot.computeSnapshot).not.toHaveBeenCalled();
  });

  it('computes a snapshot, synthesizes, creates a report, and sends no alert when everything is healthy', async () => {
    const runs = agentRunService();
    const opsAlert = { sendAlert: vi.fn() };
    const agent = new SecurityOpsAgent({
      healthSnapshot: { computeSnapshot: vi.fn().mockResolvedValue(healthySnapshot()) } as unknown as SecurityOpsAgentDependencies['healthSnapshot'],
      alertSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as SecurityOpsAgentDependencies['alertSynthesis'],
      opsAlert: opsAlert as unknown as SecurityOpsAgentDependencies['opsAlert'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'ops-healthy' });

    expect(result).toMatchObject({ status: 'COMPLETED', reportId: 'report-1' });
    expect(opsAlert.sendAlert).not.toHaveBeenCalled();
  });

  it('sends an alert via ops-alert service when a service is down', async () => {
    const runs = agentRunService();
    const opsAlert = { sendAlert: vi.fn() };
    const agent = new SecurityOpsAgent({
      healthSnapshot: { computeSnapshot: vi.fn().mockResolvedValue(degradedSnapshot()) } as unknown as SecurityOpsAgentDependencies['healthSnapshot'],
      alertSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as SecurityOpsAgentDependencies['alertSynthesis'],
      opsAlert: opsAlert as unknown as SecurityOpsAgentDependencies['opsAlert'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'ops-degraded' });

    expect(result).toMatchObject({ status: 'COMPLETED', reportId: 'report-1' });
    expect(opsAlert.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: 'run-1' }));
  });

  it('returns HALTED_BUDGET when usage capture halts, still creates a report, and does not alert', async () => {
    const runs = agentRunService({ advanceRun: vi.fn().mockRejectedValue(new AgentBudgetHalt('daily_cost_exceeded')) });
    const opsAlert = { sendAlert: vi.fn() };
    const agent = new SecurityOpsAgent({
      healthSnapshot: { computeSnapshot: vi.fn().mockResolvedValue(degradedSnapshot()) } as unknown as SecurityOpsAgentDependencies['healthSnapshot'],
      alertSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as SecurityOpsAgentDependencies['alertSynthesis'],
      opsAlert: opsAlert as unknown as SecurityOpsAgentDependencies['opsAlert'],
      agentRuns: runs,
    });

    const result = await agent.runReport({ idempotencyKey: 'ops-budget' });

    expect(result).toMatchObject({ status: 'HALTED_BUDGET', reportId: 'report-1' });
    expect(opsAlert.sendAlert).not.toHaveBeenCalled();
  });

  it('defaults the idempotency key to a stable per-day identifier', async () => {
    const runs = agentRunService();
    const agent = new SecurityOpsAgent({
      healthSnapshot: { computeSnapshot: vi.fn().mockResolvedValue(healthySnapshot()) } as unknown as SecurityOpsAgentDependencies['healthSnapshot'],
      alertSynthesis: { synthesize: vi.fn().mockResolvedValue(narrative()) } as unknown as SecurityOpsAgentDependencies['alertSynthesis'],
      agentRuns: runs,
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    });

    await agent.runReport();

    expect(runs.beginRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'security-ops:2026-07-03' }));
  });
});
