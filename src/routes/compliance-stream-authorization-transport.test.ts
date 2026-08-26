import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  plan: 'REGULATOR',
  homeJurisdictionCode: 'KE' as string | null,
}));

const fakeRedis = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  incr: vi.fn().mockResolvedValue(1),
  incrby: vi.fn().mockResolvedValue(1),
  decr: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
}));

const fakePrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockImplementation(({ select }) => {
      if (select?.organizationId) {
        return Promise.resolve({ id: 'user-ke', organizationId: 'org-ke', role: 'STARTUP' });
      }
      return Promise.resolve({
        id: 'user-ke',
        email: 'owner@example.test',
        fullName: 'Test Owner',
        freeTrialActivatedAt: null,
        freeTrialExpiresAt: null,
        freeTrialUsage: null,
        isPilot: false,
        pilotExpiresAt: null,
        pilotAccessStatus: null,
      });
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
  organizationMember: {
    findUnique: vi.fn().mockResolvedValue({
      userId: 'user-ke',
      organizationId: 'org-ke',
      role: 'OWNER',
      status: 'ACTIVE',
    }),
  },
  pilotAccess: { findFirst: vi.fn().mockResolvedValue(null) },
  enterprisePlanOverride: { findMany: vi.fn().mockResolvedValue([]) },
  complianceQuery: { create: vi.fn().mockResolvedValue({ id: 'new-query' }), update: vi.fn().mockResolvedValue({}) },
  complianceQueryRun: { findFirst: vi.fn().mockResolvedValue(null) },
}));

const searchAndGetRegulatoryEvidenceContext = vi.hoisted(() => vi.fn());
const stream = vi.hoisted(() => vi.fn());

vi.mock('@/lib/redis/client', () => ({ redis: fakeRedis }));
vi.mock('@/lib/prisma/client', () => ({ prisma: fakePrisma, disconnectDatabase: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'supabase-user-ke' } },
        error: null,
      }),
    },
  },
}));
vi.mock('@/utils/token-revocation', () => ({ isTokenRevoked: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));
vi.mock('@/lib/rag/rag.service', () => ({
  ragService: { getContextForPrompt: vi.fn().mockReturnValue('accepted context') },
  searchAndGetRegulatoryEvidenceContext,
}));
vi.mock('@/lib/rag/client', () => ({ getPineconeDiagnostics: vi.fn().mockReturnValue({ available: true }) }));
vi.mock('@/lib/ai/client', () => ({ stream }));
vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 10 }),
  incrementTrialUsage: vi.fn().mockResolvedValue(undefined),
  incrementTrialUsageAtomic: vi.fn().mockResolvedValue({ allowed: true, newCount: 1, limit: 10 }),
  planCtxCacheKey: (userId: string) => `test-plan:${userId}`,
  fireTrialExpiredEmail: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@/modules/compliance/orchestrator/grader.agent', () => ({
  runGraderAgent: vi.fn().mockResolvedValue({ accepted: [], rejected: [], gradeFailed: false, diagnostics: {} }),
}));

describe('compliance stream authorization transport isolation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { registerComplianceStreamRoute } = await import('./compliance-stream.route');
    app = Fastify();
    await registerComplianceStreamRoute(app, ['http://localhost:3000']);
    await app.ready();
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.plan = 'REGULATOR';
    state.homeJurisdictionCode = 'KE';
    fakeRedis.get.mockResolvedValue(null);
  });

  async function post(payload: Record<string, unknown>) {
    return await app.inject({
      method: 'POST',
      url: '/api/compliance/stream',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  }

  it('denies a foreign jurisdiction before usage, Pinecone/RAG, or Anthropic boundaries', async () => {
    const response = await post({
      question: 'What are the KYC requirements for a Rwandan payment fintech?',
      mode: 'SINGLE',
      jurisdictions: ['RW'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('JURISDICTION_NOT_ENTITLED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
    expect(fakeRedis.incrby).not.toHaveBeenCalled();
  });

  it('denies compare mode before usage, Pinecone/RAG, or Anthropic boundaries', async () => {
    const response = await post({
      question: 'Compare KYC requirements for Kenya and Rwanda fintechs.',
      mode: 'COMPARE',
      jurisdictions: ['KE', 'RW'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('COMPARISON_NOT_ENTITLED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
    expect(fakeRedis.incrby).not.toHaveBeenCalled();
  });

  it('fails closed when home jurisdiction is missing before usage or provider calls', async () => {
    state.homeJurisdictionCode = null;

    const response = await post({
      question: 'What are the KYC requirements for a Kenyan payment fintech?',
      mode: 'SINGLE',
      jurisdictions: ['KE'],
      organizationType: 'FINTECH',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('HOME_JURISDICTION_REQUIRED');
    expect(searchAndGetRegulatoryEvidenceContext).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(fakeRedis.incr).not.toHaveBeenCalled();
    expect(fakeRedis.incrby).not.toHaveBeenCalled();
  });
});
