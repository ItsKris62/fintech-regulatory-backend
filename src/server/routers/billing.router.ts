import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { BillingMetric, PaymentProvider, PaymentStatus, SubscriptionPlan } from '@prisma/client';
import { router, protectedProcedure, orgMemberProcedure } from '../trpc/trpc';
import { withPlanContext } from '../trpc/middleware';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { stripe } from '@/lib/stripe/client';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { stripeConfig } from '@/config/stripe.config';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { logger } from '@/utils/logger';
import { getTrialStatus } from '@/modules/trial';
import { intaSendService, normalisePhoneNumber } from '@/modules/intasend';
import { paymentService } from '@/modules/billing/payment.service';
import {
  getBillingPlanCatalog,
  getRuntimePlan,
  resolvePlanPriceForInterval,
} from '@/lib/runtime-billing-plans';
import { assertCanCreateOrJoinOrganization } from '../services/organization-plan-limit.service';

/** Redis key for enterprise inquiry rate-limiting (max 3 per org per day) */
const enterpriseInquiryKey = (orgId: string) => {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `sheriabot:enterprise_inquiry:${orgId}:${date}`;
};

// ============================================================================
// Helpers
// ============================================================================

/** Read the current-month usage count for a metric from Redis, fall back to 0. */
async function readUsageCount(scopeId: string, metric: BillingMetric): Promise<number> {
  const period = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const key = `sheriabot:usage:${scopeId}:${metric}:${period}`;
  try {
    const raw = await redis.get<number>(key);
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') return Number(raw);
    return 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Router
// ============================================================================

/**
 * Billing Router
 *
 * Routes:
 *  - billing.getPlanAndUsage         -  current plan, entitlements, usage, subscription status
 *  - billing.createCheckoutSession   -  Stripe Checkout for STARTUP / BUSINESS plans
 *  - billing.createPortalSession     -  Stripe Customer Portal (manage / cancel subscription)
 */
export const billingRouter = router({
  /**
   * Get the authenticated user's current plan, entitlements, and usage.
   *
   * Called once on dashboard mount (stale 5 min). The frontend caches this
   * and exposes it via `usePlan()` to drive all feature-gate UI.
   *
   * @protected  -  requires isAuthenticated + withPlanContext
   */
  getPlanAndUsage: orgMemberProcedure
    .use(withPlanContext)
    .query(async ({ ctx }) => {
      try {
        const plan = ctx.plan!;
        const orgId = ctx.orgMembership!.organizationId;
        const scopeId = orgId;
        const entitlements = ctx.entitlements ?? PLAN_ENTITLEMENTS[plan];

        // -- Usage counts (Redis, parallel reads) --------------------------
        const [
          complianceQueriesCount,
          checklistGenerationsCount,
          apiCallsCount,
          documentStorageMbCount,
        ] = await Promise.all([
          readUsageCount(scopeId, BillingMetric.COMPLIANCE_QUERIES),
          readUsageCount(scopeId, BillingMetric.CHECKLIST_GENERATIONS),
          readUsageCount(scopeId, BillingMetric.API_CALLS),
          readUsageCount(scopeId, BillingMetric.DOCUMENT_STORAGE_MB),
        ]);

        // -- Trial status (user-scoped, fetched for FREE_TRIAL and REGULATOR so
        //    the frontend knows whether the user is eligible or has already used
        //    their trial  -  prevents showing the activation banner to expired users)
        const trialStatus =
          plan === 'FREE_TRIAL' || plan === 'REGULATOR'
            ? await getTrialStatus(ctx.user!.id)
            : null;

        // -- Billing + subscription metadata (org row) ----------------------
        const [org, catalog] = await Promise.all([
          orgId
            ? prisma.organization.findUnique({
                where: { id: orgId },
                select: {
                  planStartDate:      true,
                  planEndDate:        true,
                  stripeCustomerId:   true,
                  subscriptionStatus: true,
                  trialEndsAt:        true,
                  gracePeriodEndsAt:  true,
                  cancelledAt:        true,
                  subscriptionEndsAt: true,
                  preferredPaymentMethod: true,
                  mpesaNextPaymentDueDate: true,
                  subscriptionCycleEnd: true,
                },
              })
            : Promise.resolve(null),
          // Catalog prices are Redis-cached (5-min TTL)  -  this is a fast read.
          // Returned so the UpgradeBanner can display live-overridable KES prices
          // instead of hardcoded strings.
          getBillingPlanCatalog(),
        ]);

        // Build a price map for self-serve plans only (STARTUP, BUSINESS).
        const catalogPrice = Object.fromEntries(
          catalog.plans
            .filter((p) => (catalog.managedPlanIds as readonly string[]).includes(p.id))
            .map((p) => [
              p.id,
              {
                monthly:  p.price.monthly  ?? 0,
                yearly:   p.price.yearly   ?? p.price.monthly ?? 0,
                currency: 'KES' as const,
              },
            ])
        ) as Record<'STARTUP' | 'BUSINESS', { monthly: number; yearly: number; currency: 'KES' }>;

        logger.info({
          type: 'billing_plan_usage_fetched',
          userId: ctx.user!.id,
          orgId,
          plan,
        });

        return {
          plan,
          entitlements,
          usage: {
            complianceQueries: {
              current: complianceQueriesCount,
              limit:   entitlements.complianceQueries.limit,
            },
            checklistGenerations: {
              current: checklistGenerationsCount,
              limit:   entitlements.checklistGenerations.limit,
            },
            apiCalls: {
              current: apiCallsCount,
              limit:   entitlements.apiAccess === false
                ? 0
                : entitlements.apiAccess.limit,
            },
            documentStorageMB: {
              current: documentStorageMbCount,
              limit:   entitlements.documentRepository.limitMB,
            },
          },
          billing: {
            planStartDate:      org?.planStartDate?.toISOString()     ?? null,
            planEndDate:        org?.planEndDate?.toISOString()        ?? null,
            stripeCustomerId:   org?.stripeCustomerId                  ?? null,
            subscriptionStatus: org?.subscriptionStatus                ?? null,
            trialEndsAt:        org?.trialEndsAt?.toISOString()        ?? null,
            gracePeriodEndsAt:  org?.gracePeriodEndsAt?.toISOString()  ?? null,
            cancelledAt:        org?.cancelledAt?.toISOString()        ?? null,
            subscriptionEndsAt: org?.subscriptionEndsAt?.toISOString() ?? null,
            // B4.1 (2026-05-27) -- M-Pesa lifecycle fields surfaced for client typed access
            preferredPaymentMethod: org?.preferredPaymentMethod ?? null,
            mpesaNextPaymentDueDate: org?.mpesaNextPaymentDueDate?.toISOString() ?? null,
            subscriptionCycleEnd:    org?.subscriptionCycleEnd?.toISOString()    ?? null,
            catalogPrice,
          },
          trial: trialStatus,
          effectivePlanSource: ctx.effectivePlanSource ?? 'FALLBACK',
          pilot: ctx.pilotState
            ? {
                isPilot: true,
                pilotStatus: ctx.pilotState.status,
                pilotExpiresAt: ctx.pilotState.expiresAt,
                pilotExtensionCount: ctx.pilotState.extensionCount,
                entitlementProfile: ctx.pilotState.entitlementProfile,
              }
            : {
                isPilot: false,
                pilotStatus: null,
                pilotExpiresAt: null,
                pilotExtensionCount: 0,
                entitlementProfile: null,
              },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';

        logger.error({
          type: 'billing_plan_usage_error',
          userId: ctx.user!.id,
          error: message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to load plan and usage data',
          cause: error,
        });
      }
    }),

  getPlanCatalog: protectedProcedure
    .input(z.void())
    .query(async () => {
      return getBillingPlanCatalog();
    }),

  /**
   * Create a Stripe Checkout Session for upgrading to STARTUP or BUSINESS.
   *
   * - Creates or reuses the org's Stripe Customer record.
   * - Starts a 14-day free trial (Stripe enforces this  -  no charges until trial ends).
   * - Enterprise is sales-led only; REGULATOR is free  -  neither goes through Stripe.
   *
   * Returns { url }  -  the frontend redirects the user to this URL.
   *
   * @protected  -  requires authentication + an organization
   */
  createCheckoutSession: orgMemberProcedure
    .use(withPlanContext)
    .input(
      z.object({
        plan: z.enum(['STARTUP', 'BUSINESS']),
        interval: z.enum(['monthly', 'yearly']).default('monthly'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user!;

      const orgId = ctx.orgMembership!.organizationId;

      // B7.3 (TD-009): Redis dedup lock - prevents double-click from creating two
      // Stripe checkout sessions. Lock is keyed on orgId+plan+interval so the user
      // can still switch plans without being blocked. TTL = 30s (well above the
      // Stripe API round-trip time). nx=true means "only set if not exists".
      const checkoutLockKey = `lock:checkout:${orgId}:${input.plan}:${input.interval}`;
      const lockAcquired = await redis.set(checkoutLockKey, '1', { ex: 30, nx: true });
      if (!lockAcquired) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'A checkout session is already being created. Please wait a moment.',
        });
      }

      // Fetch org for customer ID and current plan
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          plan: true,
          stripeCustomerId: true,
          name: true,
        },
      });

      if (!org) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found.' });
      }

      await assertCanCreateOrJoinOrganization({
        prisma: prisma as any,
        userId: user.id,
        targetOrganizationId: orgId,
        requestedPlan: input.plan as SubscriptionPlan,
        actorContext: {
          actorUserId: user.id,
          actorRole: user.role,
          sourceProcedure: 'billing.createCheckoutSession',
        },
      });

      // REGULATOR and ENTERPRISE are not self-serve via Stripe
      if (org.plan === SubscriptionPlan.ENTERPRISE) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Enterprise plans are managed by the SheriaBot sales team. Please contact us.',
        });
      }

      const runtimePlan = await getRuntimePlan(input.plan);
      const priceId = input.interval === 'yearly'
        ? (runtimePlan.stripe?.yearlyPriceId ?? null)
        : (runtimePlan.stripe?.monthlyPriceId ?? null);

      if (!priceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The ${input.plan} ${input.interval} Stripe price is not configured.`,
        });
      }

      // -- Find or create Stripe Customer ---------------------------------
      let customerId = org.stripeCustomerId ?? undefined;

      if (!customerId) {
        const userRecord = await prisma.user.findUnique({
          where: { id: user.id },
          select: { email: true, fullName: true },
        });

        const customer = await stripe.customers.create({
          email:    userRecord?.email ?? undefined,
          name:     org.name,
          metadata: { organizationId: orgId },
        });

        customerId = customer.id;

        // Persist immediately so we don't create duplicate customers on retry
        await prisma.organization.update({
          where: { id: orgId },
          data: { stripeCustomerId: customerId },
        });
      }

      // -- Create Checkout Session ----------------------------------------
      const session = await stripe.checkout.sessions.create({
        customer:   customerId,
        mode:       'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: runtimePlan.trialDays,
          metadata: {
            organizationId: orgId,
            plan:           input.plan,
            interval:       input.interval,
          },
        },
        success_url: stripeConfig.redirectUrls.checkoutSuccess,
        cancel_url:  stripeConfig.redirectUrls.checkoutCancel,
        metadata: {
          organizationId: orgId,
          plan:           input.plan,
          interval:       input.interval,
          userId:         user.id,
        },
      });

      logger.info({
        type:           'stripe_checkout_created',
        userId:         user.id,
        orgId,
        plan:           input.plan,
        interval:       input.interval,
        sessionId:      session.id,
        customerId,
      });

      // Release the dedup lock immediately - the user is being redirected to Stripe
      // so there is no risk of a second call succeeding before the redirect completes.
      await redis.del(checkoutLockKey);

      return { url: session.url };
    }),

  /**
   * Create a Stripe Customer Portal session.
   *
   * Lets the user manage their subscription (upgrade, downgrade, cancel, update
   * payment method) directly in Stripe's hosted portal.
   *
   * Requires an existing stripeCustomerId on the organization.
   *
   * Returns { url }  -  the frontend redirects the user to this URL.
   *
   * @protected  -  requires authentication + an organization with an active Stripe customer
   */
  createPortalSession: orgMemberProcedure
    .use(withPlanContext)
    .mutation(async ({ ctx }) => {
      const user = ctx.user!;

      const orgId = ctx.orgMembership!.organizationId;

      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { stripeCustomerId: true, plan: true },
      });

      if (!org?.stripeCustomerId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            org?.plan === SubscriptionPlan.REGULATOR
              ? 'Regulator accounts are on a free plan and do not have a Stripe subscription to manage.'
              : 'No active Stripe subscription found. Please start a subscription first.',
        });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer:   org.stripeCustomerId,
        return_url: stripeConfig.redirectUrls.portalReturn,
      });

      logger.info({
        type:       'stripe_portal_created',
        userId:     user.id,
        orgId,
        customerId: org.stripeCustomerId,
      });

      return { url: portalSession.url };
    }),

  /**
   * Submit an Enterprise plan inquiry.
   *
   * Sends a notification email to the SheriaBot admin inbox and returns success.
   * Rate-limited to 3 submissions per org per calendar day (UTC).
   *
   * @protected  -  requires authentication + an organization
   */
  requestEnterprise: orgMemberProcedure
    .use(withPlanContext)
    .input(
      z.object({
        name:    z.string().min(1).max(200),
        email:   z.string().email(),
        message: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user!;

      const orgId = ctx.orgMembership!.organizationId;

      // -- Rate limiting: max 3 per org per day -----------------------------
      const rateKey = enterpriseInquiryKey(orgId);
      const currentCount = await redis.get<number>(rateKey);
      const count = typeof currentCount === 'number' ? currentCount
        : typeof currentCount === 'string' ? Number(currentCount)
        : 0;

      if (count >= 3) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'You have submitted too many Enterprise inquiries today. Please try again tomorrow.',
        });
      }

      // B7.3 (TD-009) + F-enterprise (TD-008): Fix incr+expire race.
      // Use set with ex on first write to atomically apply TTL.
      const newCount = await redis.incr(rateKey);
      if (newCount === 1) {
        // First submission today - set TTL atomically (always overwrite is correct here)
        await redis.set(rateKey, String(newCount), { ex: 86400 });
      }

      // -- Fetch org details -------------------------------------------------
      const org = await prisma.organization.findUnique({
        where:  { id: orgId },
        select: { name: true, plan: true },
      });

      const adminEmail = appConfig.email.supportRecipient;
      const currentPlan = org?.plan
        ? org.plan.charAt(0) + org.plan.slice(1).toLowerCase()
        : 'Unknown';

      // -- Send inquiry email (non-blocking on the response) -----------------
      void reactMailer.sendEnterpriseInquiryEmail(adminEmail, {
        contactName:  input.name,
        contactEmail: input.email,
        orgName:      org?.name ?? 'Unknown Organization',
        currentPlan,
        message:      input.message,
        submittedAt:  new Date().toISOString(),
      });

      logger.info({
        type:   'enterprise_inquiry_submitted',
        userId: user.id,
        orgId,
        contactEmail: input.email,
      });

      return { success: true };
    }),

  // ==========================================================================
  // M-Pesa / IntaSend procedures
  // ==========================================================================

  /**
   * Update the preferred payment method (Card/Stripe or M-Pesa) for the org.
   *
   * When switching to M-Pesa, a phone number is required (now or previously stored).
   * Switching methods does NOT cancel an existing Stripe subscription  -  it only
   * affects the next payment initiated by the user.
   */
  updatePaymentMethod: orgMemberProcedure
    .input(
      z.object({
        provider:          z.nativeEnum(PaymentProvider),
        mpesaPhoneNumber:  z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user!;

      const orgId = ctx.orgMembership!.organizationId;

      let normalisedPhone: string | undefined;

      if (input.provider === PaymentProvider.MPESA) {
        const raw = input.mpesaPhoneNumber;
        const existing = await prisma.organization.findUnique({
          where:  { id: orgId },
          select: { mpesaPhoneNumber: true },
        });

        const phoneToNormalise = raw ?? existing?.mpesaPhoneNumber ?? null;

        if (!phoneToNormalise) {
          throw new TRPCError({
            code:    'BAD_REQUEST',
            message: 'M-Pesa phone number is required when selecting M-Pesa as payment method.',
          });
        }

        const normalised = normalisePhoneNumber(phoneToNormalise);
        if (!normalised) {
          throw new TRPCError({
            code:    'BAD_REQUEST',
            message: 'Invalid phone number. Use format: 07XX XXX XXX, 01XX XXX XXX, or 254XXXXXXXXX.',
          });
        }
        normalisedPhone = normalised;
      }

      const updated = await prisma.organization.update({
        where: { id: orgId },
        data: {
          preferredPaymentMethod: input.provider,
          ...(normalisedPhone ? { mpesaPhoneNumber: normalisedPhone } : {}),
        },
        select: {
          preferredPaymentMethod: true,
          mpesaPhoneNumber: true,
        },
      });

      // Invalidate plan context cache so next request picks up the updated payment method
      await redis.del(`sheriabot:planctx:${user.id}`);

      logger.info({
        type:     'payment_method_updated',
        userId:   user.id,
        orgId,
        provider: input.provider,
      });

      return {
        preferredPaymentMethod: updated.preferredPaymentMethod,
        mpesaPhoneNumber:       updated.mpesaPhoneNumber ?? null,
      };
    }),

  /**
   * Initiate an M-Pesa STK push for a subscription plan.
   *
   * Creates a PENDING Payment record first (idempotent via providerTransactionId),
   * then triggers the STK push via IntaSend. Returns the paymentId for polling.
   */
  initiateMpesaPayment: orgMemberProcedure
    .input(
      z.object({
        plan:             z.nativeEnum(SubscriptionPlan),
        phoneNumber:      z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user!;

      const orgId = ctx.orgMembership!.organizationId;

      if (input.plan === SubscriptionPlan.REGULATOR || input.plan === SubscriptionPlan.ENTERPRISE) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'M-Pesa payments are available for Startup and Business plans only.',
        });
      }

      // Resolve phone number: use provided value or fall back to stored org number
      const org = await prisma.organization.findUnique({
        where:  { id: orgId },
        select: { mpesaPhoneNumber: true, name: true },
      });

      const rawPhone = input.phoneNumber ?? org?.mpesaPhoneNumber ?? null;
      if (!rawPhone) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'No M-Pesa phone number on file. Please provide a phone number.',
        });
      }

      const phoneNumber = normalisePhoneNumber(rawPhone);
      if (!phoneNumber) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'Invalid phone number. Use format: 07XX XXX XXX, 01XX XXX XXX, or 254XXXXXXXXX.',
        });
      }

      // Persist normalised phone if a new number was provided
      if (input.phoneNumber) {
        await prisma.organization.update({
          where: { id: orgId },
          data:  { mpesaPhoneNumber: phoneNumber, preferredPaymentMethod: PaymentProvider.MPESA },
        });
      }

      const runtimePlan = await getRuntimePlan(input.plan);
      const amountKes = resolvePlanPriceForInterval(runtimePlan, 'monthly') ?? 0;

      if (amountKes <= 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The ${input.plan} monthly M-Pesa price is not configured.`,
        });
      }

      const amountCents = amountKes * 100; // DB stores smallest unit

      // Idempotency guard: return existing PENDING payment if created within last 15 minutes
      // for the same org + plan. Prevents duplicate STK prompts on network-drop retries.
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      const existingPending = await prisma.payment.findFirst({
        where: {
          orgId,
          status:           PaymentStatus.PENDING,
          provider:         PaymentProvider.MPESA,
          subscriptionPlan: input.plan as string,
          createdAt:        { gte: fifteenMinsAgo },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (existingPending) {
        logger.info({
          type:      'mpesa_payment_dedup_hit',
          userId:    user.id,
          orgId,
          paymentId: existingPending.id,
          plan:      input.plan,
        });
        return { paymentId: existingPending.id };
      }

      // Generate invoice number upfront (stored on payment record)
      const invoiceNumber = await paymentService.generateInvoiceNumber();

      // Create PENDING payment record before initiating STK push
      const payment = await paymentService.createPaymentRecord({
        orgId,
        provider:         PaymentProvider.MPESA,
        amount:           amountCents,
        currency:         'KES',
        status:           PaymentStatus.PENDING,
        description:      `${input.plan} plan  -  M-Pesa payment`,
        invoiceNumber,
        subscriptionPlan: input.plan,
        metadata:         { phone_number: phoneNumber, plan: input.plan },
      });

      // Trigger STK push
      let stkResponse: Awaited<ReturnType<typeof intaSendService.initiateSTKPush>>;
      try {
        stkResponse = await intaSendService.initiateSTKPush({
          phoneNumber,
          amount:           amountKes,
          accountReference: payment.id,
          narrative:        `SheriaBot ${input.plan} subscription`,
        });
      } catch (err: unknown) {
        // Mark the pre-created payment as failed so history is clean
        void paymentService.updatePaymentStatus(payment.id, PaymentStatus.FAILED, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'Failed to initiate M-Pesa payment.',
        });
      }

      // Store IntaSend's invoice ID on the payment record for polling / webhook matching
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerTransactionId: stkResponse.invoiceId,
          metadata: {
            ...(payment.metadata as Record<string, unknown> ?? {}),
            intasendInvoiceId: stkResponse.invoiceId,
          },
        },
      });

      logger.info({
        type:              'mpesa_payment_initiated',
        userId:            user.id,
        orgId,
        paymentId:         payment.id,
        intasendInvoiceId: stkResponse.invoiceId,
        plan:              input.plan,
        amountKes,
      });

      return {
        paymentId:  payment.id,
        trackingId: stkResponse.invoiceId,
        message:    'Check your phone for the M-Pesa prompt. Enter your PIN to complete payment.',
      };
    }),

  /**
   * Poll the status of a pending M-Pesa payment.
   *
   * Used by the frontend MpesaPaymentFlow component to check every 5 seconds
   * whether the webhook has confirmed the payment (or failed).
   */
  getMpesaPaymentStatus: orgMemberProcedure
    .input(z.object({ paymentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orgId = ctx.orgMembership!.organizationId;
      const payment = await paymentService.getPaymentById(input.paymentId, orgId);

      if (!payment) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment record not found.' });
      }

      if (payment.provider !== PaymentProvider.MPESA) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Payment is not an M-Pesa payment.' });
      }

      // If still PENDING and we have an IntaSend invoice ID, re-check status
      if (payment.status === PaymentStatus.PENDING && payment.providerTransactionId) {
        try {
          const liveStatus = await intaSendService.getPaymentStatus(payment.providerTransactionId);

          if (liveStatus.state === 'COMPLETE') {
            // Webhook may not have fired yet  -  optimistically reflect completed status
            // (webhook will do the full activation; we just return the current DB state)
            logger.info({
              type:      'mpesa_poll_status_complete_not_yet_webhoooked',
              paymentId: payment.id,
              invoiceId: payment.providerTransactionId,
            });
          }
        } catch {
          // Non-fatal  -  just return current DB status
        }
      }

      return {
        paymentId:  payment.id,
        status:     payment.status,
        updatedAt:  payment.updatedAt.toISOString(),
      };
    }),
});
