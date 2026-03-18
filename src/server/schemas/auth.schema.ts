import { z } from 'zod';
import { emailSchema, passwordSchema, phoneSchema } from '@/utils/validation';

/**
 * Auth Schemas
 * 
 * Zod validation schemas for authentication operations.
 * Reuses validation schemas from Phase 1 utilities.
 */

/**
 * Register new user
 * 
 * @example
 * {
 *   email: "user@example.com",
 *   password: "SecurePass123!",
 *   name: "John Doe",
 *   role: "STARTUP",
 *   organizationId: "org_123" // optional
 * }
 */
export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name must be less than 100 characters'),
  role: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE'], {
    error: 'Role must be REGULATOR, STARTUP, or ENTERPRISE',
  }),
  companyName: z.string().min(2, 'Organization name must be at least 2 characters').max(200).optional(),
  organizationId: z.string().optional(),
  phone: phoneSchema.optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Login with email and password
 * 
 * @example
 * {
 *   email: "user@example.com",
 *   password: "SecurePass123!"
 * }
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Request password reset
 * 
 * @example
 * {
 *   email: "user@example.com"
 * }
 */
export const resetPasswordRequestSchema = z.object({
  email: emailSchema,
});

export type ResetPasswordRequestInput = z.infer<typeof resetPasswordRequestSchema>;

/**
 * Reset password with token
 * 
 * @example
 * {
 *   token: "reset_token_123",
 *   newPassword: "NewSecurePass123!"
 * }
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Change password (authenticated)
 *
 * confirmPassword is validated both client-side and server-side.
 * The backend enforces the match so that a direct API call cannot bypass it.
 *
 * @example
 * {
 *   currentPassword: "OldPass123!",
 *   newPassword: "NewSecurePass123!",
 *   confirmPassword: "NewSecurePass123!"
 * }
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'New password and confirmation do not match',
    path: ['confirmPassword'],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Verify email with token
 * 
 * @example
 * {
 *   token: "verify_token_123"
 * }
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

/**
 * Refresh access token
 * 
 * @example
 * {
 *   refreshToken: "refresh_token_123"
 * }
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;