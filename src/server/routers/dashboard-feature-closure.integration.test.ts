import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemberRole, MemberStatus } from '@prisma/client';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import type { EffectivePlan } from '@/types/plan.types';

const mocks = vi.hoisted(() => ({
  prisma: {
    organizationMember: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    customFramework: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    customFrameworkSection: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customFrameworkControl: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customFrameworkVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    regulatoryApplication: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    applicationTimelineEvent: { create: vi.fn() },
    applicationDocument: { create: vi.fn() },
    applicationFee: { create: vi.fn() },
    applicationRegulatorFeedback: { create: vi.fn() },
    regulatoryAlert: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    alertSubscription: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    alertNotification: { count: vi.fn() },
  },
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    decr: vi.fn(),
    expire: vi.fn(),
  },
  rateLimiter: { check: vi.fn(), checkOrThrow: vi.fn() },
  resolveEffectivePlan: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/prisma/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/redis/client', () => ({ redis: mocks.redis }));
vi.mock('@/lib/redis/rate-limiter', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: mocks.resolveEffectivePlan,
}));
vi.mock('@/lib/system-config', () => ({
  loadSystemConfig: vi.fn(async () => ({ maintenanceMode: false })),
}));
vi.mock('@/utils/logger', () => ({ logger: mocks.logger }));
vi.mock('@/lib/redis/pubsub', () => ({ alertPubSub: { publish: vi.fn() } }));
vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: { sendRegulatoryAlertEmail: vi.fn() },
}));

import { customFrameworkRouter } from './custom-framework.router';
import { applicationRouter } from './application.router';
import { alertRouter } from './alert.router';

type PlanUnderTest = EffectivePlan;
type JurisdictionCode = 'KE' | 'RW' | 'MW';

const plans: PlanUnderTest[] = ['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE', 'FREE_TRIAL'];
const deniedCustomFrameworkPlans: PlanUnderTest[] = ['REGULATOR', 'STARTUP', 'BUSINESS', 'FREE_TRIAL'];
const jurisdictions: JurisdictionCode[] = ['KE', 'RW', 'MW'];

let currentPlan: PlanUnderTest = 'ENTERPRISE';

function baseCtx(organizationId = 'org-a', role = 'STARTUP') {
  return {
    user: {
      id: `user-${organizationId}`,
      email: `${organizationId}@example.com`,
      role,
      organizationId,
      supabaseAuthId: `auth-${organizationId}`,
    },
    prisma: mocks.prisma,
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' } },
    res: {},
  } as any;
}

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ code });
}

function configureCommonMocks() {
  vi.clearAllMocks();
  mocks.redis.get.mockResolvedValue(null);
  mocks.redis.set.mockResolvedValue('OK');
  mocks.redis.del.mockResolvedValue(1);
  mocks.rateLimiter.check.mockResolvedValue({ allowed: true });
  mocks.rateLimiter.checkOrThrow.mockResolvedValue(undefined);
  mocks.prisma.auditLog.create.mockResolvedValue({});
  mocks.prisma.organizationMember.findUnique.mockImplementation(async ({ where }: any) => ({
    userId: where.userId_organizationId.userId,
    organizationId: where.userId_organizationId.organizationId,
    role: MemberRole.OWNER,
    status: MemberStatus.ACTIVE,
  }));
  mocks.resolveEffectivePlan.mockImplementation(async () => ({
    plan: currentPlan,
    source: currentPlan === 'FREE_TRIAL' ? 'trial' : 'subscription',
    entitlements: PLAN_ENTITLEMENTS[currentPlan],
    entitlementProfile: null,
    appliedOverrides: [],
    pilotState: null,
    trialState: null,
    customLimits: null,
  }));
}

function configureCustomFrameworkSuccessMocks() {
  const framework = {
    id: 'fw-a',
    organizationId: 'org-a',
    name: 'Org A Framework',
    slug: 'org-a-framework',
    description: null,
    jurisdiction: 'KE',
    regulator: 'CBK',
    category: 'AML',
    status: 'DRAFT',
    version: 1,
    sections: [{ id: 'section-a', title: 'Governance' }],
    controls: [{ id: 'control-a', title: 'Board approval', requirement: 'Approve policy' }],
  };

  mocks.prisma.customFramework.findMany.mockResolvedValue([framework]);
  mocks.prisma.customFramework.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.slug) return null;
    if (where.id === 'fw-b') return null;
    return framework;
  });
  mocks.prisma.customFramework.create.mockImplementation(async ({ data }: any) => ({
    ...framework,
    ...data,
    id: 'fw-new',
    status: 'DRAFT',
    version: 1,
  }));
  mocks.prisma.customFramework.update.mockImplementation(async ({ data }: any) => ({
    ...framework,
    ...data,
  }));
  mocks.prisma.customFrameworkSection.findFirst.mockResolvedValue({
    id: 'section-a',
    frameworkId: 'fw-a',
    organizationId: 'org-a',
  });
  mocks.prisma.customFrameworkSection.create.mockImplementation(async ({ data }: any) => ({
    id: 'section-new',
    ...data,
  }));
  mocks.prisma.customFrameworkControl.findFirst.mockResolvedValue({
    id: 'control-a',
    frameworkId: 'fw-a',
    organizationId: 'org-a',
  });
  mocks.prisma.customFrameworkControl.create.mockImplementation(async ({ data }: any) => ({
    id: 'control-new',
    ...data,
  }));
  mocks.prisma.customFrameworkVersion.create.mockResolvedValue({ id: 'version-a' });
}

function configureApplicationSuccessMocks() {
  const app = {
    id: 'app-a',
    organizationId: 'org-a',
    userId: 'user-org-a',
    title: 'PSP License',
    jurisdictionCode: 'KE',
    regulator: 'CBK',
    licenseType: 'Payment Service Provider',
    status: 'DRAFT',
    progress: 0,
    referenceNumber: null,
    nextAction: null,
    dueDate: null,
    submittedAt: null,
    decidedAt: null,
    updatedAt: new Date(),
    deletedAt: null,
    timelineEvents: [],
    documents: [],
    fees: [],
    regulatorFeedback: [],
  };

  mocks.prisma.regulatoryApplication.findMany.mockResolvedValue([app]);
  mocks.prisma.regulatoryApplication.count.mockResolvedValue(1);
  mocks.prisma.regulatoryApplication.findFirst.mockResolvedValue({ id: 'app-a', organizationId: 'org-a' });
  mocks.prisma.regulatoryApplication.findUnique.mockResolvedValue(app);
  mocks.prisma.regulatoryApplication.create.mockImplementation(async ({ data }: any) => ({
    ...app,
    ...data,
    id: 'app-new',
  }));
  mocks.prisma.regulatoryApplication.update.mockImplementation(async ({ data }: any) => ({
    ...app,
    ...data,
  }));
  mocks.prisma.applicationTimelineEvent.create.mockImplementation(async ({ data }: any) => ({
    id: 'timeline-new',
    ...data,
  }));
  mocks.prisma.applicationDocument.create.mockImplementation(async ({ data }: any) => ({
    id: 'document-new',
    ...data,
  }));
  mocks.prisma.applicationFee.create.mockImplementation(async ({ data }: any) => ({
    id: 'fee-new',
    ...data,
  }));
  mocks.prisma.applicationRegulatorFeedback.create.mockImplementation(async ({ data }: any) => ({
    id: 'feedback-new',
    ...data,
  }));
}

beforeEach(() => {
  currentPlan = 'ENTERPRISE';
  configureCommonMocks();
});

describe('dashboard feature closure - custom framework entitlements', () => {
  it.each(deniedCustomFrameworkPlans)('denies every custom framework operation for %s', async (plan) => {
    currentPlan = plan;
    const caller = customFrameworkRouter.createCaller(baseCtx());

    await expectCode(caller.list(), 'FORBIDDEN');
    await expectCode(caller.get({ id: 'fw-a' }), 'FORBIDDEN');
    await expectCode(caller.create({ name: 'Denied Framework', jurisdiction: 'KE' }), 'FORBIDDEN');
    await expectCode(caller.updateMetadata({ id: 'fw-a', name: 'Denied Update' }), 'FORBIDDEN');
    await expectCode(caller.publish({ id: 'fw-a' }), 'FORBIDDEN');
    await expectCode(caller.archive({ id: 'fw-a' }), 'FORBIDDEN');
    await expectCode(caller.createSection({ frameworkId: 'fw-a', title: 'Denied Section' }), 'FORBIDDEN');
    await expectCode(caller.createControl({ frameworkId: 'fw-a', title: 'Denied Control', requirement: 'No access' }), 'FORBIDDEN');
  });

  it('allows enterprise custom framework operations through the real plan gate', async () => {
    currentPlan = 'ENTERPRISE';
    configureCustomFrameworkSuccessMocks();
    const caller = customFrameworkRouter.createCaller(baseCtx());

    await expect(caller.list()).resolves.toHaveLength(1);
    await expect(caller.get({ id: 'fw-a' })).resolves.toMatchObject({ id: 'fw-a' });
    await expect(caller.create({ name: 'Enterprise Framework', jurisdiction: 'RW' })).resolves.toMatchObject({ jurisdiction: 'RW' });
    await expect(caller.updateMetadata({ id: 'fw-a', name: 'Updated Framework' })).resolves.toMatchObject({ name: 'Updated Framework' });
    await expect(caller.publish({ id: 'fw-a' })).resolves.toMatchObject({ status: 'PUBLISHED' });
    await expect(caller.archive({ id: 'fw-a' })).resolves.toMatchObject({ status: 'ARCHIVED' });
    await expect(caller.createSection({ frameworkId: 'fw-a', title: 'Section' })).resolves.toMatchObject({ id: 'section-new' });
    await expect(caller.createControl({ frameworkId: 'fw-a', title: 'Control', requirement: 'Requirement' })).resolves.toMatchObject({ id: 'control-new' });
  });
});

describe('dashboard feature closure - tenant isolation', () => {
  it('denies Organization A access to Organization B custom frameworks without NOT_FOUND leakage', async () => {
    currentPlan = 'ENTERPRISE';
    configureCustomFrameworkSuccessMocks();
    mocks.prisma.customFramework.findFirst.mockResolvedValue(null);
    mocks.prisma.customFrameworkSection.findFirst.mockResolvedValue(null);
    mocks.prisma.customFrameworkControl.findFirst.mockResolvedValue(null);
    const caller = customFrameworkRouter.createCaller(baseCtx('org-a'));

    await expectCode(caller.get({ id: 'fw-b' }), 'FORBIDDEN');
    await expectCode(caller.updateMetadata({ id: 'fw-b', name: 'Attack' }), 'FORBIDDEN');
    await expectCode(caller.publish({ id: 'fw-b' }), 'FORBIDDEN');
    await expectCode(caller.archive({ id: 'fw-b' }), 'FORBIDDEN');
    await expectCode(caller.createSection({ frameworkId: 'fw-b', title: 'Attack Section' }), 'FORBIDDEN');
    await expectCode(caller.updateSection({ id: 'section-b', title: 'Attack Section' }), 'FORBIDDEN');
    await expectCode(caller.createControl({ frameworkId: 'fw-b', title: 'Attack Control', requirement: 'Attack' }), 'FORBIDDEN');
    await expectCode(caller.updateControl({ id: 'control-b', title: 'Attack Control' }), 'FORBIDDEN');
  });

  it('denies Organization A access to Organization B applications and sub-record mutations', async () => {
    configureApplicationSuccessMocks();
    mocks.prisma.regulatoryApplication.findFirst.mockResolvedValue(null);
    const caller = applicationRouter.createCaller(baseCtx('org-a'));

    await expectCode(caller.get({ id: 'app-b' }), 'FORBIDDEN');
    await expectCode(caller.update({ id: 'app-b', title: 'Attack' }), 'FORBIDDEN');
    await expectCode(caller.delete({ id: 'app-b' }), 'FORBIDDEN');
    await expectCode(caller.addTimelineEvent({ applicationId: 'app-b', title: 'Attack' }), 'FORBIDDEN');
    await expectCode(caller.addDocument({ applicationId: 'app-b', name: 'Attack document' }), 'FORBIDDEN');
    await expectCode(caller.addFee({ applicationId: 'app-b', description: 'Attack fee', amount: 100, currency: 'KES' }), 'FORBIDDEN');
    await expectCode(caller.addRegulatorFeedback({ applicationId: 'app-b', message: 'Attack feedback' }), 'FORBIDDEN');
  });
});

describe('dashboard feature closure - application plan access', () => {
  it.each(plans)('keeps applications available to %s authenticated organization members', async (plan) => {
    currentPlan = plan;
    configureApplicationSuccessMocks();
    const role = plan === 'REGULATOR' ? 'REGULATOR' : 'STARTUP';
    const caller = applicationRouter.createCaller(baseCtx('org-a', role));

    await expect(caller.list({ page: 1, limit: 20 })).resolves.toMatchObject({ applications: expect.any(Array) });
    await expect(caller.create({
      title: `${plan} Application`,
      jurisdictionCode: 'KE',
      regulator: 'CBK',
      licenseType: 'PSP',
    })).resolves.toMatchObject({ id: 'app-new' });
    await expect(caller.get({ id: 'app-a' })).resolves.toMatchObject({ id: 'app-a' });
    await expect(caller.update({ id: 'app-a', title: `${plan} Updated` })).resolves.toMatchObject({ title: `${plan} Updated` });
    expect(mocks.resolveEffectivePlan).not.toHaveBeenCalled();
  });
});

describe('dashboard feature closure - KE/RW/MW journeys', () => {
  it.each(jurisdictions)('persists and filters %s applications and fee currency', async (jurisdictionCode) => {
    configureApplicationSuccessMocks();
    const caller = applicationRouter.createCaller(baseCtx());
    const currency = jurisdictionCode === 'KE' ? 'KES' : jurisdictionCode === 'RW' ? 'RWF' : 'MWK';

    await caller.list({ page: 1, limit: 20, jurisdictionCode });
    expect(mocks.prisma.regulatoryApplication.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ jurisdictionCode }),
    }));

    await expect(caller.create({
      title: `${jurisdictionCode} Application`,
      jurisdictionCode,
      regulator: 'Regulator',
      licenseType: 'License',
    })).resolves.toMatchObject({ jurisdictionCode });

    await expect(caller.addFee({
      applicationId: 'app-a',
      description: `${jurisdictionCode} Fee`,
      amount: 100,
      currency,
    })).resolves.toMatchObject({ currency });
  });

  it.each(jurisdictions)('accepts %s custom framework jurisdiction', async (jurisdiction) => {
    currentPlan = 'ENTERPRISE';
    configureCustomFrameworkSuccessMocks();
    const caller = customFrameworkRouter.createCaller(baseCtx());

    await expect(caller.create({ name: `${jurisdiction} Framework`, jurisdiction })).resolves.toMatchObject({ jurisdiction });
  });

  it.each(['NG', 'US'])('rejects unsupported custom framework jurisdiction %s', async (jurisdiction) => {
    currentPlan = 'ENTERPRISE';
    configureCustomFrameworkSuccessMocks();
    const caller = customFrameworkRouter.createCaller(baseCtx());

    await expectCode(caller.create({ name: 'Unsupported Framework', jurisdiction } as any), 'BAD_REQUEST');
  });

  it.each(jurisdictions)('preserves and filters %s regulatory alerts through tRPC', async (jurisdictionCode) => {
    currentPlan = 'ENTERPRISE';
    const now = new Date();
    mocks.prisma.regulatoryAlert.create.mockImplementation(async ({ data }: any) => ({
      id: `alert-${jurisdictionCode}`,
      ...data,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    mocks.prisma.regulatoryAlert.findMany.mockImplementation(async ({ where }: any) => ([{
      id: `alert-${jurisdictionCode}`,
      title: `${jurisdictionCode} Alert`,
      summary: 'Country alert',
      body: 'Country alert body',
      jurisdictionCode: where.jurisdictionCode,
      regulatoryBody: 'CBK',
      category: 'GENERAL',
      severity: 'LOW',
      isActive: true,
      publishedAt: now,
      notifications: [],
    }]));
    mocks.prisma.regulatoryAlert.count.mockResolvedValue(1);
    mocks.prisma.alertSubscription.upsert.mockImplementation(async ({ create, update }: any) => ({
      id: 'sub-a',
      organizationId: 'org-a',
      ...(create ?? update),
    }));

    const adminCaller = alertRouter.createCaller(baseCtx('org-a', 'ADMIN'));
    const memberCaller = alertRouter.createCaller(baseCtx('org-a'));

    await expect(adminCaller.create({
      title: `${jurisdictionCode} Alert`,
      summary: 'Regulatory alert summary',
      body: 'Regulatory alert body text',
      jurisdictionCode,
      regulatoryBody: jurisdictionCode === 'RW' ? 'BNR' : jurisdictionCode === 'MW' ? 'RBM' : 'CBK',
      category: 'GENERAL',
      severity: 'LOW',
    })).resolves.toMatchObject({ jurisdictionCode });

    await expect(memberCaller.getAlerts({ page: 1, limit: 20, jurisdictionCode })).resolves.toMatchObject({
      alerts: [expect.objectContaining({ jurisdictionCode })],
    });
    expect(mocks.prisma.regulatoryAlert.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ jurisdictionCode }),
    }));

    await expect(memberCaller.upsertSubscription({
      jurisdictions: [jurisdictionCode],
      regulatoryBodies: ['CBK'],
      categories: ['GENERAL'],
      severityThreshold: 'LOW',
      emailEnabled: false,
      inAppEnabled: true,
      emailFrequency: 'DAILY',
    })).resolves.toMatchObject({ jurisdictions: [jurisdictionCode] });
  });
});
