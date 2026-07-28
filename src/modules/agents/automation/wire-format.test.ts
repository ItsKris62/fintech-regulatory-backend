import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Empirically proves the actual HTTP wire format for the two n8n-facing
 * procedures, by driving real HTTP requests (via Fastify's app.inject, no
 * open socket needed) through the REAL fastifyTRPCPlugin adapter, the REAL
 * agentsRouter, and the REAL requireAgentCapability/rateLimited middleware
 * chain -- only Prisma, Redis, and the LLM gateway are faked, so no live
 * infra is required. This is not a guess from tRPC convention: whatever
 * request shape passes in this test is the shape n8n must send.
 */

const AUTOMATION_SECRET = 'sb_agent_test_automation_secret_with_enough_entropy_00000001';
const AUTOMATION_CONFIG_KEY = 'agent.automationOrchestrator.activeCredential';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const fakeRedis = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  exists: vi.fn().mockResolvedValue(0),
  incrbyfloat: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
  incr: vi.fn().mockResolvedValue(1),
  ttl: vi.fn().mockResolvedValue(60),
  zrange: vi.fn().mockResolvedValue([]),
  pipeline: () => {
    const chain = {
      zremrangebyscore: () => chain,
      zcard: () => chain,
      zadd: () => chain,
      expire: () => chain,
      exec: async () => [0, 0, 1, 1],
    };
    return chain;
  },
}));

const fakePrisma = vi.hoisted(() => {
  const agentRuns = new Map<string, Record<string, unknown>>();
  return {
    systemConfig: {
      findUnique: vi.fn().mockImplementation(({ where }: { where: { key: string } }) => {
        if (where.key === AUTOMATION_CONFIG_KEY) {
          return Promise.resolve({
            value: JSON.stringify({
              credentialHash: sha256Hex(AUTOMATION_SECRET),
              issuedAt: new Date().toISOString(),
              version: 1,
            }),
          });
        }
        return Promise.resolve(null);
      }),
    },
    user: { upsert: vi.fn().mockResolvedValue({}) },
    agentRun: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const run = { status: 'RUNNING', inputTokens: 0, outputTokens: 0, iterations: 0, completedAt: null, error: null, ...data };
        agentRuns.set(data.id as string, run);
        agentRuns.set(data.idempotencyKey as string, run);
        return Promise.resolve(run);
      }),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        const key = where.id ?? where.idempotencyKey;
        return Promise.resolve(key ? (agentRuns.get(key) ?? null) : null);
      }),
      update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = agentRuns.get(where.id) ?? {};
        const updated = { ...existing, ...data };
        agentRuns.set(where.id, updated);
        if (typeof existing.idempotencyKey === 'string') agentRuns.set(existing.idempotencyKey, updated);
        return Promise.resolve(updated);
      }),
    },
    agentReport: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
});

vi.mock('@/lib/redis/client', () => ({ redis: fakeRedis }));
vi.mock('@/lib/prisma/client', () => ({ prisma: fakePrisma, disconnectDatabase: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { auth: { getUser: vi.fn().mockResolvedValue({ data: null, error: new Error('not used in this test') }) } },
}));
// AGENTS_ENABLED is false by default in this env; the generate() happy-path
// test needs it true to reach the LLM gateway call (the false-path itself is
// already covered by automation.service.test.ts). Everything else in
// appConfig is left untouched via importOriginal.
vi.mock('@/config/app.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/app.config')>();
  return {
    ...actual,
    appConfig: {
      ...actual.appConfig,
      features: { ...actual.appConfig.features, agentsEnabled: true },
    },
  };
});
vi.mock('@/lib/ai/gateway/llm-gateway', () => ({
  llmGateway: {
    complete: vi.fn().mockResolvedValue({
      content: 'Drafted regulatory content.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 200 },
      stopReason: 'end_turn',
    }),
    checkCostLimit: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('agents.automation wire format (real Fastify + real tRPC adapter)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    const { router } = await import('@/server/trpc/init');
    const { agentsRouter } = await import('@/server/routers/agents.router');
    const { createContext } = await import('@/server/trpc/context');

    const testRouter = router({ agents: agentsRouter });

    app = Fastify();
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: testRouter, createContext },
    });
    await app.ready();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('logEvent: plain (non-batched) POST with a bare JSON body returns 200', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/agents.automation.logEvent',
      headers: {
        'content-type': 'application/json',
        'x-agent-credential': AUTOMATION_SECRET,
      },
      payload: {
        workflowKey: 'W-SEC-02',
        event: 'automation_failure',
        payload: { detail: 'timeout contacting downstream service' },
        executionId: 'n8n-exec-12345',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { data: { received: true } } });
  });

  it('generate: plain (non-batched) POST with a bare JSON body returns 200', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/agents.automation.generate',
      headers: {
        'content-type': 'application/json',
        'x-agent-credential': AUTOMATION_SECRET,
      },
      payload: {
        workflowKey: 'W-CONTENT-02',
        taskType: 'regulatory_content_draft',
        systemPrompt: 'You are a compliance copywriter.',
        userPrompt: 'Draft a short summary of the new CBK AML guideline.',
        maxTokens: 800,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result.data).toEqual({
      result: 'Drafted regulatory content.',
      providerUsed: 'anthropic',
      modelUsed: 'claude-sonnet-4-6',
    });
  });

  it('rejects a missing credential with 401 and no batch/transformer envelope surprises', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/agents.automation.logEvent',
      headers: { 'content-type': 'application/json' },
      payload: { workflowKey: 'W-SEC-02', event: 'x', payload: {}, executionId: 'e' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { message: 'Invalid agent credential.', data: { code: 'UNAUTHORIZED', httpStatus: 401 } },
    });
  });

  describe('Phase E Editorial Intelligence Automation Smoke Tests', () => {
    const endpoints = [
      'triageEditorialCandidate',
      'getEditorialTriage',
      'createResearchPack',
      'getResearchPack',
      'verifyBlogPostClaims',
      'getVerificationResult',
      'listFreshnessReviewCandidates',
      'runFreshnessReview',
      'createRevisionRequest'
    ];

    for (const endpoint of endpoints) {
      it(`rejects ${endpoint} with 401 when missing credential`, async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/trpc/agents.automation.${endpoint}`,
          headers: { 'content-type': 'application/json' },
          payload: {},
        });
        expect(response.statusCode).toBe(401);
      });
    }
  });
});
