import { VAULT_MIME_TYPES } from '@/lib/storage/mime';
import { SubscriptionPlan, type EffectivePlan, type PilotEntitlementProfile } from '@/types/plan.types';

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
  benchmarkDocuments: boolean;
  policyGeneration: boolean;
  customFrameworks: boolean;
  customIntegrations: boolean;
  teamCollaboration: boolean;
  regulatoryDashboard: boolean;
  regulatoryAlerts: boolean;

  /** Rich alert entitlements -- history window, email frequency, filters */
  alerts?: AlertEntitlement;

  /** Compliance Calendar -- create/manage org-scoped deadline events */
  complianceCalendar: boolean;
  /** License Management -- manage org-scoped licenses, renewals, evidence links, and fees */
  licenseManagement: boolean;

  // Tiered / numeric
  documentRepository: StorageEntitlement;
  /** -1 = unlimited, 0 = feature disabled, n = max bytes for a single vault document */
  vaultDocumentMaxBytes: number;
  /** -1 = unlimited, 0 = feature disabled, n = max bytes for active org vault storage */
  vaultTotalQuotaBytes: number;
  /** Plan-specific MIME types permitted for vault uploads */
  vaultAllowedMimeTypes: readonly string[];
  maxSeats: number; // -1 = unlimited
  maxEnabledCountries: number;
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
export type PilotEntitlementProfiles = Record<PilotEntitlementProfile, PlanEntitlementConfig>;

// ============================================================================
// Single source of truth
// ============================================================================

export const PLAN_ENTITLEMENTS: PlanEntitlements = {
  /**
   * FREE -- 1 seat, KES 0.
   * Bounded evaluation access within home country.
   */
  FREE: {
    complianceQueries:     { limit: 25,  period: 'month' },
    checklistGenerations:  { limit: 1,   period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 0,   period: 'month' },
    benchmarkDocuments:    false,
    policyGeneration:      false,
    customFrameworks:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 7, emailFrequency: null, customFilters: false, aiSummary: false },
    complianceCalendar:    false,
    licenseManagement:     false,
    documentRepository:    { limitMB: 100 },
    vaultDocumentMaxBytes:  5 * 1024 * 1024,
    vaultTotalQuotaBytes:   100 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_BASE_MIME_TYPES,
    maxSeats:              1,
    maxEnabledCountries:   1,
    supportTier:           'community',
    analytics:             'none',
    knowledgeBaseAccess:   'read-only',
    agenticComplexityLevel: 'simple',
  },

  /**
   * STARTER -- 1 seat, KES 7,500/month (KES 76,500/year).
   * Cited queries, knowledge base, regulatory alerts, calendar, checklists,
   * licenses, quick gap analysis, single home jurisdiction.
   */
  STARTER: {
    complianceQueries:     { limit: 100, period: 'month' },
    checklistGenerations:  { limit: 5,   period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 2,   period: 'month' }, // Quick analysis
    benchmarkDocuments:    false,
    policyGeneration:      false,
    customFrameworks:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 90, emailFrequency: 'WEEKLY', customFilters: false, aiSummary: false },
    complianceCalendar:    true,
    licenseManagement:     true,
    documentRepository:    { limitMB: 1024 }, // 1 GB
    vaultDocumentMaxBytes:  10 * 1024 * 1024,
    vaultTotalQuotaBytes:   1024 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_STARTUP_MIME_TYPES,
    maxSeats:              1,
    maxEnabledCountries:   1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },

  /**
   * GROWTH -- 2 seats, KES 15,000/month (KES 153,000/year).
   * Quick & Standard gap analysis, two-person collaboration, 3 GB storage, single home jurisdiction.
   */
  GROWTH: {
    complianceQueries:     { limit: 250, period: 'month' },
    checklistGenerations:  { limit: 15,  period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 8,   period: 'month' }, // Quick + Standard
    benchmarkDocuments:    false,
    policyGeneration:      false,
    customFrameworks:      false,
    customIntegrations:    false,
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 180, emailFrequency: 'DAILY', customFilters: true, aiSummary: true },
    complianceCalendar:    true,
    licenseManagement:     true,
    documentRepository:    { limitMB: 3072 }, // 3 GB
    vaultDocumentMaxBytes:  15 * 1024 * 1024,
    vaultTotalQuotaBytes:   3072 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_STARTUP_MIME_TYPES,
    maxSeats:              2,
    maxEnabledCountries:   1,
    supportTier:           'priority-24hr',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },

  /**
   * BUSINESS -- 6 seats, KES 35,000/month (KES 357,000/year).
   * All analysis depths, multi-country access and comparison within 2 enabled countries,
   * 10 GB storage, API access (10k calls/month).
   */
  BUSINESS: {
    complianceQueries:     { limit: 600,   period: 'month' },
    checklistGenerations:  { limit: -1,    period: 'month' },
    apiAccess:             { limit: 10000, period: 'month' },
    gapAnalysis:           { limit: 25,    period: 'month' }, // All analysis depths
    benchmarkDocuments:    true,
    policyGeneration:      false, // Enterprise only
    customFrameworks:      false, // Enterprise only
    customIntegrations:    false, // Enterprise only
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 365, emailFrequency: 'DAILY', customFilters: true, aiSummary: true },
    complianceCalendar:    true,
    licenseManagement:     true,
    documentRepository:    { limitMB: 10240 }, // 10 GB
    vaultDocumentMaxBytes:  25 * 1024 * 1024,
    vaultTotalQuotaBytes:   10240 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_BUSINESS_MIME_TYPES,
    maxSeats:              6,
    maxEnabledCountries:   2,
    supportTier:           'priority-24hr',
    analytics:             'advanced',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },

  /**
   * ENTERPRISE -- 12 seats, starting from KES 75,000/month (KES 765,000/year).
   * All analysis depths, policy generation/refinement, custom frameworks, up to 4 enabled countries,
   * 25 GB storage, dedicated support, custom integrations, SSO.
   */
  ENTERPRISE: {
    complianceQueries:     { limit: 1200, period: 'month' },
    checklistGenerations:  { limit: -1,   period: 'month' },
    apiAccess:             { limit: -1,   period: 'month' }, // unlimited
    gapAnalysis:           { limit: 60,   period: 'month' }, // unlimited/60 baseline
    benchmarkDocuments:    true,
    policyGeneration:      true, // 5 baseline policy credits
    customFrameworks:      true,
    customIntegrations:    true,
    teamCollaboration:     true,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: -1, emailFrequency: 'REALTIME', customFilters: true, aiSummary: true },
    complianceCalendar:    true,
    licenseManagement:     true,
    documentRepository:    { limitMB: 25600 }, // 25 GB baseline
    vaultDocumentMaxBytes:  50 * 1024 * 1024,
    vaultTotalQuotaBytes:   25600 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_ENTERPRISE_MIME_TYPES,
    maxSeats:              12,
    maxEnabledCountries:   4,
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
   * REGULATOR (Legacy Compatibility) -- Maps to evaluation/free tier.
   */
  REGULATOR: {
    complianceQueries:     { limit: 50,  period: 'month' },
    checklistGenerations:  { limit: 1,   period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 0,   period: 'month' },
    benchmarkDocuments:    false,
    policyGeneration:      false,
    customFrameworks:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: -1, emailFrequency: 'REALTIME', customFilters: true, aiSummary: true },
    complianceCalendar:    false,
    licenseManagement:     false,
    documentRepository:    { limitMB: 0 },
    vaultDocumentMaxBytes:  0,
    vaultTotalQuotaBytes:   0,
    vaultAllowedMimeTypes:  [],
    maxSeats:              1,
    maxEnabledCountries:   1,
    supportTier:           'community',
    analytics:             'none',
    knowledgeBaseAccess:   'read-only',
    agenticComplexityLevel: 'simple',
  },

  /**
   * STARTUP (Legacy Compatibility) -- Maps to Starter tier defaults.
   */
  STARTUP: {
    complianceQueries:     { limit: 100, period: 'month' },
    checklistGenerations:  { limit: 5,   period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: 2,   period: 'month' },
    benchmarkDocuments:    false,
    policyGeneration:      false,
    customFrameworks:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 90, emailFrequency: 'WEEKLY', customFilters: false, aiSummary: false },
    complianceCalendar:    true,
    licenseManagement:     true,
    documentRepository:    { limitMB: 1024 },
    vaultDocumentMaxBytes:  10 * 1024 * 1024,
    vaultTotalQuotaBytes:   1024 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_STARTUP_MIME_TYPES,
    maxSeats:              1,
    maxEnabledCountries:   1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },

  /**
   * FREE_TRIAL -- One-time trial (TypeScript-only).
   */
  FREE_TRIAL: {
    complianceQueries:     { limit: -1, period: 'month' },
    checklistGenerations:  { limit: -1, period: 'month' },
    apiAccess:             false,
    gapAnalysis:           { limit: -1, period: 'month' },
    benchmarkDocuments:    false,
    policyGeneration:      false,
    customFrameworks:      false,
    customIntegrations:    false,
    teamCollaboration:     false,
    regulatoryDashboard:   true,
    regulatoryAlerts:      true,
    alerts:                { historyDays: 7, emailFrequency: null, customFilters: false, aiSummary: false },
    complianceCalendar:    false,
    licenseManagement:     false,
    documentRepository:    { limitMB: 100 },
    vaultDocumentMaxBytes:  5 * 1024 * 1024,
    vaultTotalQuotaBytes:   100 * 1024 * 1024,
    vaultAllowedMimeTypes:  VAULT_BASE_MIME_TYPES,
    maxSeats:              1,
    maxEnabledCountries:   1,
    supportTier:           'email-48hr',
    analytics:             'basic',
    knowledgeBaseAccess:   'full',
    agenticComplexityLevel: 'simple',
  },
};

const pilotFullBase: PlanEntitlementConfig = {
  ...PLAN_ENTITLEMENTS.ENTERPRISE,
  policyGeneration: false,
  customFrameworks: false,
  customIntegrations: false,
  sso: false,
  onPremise: false,
  slaGuarantee: undefined,
  legalCorpusManagement: false,
  dedicatedAccountManager: false,
};

export const PILOT_ENTITLEMENT_PROFILES: PilotEntitlementProfiles = {
  PILOT_FULL: pilotFullBase,
  PILOT_FULL_WITH_POLICY_GENERATION: {
    ...pilotFullBase,
    policyGeneration: true,
  },
};

export function resolvePilotEntitlementProfile(
  value: string | null | undefined,
): PilotEntitlementProfile {
  return value === 'PILOT_FULL_WITH_POLICY_GENERATION'
    ? 'PILOT_FULL_WITH_POLICY_GENERATION'
    : 'PILOT_FULL';
}

export function getPlanEntitlements(plan: EffectivePlan): PlanEntitlementConfig {
  return PLAN_ENTITLEMENTS[plan] ?? PLAN_ENTITLEMENTS.FREE;
}

// Re-export SubscriptionPlan from Prisma so consumers only need one import
export { SubscriptionPlan };
