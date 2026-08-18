import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { IntaSendReconciliationService } from './intasend-reconciliation.service';
import { prisma } from '@/lib/prisma/client';
import { intaSendService } from '@/modules/intasend';
import { intaSendFinalizationService } from './intasend-finalization.service';

vi.mock('@/config/app.config', () => ({
  appConfig: {
    intasend: {
      reconciliation: { staleMinutes: 15, pendingExpireHours: 24 },
    },
  },
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    payment: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/modules/intasend', () => ({
  intaSendService: {
    getPaymentStatus: vi.fn(),
  },
}));

vi.mock('./intasend-finalization.service', () => ({
  intaSendFinalizationService: {
    finalizePayment: vi.fn(),
    markFailed: vi.fn(),
  },
}));

describe('IntaSendReconciliationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(prisma));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('finalizes stale pending payments when IntaSend reports COMPLETE', async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([{
      id: 'pay_1',
      orgId: 'org_1',
      provider: PaymentProvider.MPESA,
      status: PaymentStatus.PENDING,
      providerTransactionId: 'inv_123',
      createdAt: new Date('2026-08-18T08:00:00.000Z'),
      metadata: {},
    }] as any);
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

    const result = await new IntaSendReconciliationService().run();

    expect(result.finalized).toBe(1);
    expect(intaSendFinalizationService.finalizePayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'pay_1',
      invoiceId: 'inv_123',
      source: 'reconciliation',
    }));
  });

  it('expires old provider-pending rows with a conditional pending-only mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T08:00:00.000Z'));
    vi.mocked(prisma.payment.findMany).mockResolvedValue([{
      id: 'pay_1',
      orgId: 'org_1',
      provider: PaymentProvider.MPESA,
      status: PaymentStatus.PENDING,
      providerTransactionId: 'inv_123',
      createdAt: new Date('2026-08-18T08:00:00.000Z'),
      metadata: {},
    }] as any);
    vi.mocked(prisma.payment.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(intaSendService.getPaymentStatus).mockResolvedValue({
      invoiceId: 'inv_123',
      state: 'PENDING',
      amount: 4999,
      currency: 'KES',
      providerRef: null,
      raw: {},
    });

    const result = await new IntaSendReconciliationService().run();

    expect(result.expired).toBe(1);
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pay_1', status: PaymentStatus.PENDING },
      data: expect.objectContaining({ status: PaymentStatus.EXPIRED }),
    }));
  });
});
