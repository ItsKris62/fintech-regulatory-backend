/**
 * User Module Utilities
 * Helper functions for user operations
 */

import { z } from 'zod';
import type {
  UserProfile,
  UserPreferences,
  UpdatePreferencesInput,
  ActivityLogEntry,
  ActivityAction,
  ResourceType,
} from './user.types';

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Profile update validation schema
 */
export const updateProfileSchema = z.object({
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be less than 100 characters')
    .optional(),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number format')
    .optional()
    .nullable(),
  avatarUrl: z
    .string()
    .url('Invalid avatar URL')
    .optional()
    .nullable(),
});

/**
 * Email change validation schema
 */
export const changeEmailSchema = z.object({
  newEmail: z.string().email('Invalid email format').toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Preferences update validation schema
 */
export const updatePreferencesSchema = z.object({
  notifications: z.object({
    email: z.boolean().optional(),
    inApp: z.boolean().optional(),
    policyReady: z.boolean().optional(),
    complianceAlerts: z.boolean().optional(),
    weeklyDigest: z.boolean().optional(),
  }).optional(),
  ui: z.object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    language: z.string().min(2).max(5).optional(),
    timezone: z.string().optional(),
    dateFormat: z.string().optional(),
  }).optional(),
  privacy: z.object({
    showActivityStatus: z.boolean().optional(),
    allowAnalytics: z.boolean().optional(),
  }).optional(),
});

/**
 * Activity log filters validation schema
 */
export const activityLogFiltersSchema = z.object({
  action: z.enum([
    'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'PROFILE_UPDATE',
    'POLICY_CREATE', 'POLICY_UPDATE', 'POLICY_DELETE', 'POLICY_EXPORT',
    'QUERY_SUBMIT', 'DOCUMENT_UPLOAD', 'DOCUMENT_DELETE',
    'ORG_JOIN', 'ORG_LEAVE', 'SETTINGS_CHANGE',
  ] as const).optional(),
  resourceType: z.enum([
    'USER', 'POLICY', 'QUERY', 'DOCUMENT', 'ORGANIZATION', 'SETTINGS',
  ] as const).optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
});

/**
 * Account deletion validation schema
 */
export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  reason: z.string().max(500).optional(),
  feedback: z.string().max(2000).optional(),
});

// ============================================================================
// Profile Utilities
// ============================================================================

/**
 * Convert database user to profile (safe for client)
 */
export function toUserProfile(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  phone: string | null;
  avatarUrl?: string | null;
  organizationId: string | null;
  organization?: { name: string } | null;
  emailVerified: boolean;
  preferences?: any;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date | null;
}): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserProfile['role'],
    phone: user.phone,
    avatarUrl: user.avatarUrl || null,
    organizationId: user.organizationId,
    organizationName: user.organization?.name || null,
    emailVerified: user.emailVerified,
    preferences: parsePreferences(user.preferences),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

// ============================================================================
// Preferences Utilities
// ============================================================================

/**
 * Default preferences for new users
 */
export const defaultPreferences: UserPreferences = {
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
 * Parse preferences from database (handles null/undefined/JSON)
 */
export function parsePreferences(raw: any): UserPreferences {
  if (!raw) {
    return { ...defaultPreferences };
  }
  
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return mergePreferences(defaultPreferences, parsed);
  } catch {
    return { ...defaultPreferences };
  }
}

/**
 * Merge partial preferences with existing preferences
 */
export function mergePreferences(
  existing: UserPreferences,
  updates: UpdatePreferencesInput
): UserPreferences {
  return {
    notifications: {
      ...existing.notifications,
      ...updates.notifications,
    },
    ui: {
      ...existing.ui,
      ...updates.ui,
    },
    privacy: {
      ...existing.privacy,
      ...updates.privacy,
    },
  };
}

/**
 * Validate timezone string
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Activity Utilities
// ============================================================================

/**
 * Create activity log entry data
 */
export function createActivityEntry(params: {
  userId: string;
  action: ActivityAction;
  resourceType: ResourceType;
  resourceId?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}): Omit<ActivityLogEntry, 'id' | 'createdAt'> {
  return {
    userId: params.userId,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId || null,
    metadata: params.metadata || {},
    ipAddress: params.ipAddress || null,
    userAgent: params.userAgent || null,
  };
}

/**
 * Format activity action for display
 */
export function formatActivityAction(action: ActivityAction): string {
  const actionLabels: Record<ActivityAction, string> = {
    LOGIN: 'Logged in',
    LOGOUT: 'Logged out',
    PASSWORD_CHANGE: 'Changed password',
    PROFILE_UPDATE: 'Updated profile',
    POLICY_CREATE: 'Created policy',
    POLICY_UPDATE: 'Updated policy',
    POLICY_DELETE: 'Deleted policy',
    POLICY_EXPORT: 'Exported policy',
    QUERY_SUBMIT: 'Submitted compliance query',
    DOCUMENT_UPLOAD: 'Uploaded document',
    DOCUMENT_DELETE: 'Deleted document',
    ORG_JOIN: 'Joined organization',
    ORG_LEAVE: 'Left organization',
    SETTINGS_CHANGE: 'Changed settings',
  };
  
  return actionLabels[action] || action;
}

/**
 * Get activity icon based on action
 */
export function getActivityIcon(action: ActivityAction): string {
  const icons: Record<ActivityAction, string> = {
    LOGIN: '🔑',
    LOGOUT: '👋',
    PASSWORD_CHANGE: '🔒',
    PROFILE_UPDATE: '👤',
    POLICY_CREATE: '📝',
    POLICY_UPDATE: '✏️',
    POLICY_DELETE: '🗑️',
    POLICY_EXPORT: '📤',
    QUERY_SUBMIT: '❓',
    DOCUMENT_UPLOAD: '📄',
    DOCUMENT_DELETE: '🗑️',
    ORG_JOIN: '🏢',
    ORG_LEAVE: '🚪',
    SETTINGS_CHANGE: '⚙️',
  };
  
  return icons[action] || '📌';
}

// ============================================================================
// Stats Utilities
// ============================================================================

/**
 * Calculate days since a date
 */
export function daysSince(date: Date): number {
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Calculate remaining quota
 */
export function calculateRemainingQuota(
  used: number,
  limit: number
): { remaining: number; percentage: number } {
  const remaining = Math.max(0, limit - used);
  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;
  
  return { remaining, percentage };
}

// ============================================================================
// Data Export Utilities
// ============================================================================

/**
 * Generate data export filename
 */
export function generateExportFilename(userId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sheriabot-data-export-${userId}-${timestamp}.json`;
}

/**
 * Anonymize user data for soft delete
 */
export function anonymizeUserData(userId: string): {
  email: string;
  name: string;
  phone: null;
} {
  const anonymousId = userId.slice(0, 8);
  return {
    email: `deleted-${anonymousId}@anonymous.sheriabot.com`,
    name: `Deleted User ${anonymousId}`,
    phone: null,
  };
}

// ============================================================================
// Email Templates
// ============================================================================

/**
 * Generate account deletion confirmation email
 */
export function generateDeletionEmail(
  name: string,
  scheduledDate: Date,
  downloadUrl?: string
): { subject: string; text: string; html: string } {
  const formattedDate = scheduledDate.toLocaleDateString('en-KE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  
  return {
    subject: 'Your SheriaBot Account Deletion Request',
    text: `
Hi ${name},

We've received your request to delete your SheriaBot account.

Your account will be permanently deleted on ${formattedDate}.

If you change your mind, you can cancel this request by logging in before that date.

${downloadUrl ? `Your data export is available for download: ${downloadUrl}` : ''}

If you didn't request this, please contact our support team immediately.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #dc2626;">Account Deletion Request</h2>
    <p>Hi ${name},</p>
    <p>We've received your request to delete your SheriaBot account.</p>
    <p style="background: #fef2f2; padding: 15px; border-radius: 8px; border-left: 4px solid #dc2626;">
      Your account will be permanently deleted on <strong>${formattedDate}</strong>.
    </p>
    <p>If you change your mind, you can cancel this request by logging in before that date.</p>
    ${downloadUrl ? `
    <p style="text-align: center; margin: 30px 0;">
      <a href="${downloadUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        Download Your Data
      </a>
    </p>
    ` : ''}
    <p style="color: #666; font-size: 14px;">
      If you didn't request this, please contact our support team immediately.
    </p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
      Best regards,<br>
      The SheriaBot Team
    </p>
  </div>
</body>
</html>
    `.trim(),
  };
}

/**
 * Generate email change verification email
 */
export function generateEmailChangeEmail(
  name: string,
  newEmail: string,
  verificationUrl: string
): { subject: string; text: string; html: string } {
  return {
    subject: 'Verify Your New Email Address - SheriaBot',
    text: `
Hi ${name},

You requested to change your email address to ${newEmail}.

Please verify this new email by clicking the link below:

${verificationUrl}

This link will expire in 24 hours.

If you didn't request this change, please ignore this email and your email will remain unchanged.

Best regards,
The SheriaBot Team
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #2563eb;">Verify Your New Email</h2>
    <p>Hi ${name},</p>
    <p>You requested to change your email address to <strong>${newEmail}</strong>.</p>
    <p style="text-align: center; margin: 30px 0;">
      <a href="${verificationUrl}" 
         style="background-color: #2563eb; color: white; padding: 12px 24px; 
                text-decoration: none; border-radius: 6px; display: inline-block;">
        Verify New Email
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">
      This link will expire in 24 hours.
    </p>
    <p style="color: #666; font-size: 14px;">
      If you didn't request this change, please ignore this email.
    </p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
    <p style="color: #999; font-size: 12px;">
      Best regards,<br>
      The SheriaBot Team
    </p>
  </div>
</body>
</html>
    `.trim(),
  };
}