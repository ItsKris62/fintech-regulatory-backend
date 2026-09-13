/**
 * Shared Plan Configuration - Single Source of Truth
 *
 * Defines canonical 5-tier subscription plans (FREE, STARTER, GROWTH, BUSINESS, ENTERPRISE),
 * pricing, seat limits, max enabled jurisdictions, feature metadata, and Stripe configuration.
 *
 * Version: 2026-09-01 (Batch 1 Canonical Catalog)
 * Annual Discount: Strict 15% upfront discount (monthly * 12 * 0.85).
 * Prices belong to organizations.
 */

import { PLAN_ENTITLEMENTS, SubscriptionPlan } from './entitlements.config';
import { stripeConfig } from './stripe.config';
import type { MemberRole } from '@prisma/client';

export const CATALOG_VERSION = '2026-09-01' as const;

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
  seats: number;
  maxEnabledCountries: number;
  features: PlanFeatureRow[];
  entitlements: (typeof PLAN_ENTITLEMENTS)[SubscriptionPlan];
  stripe: PlanStripeConfig | null;
}

// -- Comparison table rows ---------------------------------------------------

export interface ComparisonRow {
  feature: string;
  free: string;
  starter: string;
  growth: string;
  business: string;
  enterprise: string;
}

// -- Feature Catalog Definition ----------------------------------------------

export type ImplementationStatus = 'COMPLETE' | 'PARTIAL' | 'CONFIGURED_ONLY' | 'ADVERTISED_ONLY';
export type CountryBehavior = 'HOME_ONLY' | 'MULTI_UP_TO_2' | 'MULTI_UP_TO_4' | 'NOT_APPLICABLE';
export type AllowanceResetSemantics = 'MONTHLY' | 'LIFETIME' | 'NONE';

export interface FeatureCatalogItem {
  id: string;
  displayName: string;
  description: string;
  eligiblePlans: SubscriptionPlan[];
  availability: ImplementationStatus;
  roleRequirements: MemberRole[];
  countryBehavior: CountryBehavior;
  allowanceResetSemantics: AllowanceResetSemantics;
  provisionalQuota?: {
    free?: number | string;
    starter?: number | string;
    growth?: number | string;
    business?: number | string;
    enterprise?: number | string;
  };
}

export const FEATURE_CATALOG: FeatureCatalogItem[] = [
  {
    id: 'compliance_queries',
    displayName: 'Cited Compliance Queries',
    description: 'Statutory compliance queries grounded in CBK, CMA, BNR, RBM, and CBN official sources.',
    eligiblePlans: [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.REGULATOR,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'MONTHLY',
    provisionalQuota: { free: 25, starter: 100, growth: 250, business: 600, enterprise: 1200 },
  },
  {
    id: 'knowledge_base',
    displayName: 'Regulatory Knowledge Base',
    description: 'Search and read authoritative statutory circulars, guidelines, and compliance acts.',
    eligiblePlans: [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.REGULATOR,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'NONE',
  },
  {
    id: 'regulatory_alerts',
    displayName: 'Regulatory Alerts & Horizon Scanning',
    description: 'Notifications and intelligence updates on statutory circular changes.',
    eligiblePlans: [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.REGULATOR,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'NONE',
  },
  {
    id: 'compliance_calendar',
    displayName: 'Compliance Calendar',
    description: 'Statutory filing deadline tracking and calendar event scheduling.',
    eligiblePlans: [
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'NONE',
  },
  {
    id: 'license_management',
    displayName: 'License & Application Tracker',
    description: 'Manage regulatory license applications, renewals, statutory fees, and evidence.',
    eligiblePlans: [
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'NONE',
  },
  {
    id: 'checklists',
    displayName: 'Compliance Checklists',
    description: 'AI-generated statutory compliance checklists with verifiable audit trails.',
    eligiblePlans: [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.REGULATOR,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'MONTHLY',
    provisionalQuota: { free: 1, starter: 5, growth: 15, business: 'Unlimited', enterprise: 'Unlimited' },
  },
  {
    id: 'gap_analysis_quick',
    displayName: 'Quick Gap Analysis',
    description: 'Fast statutory gap evaluation against core compliance requirements.',
    eligiblePlans: [
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'MONTHLY',
    provisionalQuota: { starter: 2, growth: 8, business: 25, enterprise: 60 },
  },
  {
    id: 'gap_analysis_standard',
    displayName: 'Standard Gap Analysis',
    description: 'In-depth multi-section compliance assessment across regulatory frameworks.',
    eligiblePlans: [
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'HOME_ONLY',
    allowanceResetSemantics: 'MONTHLY',
  },
  {
    id: 'gap_analysis_deep',
    displayName: 'Deep Multi-Framework Gap Analysis',
    description: 'Comprehensive cross-statute gap analysis with evidence link verification.',
    eligiblePlans: [
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'MULTI_UP_TO_2',
    allowanceResetSemantics: 'MONTHLY',
  },
  {
    id: 'multi_jurisdiction_rag',
    displayName: 'Multi-Jurisdiction Access & Comparison',
    description: 'Cross-border regulatory search and side-by-side jurisdiction comparison.',
    eligiblePlans: [
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'],
    countryBehavior: 'MULTI_UP_TO_2',
    allowanceResetSemantics: 'NONE',
  },
  {
    id: 'policy_generation',
    displayName: 'AI Policy Generation & Refinement',
    description: 'Generate institutional compliance policies grounded in statutory acts.',
    eligiblePlans: [
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['ADMIN', 'OWNER'],
    countryBehavior: 'MULTI_UP_TO_4',
    allowanceResetSemantics: 'MONTHLY',
    provisionalQuota: { enterprise: 5 },
  },
  {
    id: 'custom_frameworks',
    displayName: 'Custom Regulatory Frameworks',
    description: 'Ingest proprietary compliance frameworks and custom institutional standards.',
    eligiblePlans: [
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'CONFIGURED_ONLY',
    roleRequirements: ['ADMIN', 'OWNER'],
    countryBehavior: 'MULTI_UP_TO_4',
    allowanceResetSemantics: 'NONE',
  },
  {
    id: 'document_vault',
    displayName: 'Secure Document Vault',
    description: 'Encrypted document repository for organizational compliance evidence.',
    eligiblePlans: [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.GROWTH,
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
      SubscriptionPlan.STARTUP,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['ADMIN', 'OWNER'],
    countryBehavior: 'NOT_APPLICABLE',
    allowanceResetSemantics: 'NONE',
    provisionalQuota: { free: '100 MB', starter: '1 GB', growth: '3 GB', business: '10 GB', enterprise: '25 GB' },
  },
  {
    id: 'api_access',
    displayName: 'Programmatic API Access',
    description: 'REST and tRPC machine access for automated compliance verification.',
    eligiblePlans: [
      SubscriptionPlan.BUSINESS,
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'COMPLETE',
    roleRequirements: ['ADMIN', 'OWNER'],
    countryBehavior: 'NOT_APPLICABLE',
    allowanceResetSemantics: 'MONTHLY',
    provisionalQuota: { business: '10,000 calls', enterprise: 'Unlimited' },
  },
  {
    id: 'sso_saml',
    displayName: 'Enterprise Single Sign-On (SAML/SSO)',
    description: 'SAML 2.0 and Okta/Azure AD enterprise identity federation.',
    eligiblePlans: [
      SubscriptionPlan.ENTERPRISE,
    ],
    availability: 'ADVERTISED_ONLY',
    roleRequirements: ['ADMIN', 'OWNER'],
    countryBehavior: 'NOT_APPLICABLE',
    allowanceResetSemantics: 'NONE',
  },
];

// -- Plans config ------------------------------------------------------------

export const PLANS: Record<SubscriptionPlan, PlanConfig> = {
  FREE: {
    id: SubscriptionPlan.FREE,
    name: 'Free',
    tagline: 'Bounded evaluation access within your home country',
    price: { monthly: 0, yearly: 0, currency: 'KES' },
    badge: 'Free',
    cta: { type: 'none' },
    popular: false,
    trialDays: 0,
    seats: 1,
    maxEnabledCountries: 1,
    features: [
      { text: '1 user seat', included: true },
      { text: 'Single home compliance country', included: true },
      { text: '25 cited compliance queries/month', included: true },
      { text: 'Read-only regulatory knowledge base', included: true },
      { text: '1 compliance checklist/month', included: true },
      { text: '100 MB document vault', included: true },
      { text: 'Gap analysis tool', included: false },
      { text: 'API access', included: false },
    ],
    entitlements: PLAN_ENTITLEMENTS.FREE,
    stripe: null,
  },

  STARTER: {
    id: SubscriptionPlan.STARTER,
    name: 'Starter',
    tagline: 'For growing fintechs navigating single-country compliance',
    price: { monthly: 7500, yearly: 76500, currency: 'KES' },
    badge: null,
    cta: { type: 'subscribe', label: 'Choose Starter' },
    popular: false,
    trialDays: 14,
    seats: 1,
    maxEnabledCountries: 1,
    features: [
      { text: '1 user seat', included: true },
      { text: 'Single home compliance country', included: true },
      { text: '100 cited queries/month', included: true },
      { text: 'Quick gap analysis (2/month)', included: true },
      { text: '5 checklist generations/month', included: true },
      { text: 'Compliance calendar & license tracking', included: true },
      { text: '1 GB document storage', included: true },
      { text: 'Email support (48hr response)', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.STARTER,
    stripe: {
      monthlyPriceId: stripeConfig.prices.STARTUP?.monthly ?? 'price_starter_monthly',
      yearlyPriceId: null,
    },
  },

  GROWTH: {
    id: SubscriptionPlan.GROWTH,
    name: 'Growth',
    tagline: 'Collaborative compliance intelligence for scaling teams',
    price: { monthly: 15000, yearly: 153000, currency: 'KES' },
    badge: null,
    cta: { type: 'subscribe', label: 'Choose Growth' },
    popular: false,
    trialDays: 14,
    seats: 2,
    maxEnabledCountries: 1,
    features: [
      { text: '2 team collaboration seats', included: true },
      { text: 'Single home compliance country', included: true },
      { text: '250 cited queries/month', included: true },
      { text: 'Quick & Standard gap analysis (8/month)', included: true },
      { text: '15 checklist generations/month', included: true },
      { text: 'Daily regulatory alerts & AI summary', included: true },
      { text: '3 GB document storage', included: true },
      { text: 'Priority support (24hr response)', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.GROWTH,
    stripe: null,
  },

  BUSINESS: {
    id: SubscriptionPlan.BUSINESS,
    name: 'Business',
    tagline: 'For cross-border fintechs operating in multiple African jurisdictions',
    price: { monthly: 35000, yearly: 357000, currency: 'KES' },
    badge: 'Most Popular',
    cta: { type: 'subscribe', label: 'Start Business Trial' },
    popular: true,
    trialDays: 14,
    seats: 6,
    maxEnabledCountries: 2,
    features: [
      { text: '6 pooled team seats', included: true },
      { text: '2 enabled jurisdictions with comparison', included: true },
      { text: '600 cited queries/month', included: true },
      { text: 'All analysis depths (25/month)', included: true },
      { text: 'Unlimited checklist generations', included: true },
      { text: 'API access (10,000 calls/month)', included: true },
      { text: '10 GB document repository', included: true },
      { text: 'Organization audit history & RBAC', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.BUSINESS,
    stripe: {
      monthlyPriceId: stripeConfig.prices.BUSINESS?.monthly ?? 'price_biz_monthly',
      yearlyPriceId: null,
    },
  },

  ENTERPRISE: {
    id: SubscriptionPlan.ENTERPRISE,
    name: 'Enterprise',
    tagline: 'For pan-African institutions, banks, and enterprise regulatory teams',
    price: { monthly: 75000, yearly: 765000, currency: 'KES' },
    badge: null,
    cta: { type: 'contact-sales', label: 'Contact Sales' },
    popular: false,
    trialDays: 0,
    seats: 12,
    maxEnabledCountries: 4,
    features: [
      { text: '12 team seats (expandable)', included: true },
      { text: 'Up to 4 enabled jurisdictions (KE, RW, MW, NG)', included: true },
      { text: '1,200 cited queries/month', included: true },
      { text: 'AI Policy Generator & Refinement (5 credits/mo)', included: true },
      { text: 'Custom regulatory frameworks & contract overrides', included: true },
      { text: 'Unlimited API access & integrations', included: true },
      { text: '25 GB document storage', included: true },
      { text: 'Dedicated account manager & 99.9% SLA', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.ENTERPRISE,
    stripe: null,
  },

  // Legacy / Compatibility entries
  REGULATOR: {
    id: SubscriptionPlan.REGULATOR,
    name: 'Regulator (Legacy)',
    tagline: 'For government regulatory bodies',
    price: { monthly: 0, yearly: 0, currency: 'KES' },
    badge: 'Free',
    cta: { type: 'none' },
    popular: false,
    trialDays: 0,
    seats: 1,
    maxEnabledCountries: 1,
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
    name: 'Startup (Legacy)',
    tagline: 'Legacy tier mapped to Starter',
    price: { monthly: 4999, yearly: 50390, currency: 'KES' },
    badge: null,
    cta: { type: 'subscribe', label: 'Choose Starter' },
    popular: false,
    trialDays: 14,
    seats: 1,
    maxEnabledCountries: 1,
    features: [
      { text: '100 compliance queries/month', included: true },
      { text: '5 checklist generations/month', included: true },
      { text: 'Regulatory alerts & notifications', included: true },
      { text: '1 GB document storage', included: true },
    ],
    entitlements: PLAN_ENTITLEMENTS.STARTUP,
    stripe: {
      monthlyPriceId: stripeConfig.prices.STARTUP?.monthly ?? 'price_startup_monthly',
      yearlyPriceId: null,
    },
  },
};

// -- Comparison table (matches pricing page and billing page) ----------------

export const PLAN_COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: 'Team Seats',
    free: '1',
    starter: '1',
    growth: '2',
    business: '6 total',
    enterprise: '12 (customisable)',
  },
  {
    feature: 'Jurisdiction Coverage',
    free: 'Home country only',
    starter: 'Home country only',
    growth: 'Home country only',
    business: '2 enabled countries',
    enterprise: 'Up to 4 countries',
  },
  {
    feature: 'Compliance Queries',
    free: '25/month',
    starter: '100/month',
    growth: '250/month',
    business: '600/month',
    enterprise: '1,200/month',
  },
  {
    feature: 'Gap Analysis',
    free: '-',
    starter: 'Quick (2/mo)',
    growth: 'Quick & Std (8/mo)',
    business: 'All depths (25/mo)',
    enterprise: 'All depths (60/mo)',
  },
  {
    feature: 'Checklist Generations',
    free: '1/month',
    starter: '5/month',
    growth: '15/month',
    business: 'Unlimited',
    enterprise: 'Unlimited',
  },
  {
    feature: 'AI Policy Generator',
    free: '-',
    starter: '-',
    growth: '-',
    business: '-',
    enterprise: '5 credits/month',
  },
  {
    feature: 'Document Storage',
    free: '100 MB',
    starter: '1 GB',
    growth: '3 GB',
    business: '10 GB',
    enterprise: '25 GB',
  },
  {
    feature: 'API Access',
    free: '-',
    starter: '-',
    growth: '-',
    business: '10K calls/mo',
    enterprise: 'Unlimited',
  },
  {
    feature: 'Support Tier',
    free: 'Community',
    starter: 'Email (48hr)',
    growth: 'Priority (24hr)',
    business: 'Priority (24hr)',
    enterprise: 'Dedicated Manager',
  },
];

// -- Ordered plan IDs (least to most permissive) -----------------------------

export const PLAN_ORDER: SubscriptionPlan[] = [
  SubscriptionPlan.FREE,
  SubscriptionPlan.STARTER,
  SubscriptionPlan.GROWTH,
  SubscriptionPlan.BUSINESS,
  SubscriptionPlan.ENTERPRISE,
];

export { SubscriptionPlan };
export type PlanId = SubscriptionPlan;
