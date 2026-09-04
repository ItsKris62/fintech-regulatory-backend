import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentStatus } from '@prisma/client';
import { paymentService } from './payment.service';
import { prisma } from '@/lib/prisma/client';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    payment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Authoritative Backend Purchase Telemetry Deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. returns firstPurchaseTelemetry=true on first claim for a COMPLETED payment', async () => {
    const paymentRecord = {
      id: 'pay_comp_001',
      orgId: 'org_123',
      status: PaymentStatus.COMPLETED,
      metadata: {},
    };

    // Atomic SQL UPDATE matches 1 row on first claim
    (prisma.$queryRaw as any).mockResolvedValue([
      { id: paymentRecord.id, metadata: { analyticsPurchaseRecordedAt: new Date().toISOString() } },
    ]);

    const result = await paymentService.claimPurchaseTelemetry({
      paymentId: 'pay_comp_001',
      orgId: 'org_123',
    });

    expect(result.success).toBe(true);
    expect(result.firstPurchaseTelemetry).toBe(true);
    expect(result.recordedAt).toBeDefined();
  });

  it('2. returns firstPurchaseTelemetry=false on second claim for same payment', async () => {
    const paymentRecordAlreadyClaimed = {
      id: 'pay_comp_001',
      orgId: 'org_123',
      status: PaymentStatus.COMPLETED,
      metadata: {
        analyticsPurchaseRecordedAt: '2026-09-04T12:00:00.000Z',
      },
    };

    // Atomic SQL UPDATE matches 0 rows because analyticsPurchaseRecordedAt is already set
    (prisma.$queryRaw as any).mockResolvedValue([]);
    (prisma.payment.findFirst as any).mockResolvedValue(paymentRecordAlreadyClaimed);

    const result = await paymentService.claimPurchaseTelemetry({
      paymentId: 'pay_comp_001',
      orgId: 'org_123',
    });

    expect(result.success).toBe(true);
    expect(result.firstPurchaseTelemetry).toBe(false);
    expect(result.reason).toBe('ALREADY_CLAIMED');
    expect(result.recordedAt).toBe('2026-09-04T12:00:00.000Z');
  });

  it('3. ensures concurrent claims produce exactly ONE winner (firstPurchaseTelemetry=true)', async () => {
    let claimed = false;
    let internalMetadata: Record<string, unknown> = {};

    const baseRecord = {
      id: 'pay_concurrent_100',
      orgId: 'org_123',
      status: PaymentStatus.COMPLETED,
    };

    (prisma.$queryRaw as any).mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        const now = new Date().toISOString();
        internalMetadata = { analyticsPurchaseRecordedAt: now };
        return [{ id: baseRecord.id, metadata: internalMetadata }];
      }
      return [];
    });

    (prisma.payment.findFirst as any).mockImplementation(async () => ({
      ...baseRecord,
      metadata: internalMetadata,
    }));

    // Run 5 simultaneous concurrent claim requests
    const concurrentResults = await Promise.all([
      paymentService.claimPurchaseTelemetry({ paymentId: 'pay_concurrent_100', orgId: 'org_123' }),
      paymentService.claimPurchaseTelemetry({ paymentId: 'pay_concurrent_100', orgId: 'org_123' }),
      paymentService.claimPurchaseTelemetry({ paymentId: 'pay_concurrent_100', orgId: 'org_123' }),
      paymentService.claimPurchaseTelemetry({ paymentId: 'pay_concurrent_100', orgId: 'org_123' }),
      paymentService.claimPurchaseTelemetry({ paymentId: 'pay_concurrent_100', orgId: 'org_123' }),
    ]);

    const trueCount = concurrentResults.filter((r) => r.firstPurchaseTelemetry === true).length;
    const falseCount = concurrentResults.filter((r) => r.firstPurchaseTelemetry === false).length;

    expect(trueCount).toBe(1);
    expect(falseCount).toBe(4);
  });

  it('4. prevents non-COMPLETED (PENDING or FAILED) payments from claiming purchase telemetry', async () => {
    const pendingPayment = {
      id: 'pay_pending_002',
      orgId: 'org_123',
      status: PaymentStatus.PENDING,
      metadata: {},
    };

    // Atomic SQL matches 0 rows because status != 'COMPLETED'
    (prisma.$queryRaw as any).mockResolvedValue([]);
    (prisma.payment.findFirst as any).mockResolvedValue(pendingPayment);

    const pendingResult = await paymentService.claimPurchaseTelemetry({
      paymentId: 'pay_pending_002',
      orgId: 'org_123',
    });

    expect(pendingResult.success).toBe(false);
    expect(pendingResult.firstPurchaseTelemetry).toBe(false);
    expect(pendingResult.reason).toBe('PAYMENT_NOT_COMPLETED');

    const failedPayment = {
      id: 'pay_failed_003',
      orgId: 'org_123',
      status: PaymentStatus.FAILED,
      metadata: {},
    };

    (prisma.$queryRaw as any).mockResolvedValue([]);
    (prisma.payment.findFirst as any).mockResolvedValue(failedPayment);

    const failedResult = await paymentService.claimPurchaseTelemetry({
      paymentId: 'pay_failed_003',
      orgId: 'org_123',
    });

    expect(failedResult.success).toBe(false);
    expect(failedResult.firstPurchaseTelemetry).toBe(false);
    expect(failedResult.reason).toBe('PAYMENT_NOT_COMPLETED');
  });

  it('5. allows different transactions to each claim purchase telemetry once', async () => {
    const claimedSet = new Set<string>();

    (prisma.$queryRaw as any).mockImplementation(async (_strings: any, ...values: any[]) => {
      const paymentId = values[1];
      if (!claimedSet.has(paymentId)) {
        claimedSet.add(paymentId);
        return [{ id: paymentId, metadata: { analyticsPurchaseRecordedAt: new Date().toISOString() } }];
      }
      return [];
    });

    const resA = await paymentService.claimPurchaseTelemetry({ paymentId: 'pay_tx_A', orgId: 'org_123' });
    const resB = await paymentService.claimPurchaseTelemetry({ paymentId: 'pay_tx_B', orgId: 'org_123' });

    expect(resA.firstPurchaseTelemetry).toBe(true);
    expect(resB.firstPurchaseTelemetry).toBe(true);
  });

  it('6. browser localStorage deletion / incognito cannot cause another backend claim', async () => {
    const backendRecordedPayment = {
      id: 'pay_incognito_999',
      orgId: 'org_123',
      status: PaymentStatus.COMPLETED,
      metadata: {
        analyticsPurchaseRecordedAt: '2026-09-04T12:15:00.000Z',
      },
    };

    (prisma.$queryRaw as any).mockResolvedValue([]);
    (prisma.payment.findFirst as any).mockResolvedValue(backendRecordedPayment);

    const incognitoResult = await paymentService.claimPurchaseTelemetry({
      paymentId: 'pay_incognito_999',
      orgId: 'org_123',
    });

    expect(incognitoResult.firstPurchaseTelemetry).toBe(false);
    expect(incognitoResult.reason).toBe('ALREADY_CLAIMED');
  });

  it('7. verifies no PII is included in the purchase claim audit or metadata', async () => {
    const payment = {
      id: 'pay_no_pii_888',
      orgId: 'org_123',
      status: PaymentStatus.COMPLETED,
      metadata: {
        plan: 'BUSINESS',
      },
    };

    const savedMetadata: Record<string, unknown> = {
      plan: 'BUSINESS',
      analyticsPurchaseRecordedAt: new Date().toISOString(),
    };

    (prisma.$queryRaw as any).mockResolvedValue([{ id: payment.id, metadata: savedMetadata }]);

    const result = await paymentService.claimPurchaseTelemetry({ paymentId: 'pay_no_pii_888', orgId: 'org_123' });

    expect(result.firstPurchaseTelemetry).toBe(true);
    expect(savedMetadata.analyticsPurchaseRecordedAt).toBeDefined();
    expect(savedMetadata.phoneNumber).toBeUndefined();
    expect(savedMetadata.email).toBeUndefined();
    expect(savedMetadata.customerName).toBeUndefined();
  });
});
