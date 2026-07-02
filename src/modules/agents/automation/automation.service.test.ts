import { Prisma } from '@prisma/client';
import type { AgentRun } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/logger';
import { AgentRunService, type AgentRunServiceDependencies } from '../agent-run.service';
import { AutomationService, type GenerateAutomationContentInput } from './automation.service';

function baseGenerateInput(overrides: Partial<GenerateAutomationContentInput> = {}): GenerateAutomationContentInput {
  return {
    workflowKey: 'W-CONTENT-02',
    taskType: 'regulatory_content_draft',
    systemPrompt: 'You are a compliance copywriter.',
    userPrompt: 'Draft a summary of the new CBK guideline.',
    maxTokens: 800,
    ...overrides,
  };
}

/**
 * Minimal stateful fake of the Prisma/Redis surface AgentRunService needs,
 * so beginRun()'s SET-NX idempotency lock and the AgentRun row it creates
 * behave like the real thing across successive calls  -  needed to prove
 * duplicate requests actually replay a persisted result instead of the test
 * merely mocking "duplicate: true" by hand.
 */
function createRealAgentRunService(args: { enabled?: boolean } = {}): {
  service: AgentRunService;
  prisma: { agentRun: { create: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
} {
  // Keyed by idempotencyKey, so distinct requests within one test don't
  // collide  -  each idempotencyKey gets its own SET-NX lock and its own row.
  const runsByIdempotencyKey = new Map<string, AgentRun>();
  const runsById = new Map<string, AgentRun>();
  const lockedRedisKeys = new Set<string>();

  const prisma = {
    agentRun: {
      create: vi.fn().mockImplementation(({ data }: { data: Partial<AgentRun> }) => {
        const run: AgentRun = {
          id: data.id as string,
          agentType: data.agentType as string,
          status: 'RUNNING',
          idempotencyKey: data.idempotencyKey as string,
          organizationId: data.organizationId ?? null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: new Prisma.Decimal('0'),
          iterations: 0,
          startedAt: new Date('2026-07-01T00:00:00.000Z'),
          completedAt: null,
          error: null,
          metadata: (data.metadata as Prisma.JsonValue) ?? null,
        };
        runsByIdempotencyKey.set(run.idempotencyKey, run);
        runsById.set(run.id, run);
        return Promise.resolve(run);
      }),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
        const run = where.idempotencyKey
          ? runsByIdempotencyKey.get(where.idempotencyKey)
          : where.id
            ? runsById.get(where.id)
            : undefined;
        return Promise.resolve(run ?? null);
      }),
      update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Partial<AgentRun> }) => {
        const existing = runsById.get(where.id) as AgentRun;
        const updated = { ...existing, ...data };
        runsById.set(updated.id, updated);
        runsByIdempotencyKey.set(updated.idempotencyKey, updated);
        return Promise.resolve(updated);
      }),
    },
    agentReport: { create: vi.fn() },
  };

  const redis = {
    set: vi.fn().mockImplementation((key: string) => {
      if (lockedRedisKeys.has(key)) return Promise.resolve(null);
      lockedRedisKeys.add(key);
      return Promise.resolve('OK');
    }),
    get: vi.fn().mockResolvedValue('0'),
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

function fakeLlmResult(content = 'Drafted content.') {
  return {
    content,
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 120, outputTokens: 240 },
    stopReason: 'end_turn' as const,
  };
}

describe('AutomationService.logEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes exactly one automation_event log line and returns received:true', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const service = new AutomationService();

    const result = service.logEvent({
      workflowKey: 'W-SEC-02',
      event: 'automation_failure',
      payload: { detail: 'timeout' },
      executionId: 'n8n-exec-1',
    });

    expect(result).toEqual({ received: true });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'automation_event',
        workflowKey: 'W-SEC-02',
        event: 'automation_failure',
        executionId: 'n8n-exec-1',
      }),
    );
  });

  it('never calls agentRunService  -  a log write is not an LLM-invoking capability', () => {
    const agentRuns = {
      beginRun: vi.fn(),
      advanceRun: vi.fn(),
      completeRun: vi.fn(),
      failRun: vi.fn(),
      createReport: vi.fn(),
      getRun: vi.fn(),
    };
    const service = new AutomationService({ agentRuns: agentRuns as unknown as AgentRunService });

    service.logEvent({
      workflowKey: 'W-SEC-02',
      event: 'automation_failure',
      payload: {},
      executionId: 'n8n-exec-2',
    });

    expect(agentRuns.beginRun).not.toHaveBeenCalled();
    expect(agentRuns.advanceRun).not.toHaveBeenCalled();
    expect(agentRuns.completeRun).not.toHaveBeenCalled();
    expect(agentRuns.failRun).not.toHaveBeenCalled();
    expect(agentRuns.createReport).not.toHaveBeenCalled();
  });
});

describe('AutomationService.generate', () => {
  it('rejects cleanly with no LLM call when AGENTS_ENABLED is false', async () => {
    const { service: agentRuns, prisma } = createRealAgentRunService({ enabled: false });
    const llmGateway = { complete: vi.fn() };
    const service = new AutomationService({ agentRuns, llmGateway });

    await expect(service.generate(baseGenerateInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(llmGateway.complete).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('calls the gateway once and returns provider/model on the happy path', async () => {
    const { service: agentRuns } = createRealAgentRunService();
    const llmGateway = { complete: vi.fn().mockResolvedValue(fakeLlmResult('Hello world.')) };
    const service = new AutomationService({ agentRuns, llmGateway });

    const result = await service.generate(baseGenerateInput());

    expect(result).toEqual({ result: 'Hello world.', providerUsed: 'anthropic', modelUsed: 'claude-sonnet-4-6' });
    expect(llmGateway.complete).toHaveBeenCalledTimes(1);
    expect(llmGateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({ useCase: 'analysis', maxTokens: 800, allowFallback: false }),
    );
  });

  it('does not double-spend: a retried identical request replays the cached result with zero new LLM calls', async () => {
    const { service: agentRuns } = createRealAgentRunService();
    const llmGateway = { complete: vi.fn().mockResolvedValue(fakeLlmResult('Idempotent content.')) };
    const service = new AutomationService({ agentRuns, llmGateway });

    const input = baseGenerateInput();
    const first = await service.generate(input);
    const second = await service.generate(input);

    expect(llmGateway.complete).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('produces a different idempotency key (and a second LLM call) for a genuinely different request', async () => {
    const { service: agentRuns } = createRealAgentRunService();
    const llmGateway = { complete: vi.fn().mockResolvedValue(fakeLlmResult()) };
    const service = new AutomationService({ agentRuns, llmGateway });

    await service.generate(baseGenerateInput());
    await service.generate(baseGenerateInput({ userPrompt: 'A completely different prompt.' }));

    expect(llmGateway.complete).toHaveBeenCalledTimes(2);
  });

  it('rejects a retry that races an in-flight (not-yet-completed) run without calling the LLM again', async () => {
    const { service: agentRuns } = createRealAgentRunService();
    // Never resolves during this test  -  simulates the first call still being in flight.
    const llmGateway = { complete: vi.fn().mockImplementation(() => new Promise(() => {})) };
    const service = new AutomationService({ agentRuns, llmGateway });

    const input = baseGenerateInput();
    void service.generate(input); // fire-and-forget: leaves the run RUNNING

    await new Promise((resolve) => setImmediate(resolve));

    await expect(service.generate(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(llmGateway.complete).toHaveBeenCalledTimes(1);
  });

  it('marks the run failed and throws a generic error when the gateway call throws', async () => {
    const { service: agentRuns, prisma } = createRealAgentRunService();
    const llmGateway = { complete: vi.fn().mockRejectedValue(new Error('upstream provider exploded: sk-ant-abc123')) };
    const service = new AutomationService({ agentRuns, llmGateway });

    await expect(service.generate(baseGenerateInput())).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    const updateCalls = prisma.agentRun.update.mock.calls as Array<[{ data: { status?: string } }]>;
    expect(updateCalls.some(([args]) => args.data.status === 'FAILED')).toBe(true);
  });
});
