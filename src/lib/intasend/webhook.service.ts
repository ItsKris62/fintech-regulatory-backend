/**
 * IntaSend Webhook Service
 *
 * Handles POST events from IntaSend at /api/webhooks/intasend.
 *
 * Security:
 *   IntaSend does not sign webhook payloads with HMAC. On every webhook
 *   receipt we re-call intaSendService.getPaymentStatus(invoice_id) to
 *   confirm the reported state from IntaSend's API before acting on it.
 *
 * Idempotency:
 *   All handlers guard against duplicate delivery using the Payment record's
 *   providerTransactionId (= IntaSend invoice_id) dedup check in
 *   paymentService.createPaymentRecord().
 *
 * Handled events (IntaSend state field):
 *   COMPLETE  -> activate subscription, generate invoice, send receipt email
 *   FAILED    -> mark payment FAILED, send failure email
 *   PENDING   -> upsert payment record as PENDING (no further action)
 */

import { PaymentProvider, PaymentStatus, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { paymentService } from '@/modules/billing/payment.service';
import { intaSendService } from '@/modules/intasend/intasend.service';
import { normaliseIntaSendState, type IntaSendWebhookPayload } from '@/modules/intasend/intasend.types';
import { planCtxCacheKey } from '@/modules/trial';
import { appConfig } from '@/config/app.config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRACE_PERIOD_DAYS = 7;
const MPESA_SUBSCRIPTION_DAYS = 30;

/** Redis key pattern for legacy org plan cache (mirrors webhook.service.ts). */
const planCacheKey = (orgId: string) => `sheriabot:plan:${orgId}`;

/** Human-readable plan labels for email copy. */
const PLAN_LABELS: Record<string, string> = {
  STARTUP:    'Startup',
  BUSINESS:   'Business',
  ENTERPRISE: 'Enterprise',
};

/** Plan price in KES (whole number) — used for receipt email formatting. */
const PLAN_PRICES: Record<string, number> = {
  STARTUP:    25000,
  BUSINESS:   75000,
  ENTERPRISE: 0, // Enterprise is custom-priced
};

const frontendUrl = () => appConfig.frontendUrl.replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Helpers (mirrors patterns from stripe/webhook.service.ts)
// ---------------------------------------------------------------------------

/**
 * Invalidate the org-scoped plan cache and all user-scoped plan context
 * keys for org members so the next request re-fetches the updated plan.
 */
async function invalidatePlanCache(orgId: string): Promise<void> {
  try {
    await redis.del(planCacheKey(orgId));

    const users = await prisma.user.findMany({
      where:  { organizationId: orgId },
      select: { id: true },
    });

    if (users.length > 0) {
      await Promise.all(users.map((u) => redis.del(planCtxCacheKey(u.id))));
    }

    logger.debug({ type: 'intasend_plan_cache_invalidated', orgId, userCount: users.length });
  } catch (err: unknown) {
    logger.error({
      type:  'intasend_plan_cache_invalidation_failed',
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Find the primary contact for an org (oldest admin/owner user).
 * Used to address billing emails correctly.
 */
async function findOrgOwnerContact(
  orgId: string,
): Promise<{ email: string; fullName: string } | null> {
  const user = await prisma.user.findFirst({
    where:   { organizationId: orgId, role: { in: ['ADMIN', 'STARTUP', 'ENTERPRISE'] } },
    select:  { email: true, fullName: true },
    orderBy: { createdAt: 'asc' },
  });
  return user ?? null;
}

/**
 * Find an org that has an active M-Pesa payment pending.
 * Looks up via the Payment record's orgId (using providerTransactionId).
 */
async function findOrgByInvoiceId(
  invoiceId: string,
): Promise<{ orgId: string; org: { id: string; name: string; plan: SubscriptionPlan } } | null> {
  const payment = await prisma.payment.findFirst({
    where:   { providerTransactionId: invoiceId, provider: PaymentProvider.MPESA },
    select:  { orgId: true, org: { select: { id: true, name: true, plan: true } } },
  });
  if (!payment) return null;
  return { orgId: payment.orgId, org: payment.org };
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

class IntaSendWebhookService {
  /**
   * Main entry point. Called by the Fastify /api/webhooks/intasend route.
   *
   * Verification: re-calls IntaSend status API to confirm state before acting.
   */
  async handleEvent(rawPayload: IntaSendWebhookPayload): Promise<void> {
    const invoiceId = rawPayload.invoice_id;

    if (!invoiceId) {
      logger.warn({ type: 'intasend_webhook_missing_invoice_id', rawPayload });
      return;
    }

    logger.info({
      type:      'intasend_webhook_received',
      invoiceId,
      rawState:  rawPayload.state,
    });

    // SSRF guard: confirm this invoice_id belongs to one of our Payment records
    // *before* calling IntaSend's API with it. An attacker-supplied invoice_id
    // that has no matching Payment row is dropped here — we never proxy it to
    // IntaSend's servers.
    const knownPayment = await prisma.payment.findFirst({
      where:  { providerTransactionId: invoiceId, provider: PaymentProvider.MPESA },
      select: { id: true },
    });
    if (!knownPayment) {
      logger.warn({ type: 'intasend_webhook_unknown_invoice', invoiceId });
      // Ack silently — don't tell the caller whether the ID was unrecognised
      return;
    }

    // Re-verify from IntaSend's API (do not trust payload state alone)
    let verifiedState: ReturnType<typeof normaliseIntaSendState>;
    try {
      const status = await intaSendService.getPaymentStatus(invoiceId);
      verifiedState = status.state;
    } catch (err: unknown) {
      logger.error({
        type:      'intasend_webhook_verification_failed',
        invoiceId,
        error:     err instanceof Error ? err.message : String(err),
      });
      // Do not throw — ack the webhook so IntaSend stops retrying,
      // but log so we can investigate
      return;
    }

    logger.info({
      type:          'intasend_webhook_verified',
      invoiceId,
      rawState:      rawPayload.state,
      verifiedState,
    });

    switch (verifiedState) {
      case 'COMPLETE':
        await this.handleComplete(invoiceId);
        break;
      case 'FAILED':
        await this.handleFailed(invoiceId, rawPayload);
        break;
      case 'PENDING':
        await this.handlePending(invoiceId);
        break;
      default:
        logger.debug({ type: 'intasend_webhook_unhandled_state', invoiceId, verifiedState });
    }
  }

  // --------------------------------------------------------------------------
  // COMPLETE
  // --------------------------------------------------------------------------

  private async handleComplete(invoiceId: string): Promise<void> {
    // Find the org via the pending payment record
    const found = await findOrgByInvoiceId(invoiceId);
    if (!found) {
      logger.error({ type: 'intasend_complete_org_not_found', invoiceId });
      return;
    }
    const { orgId, org } = found;

    // Fetch the pending payment record
    const payment = await prisma.payment.findFirst({
      where: { providerTransactionId: invoiceId, provider: PaymentProvider.MPESA },
    });
    if (!payment) {
      logger.error({ type: 'intasend_complete_payment_not_found', invoiceId, orgId });
      return;
    }

    // Idempotency: skip if already completed
    if (payment.status === PaymentStatus.COMPLETED) {
      logger.info({ type: 'intasend_complete_already_processed', invoiceId, orgId });
      return;
    }

    const now          = new Date();
    const periodStart  = now;
    const periodEnd    = new Date(now.getTime() + MPESA_SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);
    const planName     = org.plan as string;

    // Generate invoice number
    const invoiceNumber = await paymentService.generateInvoiceNumber();

    // Update payment record: COMPLETED + invoice fields
    await paymentService.updatePaymentStatus(payment.id, PaymentStatus.COMPLETED, {
      ...(payment.metadata as Record<string, unknown> ?? {}),
      verifiedAt: now.toISOString(),
    });

    // Write invoice fields (updatePaymentStatus only touches status + metadata)
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        invoiceNumber,
        subscriptionPlan:   planName,
        billingPeriodStart: periodStart,
        billingPeriodEnd:   periodEnd,
        paidAt:             now,
      },
    });

    // Activate / renew M-Pesa subscription on org
    await prisma.organization.update({
      where: { id: orgId },
      data: {
        subscriptionStatus:     SubscriptionStatus.ACTIVE,
        planStartDate:          now,
        planEndDate:            periodEnd,
        mpesaNextPaymentDueDate: periodEnd,
        // Clear any grace/cancellation state
        cancelledAt:            null,
        gracePeriodEndsAt:      null,
      },
    });

    await invalidatePlanCache(orgId);

    logger.info({
      type:          'intasend_payment_completed',
      invoiceId,
      invoiceNumber,
      orgId,
      planName,
      periodStart:   periodStart.toISOString(),
      periodEnd:     periodEnd.toISOString(),
    });

    // Fire receipt email (non-blocking)
    const contact = await findOrgOwnerContact(orgId);
    if (contact) {
      const planLabel    = PLAN_LABELS[planName] ?? planName;
      const amountKes    = PLAN_PRICES[planName] ?? (payment.amount / 100);
      const amountStr    = `KES ${amountKes.toLocaleString('en-KE')}`;
      const mpesaPhone   = (payment.metadata as Record<string, unknown>)?.['phone_number'] as string | undefined;
      const maskedPhone  = mpesaPhone ? `M-Pesa (**** ${mpesaPhone.slice(-4)})` : 'M-Pesa';
      const base         = frontendUrl();

      void reactMailer.sendPaymentReceiptEmail(contact.email, {
        userName:      contact.fullName,
        invoiceNumber,
        amount:        amountStr,
        currency:      'KES',
        paymentDate:   now.toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' }),
        paymentMethod: maskedPhone,
        planName:      planLabel,
        billingPeriod: `${periodStart.toLocaleDateString('en-KE', { month: 'short', day: 'numeric', year: 'numeric' })} to ${periodEnd.toLocaleDateString('en-KE', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        receiptUrl:    `${base}/settings/billing`,
        items: [
          {
            description: `${planLabel} Plan — Monthly Subscription`,
            amount:      amountStr,
          },
        ],
      });
    }
  }

  // --------------------------------------------------------------------------
  // FAILED
  // --------------------------------------------------------------------------

  private async handleFailed(
    invoiceId:  string,
    rawPayload: IntaSendWebhookPayload,
  ): Promise<void> {
    const payment = await prisma.payment.findFirst({
      where: { providerTransactionId: invoiceId, provider: PaymentProvider.MPESA },
    });

    if (!payment) {
      logger.warn({ type: 'intasend_failed_payment_not_found', invoiceId });
      return;
    }

    if (payment.status === PaymentStatus.FAILED) {
      logger.info({ type: 'intasend_failed_already_processed', invoiceId });
      return;
    }

    await paymentService.updatePaymentStatus(payment.id, PaymentStatus.FAILED, {
      ...(payment.metadata as Record<string, unknown> ?? {}),
      failedReason: rawPayload.failed_reason ?? null,
      failedCode:   rawPayload.failed_code ?? null,
      failedAt:     new Date().toISOString(),
    });

    logger.warn({
      type:         'intasend_payment_failed',
      invoiceId,
      orgId:        payment.orgId,
      failedReason: rawPayload.failed_reason ?? null,
    });

    // Fire payment-failed email (non-blocking)
    const contact = await findOrgOwnerContact(payment.orgId);
    if (contact) {
      const org       = await prisma.organization.findUnique({
        where:  { id: payment.orgId },
        select: { plan: true, name: true },
      });
      const planLabel  = PLAN_LABELS[org?.plan ?? ''] ?? (org?.plan ?? 'Subscription');
      const amountKes  = payment.amount / 100;
      const amountStr  = `KES ${amountKes.toLocaleString('en-KE')}`;
      const base       = frontendUrl();

      void reactMailer.sendPaymentFailedEmail(contact.email, {
        userName:        contact.fullName,
        amount:          amountStr,
        planName:        planLabel,
        retryUrl:        `${base}/settings/billing`,
        gracePeriodDays: GRACE_PERIOD_DAYS,
      });
    }
  }

  // --------------------------------------------------------------------------
  // PENDING
  // --------------------------------------------------------------------------

  private async handlePending(invoiceId: string): Promise<void> {
    const payment = await prisma.payment.findFirst({
      where: { providerTransactionId: invoiceId, provider: PaymentProvider.MPESA },
    });

    if (!payment) {
      logger.debug({ type: 'intasend_pending_payment_not_found', invoiceId });
      return;
    }

    // Only update if currently PENDING (no regression from COMPLETED/FAILED)
    if (payment.status === PaymentStatus.PENDING) {
      logger.debug({ type: 'intasend_payment_still_pending', invoiceId, orgId: payment.orgId });
    }
  }
}

export const intaSendWebhookService = new IntaSendWebhookService();
export { IntaSendWebhookService };
