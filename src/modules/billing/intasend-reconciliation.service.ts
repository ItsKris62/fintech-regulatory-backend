import { PaymentProvider, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';
import { intaSendService } from '@/modules/intasend';
import { intaSendFinalizationService } from './intasend-finalization.service';

interface ReconciliationResult {
  scanned: number;
  finalized: number;
  failed: number;
  expired: number;
  pending: number;
  errors: number;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class IntaSendReconciliationService {
  async run(): Promise<ReconciliationResult> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - appConfig.intasend.reconciliation.staleMinutes * 60 * 1000);
    const expireBefore = new Date(now.getTime() - appConfig.intasend.reconciliation.pendingExpireHours * 60 * 60 * 1000);

    const payments = await prisma.payment.findMany({
      where: {
        provider: PaymentProvider.MPESA,
        status: PaymentStatus.PENDING,
        providerTransactionId: { not: null },
        createdAt: { lte: staleBefore },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    const result: ReconciliationResult = {
      scanned: payments.length,
      finalized: 0,
      failed: 0,
      expired: 0,
      pending: 0,
      errors: 0,
    };

    for (const payment of payments) {
      const invoiceId = payment.providerTransactionId;
      if (!invoiceId) continue;

      try {
        const status = await intaSendService.getPaymentStatus(invoiceId);

        if (status.state === 'COMPLETE') {
          await intaSendFinalizationService.finalizePayment({
            paymentId: payment.id,
            invoiceId,
            verifiedStatus: status,
            source: 'reconciliation',
          });
          result.finalized++;
          continue;
        }

        if (status.state === 'FAILED') {
          await intaSendFinalizationService.markFailed({
            invoiceId,
            source: 'reconciliation',
          });
          result.failed++;
          continue;
        }

        if (payment.createdAt <= expireBefore) {
          const expired = await prisma.$transaction(async (tx) => {
            const transition = await tx.payment.updateMany({
              where: { id: payment.id, status: PaymentStatus.PENDING },
              data: {
                status: PaymentStatus.EXPIRED,
                metadata: {
                  ...toRecord(payment.metadata),
                  expiredAt: now.toISOString(),
                  expiredBy: 'reconciliation',
                  lastReconciliationAt: now.toISOString(),
                } as Prisma.InputJsonObject,
              },
            });
            if (transition.count === 0) return false;
            await tx.auditLog.create({
              data: {
                action: 'payment_expired',
                entityType: 'Payment',
                entityId: payment.id,
                metadata: {
                  orgId: payment.orgId,
                  invoiceId,
                  staleMinutes: appConfig.intasend.reconciliation.staleMinutes,
                  pendingExpireHours: appConfig.intasend.reconciliation.pendingExpireHours,
                } as Prisma.InputJsonObject,
              },
            });
            return true;
          });
          if (expired) result.expired++;
          continue;
        }

        result.pending++;
      } catch (err: unknown) {
        result.errors++;
        logger.error({
          type: 'intasend_reconciliation_payment_error',
          paymentId: payment.id,
          invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });

        await prisma.auditLog.create({
          data: {
            action: 'payment_reconciliation_failed',
            entityType: 'Payment',
            entityId: payment.id,
            metadata: {
              orgId: payment.orgId,
              invoiceId,
              error: err instanceof Error ? err.message : String(err),
            } as Prisma.InputJsonObject,
          },
        }).catch(() => undefined);
      }
    }

    logger.info({ type: 'intasend_reconciliation_complete', ...result });
    return result;
  }
}

export const intaSendReconciliationService = new IntaSendReconciliationService();
export { IntaSendReconciliationService };
