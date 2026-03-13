import { SubscriptionPlan } from '@prisma/client';

// ============================================================================
// Value shape types
// ============================================================================

export type SupportTier = 'community' | 'email-48hr' | 'priority-24hr' | 'dedicated';
export type AnalyticsTier = 'none' | 'basic' | 'advanced';
export type KnowledgeBaseAccess = 'read-only' | 'full';

export interface QuotaEntitlement {
  /** -1 = unlimited, 0 = not available, n = monthly cap */
  limit: number;
  period: 'month';
}

export interface StorageEntitlement {
  /** -1 = unlimited, 0 = not available */
  limitMB: number;
}

export type ApiAccessEntitlement = false | QuotaEntitlement;

// ============================================================================
// Per-plan entitlement shape
// ============================================================================

export interface PlanEntitlementConfig {
  // Metered quotas
  complianceQueries: QuotaEntitlement;
  checklistGenerations: QuotaEntitlement;
  apiAccess: ApiAccessEntitlement;

  // Boolean feature flags
  gapAnalysis: boolean;
  policyGeneration: boolean;
  customIntegrations: boolean;
  teamCollaboration: boolean;
  regulatoryDashboard: boolean;
  regulatoryAlerts: boolean;

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

/** The full entitlements map — all plan logic lives here */
export type PlanEntitlements = Record<SubscriptionPlan, PlanEntitlementConfig>;

// ============================================================================
// Single source of truth
// ============================================================================

export const PLAN_ENTITLEMENTS: PlanEntitlements = {
  /**
   * REGULATOR — Free tier for CBK/CMA/CA officials.
   * Read-only knowledge base, limited queries, no generative features.
   */
  REGULATOR: {
    complianceQueries:     { limit: 50,  period: 'month' },
    checklistGenerations:  { limit: 0,   period: 'month' }, // 0 = not available
    apiAccess:             false,
    gapAnalysis:           false,
    policyGeneration:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    documentRepository:    { limitMB: 0 }, // no document repo
    maxSeats:              1,
    supportTier:           'community',
    analytics:             'none',
    knowledgeBaseAccess:   'read-only',
  },

  /**
   * STARTUP — KES 25,000/month.
   * Unlimited queries, 5 checklists/month, 1 GB storage.
   * Gap analysis / API / custom integrations greyed out (upsell to Business).
   */
  STARTUP: {
    complianceQueries:     { limit: -1, period: 'month' }, // unlimited
    checklistGenerations:  { limit: 5,  period: 'month' },
    apiAccess:             false,
    gapAnalysis:           false,
    policyGeneration:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    documentRepository:    { limitMB: 1024 }, // 1 GB
    maxSeats:              1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
  },

  /**
   * BUSINESS — KES 75,000/month. "Most Popular".
   * Unlimited queries + checklists, gap analysis, API (10k calls/month),
   * 5 seats, 10 GB storage.
   */
  BUSINESS: {
    complianceQueries:     { limit: -1,    period: 'month' },
    checklistGenerations:  { limit: -1,    period: 'month' },
    apiAccess:             { limit: 10000, period: 'month' },
    gapAnalysis:           true,
    policyGeneration:      false, // Enterprise only
    customIntegrations:    false, // Enterprise only
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    documentRepository:    { limitMB: 10240 }, // 10 GB
    maxSeats:              5,
    supportTier:           'priority-24hr',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
  },

  /**
   * ENTERPRISE — Custom pricing.
   * Everything in Business plus AI Policy Generator, unlimited API,
   * custom integrations, SSO, on-premise option, dedicated support.
   */
  ENTERPRISE: {
    complianceQueries:     { limit: -1, period: 'month' },
    checklistGenerations:  { limit: -1, period: 'month' },
    apiAccess:             { limit: -1, period: 'month' }, // unlimited
    gapAnalysis:           true,
    policyGeneration:      true,
    customIntegrations:    true,
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
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
};

// Re-export SubscriptionPlan from Prisma so consumers only need one import
export { SubscriptionPlan };
