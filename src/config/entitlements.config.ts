import { SubscriptionPlan } from '@prisma/client';
import { VAULT_MIME_TYPES } from '@/lib/storage/mime';
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

export const VAULT_BASE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
] as const;

export const VAULT_STARTUP_MIME_TYPES = [
  ...VAULT_BASE_MIME_TYPES,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/csv',
] as const;

export const VAULT_BUSINESS_MIME_TYPES = [
  ...VAULT_STARTUP_MIME_TYPES,
  'image/png',
  'image/jpeg',
] as const;

export const VAULT_ENTERPRISE_MIME_TYPES = [
  ...VAULT_BUSINESS_MIME_TYPES,
  'image/webp',
] as const;

export const ALLOWED_VAULT_MIME_TYPE_VALUES = VAULT_MIME_TYPES;

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

  /** Rich alert entitlements  history window, email frequency, filters */
  alerts?: AlertEntitlement;

  /** Compliance Calendar -- create/manage org-scoped deadline events */
  complianceCalendar: boolean;

  // Tiered / numeric
  documentRepository: StorageEntitlement;
  /** -1 = unlimited, 0 = feature disabled, n = max bytes for a single vault document */
  vaultDocumentMaxBytes: number;
  /** -1 = unlimited, 0 = feature disabled, n = max bytes for active org vault storage */
  vaultTotalQuotaBytes: number;
  /** Plan-specific MIME types permitted for vault uploads */
  vaultAllowedMimeTypes: readonly string[];
  maxSeats: number; // -1 = unlimited
  supportTier: SupportTier;
  analytics: AnalyticsTier;
  knowledgeBaseAccess: KnowledgeBaseAccess;

  /** Agentic orchestrator complexity level gated inside the orchestrator itself */
  agenticComplexityLevel: 'simple' | 'complex';

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
    vaultDocumentMaxBytes:  0,
    vaultTotalQuotaBytes:   0,
    vaultAllowedMimeTypes:  [],
    maxSeats:              1,
    supportTier:           'community',
    analytics:             'none',
    knowledgeBaseAccess:   'read-only',
    agenticComplexityLevel: 'simple',
  },

  /**
   * STARTUP -- KES 4,999/month.
   * Unlimited queries, 5 checklists/month, 1 GB storage.
   * Gap analysis / API / custom integrations greyed out (upsell to Business).
   */
  STARTUP: {
    complianceQueries:     { limit: -1, period: 'month' }, // unlimited
    checklistGenerations:  { limit: 5,  period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 0,  period: 'month' }, // blocked -- upsell to Business tier
    policyGeneration:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 90, emailFrequency: 'WEEKLY', customFilters: false, aiSummary: false },
    complianceCalendar:    true,
    documentRepository:    { limitMB: 1024 }, // 1 GB
    vaultDocumentMaxBytes:  10 * 1024 * 1024,
    vaultTotalQuotaBytes:   1024 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_STARTUP_MIME_TYPES,
    maxSeats:              1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },

  /**
   * BUSINESS -- KES 44,999/month. "Most Popular".
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
    vaultDocumentMaxBytes:  25 * 1024 * 1024,
    vaultTotalQuotaBytes:   10240 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_BUSINESS_MIME_TYPES,
    maxSeats:              5,
    supportTier:           'priority-24hr',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
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
    vaultDocumentMaxBytes:  50 * 1024 * 1024,
    vaultTotalQuotaBytes:   -1,
    vaultAllowedMimeTypes:  VAULT_ENTERPRISE_MIME_TYPES,
    maxSeats:              -1,              // unlimited
    supportTier:           'dedicated',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
    sso:                   true,
    onPremise:             true,
    slaGuarantee:          '99.9%',
    legalCorpusManagement: true,
    dedicatedAccountManager: true,
    agenticComplexityLevel: 'complex',
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
    vaultDocumentMaxBytes:  5 * 1024 * 1024,
    vaultTotalQuotaBytes:   100 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_BASE_MIME_TYPES,
    maxSeats:              1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },
};

// Re-export SubscriptionPlan from Prisma so consumers only need one import
export { SubscriptionPlan };
