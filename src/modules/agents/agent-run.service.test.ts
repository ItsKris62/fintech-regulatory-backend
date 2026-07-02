import { Prisma } from '@prisma/client';
import type { AgentRun } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunService, type AgentRunServiceDependencies } from './agent-run.service';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    agentType: 'regulatory-intelligence',
    status: 'RUNNING',
    idempotencyKey: 'idem-1',
    organizationId: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: new Prisma.Decimal('0'),
    iterations: 0,
    startedAt: new Date('2026-07-01T00:00:00.000Z'),
    completedAt: null,
    error: null,
    metadata: null,
    ...overrides,
  };
}

function serviceFor(args: {
  enabled?: boolean;
  redisSetResult?: string | null;
  dailyCost?: string | null;
  budgetThrows?: boolean;
  existingRun?: AgentRun;
}): { service: AgentRunService; prisma: { agentRun: { create: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } } } {
  const createdRun = makeRun();
  const updatedRun = makeRun({ status: 'HALTED_BUDGET', completedAt: new Date('2026-07-01T00:00:00.000Z'), error: 'daily_cost_exceeded' });
  const prisma = {
    agentRun: {
      create: vi.fn().mockResolvedValue(createdRun),
      findUnique: vi.fn().mockResolvedValue(args.existingRun ?? createdRun),
      update: vi.fn().mockResolvedValue(updatedRun),
    },
    agentReport: {
      create: vi.fn(),
    },
  };
  const redis = {
    set: vi.fn().mockResolvedValue(args.redisSetResult === undefined ? 'OK' : args.redisSetResult),
    get: vi.fn().mockImplementation(() => {
      if (args.budgetThrows) throw new Error('redis down');
      return Promise.resolve(args.dailyCost ?? '0');
    }),
    incrbyfloat: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
  };
  const service = new AgentRunService({
    prisma,
    redis,
    llmGateway: { checkCostLimit: vi.fn().mockResolvedValue(undefined) },
    sendEmail: vi.fn().mockResolvedValue({ success: true }),
    budgetConfigProvider: () => ({ maxCostPerRunUsd: 2, maxCostPerDayUsd: 20, maxIterationsPerRun: 25 }),
    agentsEnabledProvider: () => args.enabled ?? true,
    now: () => new Date('2026-07-01T00:00:00.000Z'),
  } as unknown as AgentRunServiceDependencies);
  return { service, prisma };
}

describe('AgentRunService guards', () => {
  it('short-circuits before work when AGENTS_ENABLED is false', async () => {
    const { service, prisma } = serviceFor({ enabled: false });

    const result = await service.beginRun({ agentType: 'regulatory-intelligence', idempotencyKey: 'idem-test-1' });

    expect(result).toEqual({ started: false, reason: 'agents_disabled' });
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('halts before provider calls when the daily ceiling is breached', async () => {
    const { service, prisma } = serviceFor({ dailyCost: '21' });

    const result = await service.beginRun({ agentType: 'regulatory-intelligence', idempotencyKey: 'idem-test-2' });

    expect(result.started).toBe(true);
    expect(prisma.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'HALTED_BUDGET' }),
    }));
  });

  it('fails safe when the daily limit cannot be read', async () => {
    const { service, prisma } = serviceFor({ budgetThrows: true });

    const result = await service.beginRun({ agentType: 'regulatory-intelligence', idempotencyKey: 'idem-test-3' });

    expect(result.started).toBe(true);
    expect(prisma.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'HALTED_BUDGET' }),
    }));
  });

  it('returns the existing run on duplicate idempotency key', async () => {
    const existingRun = makeRun({ id: 'existing-run', idempotencyKey: 'idem-test-4' });
    const { service, prisma } = serviceFor({ redisSetResult: null, existingRun });

    const result = await service.beginRun({ agentType: 'regulatory-intelligence', idempotencyKey: 'idem-test-4' });

    expect(result).toEqual({ started: true, duplicate: true, run: existingRun });
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });
});