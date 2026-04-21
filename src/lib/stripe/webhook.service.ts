/**
 * Stripe Webhook Service
 *
 * Validates incoming Stripe webhook events and updates org subscription state
 * in the database. All handlers are idempotent  -  Stripe may deliver the same
 * event more than once.
 *
 * Handled events:
 *   checkout.session.completed          -> activate trial / subscription + send PlanActivatedEmail
 *   customer.subscription.updated       -> plan change, trial-end, status transitions
 *   customer.subscription.deleted       -> enter 7-day grace period + send SubscriptionCancelledEmail
 *   customer.subscription.trial_will_end -> send TrialEndingReminderEmail
 *   invoice.payment_failed              -> mark PAST_DUE + send PaymentFailedEmail
 *   invoice.payment_succeeded           -> clear PAST_DUE back to ACTIVE
 *
 * Raw-body requirement:
 *   This service receives the request body as a `Buffer`. The Fastify webhook
 *   route uses an encapsulated plugin with a custom content-type parser so that
 *   the global JSON parser is NOT invoked before this service sees the payload.
 */

import type Stripe from 'stripe';
import { PaymentProvider, PaymentStatus, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { stripe } from './client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { paymentService } from '@/modules/billing/payment.service';
import { planCtxCacheKey } from '@/modules/trial';
import { getRuntimePriceToPlanMap } from '@/lib/runtime-billing-plans';

// -- Constants --------------------------------------------------------------

/** Duration of the grace period after cancellation (in days). */
const GRACE_PERIOD_DAYS = 7;

/** Redis key pattern for org plan cache (must match middleware.ts). */
const planCacheKey = (orgId: string) => `sheriabot:plan:${orgId}`;

/** Key features included in each paid plan  -  used in activation emails. */
const PLAN_FEATURES: Record<string, string[]> = {
  STARTUP: [
    '50 compliance queries / month',
    '5 AI checklist generations / month',
    'AI gap analysis',
    'Policy generation',
    'Email support (48 hr)',
  ],
  BUSINESS: [
    '200 compliance queries / month',
    '20 AI checklist generations / month',
    'Advanced analytics',
    'Custom integrations & API access',
    'Team collaboration',
    'Priority support (24 hr)',
  ],
  ENTERPRISE: [
    'Unlimited compliance queries',
    'Unlimited checklists & templates',
    'Custom integrations',
    'Dedicated account manager',
    'SLA guarantee',
    'On-premise deployment option',
  ],
};

/** Human-readable plan labels for email copy. */
const PLAN_LABELS: Record<string, string> = {
  STARTUP:    'Startup',
  BUSINESS:   'Business',
  ENTERPRISE: 'Enterprise',
};

const frontendUrl = () => appConfig.frontendUrl.replace(/\/$/, '');

// -- Helpers ----------------------------------------------------------------

/** Extract string ID from an expandable Stripe field. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Map a Stripe subscription status to our SubscriptionStatus enum. */
function mapStripeStatus(status: Stripe.Subscription['status']): SubscriptionStatus {
  switch (status) {
    case 'trialing':  return SubscriptionStatus.TRIALING;
    case 'active':    return SubscriptionStatus.ACTIVE;
    case 'past_due':  return SubscriptionStatus.PAST_DUE;
    // 'canceled' is handled via customer.subscription.deleted -> GRACE_PERIOD
    // Treat incomplete / unpaid / paused as payment problems
    default:          return SubscriptionStatus.PAST_DUE;
  }
}

// -- Service class ----------------------------------------------------------

class StripeWebhookService {
  // --------------------------------------------------------------------------
  // Public entry point
  // --------------------------------------------------------------------------

  /**
   * Verify the webhook signature and dispatch to the correct handler.
   *
   * @param payload   Raw request body as a Buffer (not JSON-parsed).
   * @param signature Value of the `Stripe-Signature` header.
   * @throws          If signature verification fails (Fastify route returns 400).
   */
  async handleEvent(payload: Buffer, signature: string): Promise<void> {
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      appConfig.stripe.webhookSecret,
    );

    // Idempotency guard  -  Stripe retries webhooks for up to 3 days.
    // SET NX is atomic: only one concurrent delivery wins; retries see the key and skip.
    const alreadyProcessed = await this.markProcessed(event.id);
    if (alreadyProcessed) {
      logger.info({
        type: 'webhook_duplicate_skipped',
        eventId: event.id,
        eventType: event.type,
      });
      return;
    }

    logger.info({ type: 'stripe_webhook_received', eventType: event.type, eventId: event.id });

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_succeeded':
        await this.handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'customer.subscription.trial_will_end':
        await this.handleTrialWillEnd(event.data.object as Stripe.Subscription);
        break;
      default:
        // Ignore unhandled event types  -  Stripe sends many others
        logger.debug({ type: 'stripe_webhook_unhandled', eventType: event.type });
    }
  }

  // --------------------------------------------------------------------------
  // Event handlers
  // --------------------------------------------------------------------------

  /**
   * checkout.session.completed
   *
   * Fires when the user completes the Stripe-hosted checkout flow.
   * For subscription mode with a trial, this fires immediately (no charge yet).
   *
   * We store the subscription ID, activate the new plan, and record trial dates.
   */
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const orgId = session.metadata?.organizationId;
    const planName = session.metadata?.plan as keyof typeof SubscriptionPlan | undefined;

    if (!orgId || !planName || !(planName in SubscriptionPlan)) {
      logger.warn({
        type: 'stripe_webhook_checkout_missing_metadata',
        sessionId: session.id,
        metadata: session.metadata,
      });
      return;
    }

    const subId = toId(session.subscription);
    if (!subId) {
      logger.warn({ type: 'stripe_webhook_checkout_no_subscription', sessionId: session.id });
      return;
    }

    // Retrieve full subscription so we can record trial dates
    const sub = await stripe.subscriptions.retrieve(subId);
    const trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
    const subStatus   = mapStripeStatus(sub.status);

    await prisma.organization.update({
      where: { id: orgId },
      data: {
        plan:               SubscriptionPlan[planName],
        stripeSubId:        subId,
        subscriptionStatus: subStatus,
        planStartDate:      new Date(),
        trialEndsAt,
        // Clear any leftover cancellation state from a previous sub
        cancelledAt:        null,
        gracePeriodEndsAt:  null,
      },
    });

    await this.invalidatePlanCache(orgId);

    logger.info({
      type:    'stripe_subscription_activated',
      orgId,
      plan:    planName,
      subId,
      status:  subStatus,
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
    });

    // -- Append payment record (trial start  -  amount 0 until trial ends) ------
    {
      const invoiceNumber    = await paymentService.generateInvoiceNumber();
      const periodStart      = new Date();
      const periodEnd        = trialEndsAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      void paymentService.createPaymentRecord({
        orgId,
        subscriptionId:        subId,
        provider:              PaymentProvider.STRIPE,
        providerTransactionId: session.id,
        amount:                0,
        currency:              'KES',
        status:                subStatus === SubscriptionStatus.TRIALING
          ? PaymentStatus.PENDING
          : PaymentStatus.COMPLETED,
        description:           `Checkout completed  -  ${planName} plan`,
        metadata:              { sessionId: session.id, plan: planName },
        invoiceNumber,
        subscriptionPlan:      planName,
        billingPeriodStart:    periodStart,
        billingPeriodEnd:      periodEnd,
      });
    }

    // -- Fire activation email (non-blocking) --------------------------------
    const contact = await this.findOrgOwnerContact(orgId);
    if (contact) {
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
      const base = frontendUrl();
      void reactMailer.sendPlanActivatedEmail(contact.email, {
        userName:         contact.fullName,
        orgName:          org?.name ?? '',
        planName:         PLAN_LABELS[planName] ?? planName,
        trialEndsAt:      trialEndsAt?.toISOString(),
        billingPortalUrl: `${base}/settings/billing`,
        dashboardUrl:     `${base}/startup`,
        features:         PLAN_FEATURES[planName] ?? [],
      });
    }
  }

  /**
   * customer.subscription.updated
   *
   * Fires on any subscription change: trial ending, plan change, payment
   * recovery, pause, etc.
   *
   * We update the org's plan (if price ID changed) and subscription status.
   */
  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = toId(subscription.customer);
    if (!customerId) return;

    const org = await this.findOrgByCustomerId(customerId);
    if (!org) {
      logger.warn({ type: 'stripe_webhook_org_not_found', customerId });
      return;
    }

    const newStatus   = mapStripeStatus(subscription.status);
    const trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;

    // Detect plan change via price ID
    const priceToPlan = await getRuntimePriceToPlanMap();
    const priceId = subscription.items.data[0]?.price?.id;
    const newPlan = priceId ? (priceToPlan[priceId] ?? null) : null;

    await prisma.organization.update({
      where: { id: org.id },
      data: {
        subscriptionStatus: newStatus,
        trialEndsAt,
        ...(newPlan ? { plan: SubscriptionPlan[newPlan] } : {}),
      },
    });

    await this.invalidatePlanCache(org.id);

    logger.info({
      type:      'stripe_subscription_updated',
      orgId:     org.id,
      customerId,
      newStatus,
      newPlan:   newPlan ?? '(unchanged)',
    });
  }

  /**
   * customer.subscription.deleted
   *
   * Fires when a Stripe subscription is cancelled (either immediately or at
   * period end). We begin a 7-day grace period rather than revoking access
   * immediately. The lazy check in `withPlanContext` will downgrade the plan
   * once `gracePeriodEndsAt` passes.
   */
  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = toId(subscription.customer);
    if (!customerId) return;

    const org = await this.findOrgByCustomerId(customerId);
    if (!org) {
      logger.warn({ type: 'stripe_webhook_org_not_found_on_delete', customerId });
      return;
    }

    const now             = new Date();
    const gracePeriodEndsAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    await prisma.organization.update({
      where: { id: org.id },
      data: {
        subscriptionStatus: SubscriptionStatus.GRACE_PERIOD,
        cancelledAt:        now,
        gracePeriodEndsAt,
        // Plan is intentionally NOT changed here  -  grace period retains full access.
        // withPlanContext will downgrade to REGULATOR once gracePeriodEndsAt passes.
      },
    });

    await this.invalidatePlanCache(org.id);

    logger.info({
      type:             'stripe_subscription_cancelled',
      orgId:            org.id,
      customerId,
      gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
    });

    // -- Fire cancellation email (non-blocking) -------------------------------
    const contact = await this.findOrgOwnerContact(org.id);
    if (contact) {
      const base     = frontendUrl();
      const planLabel = PLAN_LABELS[org.plan] ?? org.plan;
      void reactMailer.sendSubscriptionCancelledEmail(contact.email, {
        userName:          contact.fullName,
        orgName:           org.name,
        planName:          planLabel,
        gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
        reactivateUrl:     `${base}/settings/billing`,
        dashboardUrl:      `${base}/startup`,
      });
    }
  }

  /**
   * invoice.payment_failed
   *
   * Fires when Stripe cannot collect payment. Marks the org as PAST_DUE.
   * Stripe will retry automatically; the org retains access during retries.
   */
  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = toId(invoice.customer);
    if (!customerId) return;

    const org = await this.findOrgByCustomerId(customerId);
    if (!org) {
      logger.warn({ type: 'stripe_webhook_org_not_found_payment_failed', customerId });
      return;
    }

    await prisma.organization.update({
      where: { id: org.id },
      data: { subscriptionStatus: SubscriptionStatus.PAST_DUE },
    });

    await this.invalidatePlanCache(org.id);

    logger.warn({
      type:      'stripe_payment_failed',
      orgId:     org.id,
      customerId,
      invoiceId: invoice.id,
    });

    // -- Append payment record -------------------------------------------------
    {
      const amountDue = typeof invoice.amount_due === 'number' ? invoice.amount_due : 0;
      const invoiceAny = invoice as unknown as Record<string, unknown>;
      const subId = invoiceAny['subscription'] ? toId(invoiceAny['subscription'] as string | { id: string }) : null;
      void paymentService.createPaymentRecord({
        orgId:                 org.id,
        subscriptionId:        subId ?? undefined,
        provider:              PaymentProvider.STRIPE,
        providerTransactionId: invoice.id,
        amount:                amountDue,
        currency:              (invoice.currency ?? 'kes').toUpperCase(),
        status:                PaymentStatus.FAILED,
        description:           'Invoice payment failed',
        metadata:              {
          invoiceId:        invoice.id,
          customerId,
          hostedInvoiceUrl: (invoiceAny['hosted_invoice_url'] as string | null) ?? null,
        },
      });
    }

    // -- Fire payment-failed email (non-blocking) -----------------------------
    const contact = await this.findOrgOwnerContact(org.id);
    if (contact) {
      const base       = frontendUrl();
      const planLabel  = PLAN_LABELS[org.plan] ?? org.plan;
      // Format amount from invoice (amount_due is in cents)
      const amountDue  = typeof invoice.amount_due === 'number' ? invoice.amount_due : 0;
      const amount     = `KES ${(amountDue / 100).toLocaleString('en-KE')}`;
      void reactMailer.sendPaymentFailedEmail(contact.email, {
        userName:        contact.fullName,
        amount,
        planName:        planLabel,
        retryUrl:        `${base}/settings/billing`,
        gracePeriodDays: GRACE_PERIOD_DAYS,
      });
    }
  }

  /**
   * invoice.payment_succeeded
   *
   * Fires after a successful charge. Clears PAST_DUE back to ACTIVE.
   * (TRIALING orgs that haven't yet been charged stay TRIALING until
   * `customer.subscription.updated` fires at trial end.)
   */
  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    const customerId = toId(invoice.customer);
    if (!customerId) return;

    const org = await this.findOrgByCustomerId(customerId);
    if (!org) return; // Not an error  -  could be a one-off invoice not tied to a subscription

    // Only flip status if we're currently PAST_DUE; leave TRIALING / ACTIVE untouched
    if (org.subscriptionStatus === SubscriptionStatus.PAST_DUE) {
      await prisma.organization.update({
        where: { id: org.id },
        data: { subscriptionStatus: SubscriptionStatus.ACTIVE },
      });

      await this.invalidatePlanCache(org.id);

      logger.info({
        type:      'stripe_payment_recovered',
        orgId:     org.id,
        customerId,
        invoiceId: invoice.id,
      });
    }

    // -- Append payment record for every successful invoice --------------------
    {
      const amountPaid = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0;
      const invoiceAny = invoice as unknown as Record<string, unknown>;
      const subId = invoiceAny['subscription'] ? toId(invoiceAny['subscription'] as string | { id: string }) : null;

      // Derive billing period from Stripe invoice timestamps
      const periodStartTs = invoiceAny['period_start'] as number | undefined;
      const periodEndTs   = invoiceAny['period_end'] as number | undefined;
      const billingPeriodStart = periodStartTs ? new Date(periodStartTs * 1000) : undefined;
      const billingPeriodEnd   = periodEndTs   ? new Date(periodEndTs   * 1000) : undefined;

      // Derive plan from invoice line items price ID
      const lines     = invoiceAny['lines'] as { data?: Array<{ price?: { id?: string } }> } | undefined;
      const priceToPlan = await getRuntimePriceToPlanMap();
      const priceId   = lines?.data?.[0]?.price?.id;
      const derivedPlan = priceId ? (priceToPlan[priceId] ?? null) : null;
      const planLabel = derivedPlan ?? org.plan;

      const invoiceNumber = await paymentService.generateInvoiceNumber();

      void paymentService.createPaymentRecord({
        orgId:                 org.id,
        subscriptionId:        subId ?? undefined,
        provider:              PaymentProvider.STRIPE,
        providerTransactionId: invoice.id,
        amount:                amountPaid,
        currency:              (invoice.currency ?? 'kes').toUpperCase(),
        status:                PaymentStatus.COMPLETED,
        description:           'Invoice payment succeeded',
        paidAt:                new Date(),
        metadata:              {
          invoiceId:        invoice.id,
          customerId,
          hostedInvoiceUrl: (invoiceAny['hosted_invoice_url'] as string | null) ?? null,
        },
        invoiceNumber,
        subscriptionPlan:    String(planLabel),
        billingPeriodStart,
        billingPeriodEnd,
      });
    }
  }

  /**
   * customer.subscription.trial_will_end
   *
   * Stripe fires this event ~3 days before the trial ends. We send a reminder
   * email so the user knows to add a payment method. No DB changes are needed.
   */
  private async handleTrialWillEnd(subscription: Stripe.Subscription): Promise<void> {
    const customerId = toId(subscription.customer);
    if (!customerId) return;

    const org = await this.findOrgByCustomerId(customerId);
    if (!org) {
      logger.warn({ type: 'stripe_webhook_org_not_found_trial_will_end', customerId });
      return;
    }

    const trialEnd = subscription.trial_end;
    if (!trialEnd) return;

    const trialEndsAt  = new Date(trialEnd * 1000);
    const now          = new Date();
    const daysRemaining = Math.max(1, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000));

    logger.info({
      type:         'stripe_trial_will_end',
      orgId:        org.id,
      customerId,
      trialEndsAt:  trialEndsAt.toISOString(),
      daysRemaining,
    });

    // -- Fire trial-ending reminder email (non-blocking) ----------------------
    const contact = await this.findOrgOwnerContact(org.id);
    if (contact) {
      const base      = frontendUrl();
      const planLabel = PLAN_LABELS[org.plan] ?? org.plan;
      void reactMailer.sendTrialEndingReminderEmail(contact.email, {
        userName:         contact.fullName,
        orgName:          org.name,
        planName:         planLabel,
        trialEndsAt:      trialEndsAt.toISOString(),
        daysRemaining,
        billingPortalUrl: `${base}/settings/billing`,
        dashboardUrl:     `${base}/startup`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Shared utilities
  // --------------------------------------------------------------------------

  /**
   * Atomically mark a Stripe event as processed using Redis SET NX.
   *
   * Returns true  -> key already existed -> duplicate, skip processing.
   * Returns false -> key was just set    -> new event, proceed normally.
   *
   * Fails open: Redis unavailability is logged as a warning and returns false
   * so the event is processed rather than silently dropped.
   *
   * TTL is 30 days  -  longer than Stripe's maximum 3-day retry window.
   */
  private async markProcessed(eventId: string): Promise<boolean> {
    const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
    try {
      const key = `sheriabot:stripe:evt:${eventId}`;
      const result = await redis.set(key, '1', { ex: IDEMPOTENCY_TTL_SECONDS, nx: true });
      // 'OK' = key newly set (new event); null = key already existed (duplicate)
      return result === null;
    } catch (error: unknown) {
      logger.warn({
        type: 'webhook_idempotency_check_failed',
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false; // Fail open  -  process rather than silently drop
    }
  }

  private async findOrgByCustomerId(customerId: string): Promise<{
    id: string;
    name: string;
    plan: SubscriptionPlan;
    subscriptionStatus: SubscriptionStatus;
  } | null> {
    return prisma.organization.findUnique({
      where:  { stripeCustomerId: customerId },
      select: { id: true, name: true, plan: true, subscriptionStatus: true },
    });
  }

  /**
   * Fetch the primary contact (first owner / admin user) for an org so we
   * can address billing emails correctly. Returns null if no user is found.
   */
  private async findOrgOwnerContact(
    orgId: string,
  ): Promise<{ email: string; fullName: string } | null> {
    const user = await prisma.user.findFirst({
      where:  { organizationId: orgId, role: { in: ['ADMIN', 'STARTUP', 'ENTERPRISE'] } },
      select: { email: true, fullName: true },
      orderBy: { createdAt: 'asc' }, // oldest user = most likely the account owner
    });
    return user ?? null;
  }

  /**
   * Invalidate all plan-related Redis caches after a subscription change.
   *
   * Two key spaces are cleared:
   *   1. Legacy org-scoped key `sheriabot:plan:{orgId}`  -  kept for any
   *      consumers that may still read it directly.
   *   2. User-scoped plan context keys `sheriabot:planctx:{userId}`  -  the
   *      authoritative cache read by `withPlanContext` middleware. Every
   *      member of the org must have their key cleared so the next request
   *      re-fetches the updated plan from the DB within this request cycle
   *      rather than after the 5-minute TTL expires.
   */
  private async invalidatePlanCache(orgId: string): Promise<void> {
    try {
      // 1. Legacy org-scoped key
      await redis.del(planCacheKey(orgId));

      // 2. User-scoped plan context keys for all org members
      const users = await prisma.user.findMany({
        where:  { organizationId: orgId },
        select: { id: true },
      });

      await Promise.all(
        users.map((u) => redis.del(planCtxCacheKey(u.id)).catch(() => { /* non-fatal */ }))
      );

      logger.info({
        type:      'plan_cache_invalidated',
        orgId,
        userCount: users.length,
        source:    'stripe_webhook',
      });
    } catch (err) {
      // Cache invalidation failure is non-fatal  -  withPlanContext will serve
      // stale data for up to 5 minutes then re-fetch.
      logger.warn({ type: 'stripe_plan_cache_invalidation_failed', orgId, err: String(err) });
    }
  }
}

export const stripeWebhookService = new StripeWebhookService();
