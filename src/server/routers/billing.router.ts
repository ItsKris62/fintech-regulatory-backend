import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { BillingMetric, MemberRole, PaymentProvider, PaymentStatus, SubscriptionPlan } from '@prisma/client';
import { router, protectedProcedure, orgMemberProcedure, orgMemberProcedureWithRole } from '../trpc/trpc';
import { withPlanContext } from '../trpc/middleware';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { getStripeClient } from '@/lib/stripe/client';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { stripeConfig } from '@/config/stripe.config';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { logger } from '@/utils/logger';
import { getTrialStatus } from '@/modules/trial';
import { intaSendService, normalisePhoneNumber } from '@/modules/intasend';
import { paymentService } from '@/modules/billing/payment.service';
import {
  intaSendFinalizationService,
  invalidateOrganizationPlanCaches,
} from '@/modules/billing/intasend-finalization.service';
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

const billingAdminProcedure = orgMemberProcedureWithRole([MemberRole.ADMIN, MemberRole.OWNER]);
const PAYMENT_PURPOSE_INITIAL = 'INITIAL_PURCHASE';
const PAYMENT_PURPOSE_RENEWAL = 'RENEWAL';

function latestDate(...dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((date): date is Date => date instanceof Date);
  if (valid.length === 0) return null;
  return valid.reduce((latest, date) => date > latest ? date : latest, valid[0]);
}

function assertStripeEnabled(): void {
  if (!appConfig.payments.stripeEnabled || appConfig.payments.activeProvider !== 'STRIPE') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Stripe billing is currently disabled. Use M-Pesa via IntaSend.',
    });
  }
}

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
          (async () => {
            try {
              const agg = await ctx.prisma.vaultDocument.aggregate({
                where: { organizationId: scopeId, isArchived: false, deletedAt: null },
                _sum: { fileSize: true },
              });
              const bytes = agg._sum.fileSize ?? 0;
              return Math.round((bytes / (1024 * 1024)) * 100) / 100;
            } catch {
              return readUsageCount(scopeId, BillingMetric.DOCUMENT_STORAGE_MB);
            }
          })(),
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
                  mpesaPhoneNumber: true,
                  homeJurisdictionCode: true,
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
            mpesaPhoneNumber:        org?.mpesaPhoneNumber ?? null,
            homeJurisdictionCode:    org?.homeJurisdictionCode ?? null,
            catalogPrice,
            activePaymentProvider: appConfig.payments.activeProvider,
            stripeEnabled: appConfig.payments.stripeEnabled,
          },
          trial: trialStatus,
          effectivePlanSource: ctx.effectivePlanSource ?? 'FALLBACK',
          appliedOverrides: ctx.appliedPlanOverrides ?? [],
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
  createCheckoutSession: billingAdminProcedure
    .use(withPlanContext)
    .input(
      z.object({
        plan: z.enum(['STARTUP', 'BUSINESS']),
        interval: z.enum(['monthly', 'yearly']).default('monthly'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertStripeEnabled();
      const stripe = getStripeClient();
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
  createPortalSession: billingAdminProcedure
    .use(withPlanContext)
    .mutation(async ({ ctx }) => {
      assertStripeEnabled();
      const stripe = getStripeClient();
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
  updatePaymentMethod: billingAdminProcedure
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

      if (input.provider === PaymentProvider.STRIPE && !appConfig.payments.stripeEnabled) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Stripe billing is currently disabled. Use M-Pesa via IntaSend.',
        });
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

      await invalidateOrganizationPlanCaches(orgId);

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
  initiateMpesaPayment: billingAdminProcedure
    .input(
      z.object({
        plan:             z.nativeEnum(SubscriptionPlan),
        phoneNumber:      z.string().optional(),
        paymentPurpose:   z.enum([PAYMENT_PURPOSE_INITIAL, PAYMENT_PURPOSE_RENEWAL]).optional().default(PAYMENT_PURPOSE_INITIAL),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user!;

      const orgId = ctx.orgMembership!.organizationId;

      if (appConfig.payments.activeProvider !== 'INTASEND') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'M-Pesa via IntaSend is not the active payment provider.',
        });
      }

      if (input.plan === SubscriptionPlan.REGULATOR || input.plan === SubscriptionPlan.ENTERPRISE) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'M-Pesa payments are available for Startup and Business plans only.',
        });
      }

      // Resolve phone number: use provided value or fall back to stored org number
      const org = await prisma.organization.findUnique({
        where:  { id: orgId },
        select: {
          mpesaPhoneNumber: true,
          name: true,
          plan: true,
          planEndDate: true,
          subscriptionCycleEnd: true,
          mpesaNextPaymentDueDate: true,
        },
      });

      const paymentPurpose = input.paymentPurpose;
      const planToCharge = paymentPurpose === PAYMENT_PURPOSE_RENEWAL
        ? org?.plan
        : input.plan;

      if (!planToCharge || planToCharge === SubscriptionPlan.REGULATOR || planToCharge === SubscriptionPlan.ENTERPRISE) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Renewals are available only for current Startup or Business subscriptions.',
        });
      }

      if (paymentPurpose === PAYMENT_PURPOSE_RENEWAL && input.plan !== planToCharge) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Renewal payments must target the organization current paid plan.',
        });
      }

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

      await prisma.organization.update({
        where: { id: orgId },
        data:  { mpesaPhoneNumber: phoneNumber, preferredPaymentMethod: PaymentProvider.MPESA },
      });

      const runtimePlan = await getRuntimePlan(planToCharge);
      const amountKes = resolvePlanPriceForInterval(runtimePlan, 'monthly') ?? 0;

      if (amountKes <= 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The ${planToCharge} monthly M-Pesa price is not configured.`,
        });
      }

      const amountCents = Math.round(amountKes * 100); // DB stores smallest unit
      const now = new Date();
      const paidThrough = latestDate(org?.subscriptionCycleEnd, org?.mpesaNextPaymentDueDate, org?.planEndDate);
      const billingPeriodStart = paymentPurpose === PAYMENT_PURPOSE_RENEWAL
        ? (paidThrough && paidThrough > now ? paidThrough : now)
        : null;
      const billingPeriodEnd = billingPeriodStart
        ? new Date(billingPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000)
        : null;

      // Idempotency guard: return existing PENDING payment if created within last 15 minutes
      // for the same org + plan. Prevents duplicate STK prompts on network-drop retries.
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      const existingPending = await prisma.payment.findFirst({
        where: {
          orgId,
          status:           PaymentStatus.PENDING,
          provider:         PaymentProvider.MPESA,
          subscriptionPlan: planToCharge as string,
          paymentPurpose,
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
          plan:      planToCharge,
          paymentPurpose,
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
        paymentPurpose,
        description:      `${planToCharge} plan ${paymentPurpose === PAYMENT_PURPOSE_RENEWAL ? 'renewal' : 'subscription'} - M-Pesa payment`,
        invoiceNumber,
        subscriptionPlan: planToCharge,
        billingPeriodStart: billingPeriodStart ?? undefined,
        billingPeriodEnd: billingPeriodEnd ?? undefined,
        metadata: {
          phone_number: phoneNumber,
          plan: planToCharge,
          amountMinor: amountCents,
          amountKes,
          currency: 'KES',
          billingPeriod: 'monthly',
          paymentKind: paymentPurpose === PAYMENT_PURPOSE_RENEWAL ? 'renewal' : 'initial_purchase',
          paymentPurpose,
          renewalPaidThrough: paidThrough?.toISOString() ?? null,
          renewalPeriodStart: billingPeriodStart?.toISOString() ?? null,
          renewalPeriodEnd: billingPeriodEnd?.toISOString() ?? null,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'payment_initiated',
          entityType: 'Payment',
          entityId: payment.id,
          metadata: {
            orgId,
            provider: PaymentProvider.MPESA,
            plan: planToCharge,
            amountMinor: amountCents,
            currency: 'KES',
            paymentPurpose,
          },
        },
      }).catch((err: unknown) => {
        logger.error({
          type: 'payment_initiated_audit_failed',
          paymentId: payment.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Trigger STK push
      let stkResponse: Awaited<ReturnType<typeof intaSendService.initiateSTKPush>>;
      try {
        stkResponse = await intaSendService.initiateSTKPush({
          phoneNumber,
          amount:           amountKes,
          accountReference: payment.id,
          narrative:        `SheriaBot ${planToCharge} ${paymentPurpose === PAYMENT_PURPOSE_RENEWAL ? 'renewal' : 'subscription'}`,
        });
      } catch (err: unknown) {
        const failedAt = new Date();
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              metadata: {
                ...(payment.metadata as Record<string, unknown> ?? {}),
                error: err instanceof Error ? err.message : String(err),
                failedAt: failedAt.toISOString(),
                failedBy: 'initiation',
              },
            },
          });

          if (paymentPurpose === PAYMENT_PURPOSE_RENEWAL) {
            await tx.organization.update({
              where: { id: orgId },
              data: {
                mpesaFailedRenewalAttempts: { increment: 1 },
                mpesaLastRenewalAttemptAt: failedAt,
                mpesaNextRenewalRetryAt: new Date(failedAt.getTime() + 24 * 60 * 60 * 1000),
              },
            });
          }
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
            intasendInitialState: stkResponse.state,
          },
        },
      });

      logger.info({
        type:              'mpesa_payment_initiated',
        userId:            user.id,
        orgId,
        paymentId:         payment.id,
        intasendInvoiceId: stkResponse.invoiceId,
        plan:              planToCharge,
        amountKes,
        paymentPurpose,
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
            await intaSendFinalizationService.finalizePayment({
              paymentId: payment.id,
              invoiceId: payment.providerTransactionId,
              verifiedStatus: liveStatus,
              source: 'polling',
              actorUserId: ctx.user!.id,
            });
          } else if (liveStatus.state === 'FAILED') {
            await intaSendFinalizationService.markFailed({
              invoiceId: payment.providerTransactionId,
              source: 'polling',
            });
          }
        } catch (err: unknown) {
          logger.error({
            type: 'mpesa_poll_status_repair_failed',
            paymentId: payment.id,
            invoiceId: payment.providerTransactionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const latestPayment = await paymentService.getPaymentById(input.paymentId, orgId);

      return {
        paymentId: latestPayment?.id ?? payment.id,
        status:    latestPayment?.status ?? payment.status,
        updatedAt: (latestPayment?.updatedAt ?? payment.updatedAt).toISOString(),
      };
    }),
});
