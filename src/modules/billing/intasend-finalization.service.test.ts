import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentProvider, PaymentStatus, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { IntaSendFinalizationService } from './intasend-finalization.service';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { reactMailer } from '@/lib/email/react-mailer.service';
import type { PaymentStatusResponse } from '@/modules/intasend/intasend.types';

vi.mock('@/config/app.config', () => ({
  appConfig: {
    frontendUrl: 'https://app.sheriabot.test',
    intasend: {
      renewal: { graceDays: 7 },
    },
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    payment: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    organization: {
      update: vi.fn(),
    },
    organizationMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    del: vi.fn(),
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

vi.mock('@/lib/email/react-mailer.service', () => ({
  reactMailer: {
    sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
    sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/modules/trial', () => ({
  planCtxCacheKey: (userId: string) => `sheriabot:planctx:${userId}`,
}));

const service = new IntaSendFinalizationService();
const mockPaymentUpdate = prisma.payment.update as unknown as ReturnType<typeof vi.fn>;
const mockPaymentUpdateMany = prisma.payment.updateMany as unknown as ReturnType<typeof vi.fn>;
const mockPaymentFindUniqueOrThrow = prisma.payment.findUniqueOrThrow as unknown as ReturnType<typeof vi.fn>;
const PAYMENT_PURPOSE_INITIAL = 'INITIAL_PURCHASE';
const PAYMENT_PURPOSE_RENEWAL = 'RENEWAL';

const completedStatus: PaymentStatusResponse = {
  invoiceId: 'inv_123',
  state: 'COMPLETE',
  amount: 4999,
  currency: 'KES',
  providerRef: 'RKT123',
  raw: {
    invoice_id: 'inv_123',
    state: 'COMPLETE',
    amount: 4999,
    currency: 'KES',
    mpesa_reference: 'RKT123',
  },
};

function pendingPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_1',
    orgId: 'org_1',
    provider: PaymentProvider.MPESA,
    providerTransactionId: 'inv_123',
    amount: 499900,
    currency: 'KES',
    status: PaymentStatus.PENDING,
    paidAt: null,
    metadata: {
      amountMinor: 499900,
      amountKes: 4999,
      currency: 'KES',
    },
    paymentPurpose: PAYMENT_PURPOSE_INITIAL,
    invoiceNumber: 'SB-2026-00001',
    subscriptionPlan: SubscriptionPlan.STARTUP,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    createdAt: new Date('2026-08-18T08:00:00.000Z'),
    updatedAt: new Date('2026-08-18T08:00:00.000Z'),
    org: {
      id: 'org_1',
      plan: SubscriptionPlan.REGULATOR,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      planEndDate: null,
      subscriptionCycleEnd: null,
    },
    ...overrides,
  };
}

describe('IntaSendFinalizationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(prisma));
    mockPaymentUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentFindUniqueOrThrow.mockResolvedValue({
      ...pendingPayment(),
      status: PaymentStatus.COMPLETED,
      paidAt: new Date('2026-08-18T08:05:00.000Z'),
    });
    mockPaymentUpdate.mockImplementation(async (args: any) => ({
      ...pendingPayment(),
      ...args.data,
    }));
    vi.mocked(prisma.organization.update).mockResolvedValue({} as any);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'legacy_user' }] as any);
    vi.mocked(prisma.organizationMember.findMany).mockResolvedValue([
      { userId: 'owner_user' },
      { userId: 'member_user' },
    ] as any);
    vi.mocked(prisma.organizationMember.findFirst).mockResolvedValue({
      user: { email: 'owner@sheriabot.test', fullName: 'Owner User' },
    } as any);
  });

  it('activates the purchased STARTUP plan from Payment.subscriptionPlan, not the existing org plan', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment() as any);

    const result = await service.finalizePayment({
      invoiceId: 'inv_123',
      verifiedStatus: completedStatus,
      source: 'webhook',
    });

    expect(result).toMatchObject({
      paymentId: 'pay_1',
      orgId: 'org_1',
      status: 'finalized',
      plan: SubscriptionPlan.STARTUP,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pay_1', status: PaymentStatus.PENDING },
      data: expect.objectContaining({
        status: PaymentStatus.COMPLETED,
        invoiceNumber: 'SB-2026-00001',
        subscriptionPlan: SubscriptionPlan.STARTUP,
        paymentPurpose: PAYMENT_PURPOSE_INITIAL,
        billingPeriodStart: expect.any(Date),
        billingPeriodEnd: expect.any(Date),
      }),
    }));
    expect(prisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'org_1' },
      data: expect.objectContaining({
        plan: SubscriptionPlan.STARTUP,
        subscriptionTier: SubscriptionPlan.STARTUP,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        preferredPaymentMethod: PaymentProvider.MPESA,
        mpesaFailedRenewalAttempts: 0,
        mpesaNextRenewalRetryAt: null,
      }),
    }));
    expect(redis.del).toHaveBeenCalledWith('sheriabot:plan:org_1');
    expect(redis.del).toHaveBeenCalledWith('sheriabot:planctx:owner_user');
    expect(redis.del).toHaveBeenCalledWith('sheriabot:planctx:member_user');
    expect(redis.del).toHaveBeenCalledWith('sheriabot:planctx:legacy_user');
    expect(reactMailer.sendPaymentReceiptEmail).toHaveBeenCalledWith(
      'owner@sheriabot.test',
      expect.objectContaining({
        amount: 'KES 4,999.00',
        items: [{ description: 'Startup Plan - Monthly Subscription', amount: 'KES 4,999.00' }],
      }),
    );
  });

  it('activates the purchased BUSINESS plan from Payment.subscriptionPlan', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment({
      amount: 1499900,
      metadata: {
        amountMinor: 1499900,
        amountKes: 14999,
        currency: 'KES',
      },
      subscriptionPlan: SubscriptionPlan.BUSINESS,
    }) as any);

    const result = await service.finalizePayment({
      invoiceId: 'inv_123',
      verifiedStatus: {
        ...completedStatus,
        amount: 14999,
        raw: { ...completedStatus.raw, amount: 14999 },
      },
      source: 'polling',
    });

    expect(result).toMatchObject({
      paymentId: 'pay_1',
      orgId: 'org_1',
      status: 'finalized',
      plan: SubscriptionPlan.BUSINESS,
    });
    expect(prisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'org_1' },
      data: expect.objectContaining({
        plan: SubscriptionPlan.BUSINESS,
        subscriptionTier: SubscriptionPlan.BUSINESS,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      }),
    }));
  });

  it('rejects provider amount mismatch before the transaction mutates payment or subscription state', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment() as any);

    await expect(service.finalizePayment({
      invoiceId: 'inv_123',
      verifiedStatus: {
        ...completedStatus,
        amount: 1,
        raw: { ...completedStatus.raw, amount: 1 },
      },
      source: 'webhook',
    })).rejects.toMatchObject({
      code: 'INTASEND_PAYMENT_INTEGRITY_FAILED',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pay_1' },
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          lastFinalizationFailure: expect.objectContaining({
            reason: 'amount_mismatch',
            expectedAmountMinor: 499900,
            providerAmountMinor: 100,
          }),
        }),
      }),
    }));
  });

  it('rejects provider currency mismatch before subscription activation', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment() as any);

    await expect(service.finalizePayment({
      invoiceId: 'inv_123',
      verifiedStatus: {
        ...completedStatus,
        currency: 'USD',
        raw: { ...completedStatus.raw, currency: 'USD' },
      },
      source: 'polling',
    })).rejects.toMatchObject({
      code: 'INTASEND_PAYMENT_INTEGRITY_FAILED',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pay_1' },
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          lastFinalizationFailure: expect.objectContaining({
            reason: 'currency_mismatch',
            expectedCurrency: 'KES',
            providerCurrency: 'USD',
          }),
        }),
      }),
    }));
  });

  it('returns idempotent success for a duplicate COMPLETE after the org already has the purchased active plan', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment({
      status: PaymentStatus.COMPLETED,
      paidAt: new Date('2026-08-18T08:05:00.000Z'),
      billingPeriodEnd: new Date('2026-09-17T08:05:00.000Z'),
      org: {
        id: 'org_1',
        plan: SubscriptionPlan.STARTUP,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        planEndDate: new Date('2026-09-17T08:05:00.000Z'),
        subscriptionCycleEnd: new Date('2026-09-17T08:05:00.000Z'),
      },
    }) as any);

    await expect(service.finalizePayment({
      invoiceId: 'inv_123',
      verifiedStatus: completedStatus,
      source: 'webhook',
    })).resolves.toMatchObject({
      status: 'already_finalized',
      plan: SubscriptionPlan.STARTUP,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('allows only one concurrent COMPLETE attempt to emit completion side effects', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment() as any);
    mockPaymentUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    mockPaymentFindUniqueOrThrow.mockResolvedValue({
      ...pendingPayment(),
      status: PaymentStatus.COMPLETED,
      paidAt: new Date('2026-08-18T08:05:00.000Z'),
      billingPeriodStart: new Date('2026-08-18T08:05:00.000Z'),
      billingPeriodEnd: new Date('2026-09-17T08:05:00.000Z'),
    } as any);
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({
      ...pendingPayment({
        status: PaymentStatus.COMPLETED,
        paidAt: new Date('2026-08-18T08:05:00.000Z'),
        billingPeriodStart: new Date('2026-08-18T08:05:00.000Z'),
        billingPeriodEnd: new Date('2026-09-17T08:05:00.000Z'),
        org: {
          id: 'org_1',
          plan: SubscriptionPlan.STARTUP,
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          planEndDate: new Date('2026-09-17T08:05:00.000Z'),
          subscriptionCycleEnd: new Date('2026-09-17T08:05:00.000Z'),
        },
      }),
    } as any);

    const results = await Promise.all([
      service.finalizePayment({ invoiceId: 'inv_123', verifiedStatus: completedStatus, source: 'webhook' }),
      service.finalizePayment({ invoiceId: 'inv_123', verifiedStatus: completedStatus, source: 'polling' }),
      service.finalizePayment({ invoiceId: 'inv_123', verifiedStatus: completedStatus, source: 'reconciliation' }),
    ]);

    expect(results.filter((result) => result.newlyFinalized)).toHaveLength(1);
    expect(results.filter((result) => result.status === 'already_finalized')).toHaveLength(2);
    expect(prisma.organization.update).toHaveBeenCalledTimes(1);
    expect(reactMailer.sendPaymentReceiptEmail).toHaveBeenCalledTimes(1);
  });

  it('starts an early renewal after the existing paid-through date', async () => {
    const paidThrough = new Date('2099-09-01T00:00:00.000Z');
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment({
      paymentPurpose: PAYMENT_PURPOSE_RENEWAL,
      metadata: {
        amountMinor: 499900,
        amountKes: 4999,
        currency: 'KES',
        paymentKind: 'renewal',
      },
      org: {
        id: 'org_1',
        plan: SubscriptionPlan.STARTUP,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        planEndDate: paidThrough,
        subscriptionCycleEnd: paidThrough,
      },
    }) as any);

    await service.finalizePayment({
      invoiceId: 'inv_123',
      verifiedStatus: completedStatus,
      source: 'polling',
    });

    expect(prisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        planStartDate: paidThrough,
        planEndDate: new Date('2099-10-01T00:00:00.000Z'),
        subscriptionCycleEnd: new Date('2099-10-01T00:00:00.000Z'),
      }),
    }));
  });

  it('does not increment renewal counters for a failed initial purchase', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment() as any);

    await service.markFailed({
      invoiceId: 'inv_123',
      source: 'webhook',
      failedReason: 'cancelled',
    });

    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: PaymentStatus.FAILED }),
    }));
  });

  it('increments renewal retry state for a failed renewal payment', async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValue(pendingPayment({
      paymentPurpose: PAYMENT_PURPOSE_RENEWAL,
      metadata: { paymentKind: 'renewal' },
    }) as any);

    await service.markFailed({
      invoiceId: 'inv_123',
      source: 'reconciliation',
      failedReason: 'declined',
    });

    expect(prisma.organization.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'org_1' },
      data: expect.objectContaining({
        mpesaFailedRenewalAttempts: { increment: 1 },
        mpesaLastRenewalAttemptAt: expect.any(Date),
        mpesaNextRenewalRetryAt: expect.any(Date),
      }),
    }));
  });
});
