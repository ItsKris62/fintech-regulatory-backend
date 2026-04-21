import { appConfig } from './app.config';

/**
 * Stripe configuration for SheriaBot subscription billing.
 *
 * Price IDs are stored here (not in env vars) because they are
 * part of the application's business logic, not deployment secrets.
 * Production vs. test mode is determined by whether STRIPE_SECRET_KEY
 * starts with "sk_live_" or "sk_test_".
 *
 * Enterprise plan has no Stripe price  -  it is sales-led only.
 * REGULATOR plan is free  -  no Stripe involvement.
 */

// -- Plan -> Price ID mapping ------------------------------------------------
const PLAN_PRICES = {
  STARTUP: {
    monthly: process.env.STRIPE_PRICE_STARTUP_MONTHLY ?? 'price_startup_monthly',
  },
  BUSINESS: {
    monthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? 'price_business_monthly',
  },
} as const;

// -- Reverse lookup: Stripe Price ID -> SubscriptionPlan ---------------------
export const PRICE_TO_PLAN: Record<string, 'STARTUP' | 'BUSINESS'> = {
  [PLAN_PRICES.STARTUP.monthly]: 'STARTUP',
  [PLAN_PRICES.BUSINESS.monthly]: 'BUSINESS',
};

// -- Main config object -----------------------------------------------------
export const stripeConfig = {
  /** Stripe SDK is initialised from this secret key */
  secretKey: appConfig.stripe.secretKey,

  /** Published key (sent to frontend for Stripe.js / Elements) */
  publishableKey: appConfig.stripe.publishableKey,

  /** Webhook signing secret  -  used to verify event payloads */
  webhookSecret: appConfig.stripe.webhookSecret,

  /** Per-plan Stripe Price IDs */
  prices: PLAN_PRICES,

  /** Subscription lifecycle settings */
  subscription: {
    /** Free trial length in days */
    trialPeriodDays: 14,

    /** Grace period after cancellation (full access retained) in days */
    gracePeriodDays: 7,
  },

  /** URLs Stripe redirects to after Checkout / Portal flows */
  redirectUrls: {
    /** Where to send the user after a successful Checkout Session */
    checkoutSuccess: `${appConfig.frontendUrl}/settings/billing?checkout=success`,

    /** Where to send the user if they cancel the Checkout flow */
    checkoutCancel: `${appConfig.frontendUrl}/settings/billing?checkout=cancel`,

    /** Return URL from the Customer Portal */
    portalReturn: `${appConfig.frontendUrl}/settings/billing`,
  },
} as const;

export type StripeConfig = typeof stripeConfig;
