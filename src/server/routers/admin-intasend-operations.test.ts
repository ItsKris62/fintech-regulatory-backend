import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { adminRouter } from './admin.router';
import { intaSendService } from '@/modules/intasend';
import { intaSendFinalizationService } from '@/modules/billing/intasend-finalization.service';

vi.mock('@/modules/admin', () => ({
  adminModule: {},
}));

vi.mock('@/modules/intasend', () => ({
  intaSendService: {
    getPaymentStatus: vi.fn(),
  },
  normaliseIntaSendState: (raw: string) => {
    const upper = raw?.toUpperCase?.() ?? '';
    if (upper === 'COMPLETE') return 'COMPLETE';
    if (upper === 'FAILED') return 'FAILED';
    return 'PENDING';
  },
}));

vi.mock('@/modules/billing/intasend-finalization.service', () => ({
  intaSendFinalizationService: {
    finalizePayment: vi.fn(),
    markFailed: vi.fn(),
  },
}));

const now = new Date('2026-08-18T08:00:00.000Z');

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_1',
    orgId: 'org_1',
    provider: PaymentProvider.MPESA,
    status: PaymentStatus.PENDING,
    createdAt: new Date('2026-08-16T08:00:00.000Z'),
    metadata: {},
    providerTransactionId: 'inv_123',
    ...overrides,
  };
}

function caller(prisma: Record<string, unknown>) {
  return adminRouter.createCaller({
    user: { id: 'admin_1', role: 'ADMIN', email: 'admin@sheriabot.test' },
    req: { ip: '127.0.0.1', headers: {} },
    prisma,
  } as any);
}

describe('admin IntaSend operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('finalizes instead of expiring when provider truth is COMPLETE', async () => {
    const prisma = {
      payment: { findUnique: vi.fn().mockResolvedValue(payment()) },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(),
    };
    vi.mocked(intaSendService.getPaymentStatus).mockResolvedValue({
      invoiceId: 'inv_123',
      state: 'COMPLETE',
      amount: 4999,
      currency: 'KES',
      providerRef: 'RKT123',
      raw: {},
    });
    vi.mocked(intaSendFinalizationService.finalizePayment).mockResolvedValue({
      paymentId: 'pay_1',
      orgId: 'org_1',
      status: 'finalized',
      plan: 'STARTUP' as any,
      newlyFinalized: true,
    });

    const result = await caller(prisma).expireIntaSendPayment({
      paymentId: 'pay_1',
      reason: 'Provider completed payment',
    });

    expect(result.expired).toBe(false);
    expect(intaSendFinalizationService.finalizePayment).toHaveBeenCalledOnce();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses expiry when provider lookup fails', async () => {
    const prisma = {
      payment: { findUnique: vi.fn().mockResolvedValue(payment()) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(),
    };
    vi.mocked(intaSendService.getPaymentStatus).mockRejectedValue(new Error('provider unavailable'));

    await expect(caller(prisma).expireIntaSendPayment({
      paymentId: 'pay_1',
      reason: 'Support requested expiry',
    })).rejects.toBeInstanceOf(TRPCError);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          action: 'expire_intasend_payment_refused',
          refusalReason: 'provider_lookup_failed',
        }),
      }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('expires only old provider-pending payments', async () => {
    const tx = {
      payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      payment: { findUnique: vi.fn().mockResolvedValue(payment()) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: any) => cb(tx)),
    };
    vi.mocked(intaSendService.getPaymentStatus).mockResolvedValue({
      invoiceId: 'inv_123',
      state: 'PENDING',
      amount: 4999,
      currency: 'KES',
      providerRef: null,
      raw: {},
    });

    const result = await caller(prisma).expireIntaSendPayment({
      paymentId: 'pay_1',
      reason: 'Pending past expiry threshold',
    });

    expect(result).toMatchObject({ success: true, expired: true, providerState: 'PENDING' });
    expect(tx.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pay_1', status: PaymentStatus.PENDING },
      data: expect.objectContaining({ status: PaymentStatus.EXPIRED }),
    }));
  });
});
