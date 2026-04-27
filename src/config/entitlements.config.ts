import { SubscriptionPlan } from '@prisma/client';
import type { EffectivePlan } from '@/types/plan.types';

// ============================================================================
// Value shape types
// ============================================================================

export type SupportTier = 'community' | 'email-48hr' | 'priority-24hr' | 'dedicated';
export type AnalyticsTier = 'none' | 'basic' | 'advanced';
export type KnowledgeBaseAccess = 'read-only' | 'full';

export interface QuotaEntitlement {
  /** -1 = unlimited, 0 = not available, n = cap for the given period */
  limit: number;
  /** 'month' = reset on billing cycle; 'lifetime' = never resets */
  period: 'month' | 'lifetime';
}

export interface StorageEntitlement {
  /** -1 = unlimited, 0 = not available */
  limitMB: number;
}

export type ApiAccessEntitlement = false | QuotaEntitlement;

export interface AlertEntitlement {
  /** -1 = unlimited history; n = days of history accessible */
  historyDays: number;
  /** null = no email alerts for this tier */
  emailFrequency: 'REALTIME' | 'DAILY' | 'WEEKLY' | null;
  customFilters: boolean;
  aiSummary: boolean;
}

// ============================================================================
// Per-plan entitlement shape
// ============================================================================

export interface PlanEntitlementConfig {
  // Metered quotas
  complianceQueries: QuotaEntitlement;
  checklistGenerations: QuotaEntitlement;
  apiAccess: ApiAccessEntitlement;

  // Metered boolean features (QuotaEntitlement: limit=0 -> unavailable, -1 -> unlimited)
  gapAnalysis: QuotaEntitlement;
  policyGeneration: boolean;
  customIntegrations: boolean;
  teamCollaboration: boolean;
  regulatoryDashboard: boolean;
  regulatoryAlerts: boolean;

  /** Rich alert entitlements — history window, email frequency, filters */
  alerts?: AlertEntitlement;

  /** Compliance Calendar -- create/manage org-scoped deadline events */
  complianceCalendar: boolean;

  // Tiered / numeric
  documentRepository: StorageEntitlement;
  maxSeats: number; // -1 = unlimited
  supportTier: SupportTier;
  analytics: AnalyticsTier;
  knowledgeBaseAccess: KnowledgeBaseAccess;

  // Enterprise-only optional flags
  sso?: boolean;
  onPremise?: boolean;
  slaGuarantee?: string;
  legalCorpusManagement?: boolean;
  dedicatedAccountManager?: boolean;
}

export type FeatureKey = keyof PlanEntitlementConfig;

/** The full entitlements map -- covers all EffectivePlan values (DB plans + FREE_TRIAL). */
export type PlanEntitlements = Record<EffectivePlan, PlanEntitlementConfig>;

// ============================================================================
// Single source of truth
// ============================================================================

export const PLAN_ENTITLEMENTS: PlanEntitlements = {
  /**
   * REGULATOR -- Free tier for CBK/CMA/CA officials.
   * Read-only knowledge base, limited queries, no generative features.
   */
  REGULATOR: {
    complianceQueries:     { limit: 50,  period: 'month' },
    checklistGenerations:  { limit: 1,   period: 'lifetime' }, // 1 lifetime checklist for free tier
    apiAccess:             false,
    gapAnalysis:           { limit: 0,  period: 'month' }, // not available on free tier
    policyGeneration:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: -1, emailFrequency: 'REALTIME', customFilters: true, aiSummary: true },
    complianceCalendar:    false,
    documentRepository:    { limitMB: 0 }, // no document repo
    maxSeats:              1,
    supportTier:           'community',
    analytics:             'none',
    knowledgeBaseAccess:   'read-only',
  },

  /**
   * STARTUP -- KES 25,000/month.
   * Unlimited queries, 5 checklists/month, 1 GB storage.
   * Gap analysis / API / custom integrations greyed out (upsell to Business).
   */
  STARTUP: {
    complianceQueries:     { limit: -1, period: 'month' }, // unlimited
    checklistGenerations:  { limit: 5,  period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 5,  period: 'month' }, // 5 analyses/month -- standard frameworks only
    policyGeneration:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 90, emailFrequency: 'WEEKLY', customFilters: false, aiSummary: false },
    complianceCalendar:    true,
    documentRepository:    { limitMB: 1024 }, // 1 GB
    maxSeats:              1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
  },

  /**
   * BUSINESS -- KES 75,000/month. "Most Popular".
   * Unlimited queries + checklists, gap analysis, API (10k calls/month),
   * 5 seats, 10 GB storage.
   */
  BUSINESS: {
    complianceQueries:     { limit: -1,    period: 'month' },
    checklistGenerations:  { limit: -1,    period: 'month' },
    apiAccess:             { limit: 10000, period: 'month' },
    gapAnalysis:           { limit: 20,   period: 'month' }, // 20 analyses/month -- full framework access
    policyGeneration:      false, // Enterprise only
    customIntegrations:    false, // Enterprise only
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 365, emailFrequency: 'DAILY', customFilters: true, aiSummary: true },
    complianceCalendar:    true,
    documentRepository:    { limitMB: 10240 }, // 10 GB
    maxSeats:              5,
    supportTier:           'priority-24hr',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
  },

  /**
   * ENTERPRISE -- Custom pricing.
   * Everything in Business plus AI Policy Generator, unlimited API,
   * custom integrations, SSO, on-premise option, dedicated support.
   */
  ENTERPRISE: {
    complianceQueries:     { limit: -1, period: 'month' },
    checklistGenerations:  { limit: -1, period: 'month' },
    apiAccess:             { limit: -1, period: 'month' }, // unlimited
    gapAnalysis:           { limit: -1, period: 'month' }, // unlimited
    policyGeneration:      true,
    customIntegrations:    true,
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: -1, emailFrequency: 'REALTIME', customFilters: true, aiSummary: true },
    complianceCalendar:    true,
    documentRepository:    { limitMB: -1 }, // unlimited
    maxSeats:              -1,              // unlimited
    supportTier:           'dedicated',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
    sso:                   true,
    onPremise:             true,
    slaGuarantee:          '99.9%',
    legalCorpusManagement: true,
    dedicatedAccountManager: true,
  },

  /**
   * FREE_TRIAL -- 7-day one-time trial. TypeScript-only; never stored in the DB.
   * Mirrors STARTUP entitlements. Per-trial-lifetime usage caps are enforced
   * separately via the freeTrialUsage JSON column and FREE_TRIAL_LIMITS.
   * The quota limit values here are set to -1 (unlimited) because the real cap
   * enforcement happens through FREE_TRIAL_LIMITS in trial.service.ts, not through
   * the standard Redis monthly quota path.
   */
  FREE_TRIAL: {
    complianceQueries:     { limit: -1, period: 'month' }, // cap enforced via FREE_TRIAL_LIMITS
    checklistGenerations:  { limit: -1, period: 'month' }, // cap enforced via FREE_TRIAL_LIMITS
    apiAccess:             false,
    gapAnalysis:           { limit: -1, period: 'month' }, // cap enforced via FREE_TRIAL_LIMITS
    policyGeneration:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 7, emailFrequency: null, customFilters: false, aiSummary: false },
    complianceCalendar:    true,
    documentRepository:    { limitMB: 1024 }, // same as STARTUP -- 1 GB
    maxSeats:              1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
  },
};

// Re-export SubscriptionPlan from Prisma so consumers only need one import
export { SubscriptionPlan };
