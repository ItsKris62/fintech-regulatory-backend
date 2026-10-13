import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberRole, MemberStatus } from '@prisma/client';
import { PLAN_ENTITLEMENTS, PILOT_ENTITLEMENT_PROFILES } from '@/config/entitlements.config';
import type { EffectivePlan } from '@/types/plan.types';

const mocks = vi.hoisted(() => ({
  plan: 'STARTER' as EffectivePlan,
  source: 'SUBSCRIPTION' as 'SUBSCRIPTION' | 'FREE_TRIAL' | 'PILOT',
  entitlements: null as typeof PLAN_ENTITLEMENTS[EffectivePlan] | null,
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisIncr: vi.fn(),
  redisIncrby: vi.fn(),
  redisExpire: vi.fn(),
  redisDel: vi.fn(),
  runGapAnalysis: vi.fn(),
  validateBenchmarks: vi.fn(),
  trialIncrement: vi.fn(),
  prisma: {
    organizationMember: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    regulatoryFramework: { findMany: vi.fn() },
    gapAnalysisFramework: { createMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/gap-analysis-file-validator', () => ({
  validateGapAnalysisFile: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    incr: mocks.redisIncr,
    incrby: mocks.redisIncrby,
    decr: vi.fn(),
    decrby: vi.fn(),
    expire: mocks.redisExpire,
    del: mocks.redisDel,
  },
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    checkOrThrow: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn(async () => ({
    plan: mocks.plan,
    orgPlan: mocks.plan === 'FREE_TRIAL' ? 'FREE' : mocks.plan,
    entitlements: mocks.entitlements ?? PLAN_ENTITLEMENTS[mocks.plan],
    appliedOverrides: [],
    customLimits: null,
    subscriptionStatus: 'ACTIVE',
    gracePeriodEndsAt: null,
    trialState: mocks.plan === 'FREE_TRIAL' ? { isActive: true, daysRemaining: 5 } : undefined,
    pilotState: mocks.source === 'PILOT'
      ? { isPilot: true, status: 'ACTIVE', entitlementProfile: 'PILOT_FULL', expiresAt: null, extensionCount: 0 }
      : null,
    source: mocks.source,
    entitlementProfile: mocks.source === 'PILOT' ? 'PILOT_FULL' : null,
    fromCache: false,
  })),
}));

vi.mock('@/modules/trial', () => ({
  checkTrialLimit: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 5 }),
  incrementTrialUsageAtomic: mocks.trialIncrement,
}));

vi.mock('@/modules/compliance', () => ({
  complianceModule: {
    runGapAnalysis: mocks.runGapAnalysis,
    getUserGapAnalyses: vi.fn(),
    getGapAnalysisResult: vi.fn(),
    deleteGapAnalysis: vi.fn(),
  },
}));

vi.mock('../../services/benchmark-document.service', () => ({
  validateAuthorizedBenchmarkDocumentIds: mocks.validateBenchmarks,
}));

vi.mock('@/modules/jurisdiction/jurisdiction-entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/jurisdiction/jurisdiction-entitlements')>();
  return {
    ...actual,
    resolveJurisdictionEntitlement: vi.fn().mockResolvedValue({
      jurisdictionContext: {
        mode: 'SINGLE',
        jurisdictions: ['KE'],
        primaryJurisdiction: 'KE',
        source: 'ORGANIZATION_HOME',
      },
    }),
  };
});

vi.mock('@/modules/user/restriction.service', () => ({
  section34RestrictionService: {
    isProcessingPermitted: vi.fn().mockResolvedValue({ permitted: true }),
  },
}));

vi.mock('@/lib/system-config', () => ({
  loadSystemConfig: vi.fn().mockResolvedValue({ maintenanceMode: false, maintenanceMessage: '' }),
  getSystemConfigNumber: vi.fn().mockImplementation(async (_key: string, fallback: number) => fallback),
}));

vi.mock('@/server/services/audit.service', () => ({
  logSecurityEvent: vi.fn().mockResolvedValue(undefined),
  SECURITY_EVENT_TYPES: {},
}));

vi.mock('@/lib/prisma/client', () => ({ prisma: mocks.prisma }));

import { gapAnalysisRouter } from '../gap-analysis.router';

const tenantPrismaMock = {
  gapAnalysis: {
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
  },
};

function caller() {
  return gapAnalysisRouter.createCaller({
    user: {
      id: 'user-1',
      email: 'member@example.test',
      role: 'STARTUP',
      organizationId: 'org-1',
      supabaseAuthId: 'supabase-user-1',
      totpEnabled: true,
    },
    prisma: mocks.prisma,
    tenantPrisma: tenantPrismaMock,
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } },
    res: {},
  } as never);
}

function input(depth: 'quick' | 'standard' | 'deep', withBenchmark: boolean) {
  return {
    fileName: 'policy.pdf',
    fileType: 'pdf' as const,
    fileContent: Buffer.from('valid policy fixture').toString('base64'),
    processingConsentAcknowledged: true,
    consentVersion: '2026-10-01',
    regulatoryFrameworks: ['test-framework'],
    benchmarkDocumentIds: withBenchmark ? ['benchmark-1'] : undefined,
    analysisDepth: depth,
  };
}

type MatrixCase = {
  label: string;
  plan: EffectivePlan;
  source?: 'SUBSCRIPTION' | 'FREE_TRIAL' | 'PILOT';
  entitlements?: typeof PLAN_ENTITLEMENTS[EffectivePlan];
  depths: ReadonlyArray<'quick' | 'standard' | 'deep'>;
  benchmark: boolean;
};

const matrix: MatrixCase[] = [
  { label: 'Free', plan: 'FREE', depths: [], benchmark: false },
  { label: 'Starter', plan: 'STARTER', depths: ['quick'], benchmark: false },
  { label: 'Growth', plan: 'GROWTH', depths: ['quick', 'standard'], benchmark: false },
  { label: 'Business', plan: 'BUSINESS', depths: ['quick', 'standard', 'deep'], benchmark: true },
  { label: 'Enterprise', plan: 'ENTERPRISE', depths: ['quick', 'standard', 'deep'], benchmark: true },
  { label: 'Regulator', plan: 'REGULATOR', depths: [], benchmark: false },
  { label: 'Free Trial', plan: 'FREE_TRIAL', source: 'FREE_TRIAL', depths: ['quick', 'standard', 'deep'], benchmark: false },
  { label: 'legacy Startup', plan: 'STARTUP', depths: ['quick'], benchmark: false },
  {
    label: 'active Pilot',
    plan: 'ENTERPRISE',
    source: 'PILOT',
    entitlements: PILOT_ENTITLEMENT_PROFILES.PILOT_FULL,
    depths: ['quick', 'standard', 'deep'],
    benchmark: true,
  },
];

describe('Gap Analysis direct backend contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.organizationMember.findUnique.mockResolvedValue({
      userId: 'user-1',
      organizationId: 'org-1',
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
    });
    mocks.prisma.auditLog.create.mockResolvedValue({});
    mocks.prisma.regulatoryFramework.findMany.mockResolvedValue([
      { id: 'framework-1', slug: 'test-framework', name: 'Test Framework', category: 'Test', tier: 'FREE', sortOrder: 1 },
    ]);
    mocks.prisma.gapAnalysisFramework.createMany.mockResolvedValue({ count: 1 });
    mocks.redisGet.mockImplementation(async (key: string) => key.startsWith('sheriabot:orgmem:')
      ? { userId: 'user-1', organizationId: 'org-1', role: MemberRole.OWNER, status: MemberStatus.ACTIVE }
      : null);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.redisIncr.mockResolvedValue(1);
    mocks.redisIncrby.mockImplementation(async (_key: string, units: number) => units);
    mocks.redisExpire.mockResolvedValue(1);
    mocks.runGapAnalysis.mockResolvedValue({ id: 'analysis-1', status: 'QUEUED' });
    mocks.validateBenchmarks.mockImplementation(async ({ benchmarkDocumentIds }: { benchmarkDocumentIds: string[] }) =>
      benchmarkDocumentIds.map((id) => ({
        id,
        title: 'Benchmark',
        documentType: 'REGULATION',
        regulatoryBody: 'Authority',
        source: 'Authority',
        authorityStatus: 'OFFICIAL',
        version: '1',
        isGlobal: false,
      })),
    );
    mocks.trialIncrement.mockImplementation(async (_userId: string, _feature: string, units: number) => ({
      allowed: true,
      newCount: units,
      limit: 5,
    }));
  });

  for (const planCase of matrix) {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      for (const withBenchmark of [false, true]) {
        const shouldAllow = planCase.depths.includes(depth) && (!withBenchmark || planCase.benchmark);

        it(`${planCase.label}: ${depth}, benchmark=${withBenchmark} => ${shouldAllow ? 'allowed' : 'forbidden'}`, async () => {
          mocks.plan = planCase.plan;
          mocks.source = planCase.source ?? 'SUBSCRIPTION';
          mocks.entitlements = planCase.entitlements ?? PLAN_ENTITLEMENTS[planCase.plan];

          const request = caller().runGapAnalysis(input(depth, withBenchmark));
          if (shouldAllow) {
            await expect(request).resolves.toMatchObject({ id: 'analysis-1' });
          } else {
            await expect(request).rejects.toMatchObject({ code: 'FORBIDDEN' });
          }
        });
      }
    }
  }

  it('rejects a handcrafted Growth deep request before usage is consumed', async () => {
    mocks.plan = 'GROWTH';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.GROWTH;

    await expect(caller().runGapAnalysis(input('deep', false))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
    expect(mocks.trialIncrement).not.toHaveBeenCalled();
  });

  it('rejects a handcrafted Starter benchmark request before usage is consumed', async () => {
    mocks.plan = 'STARTER';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.STARTER;

    await expect(caller().runGapAnalysis(input('quick', true))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.validateBenchmarks).not.toHaveBeenCalled();
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
  });

  it.each([
    ['quick', 1],
    ['standard', 2],
    ['deep', 5],
  ] as const)('%s consumes %i unit(s) only after a valid request is accepted', async (depth, units) => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;

    await caller().runGapAnalysis(input(depth, false));

    if (units === 1) expect(mocks.redisIncr).toHaveBeenCalledTimes(1);
    else expect(mocks.redisIncrby).toHaveBeenCalledWith(expect.any(String), units);
  });

  it('does not consume units when benchmark ID validation fails', async () => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;
    mocks.validateBenchmarks.mockRejectedValueOnce(new Error('unavailable benchmark'));

    await expect(caller().runGapAnalysis(input('quick', true))).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
  });

  it('does not consume units when framework validation fails', async () => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;
    mocks.prisma.regulatoryFramework.findMany.mockResolvedValueOnce([]);

    await expect(caller().runGapAnalysis(input('quick', false))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
  });

  it.each([
    ['policy.pdf', 'pdf'],
    ['policy.docx', 'docx'],
    ['policy.txt', 'txt'],
  ] as const)('accepts the canonical file type %s', async (fileName, fileType) => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;

    await expect(caller().runGapAnalysis({
      ...input('quick', false),
      fileName,
      fileType,
    })).resolves.toMatchObject({ id: 'analysis-1' });
  });

  it('rejects legacy DOC at the backend schema boundary without consuming usage', async () => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;

    await expect(caller().runGapAnalysis({
      ...input('quick', false),
      fileName: 'policy.doc',
      fileType: 'doc',
    } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
  });

  it('rejects a mismatched filename and declared type without consuming usage', async () => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;

    await expect(caller().runGapAnalysis({
      ...input('quick', false),
      fileName: 'policy.txt',
      fileType: 'pdf',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
  });

  it('rejects a file over 10 MB without consuming usage', async () => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;

    await expect(caller().runGapAnalysis({
      ...input('quick', false),
      fileContent: Buffer.alloc((10 * 1024 * 1024) + 1).toString('base64'),
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
  });

  it('returns a deduplicated result without consuming units', async () => {
    mocks.plan = 'BUSINESS';
    mocks.source = 'SUBSCRIPTION';
    mocks.entitlements = PLAN_ENTITLEMENTS.BUSINESS;
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('sheriabot:orgmem:')) {
        return { userId: 'user-1', organizationId: 'org-1', role: MemberRole.OWNER, status: MemberStatus.ACTIVE };
      }
      if (key.startsWith('sheriabot:gapanalysis:dedup:')) return 'existing-analysis';
      return null;
    });
    tenantPrismaMock.gapAnalysis.findFirst.mockResolvedValueOnce({ id: 'existing-analysis', status: 'COMPLETED' });

    await expect(caller().runGapAnalysis(input('quick', false))).resolves.toMatchObject({ id: 'existing-analysis' });
    expect(mocks.redisIncr).not.toHaveBeenCalled();
    expect(mocks.redisIncrby).not.toHaveBeenCalled();
    expect(mocks.runGapAnalysis).not.toHaveBeenCalled();
  });
});
