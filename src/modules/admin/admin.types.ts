/**
 * Admin Module Types
 * Superadmin capabilities: user management, org oversight, content moderation,
 * system configuration, platform monitoring, and regulatory framework management.
 */

// ============================================================================
// Constants
// ============================================================================

export const ADMIN_CONSTANTS = {
  REDIS_KEYS: {
    FEATURE_FLAGS: 'admin:feature_flags',
    SYSTEM_CONFIG: 'admin:system_config',
    MAINTENANCE: 'admin:maintenance',
    IMPERSONATION: 'admin:impersonate:',
    CACHE_STATS: 'admin:cache_stats',
  },
  CACHE_TTL: {
    FEATURE_FLAGS: 3600,      // 1 hour
    SYSTEM_CONFIG: 3600,      // 1 hour
    IMPERSONATION_TTL: 900,   // 15 minutes
    STATS: 60,                // 1 minute
    ORG_STATS: 300,           // 5 minutes
  },
  SOFT_DELETE_RETENTION_DAYS: 30,
} as const;

// ============================================================================
// User Management Types
// ============================================================================

export interface AdminUserFilters {
  role?: string;
  status?: string;
  organizationId?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'email' | 'lastLoginAt';
  sortOrder?: 'asc' | 'desc';
}

export interface AdminUserDetail {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  status: string;
  emailVerified: boolean;
  organizationId: string | null;
  organizationName: string | null;
  organizationPlan: string | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
  updatedAt: Date;
  sessionCount: number;
  policyCount: number;
  queryCount: number;
}

export interface PaginatedUsers {
  items: AdminUserDetail[];
  nextCursor: string | null;
  total: number;
  page: number;
  limit: number;
}

export interface ImpersonationToken {
  token: string;
  adminId: string;
  targetUserId: string;
  expiresAt: Date;
}

// ============================================================================
// Organization Management Types
// ============================================================================

export interface AdminOrgFilters {
  subscriptionTier?: string;
  subscriptionStatus?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'organizationType' | 'subscriptionTier' | 'subscriptionStatus' | 'memberCount' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export interface AdminOrgMember {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  createdAt: Date;
}

export interface AdminOrgDetail {
  id: string;
  name: string;
  type: string;
  organizationType: string;
  registrationNumber: string | null;
  cbkLicenseNumber: string | null;
  website: string | null;
  industry: string | null;
  size: string | null;
  verificationStatus: string;
  address: string | null;
  contactPerson: string | null;
  contactPosition: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  subscriptionTier: string;
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;
  cancelledAt: Date | null;
  subscriptionEndsAt: Date | null;
  planStartDate: Date | null;
  planEndDate: Date | null;
  maxSeats: number;
  memberCount: number;
  documentCount: number;
  policyCount: number;
  users: AdminOrgMember[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedOrganizations {
  items: AdminOrgDetail[];
  nextCursor: string | null;
  total: number;
  page: number;
  limit: number;
}

export interface OrganizationStats {
  total: number;
  active: number;
  byTier: {
    REGULATOR: number;
    STARTUP: number;
    BUSINESS: number;
    ENTERPRISE: number;
  };
}

// ============================================================================
// Content Moderation Types
// ============================================================================

export interface ModerationFilters {
  status?: string;
  page?: number;
  limit?: number;
}

// ============================================================================
// System Configuration Types
// ============================================================================

export interface SystemConfig {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  maxFileUploadMB: number;
  maxQueriesPerHour: number;
  maxPoliciesPerHour: number;
  aiApiKey?: string;
  aiApiKeyMasked?: string | null;
  aiApiKeyConfigured?: boolean;
  aiApiKeySource?: 'system_config' | 'environment' | 'none';
  aiDailyCostLimit?: number;
  aiPolicyModel?: string;
  aiQueryModel?: string;
  aiVerificationModel?: string;
  aiComplexAnalysisModel?: string;
  aiPolicyTemperature?: number;
  aiQueryTemperature?: number;
  availableAIModels?: string[];
  allowNewRegistrations: boolean;
  requireEmailVerification: boolean;
  defaultSubscriptionTier: string;
  supportEmail: string;
  sessionTimeoutHours?: number;
  passwordMinLength?: number;
  automatedBackupsEnabled?: boolean;
  resourceUsageAlertThreshold?: number;
  webhookFailureAlertThreshold?: number;
  securityAlertEmail?: string;
  billingPlanOverrides?: BillingPlanOverrides;
  [key: string]: unknown;
}

export interface BillingPlanPriceOverride {
  monthly?: number | null;
  yearly?: number | null;
}

export interface BillingPlanStripeOverride {
  monthlyPriceId?: string | null;
  yearlyPriceId?: string | null;
}

export interface BillingPlanOverride {
  price?: BillingPlanPriceOverride;
  trialDays?: number;
  stripe?: BillingPlanStripeOverride | null;
}

export type BillingPlanOverrides = Partial<Record<SubscriptionPlan, BillingPlanOverride>>;

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  maintenanceMode: false,
  maintenanceMessage: 'SheriaBot is undergoing scheduled maintenance. We\'ll be back shortly.',
  maxFileUploadMB: 50,
  maxQueriesPerHour: 50,
  maxPoliciesPerHour: 10,
  aiApiKey: '',
  aiDailyCostLimit: 500,
  aiPolicyModel: 'claude-sonnet-4-6',
  aiQueryModel: 'claude-haiku-4-5-20251001',
  aiVerificationModel: 'claude-haiku-4-5-20251001',
  aiComplexAnalysisModel: 'claude-opus-4-6',
  aiPolicyTemperature: 0.3,
  aiQueryTemperature: 0.5,
  availableAIModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
  allowNewRegistrations: true,
  requireEmailVerification: true,
  defaultSubscriptionTier: 'starter',
  supportEmail: 'support@sheriabot.com',
  sessionTimeoutHours: 8,
  passwordMinLength: 10,
  automatedBackupsEnabled: true,
  resourceUsageAlertThreshold: 80,
  webhookFailureAlertThreshold: 5,
  securityAlertEmail: 'security@sheriabot.com',
  billingPlanOverrides: {},
};

export interface FeatureFlags {
  ragEnabled: boolean;
  aiPolicyGeneration: boolean;
  documentProcessing: boolean;
  bulkUpload: boolean;
  exportFeature: boolean;
  analyticsEnabled: boolean;
  notificationsEnabled: boolean;
  maintenanceMode: boolean;
  [key: string]: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  ragEnabled: true,
  aiPolicyGeneration: true,
  documentProcessing: true,
  bulkUpload: true,
  exportFeature: true,
  analyticsEnabled: true,
  notificationsEnabled: true,
  maintenanceMode: false,
};

export interface MaintenanceStatus {
  enabled: boolean;
  message: string;
  startedAt: Date | null;
}

// ============================================================================
// Platform Monitoring Types
// ============================================================================

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'down';
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
    pinecone: ServiceHealth;
    storage: ServiceHealth;
  };
  uptime: number;
  version: string;
  checkedAt: Date;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs?: number;
  message?: string;
}

export interface DatabaseStats {
  totalUsers: number;
  totalOrganizations: number;
  totalPolicies: number;
  totalDocuments: number;
  totalAuditLogs: number;
  dbSizeMB?: number;
}

export interface CacheStats {
  memoryUsedMB: number;
  totalKeys: number;
  hitRate?: number;
  status: string;
}

export interface VectorDBStats {
  indexName: string;
  vectorCount: number;
  dimensionality: number;
  status: string;
}

export interface StorageStats {
  totalFiles: number;
  totalSizeMB: number;
  status: string;
}

export interface ConnectionStats {
  activeDatabaseConnections: number;
  activeRedisConnections: number;
  activeSessions: number;
}

export interface ErrorLogFilters {
  level?: 'error' | 'warn';
  service?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}

export interface PaginatedErrorLog {
  items: Array<{
    id: string;
    level: string;
    message: string;
    service: string;
    metadata: unknown;
    createdAt: Date;
  }>;
  total: number;
  page: number;
  limit: number;
}

export interface AuditLogFilters {
  userId?: string;
  action?: string;
  entityType?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date;
}

export interface PaginatedAuditLog {
  items: AuditLogEntry[];
  nextCursor: string | null;
  total: number;
  page: number;
  limit: number;
}

// ============================================================================
// Regulatory Framework Types
// ============================================================================

export interface RegulatoryFramework {
  id: string;
  name: string;
  description: string;
  area: string;
  country: string;
  effectiveDate: Date | null;
  status: string;
  documentIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface FrameworkParams {
  name: string;
  description: string;
  area: string;
  country?: string;
  effectiveDate?: Date;
  status?: string;
  documentIds?: string[];
}

// ============================================================================
// Invitation Types
// ============================================================================

export interface PendingInvitation {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}

// ============================================================================
// Analytics Types
// ============================================================================

export interface TimeSeriesPoint {
  date: string; // ISO date string (YYYY-MM-DD)
  count: number;
}

export interface UserGrowthData {
  series: TimeSeriesPoint[];
  total: number;
  periodStart: string;
  periodEnd: string;
}

export interface RevenueMetrics {
  totalRevenue: number;        // KES, all time
  currentMonthRevenue: number; // KES, this calendar month
  lastMonthRevenue: number;    // KES, previous calendar month
  series: Array<{ date: string; amount: number }>; // monthly totals
  byProvider: { STRIPE: number; MPESA: number };
  successRate: number; // 0-100
}

export interface AIUsageMetrics {
  totalQueries: number;
  totalPolicies: number;
  totalChecklists: number;
  totalGapAnalyses: number;
  queriesThisMonth: number;
  policiesThisMonth: number;
  series: TimeSeriesPoint[]; // daily query counts
}

export interface SubscriptionBreakdown {
  byPlan: Record<string, number>;
  byStatus: Record<string, number>;
  total: number;
}

// ============================================================================
// Payment History Types
// ============================================================================

/**
 * A single payment record normalized to major currency units (KES).
 * All `amount` values have been divided by CURRENCY_MINOR_UNIT_SCALE (100)
 * at the AdminModule boundary  -  callers receive KES, not KES-cents.
 */
export interface PaymentSummary {
  id: string;
  orgId: string;
  orgName: string;
  provider: string;
  amount: number;
  currency: string;
  status: string;
  invoiceNumber: string | null;
  subscriptionPlan: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface OrgPaymentHistory {
  items: PaymentSummary[];
  total: number;
  page: number;
  limit: number;
}

// ============================================================================
// Security / Session Types
// ============================================================================

/**
 * A single active (non-expired) session for a user.
 * Returned by listUserActiveSessions  -  read-only; callers may not revoke
 * individual sessions (use signOutUserEverywhere to revoke all at once).
 */
export interface SessionSummary {
  id: string;
  userId: string;
  device: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

// ============================================================================
// Audit Log Export Types
// ============================================================================

/**
 * Filter criteria for server-side audit log exports.
 * Row caps are enforced by the module: DOCX max 2 000 rows, CSV max 10 000 rows.
 */
export interface AuditLogExportFilters {
  userId?: string;
  action?: string;
  entityType?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

// ============================================================================
// User Creation Types
// ============================================================================

export interface CreateUserInput {
  email: string;
  fullName: string;
  password: string;
  role: 'REGULATOR' | 'STARTUP' | 'ENTERPRISE' | 'ADMIN';
  subscriptionTier?: 'REGULATOR' | 'STARTUP' | 'BUSINESS' | 'ENTERPRISE';
  organizationId?: string;
  organizationName?: string;
  isPilot?: boolean;
  sendWelcomeEmail?: boolean;
}

// ============================================================================
// Login History Types
// ============================================================================

export interface LoginHistoryFilters {
  userId?: string;
  email?: string;
  success?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  limit?: number;
}

export interface LoginHistoryEntry {
  id: string;
  userId: string | null;
  email: string;
  success: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  failureReason: string | null;
  location: string | null;
  createdAt: Date;
}

export interface PaginatedLoginHistory {
  items: LoginHistoryEntry[];
  total: number;
  page: number;
  limit: number;
}

// ============================================================================
// Content Management Types
// ============================================================================

export interface ContentFilters {
  contentType: 'BLOG_POST' | 'KNOWLEDGE_BASE_ARTICLE';
  contentStatus?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'UNDER_REVIEW';
  search?: string;
  page?: number;
  limit?: number;
}

export interface ContentItem {
  id: string;
  title: string | null;
  slug: string | null;
  excerpt: string | null;
  contentType: string;
  contentStatus: string;
  category: string | null;
  viewCount: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  authorId: string | null;
}

export interface PaginatedContent {
  items: ContentItem[];
  total: number;
  page: number;
  limit: number;
}

// ============================================================================
// Organization Update Types
// ============================================================================

export interface UpdateOrganizationInput {
  name?: string;
  type?: string;
  registrationNumber?: string;
  website?: string;
  address?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactPosition?: string;
}

// ============================================================================
// Subscription Types
// ============================================================================

export type SubscriptionPlan = 'REGULATOR' | 'STARTUP' | 'BUSINESS' | 'ENTERPRISE';

export type SelfServeBillingPlan = 'STARTUP' | 'BUSINESS';

export interface BillingPlanCatalogEntry {
  id: SubscriptionPlan;
  name: string;
  tagline: string;
  badge: 'Free' | 'Most Popular' | null;
  popular: boolean;
  trialDays: number;
  editable: boolean;
  supportsMpesa: boolean;
  supportsStripe: boolean;
  price: {
    monthly: number | null;
    yearly: number | null;
    currency: 'KES';
  };
  stripe: {
    monthlyPriceId: string | null;
    yearlyPriceId: string | null;
  } | null;
  features: Array<{
    text: string;
    included: boolean;
  }>;
}

export interface BillingPlanCatalog {
  plans: BillingPlanCatalogEntry[];
  managedPlanIds: SelfServeBillingPlan[];
}

export interface BillingPlanCatalogUpdateItem {
  id: SelfServeBillingPlan;
  price: {
    monthly: number;
    yearly: number | null;
  };
  trialDays: number;
  stripe: {
    monthlyPriceId: string;
    yearlyPriceId: string | null;
  };
}

export interface BillingPlanCatalogUpdateInput {
  plans: BillingPlanCatalogUpdateItem[];
}

export interface Subscription {
  userId: string;
  organizationId: string;
  plan: SubscriptionPlan;
  status: string;
  updatedAt: Date;
}

export interface SubscriptionOverview {
  totalActive: number;
  byPlan: Record<SubscriptionPlan, number>;
  trialConversionRate: number;
  churnRate: number;
}
