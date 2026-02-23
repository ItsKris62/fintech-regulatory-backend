/**
 * User Module Types
 * Type definitions for user profile and account operations
 */

import type { UserRole } from '@prisma/client';

// ============================================================================
// Profile Types
// ============================================================================

/**
 * User profile data (public-safe fields)
 */
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
  avatarUrl: string | null;
  organizationId: string | null;
  organizationName: string | null;
  emailVerified: boolean;
  preferences: UserPreferences;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

/**
 * Input for updating user profile
 */
export interface UpdateProfileInput {
  name?: string;
  phone?: string;
  avatarUrl?: string;
  // Email changes require verification - handled separately
}

/**
 * Input for changing email (requires verification)
 */
export interface ChangeEmailInput {
  newEmail: string;
  password: string; // Confirm with password
}

// ============================================================================
// Preferences Types
// ============================================================================

/**
 * User preferences stored as JSON
 */
export interface UserPreferences {
  // Notification preferences
  notifications: {
    email: boolean;
    inApp: boolean;
    policyReady: boolean;
    complianceAlerts: boolean;
    weeklyDigest: boolean;
  };
  
  // UI preferences
  ui: {
    theme: 'light' | 'dark' | 'system';
    language: string;
    timezone: string;
    dateFormat: string;
  };
  
  // Privacy preferences
  privacy: {
    showActivityStatus: boolean;
    allowAnalytics: boolean;
  };
}

/**
 * Default preferences for new users
 */
export const DEFAULT_PREFERENCES: UserPreferences = {
  notifications: {
    email: true,
    inApp: true,
    policyReady: true,
    complianceAlerts: true,
    weeklyDigest: false,
  },
  ui: {
    theme: 'system',
    language: 'en',
    timezone: 'Africa/Nairobi',
    dateFormat: 'DD/MM/YYYY',
  },
  privacy: {
    showActivityStatus: true,
    allowAnalytics: true,
  },
};

/**
 * Partial preferences update
 */
export type UpdatePreferencesInput = Partial<{
  notifications: Partial<UserPreferences['notifications']>;
  ui: Partial<UserPreferences['ui']>;
  privacy: Partial<UserPreferences['privacy']>;
}>;

// ============================================================================
// Activity Types
// ============================================================================

/**
 * Activity log entry
 */
export interface ActivityLogEntry {
  id: string;
  userId: string;
  action: ActivityAction;
  resourceType: ResourceType;
  resourceId: string | null;
  metadata: Record<string, any>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

/**
 * Supported activity actions
 */
export type ActivityAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'PASSWORD_CHANGE'
  | 'PROFILE_UPDATE'
  | 'POLICY_CREATE'
  | 'POLICY_UPDATE'
  | 'POLICY_DELETE'
  | 'POLICY_EXPORT'
  | 'QUERY_SUBMIT'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_DELETE'
  | 'ORG_JOIN'
  | 'ORG_LEAVE'
  | 'SETTINGS_CHANGE';

/**
 * Resource types for activity logging
 */
export type ResourceType =
  | 'USER'
  | 'POLICY'
  | 'QUERY'
  | 'DOCUMENT'
  | 'ORGANIZATION'
  | 'SETTINGS';

/**
 * Filters for activity log queries
 */
export interface ActivityLogFilters {
  action?: ActivityAction;
  resourceType?: ResourceType;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}

/**
 * Paginated activity log response
 */
export interface PaginatedActivityLog {
  items: ActivityLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// Stats Types
// ============================================================================

/**
 * User statistics
 */
export interface UserStats {
  // Content counts
  policiesCreated: number;
  policiesPublished: number;
  queriesSubmitted: number;
  documentsUploaded: number;
  
  // Usage metrics
  totalAITokensUsed: number;
  aiTokensThisMonth: number;
  storageUsedBytes: number;
  
  // Engagement
  lastActiveAt: Date | null;
  loginCount: number;
  daysActive: number;
  
  // Quotas
  quotas: {
    policiesRemaining: number;
    queriesRemaining: number;
    storageRemaining: number;
  };
}

// ============================================================================
// Account Management Types
// ============================================================================

/**
 * Account deletion request
 */
export interface DeleteAccountInput {
  password: string;
  reason?: string;
  feedback?: string;
}

/**
 * Account deletion result
 */
export interface DeleteAccountResult {
  success: boolean;
  message: string;
  scheduledDeletionDate: Date;
  dataExportUrl?: string;
}

/**
 * User data export (GDPR compliance)
 */
export interface UserDataExport {
  user: {
    profile: UserProfile;
    preferences: UserPreferences;
  };
  policies: Array<{
    id: string;
    title: string;
    content: string;
    createdAt: Date;
  }>;
  queries: Array<{
    id: string;
    query: string;
    response: string;
    createdAt: Date;
  }>;
  documents: Array<{
    id: string;
    name: string;
    uploadedAt: Date;
  }>;
  activityLog: ActivityLogEntry[];
  exportedAt: Date;
}

/**
 * Data export result
 */
export interface ExportDataResult {
  success: boolean;
  downloadUrl: string;
  expiresAt: Date;
  fileSizeBytes: number;
}

// ============================================================================
// Cache Keys
// ============================================================================

export const USER_CACHE_KEYS = {
  PROFILE: (userId: string) => `user:profile:${userId}`,
  PREFERENCES: (userId: string) => `user:preferences:${userId}`,
  STATS: (userId: string) => `user:stats:${userId}`,
  ACTIVITY: (userId: string) => `user:activity:${userId}`,
} as const;

export const USER_CACHE_TTL = {
  PROFILE: 300, // 5 minutes
  PREFERENCES: 600, // 10 minutes
  STATS: 60, // 1 minute (changes frequently)
  ACTIVITY: 120, // 2 minutes
} as const;

// ============================================================================
// Error Types
// ============================================================================

export class UserError extends Error {
  constructor(
    message: string,
    public code: UserErrorCode,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export type UserErrorCode =
  | 'USER_NOT_FOUND'
  | 'INVALID_PASSWORD'
  | 'EMAIL_ALREADY_EXISTS'
  | 'INVALID_UPDATE'
  | 'EXPORT_FAILED'
  | 'DELETION_FAILED'
  | 'RATE_LIMIT_EXCEEDED';