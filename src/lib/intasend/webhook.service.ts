/**
 * IntaSend Webhook Service
 *
 * Handles POST events from IntaSend at /api/webhooks/intasend.
 * Webhooks verify the shared challenge in the Fastify route, then this service
 * re-checks the referenced invoice directly with IntaSend before mutating local
 * finance records.
 */

import { PaymentProvider, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { intaSendService } from '@/modules/intasend/intasend.service';
import { normaliseIntaSendState, type IntaSendWebhookPayload } from '@/modules/intasend/intasend.types';
import { intaSendFinalizationService } from '@/modules/billing/intasend-finalization.service';

async function writeWebhookAudit(
  action: string,
  invoiceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entityType: 'PaymentProviderWebhook',
        entityId: invoiceId,
        metadata: metadata as Prisma.InputJsonObject,
      },
    });
  } catch (err: unknown) {
    logger.error({
      type: 'intasend_webhook_audit_write_failed',
      action,
      invoiceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type IntaSendWebhookOperationalEvent =
  | 'WEBHOOK_RECEIVED'
  | 'WEBHOOK_ACCEPTED'
  | 'WEBHOOK_REJECTED_IP'
  | 'WEBHOOK_REJECTED_CHALLENGE'
  | 'WEBHOOK_INVALID_PAYLOAD'
  | 'WEBHOOK_UNKNOWN_TRANSACTION'
  | 'WEBHOOK_PROVIDER_LOOKUP_FAILED'
  | 'WEBHOOK_FINALIZATION_SUCCEEDED'
  | 'WEBHOOK_FINALIZATION_FAILED';

class IntaSendWebhookService {
  async recordOperationalEvent(input: {
    event: IntaSendWebhookOperationalEvent;
    providerTransactionId?: string | null;
    paymentId?: string | null;
    reasonCode?: string | null;
    requestId?: string | null;
    ipHash?: string | null;
  }): Promise<void> {
    await writeWebhookAudit(`intasend_${input.event.toLowerCase()}`, input.providerTransactionId ?? input.paymentId ?? 'request', {
      event: input.event,
      provider: PaymentProvider.MPESA,
      providerTransactionId: input.providerTransactionId ?? null,
      paymentId: input.paymentId ?? null,
      reasonCode: input.reasonCode ?? null,
      requestId: input.requestId ?? null,
      ipHash: input.ipHash ?? null,
    });
  }

  async handleEvent(rawPayload: IntaSendWebhookPayload): Promise<void> {
    const invoiceId = rawPayload.invoice_id;

    if (!invoiceId) {
      logger.warn({ type: 'intasend_webhook_missing_invoice_id' });
      await writeWebhookAudit('intasend_webhook_missing_invoice_id', 'missing', {
        rawState: rawPayload.state ?? null,
      });
      return;
    }

    logger.info({
      type: 'intasend_webhook_received',
      invoiceId,
      rawState: rawPayload.state,
    });

    const knownPayment = await prisma.payment.findFirst({
      where: { providerTransactionId: invoiceId, provider: PaymentProvider.MPESA },
      select: { id: true, status: true },
    });

    if (!knownPayment) {
      logger.warn({ type: 'intasend_webhook_unknown_invoice', invoiceId });
      await this.recordOperationalEvent({
        event: 'WEBHOOK_UNKNOWN_TRANSACTION',
        providerTransactionId: invoiceId,
        reasonCode: 'payment_not_found',
      });
      await writeWebhookAudit('intasend_webhook_unknown_invoice', invoiceId, {
        rawState: rawPayload.state ?? null,
      });
      return;
    }

    let verifiedStatus: Awaited<ReturnType<typeof intaSendService.getPaymentStatus>>;
    try {
      verifiedStatus = await intaSendService.getPaymentStatus(invoiceId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ type: 'intasend_webhook_verification_failed', invoiceId, error: message });
      await this.recordOperationalEvent({
        event: 'WEBHOOK_PROVIDER_LOOKUP_FAILED',
        providerTransactionId: invoiceId,
        paymentId: knownPayment.id,
        reasonCode: 'provider_status_lookup_failed',
      });
      await writeWebhookAudit('intasend_webhook_verification_failed', invoiceId, {
        rawState: rawPayload.state ?? null,
        error: message,
      });
      return;
    }

    logger.info({
      type: 'intasend_webhook_verified',
      invoiceId,
      rawState: rawPayload.state,
      verifiedState: verifiedStatus.state,
    });

    await writeWebhookAudit('intasend_webhook_verified', invoiceId, {
      rawState: rawPayload.state ?? null,
      verifiedState: verifiedStatus.state,
      localPaymentStatus: knownPayment.status,
    });

    switch (normaliseIntaSendState(verifiedStatus.state)) {
      case 'COMPLETE':
        await intaSendFinalizationService.finalizePayment({
          invoiceId,
          verifiedStatus,
          source: 'webhook',
        }).then(async (result) => {
          await this.recordOperationalEvent({
            event: 'WEBHOOK_FINALIZATION_SUCCEEDED',
            providerTransactionId: invoiceId,
            paymentId: result.paymentId,
            reasonCode: result.newlyFinalized ? 'newly_finalized' : result.status,
          });
        }).catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ type: 'intasend_webhook_finalization_failed', invoiceId, error: message });
          await this.recordOperationalEvent({
            event: 'WEBHOOK_FINALIZATION_FAILED',
            providerTransactionId: invoiceId,
            paymentId: knownPayment.id,
            reasonCode: 'finalizer_error',
          });
          await writeWebhookAudit('intasend_webhook_finalization_failed', invoiceId, {
            error: message,
          });
        });
        break;
      case 'FAILED':
        await intaSendFinalizationService.markFailed({
          invoiceId,
          source: 'webhook',
          failedReason: rawPayload.failed_reason ?? null,
          failedCode: rawPayload.failed_code ?? null,
        });
        break;
      case 'PENDING':
        if (knownPayment.status === PaymentStatus.PENDING) {
          logger.debug({ type: 'intasend_payment_still_pending', invoiceId });
        }
        break;
      default:
        logger.debug({ type: 'intasend_webhook_unhandled_state', invoiceId, verifiedState: verifiedStatus.state });
    }
  }
}

export const intaSendWebhookService = new IntaSendWebhookService();
export { IntaSendWebhookService };
