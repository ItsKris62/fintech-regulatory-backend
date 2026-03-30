import { z } from 'zod';
import { phoneSchema } from '@/utils/validation';
import { AVATAR_UPLOAD_LIMITS } from '@/config/upload-limits.config';

/**
 * User Schemas
 * 
 * Zod validation schemas for user management operations.
 */

/**
 * Update user profile
 * 
 * @example
 * {
 *   name: "John Doe Updated",
 *   phone: "+254700123456"
 * }
 */
export const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: phoneSchema.optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * Update user preferences
 * 
 * @example
 * {
 *   theme: "dark",
 *   notifications: {
 *     email: true,
 *     push: false
 *   },
 *   language: "en"
 * }
 */
export const updatePreferencesSchema = z.object({
  preferences: z.record(z.string(), z.any()),
});

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

/**
 * Delete account confirmation
 * 
 * @example
 * {
 *   confirmEmail: "user@example.com"
 * }
 */
export const deleteAccountSchema = z.object({
  confirmEmail: z.string().email(),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

/**
 * Revoke a specific session
 */
export const revokeSessionSchema = z.object({
  sessionId: z.string().min(1),
});

export type RevokeSessionInput = z.infer<typeof revokeSessionSchema>;

/**
 * TOTP setup initiation (no input needed — kept for procedure consistency)
 */
export const setupTotpSchema = z.object({}).optional();

export type SetupTotpInput = z.infer<typeof setupTotpSchema>;

/**
 * Confirm TOTP setup with a 6-digit code from the authenticator app
 */
export const confirmTotpSchema = z.object({
  code: z
    .string()
    .length(6, 'Code must be exactly 6 digits')
    .regex(/^\d+$/, 'Code must only contain digits'),
});

export type ConfirmTotpInput = z.infer<typeof confirmTotpSchema>;

/**
 * Disable TOTP — requires current password for security
 */
export const disableTotpSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export type DisableTotpInput = z.infer<typeof disableTotpSchema>;

/**
 * Update all notification preferences (covers all 11 fields across all sections)
 *
 * All fields optional — supports partial updates (only send changed fields).
 * Backward-compatible with the existing 4-field "Specific Email Alerts" section.
 */
/**
 * Request a presigned upload URL for the user's avatar
 */
export const getAvatarUploadUrlSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileSize: z
    .number()
    .int()
    .min(1)
    .max(AVATAR_UPLOAD_LIMITS.maxFileSizeMB * 1024 * 1024, `Avatar must not exceed ${AVATAR_UPLOAD_LIMITS.maxFileSizeMB} MB`),
});

export type GetAvatarUploadUrlInput = z.infer<typeof getAvatarUploadUrlSchema>;

/**
 * Confirm avatar upload — persists the public URL after a successful R2 PUT
 */
export const confirmAvatarUploadSchema = z.object({
  publicUrl: z.string().url('Must be a valid URL'),
});

export type ConfirmAvatarUploadInput = z.infer<typeof confirmAvatarUploadSchema>;

/**
 * Update all notification preferences (covers all 11 fields across all sections)
 *
 * All fields optional — supports partial updates (only send changed fields).
 * Backward-compatible with the existing 4-field "Specific Email Alerts" section.
 */
export const updateAllNotificationPreferencesSchema = z.object({
  // General Email Notifications
  regulatoryUpdates: z.boolean().optional(),
  deadlineReminders: z.boolean().optional(),
  reportReady: z.boolean().optional(),
  supportResponses: z.boolean().optional(),
  // Specific Email Alerts (existing 4 — kept for backward compatibility)
  paymentDueReminder: z.boolean().optional(),
  complianceQueryReady: z.boolean().optional(),
  policyDocumentReady: z.boolean().optional(),
  documentIngestionComplete: z.boolean().optional(),
  // In-App Notifications
  realTimeAlerts: z.boolean().optional(),
  // Email Digest
  emailDigestEnabled: z.boolean().optional(),
  digestFrequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
});

export type UpdateAllNotificationPreferencesInput = z.infer<typeof updateAllNotificationPreferencesSchema>;