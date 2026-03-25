import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { router, protectedProcedure } from '../trpc/trpc';
import { withPlanContext } from '../trpc/middleware';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { stripe } from '@/lib/stripe/client';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { stripeConfig, PRICE_TO_PLAN } from '@/config/stripe.config';
import { appConfig } from '@/config/app.config';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { logger } from '@/utils/logger';
import { getTrialStatus } from '@/modules/trial';

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

// Suppress unused-var warning — PRICE_TO_PLAN is the canonical reverse-lookup map
// used by stripeWebhookService (Task 4). Re-exported here for tree-shaking convenience.
export { PRICE_TO_PLAN };

// ============================================================================
// Router
// ============================================================================

/**
 * Billing Router
 *
 * Routes:
 *  - billing.getPlanAndUsage        — current plan, entitlements, usage, subscription status
 *  - billing.createCheckoutSession  — Stripe Checkout for STARTUP / BUSINESS plans
 *  - billing.createPortalSession    — Stripe Customer Portal (manage / cancel subscription)
 */
export const billingRouter = router({
  /**
   * Get the authenticated user's current plan, entitlements, and usage.
   *
   * Called once on dashboard mount (stale 5 min). The frontend caches this
   * and exposes it via `usePlan()` to drive all feature-gate UI.
   *
   * @protected — requires isAuthenticated + withPlanContext
   */
  getPlanAndUsage: protectedProcedure
    .use(withPlanContext)
    .query(async ({ ctx }) => {
      try {
        const plan = ctx.plan!;
        const orgId = ctx.user.organizationId;
        const scopeId = orgId ?? ctx.user.id;
        const entitlements = PLAN_ENTITLEMENTS[plan];

        // ── Usage counts (Redis, parallel reads) ──────────────────────────
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

        // ── Trial status (user-scoped, fetched for FREE_TRIAL and REGULATOR so
        //    the frontend knows whether the user is eligible or has already used
        //    their trial — prevents showing the activation banner to expired users)
        const trialStatus =
          plan === 'FREE_TRIAL' || plan === 'REGULATOR'
            ? await getTrialStatus(ctx.user.id)
            : null;

        // ── Billing + subscription metadata (org row) ──────────────────────
        const org = orgId
          ? await prisma.organization.findUnique({
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
              },
            })
          : null;

        logger.info({
          type: 'billing_plan_usage_fetched',
          userId: ctx.user.id,
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
          },
          trial: trialStatus,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';

        logger.error({
          type: 'billing_plan_usage_error',
          userId: ctx.user.id,
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

  /**
   * Create a Stripe Checkout Session for upgrading to STARTUP or BUSINESS.
   *
   * - Creates or reuses the org's Stripe Customer record.
   * - Starts a 14-day free trial (Stripe enforces this — no charges until trial ends).
   * - Enterprise is sales-led only; REGULATOR is free — neither goes through Stripe.
   *
   * Returns { url } — the frontend redirects the user to this URL.
   *
   * @protected — requires authentication + an organization
   */
  createCheckoutSession: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        plan: z.enum(['STARTUP', 'BUSINESS']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user } = ctx;

      if (!user.organizationId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You must belong to an organization to start a subscription.',
        });
      }

      const orgId = user.organizationId;

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

      // REGULATOR and ENTERPRISE are not self-serve via Stripe
      if (org.plan === SubscriptionPlan.ENTERPRISE) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Enterprise plans are managed by the SheriaBot sales team. Please contact us.',
        });
      }

      // Resolve price ID for requested plan
      const priceId = stripeConfig.prices[input.plan].monthly;

      // ── Find or create Stripe Customer ─────────────────────────────────
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

      // ── Create Checkout Session ────────────────────────────────────────
      const session = await stripe.checkout.sessions.create({
        customer:   customerId,
        mode:       'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: stripeConfig.subscription.trialPeriodDays,
          metadata: {
            organizationId: orgId,
            plan:           input.plan,
          },
        },
        success_url: stripeConfig.redirectUrls.checkoutSuccess,
        cancel_url:  stripeConfig.redirectUrls.checkoutCancel,
        metadata: {
          organizationId: orgId,
          plan:           input.plan,
          userId:         user.id,
        },
      });

      logger.info({
        type:           'stripe_checkout_created',
        userId:         user.id,
        orgId,
        plan:           input.plan,
        sessionId:      session.id,
        customerId,
      });

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
   * Returns { url } — the frontend redirects the user to this URL.
   *
   * @protected — requires authentication + an organization with an active Stripe customer
   */
  createPortalSession: protectedProcedure
    .use(withPlanContext)
    .mutation(async ({ ctx }) => {
      const { user } = ctx;

      if (!user.organizationId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You must belong to an organization to manage your subscription.',
        });
      }

      const orgId = user.organizationId;

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
   * @protected — requires authentication + an organization
   */
  requestEnterprise: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        name:    z.string().min(1).max(200),
        email:   z.string().email(),
        message: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user } = ctx;

      if (!user.organizationId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You must belong to an organization to submit an Enterprise inquiry.',
        });
      }

      const orgId = user.organizationId;

      // ── Rate limiting: max 3 per org per day ─────────────────────────────
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

      const newCount = await redis.incr(rateKey);
      if (newCount === 1) {
        // First submission today — set TTL to end of day (86400s max)
        await redis.expire(rateKey, 86400);
      }

      // ── Fetch org details ─────────────────────────────────────────────────
      const org = await prisma.organization.findUnique({
        where:  { id: orgId },
        select: { name: true, plan: true },
      });

      const adminEmail = appConfig.email.supportRecipient;
      const currentPlan = org?.plan
        ? org.plan.charAt(0) + org.plan.slice(1).toLowerCase()
        : 'Unknown';

      // ── Send inquiry email (non-blocking on the response) ─────────────────
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
});
