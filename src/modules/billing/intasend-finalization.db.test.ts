import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  MemberRole,
  MemberStatus,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { intaSendFinalizationService } from './intasend-finalization.service';
import { prisma as appPrisma } from '@/lib/prisma/client';

vi.mock('@/lib/redis/client', () => ({
  redis: {
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: {
    sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
    sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

import { reactMailer } from '@/lib/email/react-mailer.service';

const safeDatabaseEnvironments = new Set(['development-uat', 'preview']);
const databaseEnvironment = process.env.DATABASE_ENVIRONMENT?.trim().toLowerCase() ?? 'unknown';
const canRunDatabaseTests = safeDatabaseEnvironments.has(databaseEnvironment) && Boolean(process.env.DATABASE_URL);

const describeIfSafeDb = canRunDatabaseTests ? describe : describe.skip;

const prisma = canRunDatabaseTests ? appPrisma : null;

type TestFixture = {
  marker: string;
  orgId: string;
  userId: string;
  paymentId: string;
  providerTransactionId: string;
  invoiceNumber: string;
};

function verifiedStatus(invoiceId: string, amount = 4999, currency = 'KES') {
  return {
    invoiceId,
    state: 'COMPLETE' as const,
    amount,
    currency,
    providerRef: `mpesa-${invoiceId}`,
    raw: { invoice_id: invoiceId, state: 'COMPLETE', amount, currency },
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function cleanup(marker: string): Promise<void> {
  if (!prisma) return;
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { contains: marker } },
        { metadata: { path: ['testMarker'], equals: marker } },
      ],
    },
  });
  await prisma.payment.deleteMany({ where: { metadata: { path: ['testMarker'], equals: marker } } });
  await prisma.organizationMember.deleteMany({ where: { organization: { name: { contains: marker } } } });
  await prisma.user.deleteMany({ where: { email: { contains: marker } } });
  await prisma.organization.deleteMany({ where: { name: { contains: marker } } });
}

async function createFixture(options: {
  marker?: string;
  plan?: SubscriptionPlan;
  orgPlan?: SubscriptionPlan;
  orgStatus?: SubscriptionStatus;
  paymentPurpose?: PaymentPurpose;
  paidThrough?: Date | null;
  paymentStatus?: PaymentStatus;
} = {}): Promise<TestFixture> {
  if (!prisma) throw new Error('DB tests require a Prisma client.');
  const marker = options.marker ?? `stage-intasend-${randomUUID()}`;
  const orgId = `${marker}-org`;
  const userId = `${marker}-user`;
  const paymentId = `${marker}-payment`;
  const providerTransactionId = `${marker}-invoice`;
  const invoiceNumber = `SB-UAT-${randomUUID()}`;
  const purchasePlan = options.plan ?? SubscriptionPlan.STARTUP;
  const currentPlan = options.orgPlan ?? SubscriptionPlan.REGULATOR;
  const paidThrough = options.paidThrough ?? null;

  await cleanup(marker);

  await prisma.organization.create({
    data: {
      id: orgId,
      name: `Stage IntaSend ${marker}`,
      type: 'startup',
      organizationType: 'startup',
      plan: currentPlan,
      subscriptionTier: currentPlan,
      subscriptionStatus: options.orgStatus ?? SubscriptionStatus.ACTIVE,
      planStartDate: paidThrough ? addDays(paidThrough, -30) : null,
      planEndDate: paidThrough,
      subscriptionCycleEnd: paidThrough,
      mpesaNextPaymentDueDate: paidThrough,
      preferredPaymentMethod: PaymentProvider.MPESA,
      mpesaPhoneNumber: '254712345678',
    },
  });

  await prisma.user.create({
    data: {
      id: userId,
      email: `${marker}@example.test`,
      fullName: 'Stage Billing Owner',
      role: UserRole.STARTUP,
      status: UserStatus.ACTIVE,
      accountStatus: 'active',
      emailVerified: true,
    },
  });

  await prisma.organizationMember.create({
    data: {
      userId,
      organizationId: orgId,
      role: MemberRole.OWNER,
      status: MemberStatus.ACTIVE,
    },
  });

  await prisma.payment.create({
    data: {
      id: paymentId,
      orgId,
      provider: PaymentProvider.MPESA,
      providerTransactionId,
      amount: 499900,
      currency: 'KES',
      status: options.paymentStatus ?? PaymentStatus.PENDING,
      paymentPurpose: options.paymentPurpose ?? PaymentPurpose.INITIAL_PURCHASE,
      invoiceNumber,
      subscriptionPlan: purchasePlan,
      description: `${purchasePlan} IntaSend DB integration test`,
      metadata: {
        testMarker: marker,
        amountMinor: 499900,
        amountKes: 4999,
        currency: 'KES',
        paymentPurpose: options.paymentPurpose ?? PaymentPurpose.INITIAL_PURCHASE,
      },
    },
  });

  return { marker, orgId, userId, paymentId, providerTransactionId, invoiceNumber };
}

describeIfSafeDb('IntaSend finalization DB-backed staging gates', () => {
  const markers: string[] = [];

  beforeAll(async () => {
    expect(databaseEnvironment).toMatch(/^(development-uat|preview)$/);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const marker of markers.splice(0)) {
      await cleanup(marker);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await appPrisma.$disconnect();
  });

  it('allows only one real database transaction to complete a payment under concurrent finalization', async () => {
    const fixture = await createFixture({ plan: SubscriptionPlan.STARTUP });
    markers.push(fixture.marker);

    const results = await Promise.all([
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'webhook' }),
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'polling' }),
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'reconciliation' }),
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'admin' }),
    ]);

    const payment = await prisma!.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
    const organization = await prisma!.organization.findUniqueOrThrow({ where: { id: fixture.orgId } });
    const paymentCompletedAudits = await prisma!.auditLog.count({ where: { action: 'payment_completed', entityId: fixture.paymentId } });
    const subscriptionActivatedAudits = await prisma!.auditLog.count({ where: { action: 'subscription_activated', entityId: fixture.orgId } });

    expect(results.filter((result) => result.newlyFinalized)).toHaveLength(1);
    expect(payment.status).toBe(PaymentStatus.COMPLETED);
    expect(organization.plan).toBe(SubscriptionPlan.STARTUP);
    expect(organization.subscriptionStatus).toBe(SubscriptionStatus.ACTIVE);
    expect(paymentCompletedAudits).toBe(1);
    expect(subscriptionActivatedAudits).toBe(1);
    expect(reactMailer.sendPaymentReceiptEmail).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('rolls back payment completion when a transaction fails after the payment claim', async () => {
    const fixture = await createFixture({ plan: SubscriptionPlan.BUSINESS });
    markers.push(fixture.marker);

    await expect(prisma!.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { id: fixture.paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.COMPLETED, paidAt: new Date() },
      });
      throw new Error('controlled rollback after payment claim');
    })).rejects.toThrow('controlled rollback');

    const payment = await prisma!.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
    const organization = await prisma!.organization.findUniqueOrThrow({ where: { id: fixture.orgId } });

    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.paidAt).toBeNull();
    expect(organization.plan).toBe(SubscriptionPlan.REGULATOR);
  }, 60_000);

  it('enforces provider transaction uniqueness while allowing multiple null references', async () => {
    const fixture = await createFixture({ plan: SubscriptionPlan.STARTUP });
    markers.push(fixture.marker);

    await expect(prisma!.payment.create({
      data: {
        orgId: fixture.orgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: fixture.providerTransactionId,
        amount: 499900,
        currency: 'KES',
        status: PaymentStatus.PENDING,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        invoiceNumber: `SB-UAT-${randomUUID()}`,
        subscriptionPlan: SubscriptionPlan.STARTUP,
        metadata: { testMarker: fixture.marker },
      },
    })).rejects.toThrow();

    await prisma!.payment.createMany({
      data: [
        {
          orgId: fixture.orgId,
          provider: PaymentProvider.MPESA,
          providerTransactionId: null,
          amount: 499900,
          currency: 'KES',
          status: PaymentStatus.PENDING,
          paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
          invoiceNumber: `SB-UAT-${randomUUID()}`,
          subscriptionPlan: SubscriptionPlan.STARTUP,
          metadata: { testMarker: fixture.marker },
        },
        {
          orgId: fixture.orgId,
          provider: PaymentProvider.MPESA,
          providerTransactionId: null,
          amount: 499900,
          currency: 'KES',
          status: PaymentStatus.PENDING,
          paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
          invoiceNumber: `SB-UAT-${randomUUID()}`,
          subscriptionPlan: SubscriptionPlan.STARTUP,
          metadata: { testMarker: fixture.marker },
        },
      ],
    });

    const nullReferenceCount = await prisma!.payment.count({
      where: { orgId: fixture.orgId, providerTransactionId: null },
    });
    expect(nullReferenceCount).toBe(2);
  }, 60_000);

  it('starts an early renewal from the existing paid-through boundary', async () => {
    const paidThrough = new Date('2026-09-30T00:00:00.000Z');
    const fixture = await createFixture({
      plan: SubscriptionPlan.STARTUP,
      orgPlan: SubscriptionPlan.STARTUP,
      orgStatus: SubscriptionStatus.ACTIVE,
      paymentPurpose: PaymentPurpose.RENEWAL,
      paidThrough,
    });
    markers.push(fixture.marker);

    await intaSendFinalizationService.finalizePayment({
      invoiceId: fixture.providerTransactionId,
      verifiedStatus: verifiedStatus(fixture.providerTransactionId),
      source: 'webhook',
    });

    const payment = await prisma!.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
    const organization = await prisma!.organization.findUniqueOrThrow({ where: { id: fixture.orgId } });

    expect(payment.billingPeriodStart?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(payment.billingPeriodEnd?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(organization.planEndDate?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
  }, 60_000);

  it('starts an expired renewal from the finalization time instead of a stale paid-through date', async () => {
    const stalePaidThrough = new Date('2026-01-31T00:00:00.000Z');
    const before = new Date();
    const fixture = await createFixture({
      plan: SubscriptionPlan.STARTUP,
      orgPlan: SubscriptionPlan.STARTUP,
      orgStatus: SubscriptionStatus.EXPIRED,
      paymentPurpose: PaymentPurpose.RENEWAL,
      paidThrough: stalePaidThrough,
    });
    markers.push(fixture.marker);

    await intaSendFinalizationService.finalizePayment({
      invoiceId: fixture.providerTransactionId,
      verifiedStatus: verifiedStatus(fixture.providerTransactionId),
      source: 'webhook',
    });
    const after = new Date();

    const payment = await prisma!.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
    expect(payment.billingPeriodStart!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(payment.billingPeriodStart!.getTime()).toBeLessThanOrEqual(after.getTime() + 1_000);
    expect(payment.billingPeriodEnd!.getTime()).toBe(payment.billingPeriodStart!.getTime() + 30 * 24 * 60 * 60 * 1000);
  }, 60_000);

  it('does not double-extend a renewal payment under repeated concurrent completion', async () => {
    const paidThrough = new Date('2026-09-30T00:00:00.000Z');
    const fixture = await createFixture({
      plan: SubscriptionPlan.BUSINESS,
      orgPlan: SubscriptionPlan.BUSINESS,
      orgStatus: SubscriptionStatus.ACTIVE,
      paymentPurpose: PaymentPurpose.RENEWAL,
      paidThrough,
    });
    markers.push(fixture.marker);

    const results = await Promise.all([
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'webhook' }),
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'polling' }),
      intaSendFinalizationService.finalizePayment({ invoiceId: fixture.providerTransactionId, verifiedStatus: verifiedStatus(fixture.providerTransactionId), source: 'reconciliation' }),
    ]);

    const organization = await prisma!.organization.findUniqueOrThrow({ where: { id: fixture.orgId } });
    const subscriptionActivatedAudits = await prisma!.auditLog.count({ where: { action: 'subscription_activated', entityId: fixture.orgId } });

    expect(results.filter((result) => result.newlyFinalized)).toHaveLength(1);
    expect(organization.planEndDate?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(subscriptionActivatedAudits).toBe(1);
  }, 60_000);

  it('keeps renewal counters unchanged for a failed initial purchase', async () => {
    const fixture = await createFixture({
      plan: SubscriptionPlan.STARTUP,
      orgPlan: SubscriptionPlan.STARTUP,
      orgStatus: SubscriptionStatus.ACTIVE,
      paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
      paidThrough: new Date('2026-09-30T00:00:00.000Z'),
    });
    markers.push(fixture.marker);
    await prisma!.organization.update({
      where: { id: fixture.orgId },
      data: { mpesaFailedRenewalAttempts: 3 },
    });

    await intaSendFinalizationService.markFailed({
      invoiceId: fixture.providerTransactionId,
      source: 'webhook',
      failedReason: 'declined',
    });

    const organization = await prisma!.organization.findUniqueOrThrow({ where: { id: fixture.orgId } });
    const payment = await prisma!.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(organization.mpesaFailedRenewalAttempts).toBe(3);
    expect(organization.subscriptionStatus).toBe(SubscriptionStatus.ACTIVE);
    expect(organization.mpesaLastRenewalAttemptAt).toBeNull();
    expect(organization.mpesaNextRenewalRetryAt).toBeNull();
  }, 60_000);

  it('increments retry state for a failed renewal payment', async () => {
    const fixture = await createFixture({
      plan: SubscriptionPlan.STARTUP,
      orgPlan: SubscriptionPlan.STARTUP,
      orgStatus: SubscriptionStatus.ACTIVE,
      paymentPurpose: PaymentPurpose.RENEWAL,
      paidThrough: new Date('2026-09-30T00:00:00.000Z'),
    });
    markers.push(fixture.marker);

    await intaSendFinalizationService.markFailed({
      invoiceId: fixture.providerTransactionId,
      source: 'webhook',
      failedReason: 'declined',
    });

    const organization = await prisma!.organization.findUniqueOrThrow({ where: { id: fixture.orgId } });
    const payment = await prisma!.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(organization.mpesaFailedRenewalAttempts).toBe(1);
    expect(organization.subscriptionStatus).toBe(SubscriptionStatus.PAST_DUE);
    expect(organization.mpesaLastRenewalAttemptAt).toBeInstanceOf(Date);
    expect(organization.mpesaNextRenewalRetryAt).toBeInstanceOf(Date);
  }, 60_000);
});
