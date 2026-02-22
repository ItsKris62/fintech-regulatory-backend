import { z } from 'zod';
import { phoneSchema } from '@/utils/validation';

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