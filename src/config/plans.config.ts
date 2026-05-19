/**
 * Shared Plan Configuration  -  Single Source of Truth
 *
 * This file defines EVERYTHING about subscription plans: display metadata,
 * feature entitlements, pricing, and Stripe configuration. Both the billing
 * settings page (via tRPC) and any internal logic should derive from this.
 *
 * Convention: -1 = unlimited, 0 = disabled/unavailable, null = not applicable.
 */

import { PLAN_ENTITLEMENTS, SubscriptionPlan } from './entitlements.config';
import { stripeConfig } from './stripe.config';

// -- Plan display feature rows (subset shown on plan cards) ------------------

export interface PlanFeatureRow {
  text: string;
  included: boolean;
}

// -- Plan CTA shape ----------------------------------------------------------

export type PlanCta =
  | { type: 'none' }
  | { type: 'subscribe'; label: string }
  | { type: 'contact-sales'; label: string };

// -- Stripe sub-config per plan ----------------------------------------------

export interface PlanStripeConfig {
  monthlyPriceId: string;
  yearlyPriceId: string | null;
}

// -- Full plan shape ---------------------------------------------------------

export interface PlanConfig {
  id: SubscriptionPlan;
  name: string;
  tagline: string;
  price: {
    monthly: number | null;
    yearly: number | null;
    currency: 'KES';
  };
  badge: 'Free' | 'Most Popular' | null;
  cta: PlanCta;
  popular: boolean;
  trialDays: number;
  features: PlanFeatureRow[];
  entitlements: typeof PLAN_ENTITLEMENTS[SubscriptionPlan];
  stripe: PlanStripeConfig | null;
}

// -- Comparison table rows ---------------------------------------------------

export interface ComparisonRow {
  feature: string;
  regulator: string;
  startup: string;
  business: string;
  enterprise: string;
}

// -- Plans config ------------------------------------------------------------

export const PLANS: Record<SubscriptionPlan, PlanConfig> = {
  REGULATOR: {
    id: SubscriptionPlan.REGULATOR,
    name: 'Regulator',
    tagline: 'For government regulatory bodies',
    price: { monthly: 0, yearly: 0, currency: 'KES' },
    badge: 'Free',
    cta: { type: 'none' },
    popular: false,
    trialDays: 0,
    features: [
      { text: '50 compliance queries/month', included: true },
      { text: 'Read-only regulatory knowledge base', included: true },
      { text: 'Regulatory dashboard', included: true },
      { text: 'Checklist generations', included: false },
      { text: 'Gap analysis tool', included: false },
      { text: 'API access', included: false },
    ],
    entitlements: PLAN_ENTITLEMENTS.REGULATOR,
    stripe: null,
  },

  STARTUP: {
    id: SubscriptionPlan.STARTUP,
    name: 'Startup',
    tagline: 'Perfect for growing fintech startups navigating compliance',
    price: { monthly: 4999, yearly: 50390, currency: 'KES' },
    badge: null,
    cta: { type: 'subscribe', label: 'Start Free Trial' },
    popular: false,
    trialDays: 14,
    features: [
      { text: 'Unlimited compliance queries', included: true },
      { text: '5 checklist generations/month', included: true },
      { text: 'Regulatory alerts & notifications', included: true },
      { text: 'Basic analytics dashboard', included: true },
      { text: 'Email support (48hr response)', included: true },
      { text: '1 GB document storage', included: true },
      { text: 'Gap analysis tool', included: false },
      { text: 'API access', included: false },
    ],
    entitlements: PLAN_ENTITLEMENTS.STARTUP,
    stripe: {
      monthlyPriceId: stripeConfig.prices.STARTUP.monthly,
      yearlyPriceId: null,
    },
  },

  BUSINESS: {
    id: SubscriptionPlan.BUSINESS,
    name: 'Business',
    tagline: 'For established fintech companies with complex compliance needs',
    price: { monthly: 44999, yearly: 453590, currency: 'KES' },
    badge: 'Most Popular',
    cta: { type: 'subscribe', label: 'Start Free Trial' },
    popular: true,
    trialDays: 14,
    features: [
      { text: 'Everything in Startup', included: true },
      { text: 'Unlimited checklist generations', included: true },
      { text: 'Gap analysis tool', included: true },
      { text: 'API access (10,000 calls/month)', included: true },
      { text: 'Advanced analytics & reporting', included: true },
      { text: 'Priority support (24hr response)', included: true },
      { text: 'Team collaboration (5 seats)', included: true },
      { text: 'Document repository (10 GB)', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.BUSINESS,
    stripe: {
      monthlyPriceId: stripeConfig.prices.BUSINESS.monthly,
      yearlyPriceId: null,
    },
  },

  ENTERPRISE: {
    id: SubscriptionPlan.ENTERPRISE,
    name: 'Enterprise',
    tagline: 'For regulators, banks, and large institutions',
    price: { monthly: null, yearly: null, currency: 'KES' },
    badge: null,
    cta: { type: 'contact-sales', label: 'Contact Sales' },
    popular: false,
    trialDays: 0,
    features: [
      { text: 'Everything in Business', included: true },
      { text: 'AI Policy Generator', included: true },
      { text: 'Legal corpus management', included: true },
      { text: 'Unlimited API access', included: true },
      { text: 'Custom integrations & SSO', included: true },
      { text: 'Dedicated account manager', included: true },
      { text: 'On-premise deployment option', included: true },
      { text: '99.9% uptime SLA guarantee', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.ENTERPRISE,
    stripe: null,
  },
};

// -- Comparison table (matches pricing page and billing page) ----------------

export const PLAN_COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: 'Compliance Queries',
    regulator: '50/month',
    startup: 'Unlimited',
    business: 'Unlimited',
    enterprise: 'Unlimited',
  },
  {
    feature: 'Checklist Generations',
    regulator: '-',
    startup: '5/month',
    business: 'Unlimited',
    enterprise: 'Unlimited',
  },
  {
    feature: 'Gap Analysis',
    regulator: '-',
    startup: '-',
    business: 'Yes',
    enterprise: 'Yes',
  },
  {
    feature: 'API Access',
    regulator: '-',
    startup: '-',
    business: '10K calls/mo',
    enterprise: 'Unlimited',
  },
  {
    feature: 'Team Seats',
    regulator: '1',
    startup: '1',
    business: '5',
    enterprise: 'Unlimited',
  },
  {
    feature: 'Document Storage',
    regulator: '-',
    startup: '1 GB',
    business: '10 GB',
    enterprise: 'Unlimited',
  },
  {
    feature: 'Support Response',
    regulator: 'Community',
    startup: '48 hours',
    business: '24 hours',
    enterprise: '4 hours',
  },
  {
    feature: 'Policy Generator',
    regulator: '-',
    startup: '-',
    business: '-',
    enterprise: 'Yes',
  },
  {
    feature: 'Legal Corpus Management',
    regulator: '-',
    startup: '-',
    business: '-',
    enterprise: 'Yes',
  },
  {
    feature: 'SSO & Custom Integrations',
    regulator: '-',
    startup: '-',
    business: '-',
    enterprise: 'Yes',
  },
];

// -- Ordered plan IDs (least to most permissive) -----------------------------

export const PLAN_ORDER: SubscriptionPlan[] = [
  SubscriptionPlan.REGULATOR,
  SubscriptionPlan.STARTUP,
  SubscriptionPlan.BUSINESS,
  SubscriptionPlan.ENTERPRISE,
];

// -- Re-export for convenience ------------------------------------------------

export type PlanId = SubscriptionPlan;
