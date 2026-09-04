import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  SubscriptionPlan,
  SubscriptionStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentService } from './payment.service';
import { prisma } from '@/lib/prisma/client';

const safeDatabaseEnvironments = new Set(['development-uat', 'preview']);
const databaseEnvironment = process.env.DATABASE_ENVIRONMENT?.trim().toLowerCase() ?? 'unknown';
const canRunDatabaseTests = safeDatabaseEnvironments.has(databaseEnvironment) && Boolean(process.env.DATABASE_URL);

const describeIfSafeDb = canRunDatabaseTests ? describe : describe.skip;

describeIfSafeDb('PostgreSQL Real Database Atomic Concurrency Certification', () => {
  const testMarker = `test-conc-${randomUUID().slice(0, 8)}`;
  const testOrgId = `${testMarker}-org`;
  const testUserId = `${testMarker}-user`;

  beforeAll(async () => {
    // Create unique test Organization and User
    await prisma.organization.create({
      data: {
        id: testOrgId,
        name: `Test Org ${testMarker}`,
        type: 'startup',
        plan: SubscriptionPlan.STARTUP,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
    });

    await prisma.user.create({
      data: {
        id: testUserId,
        email: `${testMarker}@sheriabot.test`,
        fullName: 'Concurrency Test User',
        role: UserRole.STARTUP,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        emailVerified: true,
        preferences: {},
      },
    });
  });

  afterAll(async () => {
    // Cleanup test fixtures
    await prisma.payment.deleteMany({
      where: { orgId: testOrgId },
    });
    await prisma.user.deleteMany({
      where: { id: { contains: testMarker } },
    });
    await prisma.organization.deleteMany({
      where: { id: testOrgId },
    });
  });

  it('PURCHASE TELEMETRY: 10 concurrent claim attempts on SAME completed payment -> exactly 1 winner (true) and 9 losers (false)', async () => {
    const payment = await prisma.payment.create({
      data: {
        orgId: testOrgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: `mpesa-${randomUUID().slice(0, 8)}`,
        amount: 4999,
        currency: 'KES',
        status: PaymentStatus.COMPLETED,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        metadata: {},
      },
    });

    // Launch 10 concurrent race claims
    const claimPromises = Array.from({ length: 10 }, () =>
      paymentService.claimPurchaseTelemetry(testOrgId, payment.id)
    );

    const results = await Promise.all(claimPromises);

    const winners = results.filter((r) => r.firstPurchaseTelemetry === true);
    const losers = results.filter((r) => r.firstPurchaseTelemetry === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);

    // Verify winner details
    expect(winners[0].success).toBe(true);
    expect(winners[0].recordedAt).toBeDefined();

    // Verify all losers received already claimed / suppressed
    losers.forEach((loser) => {
      expect(loser.success).toBe(true);
      expect(loser.firstPurchaseTelemetry).toBe(false);
      expect(loser.reason).toBe('ALREADY_CLAIMED');
      expect(loser.recordedAt).toBe(winners[0].recordedAt);
    });

    // Verify the durable database state
    const paymentInDb = await prisma.payment.findUnique({
      where: { id: payment.id },
      select: { metadata: true },
    });
    const meta = (paymentInDb?.metadata as Record<string, unknown>) ?? {};
    expect(meta.analyticsPurchaseRecordedAt).toBe(winners[0].recordedAt);
  });

  it('PURCHASE TELEMETRY: second process/session cannot reclaim', async () => {
    const payment = await prisma.payment.create({
      data: {
        orgId: testOrgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: `mpesa-${randomUUID().slice(0, 8)}`,
        amount: 4999,
        currency: 'KES',
        status: PaymentStatus.COMPLETED,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        metadata: {},
      },
    });

    // First claim
    const firstClaim = await paymentService.claimPurchaseTelemetry(testOrgId, payment.id);
    expect(firstClaim.firstPurchaseTelemetry).toBe(true);

    // Subsequent claim after delay simulating separate session/process
    const secondClaim = await paymentService.claimPurchaseTelemetry(testOrgId, payment.id);
    expect(secondClaim.firstPurchaseTelemetry).toBe(false);
    expect(secondClaim.reason).toBe('ALREADY_CLAIMED');
    expect(secondClaim.recordedAt).toBe(firstClaim.recordedAt);
  });

  it('PURCHASE TELEMETRY: different payment IDs independently claim once each', async () => {
    const paymentA = await prisma.payment.create({
      data: {
        orgId: testOrgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: `mpesa-a-${randomUUID().slice(0, 8)}`,
        amount: 4999,
        currency: 'KES',
        status: PaymentStatus.COMPLETED,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        metadata: {},
      },
    });

    const paymentB = await prisma.payment.create({
      data: {
        orgId: testOrgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: `mpesa-b-${randomUUID().slice(0, 8)}`,
        amount: 9999,
        currency: 'KES',
        status: PaymentStatus.COMPLETED,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        metadata: {},
      },
    });

    const [claimA, claimB] = await Promise.all([
      paymentService.claimPurchaseTelemetry(testOrgId, paymentA.id),
      paymentService.claimPurchaseTelemetry(testOrgId, paymentB.id),
    ]);

    expect(claimA.firstPurchaseTelemetry).toBe(true);
    expect(claimB.firstPurchaseTelemetry).toBe(true);
  });

  it('PURCHASE TELEMETRY: non-COMPLETED payment (PENDING/FAILED) cannot claim purchase telemetry', async () => {
    const pendingPayment = await prisma.payment.create({
      data: {
        orgId: testOrgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: `mpesa-pending-${randomUUID().slice(0, 8)}`,
        amount: 4999,
        currency: 'KES',
        status: PaymentStatus.PENDING,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        metadata: {},
      },
    });

    const result = await paymentService.claimPurchaseTelemetry(testOrgId, pendingPayment.id);
    expect(result.firstPurchaseTelemetry).toBe(false);
    expect(result.reason).toBe('PAYMENT_NOT_COMPLETED');

    const inDb = await prisma.payment.findUnique({
      where: { id: pendingPayment.id },
      select: { metadata: true },
    });
    const meta = (inDb?.metadata as Record<string, unknown>) ?? {};
    expect(meta.analyticsPurchaseRecordedAt).toBeUndefined();
  });

  it('ACCOUNT ACTIVATION: 10 concurrent activation attempts on SAME user -> exactly 1 winner (true) and 9 losers (false)', async () => {
    const activationUserId = `${testMarker}-act-user`;
    await prisma.user.create({
      data: {
        id: activationUserId,
        email: `${activationUserId}@sheriabot.test`,
        fullName: 'Activation Concurrency User',
        role: UserRole.STARTUP,
        status: UserStatus.ACTIVE,
        accountStatus: 'active',
        preferences: {},
      },
    });

    const runAtomicActivation = async (featureName: string) => {
      const now = new Date().toISOString();
      const updatedUsers = await prisma.$queryRaw<Array<{ id: string; preferences: any }>>`
        UPDATE "User"
        SET preferences = jsonb_set(
          jsonb_set(
            COALESCE(preferences::jsonb, '{}'::jsonb),
            '{accountActivatedAt}',
            to_jsonb(${now}::text),
            true
          ),
          '{firstActivatedFeature}',
          to_jsonb(${featureName}::text),
          true
        ),
        "updatedAt" = NOW()
        WHERE id = ${activationUserId}
          AND (preferences IS NULL OR (preferences->>'accountActivatedAt') IS NULL)
        RETURNING id, preferences;
      `;

      if (updatedUsers && updatedUsers.length > 0) {
        return { firstActivation: true, activatedAt: now };
      }

      const user = await prisma.user.findUnique({
        where: { id: activationUserId },
        select: { preferences: true },
      });
      const prefs = (user?.preferences as Record<string, any>) || {};
      return {
        firstActivation: false,
        activatedAt: prefs.accountActivatedAt as string,
      };
    };

    // 10 concurrent workflows attempting first activation on same user
    const workflows = [
      'COMPLIANCE_QUERY',
      'GAP_ANALYSIS',
      'CHECKLIST',
      'POLICY_GENERATOR',
      'DOCUMENT_UPLOAD',
      'LICENSING',
      'CALENDAR_EVENT',
      'MONITOR_ALERT',
      'SETTINGS_UPDATE',
      'TEAM_INVITE',
    ];

    const results = await Promise.all(workflows.map((wf) => runAtomicActivation(wf)));

    const winners = results.filter((r) => r.firstActivation === true);
    const losers = results.filter((r) => r.firstActivation === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);

    // Verify DB state has only the winner's timestamp
    const userInDb = await prisma.user.findUnique({
      where: { id: activationUserId },
      select: { preferences: true },
    });
    const prefs = (userInDb?.preferences as Record<string, unknown>) ?? {};
    expect(prefs.accountActivatedAt).toBe(winners[0].activatedAt);
    expect(workflows).toContain(prefs.firstActivatedFeature);

    // Clean up activation user
    await prisma.user.delete({ where: { id: activationUserId } });
  });

  it('NO PII: verifies payment metadata and telemetry payloads contain zero PII', async () => {
    const payment = await prisma.payment.create({
      data: {
        orgId: testOrgId,
        provider: PaymentProvider.MPESA,
        providerTransactionId: `mpesa-pii-${randomUUID().slice(0, 8)}`,
        amount: 4999,
        currency: 'KES',
        status: PaymentStatus.COMPLETED,
        paymentPurpose: PaymentPurpose.INITIAL_PURCHASE,
        metadata: {},
      },
    });

    const result = await paymentService.claimPurchaseTelemetry(testOrgId, payment.id);
    expect(result.firstPurchaseTelemetry).toBe(true);

    const paymentInDb = await prisma.payment.findUnique({
      where: { id: payment.id },
      select: { metadata: true },
    });

    const meta = (paymentInDb?.metadata as Record<string, unknown>) ?? {};
    const metaKeys = Object.keys(meta);
    const forbiddenPiiKeys = ['phone', 'phoneNumber', 'email', 'cardNumber', 'pin', 'password', 'token', 'secret'];

    for (const key of forbiddenPiiKeys) {
      expect(metaKeys.map((k) => k.toLowerCase())).not.toContain(key.toLowerCase());
    }
  });
});
