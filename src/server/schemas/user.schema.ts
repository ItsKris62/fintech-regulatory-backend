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