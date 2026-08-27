import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  plan: 'REGULATOR',
  homeJurisdictionCode: 'KE' as string | null,
  originalJurisdictions: ['KE'],
  originalMode: 'SINGLE',
}));

const fakeRedis = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  incr: vi.fn().mockResolvedValue(1),
  decr: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
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

const fakePrisma = vi.hoisted(() => ({
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  systemConfig: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue({
      id: 'user-ke',
      email: 'owner@example.test',
      fullName: 'Test Owner',
      freeTrialActivatedAt: null,
      freeTrialExpiresAt: null,
      freeTrialUsage: null,
      isPilot: false,
      pilotExpiresAt: null,
      pilotAccessStatus: null,
    }),
    findFirst: vi.fn().mockResolvedValue(null),
  },
  organization: {
    findUnique: vi.fn().mockImplementation(() => Promise.resolve({
      id: 'org-ke',
      name: 'Kenya Test Org',
      plan: state.plan,
      customLimits: null,
      subscriptionStatus: null,
      gracePeriodEndsAt: null,
      preferredPaymentMethod: null,
      mpesaNextPaymentDueDate: null,
      subscriptionCycleEnd: null,
      homeJurisdictionCode: state.homeJurisdictionCode,
    })),
    update: vi.fn().mockResolvedValue({}),
  },
  pilotAccess: { findFirst: vi.fn().mockResolvedValue(null) },
  enterprisePlanOverride: { findMany: vi.fn().mockResolvedValue([]) },
  organizationMember: {
    findUnique: vi.fn().mockResolvedValue({
      userId: 'user-ke',
      organizationId: 'org-ke',
      role: 'OWNER',
      status: 'ACTIVE',
    }),
  },
  complianceQuery: {
    findUnique: vi.fn().mockImplementation(() => Promise.resolve({
      id: 'query-ke',
      query: 'What are the KYC requirements?',
      response: 'Original answer',
      summary: null,
      userId: 'user-ke',
      organizationId: 'org-ke',
      mode: state.originalMode,
      jurisdictions: state.originalJurisdictions,
      primaryJurisdiction: state.originalJurisdictions[0] ?? null,
      jurisdictionSource: 'REQUEST',
      metadata: {},
    })),
    create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-query', ...data })),
    update: vi.fn().mockResolvedValue({}),
  },
  complianceQueryRun: {
    findFirst: vi.fn().mockResolvedValue(null),
  },
}));

const searchAndGetRegulatoryEvidenceContext = vi.hoisted(() => vi.fn().mockResolvedValue({
  results: [{
    vectorId: 'ke-vector-1',
    chunkId: 'ke-chunk-1',
    documentId: 'ke-doc-1',
    documentTitle: 'Kenya AML Regulation',
    jurisdictionCode: 'KE',
    jurisdiction: 'Kenya',
    chunkText: 'A regulated institution must perform customer due diligence.',
    score: 0.95,
    rank: 1,
  }],
  context: '[Document: Kenya AML Regulation]\nA regulated institution must perform customer due diligence.',
  corpusVersions: { KE: 'test-ke-v1' },
  retrievalVersion: 'transport-test',
}));

const runGraderAgent = vi.hoisted(() => vi.fn().mockImplementation(async (_question, results) => ({
  accepted: results,
  rejected: [],
  gradeFailed: false,
  diagnostics: {},
})));

const answerComplianceQuery = vi.hoisted(() => vi.fn().mockResolvedValue({
  content: 'Grounded compliance answer.',
  model: 'mock-claude',
  inputTokens: 12,
  outputTokens: 18,
}));

const answerFollowUpQuery = vi.hoisted(() => vi.fn().mockResolvedValue({
  content: 'Grounded follow-up answer.',
  model: 'mock-claude',
  inputTokens: 6,
  outputTokens: 9,
}));

vi.mock('@/lib/redis/client', () => ({ redis: fakeRedis }));
vi.mock('@/lib/prisma/client', () => ({ prisma: fakePrisma, disconnectDatabase: vi.fn() }));
vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));
vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn().mockImplementation(async () => ({
    plan: state.plan,
    source: 'ORGANIZATION_PLAN',
    entitlementProfile: null,
    entitlements: undefined,
    appliedOverrides: [],
    pilotState: null,
    customLimits: null,
    trialState: undefined,
  })),
}));
vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 10 }),
  incrementTrialUsage: vi.fn().mockResolvedValue(undefined),
  incrementTrialUsageAtomic: vi.fn().mockResolvedValue({ allowed: true, newCount: 1, limit: 10 }),
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { auth: { getUser: vi.fn().mockResolvedValue({ data: null, error: new Error('not used') }) } },
}));
vi.mock('@/config/app.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/app.config')>();
  return {
    ...actual,
    appConfig: {
      ...actual.appConfig,
      features: { ...actual.appConfig.features, orchestratorEnabled: false },
    },
  };
});
vi.mock('@/modules/user/restriction.service', () => ({
  section34RestrictionService: {
    isProcessingPermitted: vi.fn().mockResolvedValue({ permitted: true }),
  },
}));
vi.mock('@/lib/rag/rag.service', () => ({
  ragService: {
    getContextForPrompt: vi.fn().mockImplementation((results) => results.map((r: any) => r.chunkText).join('\n')),
  },
  searchAndGetRegulatoryEvidenceContext,
}));
vi.mock('@/modules/compliance/orchestrator/grader.agent', () => ({ runGraderAgent }));

describe('compliance authorization transport isolation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { router } = await import('@/server/trpc/init');
    const { complianceRouter } = await import('./compliance.router');

    const testRouter = router({ compliance: complianceRouter });
    app = Fastify();
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: testRouter,
        createContext: async () => ({
          user: {
            id: 'user-ke',
            email: 'owner@example.test',
            role: 'STARTUP',
            organizationId: 'org-ke',
            supabaseAuthId: 'supabase-user-ke',
          },
          prisma: fakePrisma,
          redis: fakeRedis,
          aiService: {
            answerComplianceQuery,
            answerFollowUpQuery,
          },
          ragService: {},
          storageService: {},
          mailer: {},
          req: { ip: '127.0.0.1', headers: {} },
          res: {},
        }),
      },
    });
    await app.ready();
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.plan = 'REGULATOR';
    state.homeJurisdictionCode = 'KE';
    state.originalMode = 'SINGLE';
    state.originalJurisdictions = ['KE'];
    fakeRedis.get.mockResolvedValue(null);
    fakeRedis.incr.mockResolvedValue(1);
  });

  async function post(path: string, payload: Record<string, unknown>) {
    return await app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  }

  it('allows restricted KE organizations to query their own country through tRPC', async () => {
    const response = await post('compliance.query', {
      question: 'What are the KYC requirements for a Kenyan payment fintech?',
      mode: 'SINGLE',
      jurisdictions: ['KE'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(200);
    expect(searchAndGetRegulatoryEvidenceContext).toHaveBeenCalledTimes(1);
    expect(answerComplianceQuery).toHaveBeenCalledTimes(1);
    expect(fakeRedis.incr).toHaveBeenCalledTimes(1);
  });

  it('denies a foreign jurisdiction before usage, Pinecone/RAG, or Anthropic boundaries', async () => {
    const response = await post('compliance.query', {
      question: 'What are the KYC requirements for a Rwandan payment fintech?',
      mode: 'SINGLE',
      jurisdictions: ['RW'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe('JURISDICTION_NOT_ENTITLED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(answerComplianceQuery).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
  });

  it('denies compare mode while globally disabled before usage, Pinecone/RAG, or Anthropic boundaries', async () => {
    const response = await post('compliance.query', {
      question: 'Compare KYC requirements for Kenya and Rwanda fintechs.',
      mode: 'COMPARE',
      jurisdictions: ['KE', 'RW'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('COMPARE_MODE_DISABLED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(answerComplianceQuery).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
  });

  it('fails closed when home jurisdiction is missing before usage or provider calls', async () => {
    state.homeJurisdictionCode = null;

    const response = await post('compliance.query', {
      question: 'What are the KYC requirements for a Kenyan payment fintech?',
      mode: 'SINGLE',
      jurisdictions: ['KE'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe('HOME_JURISDICTION_REQUIRED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(answerComplianceQuery).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
  });

  it('reauthorizes follow-ups against current entitlement instead of historic query scope', async () => {
    state.homeJurisdictionCode = 'RW';
    state.originalJurisdictions = ['KE'];

    const response = await post('compliance.followUp', {
      originalQueryId: 'query-ke',
      question: 'What follow-up controls should we prioritize?',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe('JURISDICTION_NOT_ENTITLED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(answerFollowUpQuery).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
  });
});
