/**
 * Centralized Auth Error Messages
 *
 * Single source of truth for all auth-related error codes and their
 * corresponding user-facing messages.
 *
 * SECURITY RULES enforced here:
 * - Login/signup errors never reveal whether a specific email exists.
 * - Password reset always returns the same message regardless of email existence.
 * - Rate-limit messages include retry guidance without exposing attempt counts.
 * - Server errors never expose stack traces or internal details.
 */

// -- Error code registry -------------------------------------------------------

export const AUTH_ERROR_CODES = {
  // Credentials / session
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',

  // Verification / status
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_PENDING_APPROVAL: 'ACCOUNT_PENDING_APPROVAL',
  ACCOUNT_NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',

  // Registration
  EMAIL_UNAVAILABLE: 'EMAIL_UNAVAILABLE',
  FREE_EMAIL_NOT_ALLOWED: 'FREE_EMAIL_NOT_ALLOWED',
  REGULATOR_EMAIL_REQUIRED: 'REGULATOR_EMAIL_REQUIRED',
  REGISTRATION_FAILED: 'REGISTRATION_FAILED',

  // Password policy
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  COMMON_PASSWORD: 'COMMON_PASSWORD',
  PASSWORD_CONTAINS_EMAIL: 'PASSWORD_CONTAINS_EMAIL',
  PASSWORD_HAS_SEQUENCES: 'PASSWORD_HAS_SEQUENCES',
  PASSWORD_MISMATCH: 'PASSWORD_MISMATCH',

  // Password reset
  INVALID_RESET_TOKEN: 'INVALID_RESET_TOKEN',
  RESET_PASSWORD_FAILED: 'RESET_PASSWORD_FAILED',

  // Email verification
  INVALID_VERIFICATION_TOKEN: 'INVALID_VERIFICATION_TOKEN',

  // Rate limiting
  RATE_LIMITED_LOGIN: 'RATE_LIMITED_LOGIN',
  RATE_LIMITED_REGISTER: 'RATE_LIMITED_REGISTER',
  RATE_LIMITED_RESET: 'RATE_LIMITED_RESET',
  RATE_LIMITED_RESEND: 'RATE_LIMITED_RESEND',

  // Input format
  INVALID_EMAIL_FORMAT: 'INVALID_EMAIL_FORMAT',

  // Infrastructure
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

// -- User-facing message map ---------------------------------------------------

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  // Credentials / session  -  generic to prevent enumeration
  INVALID_CREDENTIALS:
    'Invalid email or password. Please check your credentials and try again.',
  SESSION_EXPIRED:
    'Your session has expired. Please sign in again to continue.',
  ACCOUNT_DEACTIVATED:
    'Invalid email or password. Please check your credentials and try again.',

  // Verification / status
  EMAIL_NOT_VERIFIED:
    "Your email hasn't been verified yet. Check your inbox for the verification link, or click below to resend it.",
  ACCOUNT_PENDING_APPROVAL:
    'Your account is pending admin approval. You will be notified by email once approved.',
  ACCOUNT_NOT_ACTIVE:
    'Your account is not active. Please contact support@sheriabot.com for assistance.',

  // Registration  -  safe: never reveal whether email is registered
  EMAIL_UNAVAILABLE:
    "If this email is available, you'll receive a verification link shortly. Check your inbox (and spam folder).",
  FREE_EMAIL_NOT_ALLOWED:
    'Please use your business email address. Free email providers (e.g., Gmail, Yahoo) are not accepted for organizational accounts.',
  REGULATOR_EMAIL_REQUIRED:
    'Regulator accounts require a verified government email address (e.g., @cbk.go.ke, @cma.or.ke).',
  REGISTRATION_FAILED:
    'Registration failed. Please try again. If the problem continues, contact support@sheriabot.com.',

  // Password policy  -  granular, actionable
  WEAK_PASSWORD:
    'Password does not meet the required complexity. Please review the requirements below.',
  COMMON_PASSWORD:
    'This password is too commonly used and could be easily guessed. Try combining unrelated words or a passphrase.',
  PASSWORD_CONTAINS_EMAIL:
    'Password must not contain your email address or username.',
  PASSWORD_HAS_SEQUENCES:
    'Avoid keyboard patterns or sequential characters (e.g., "abcd", "1234", "qwer").',
  PASSWORD_MISMATCH:
    "Passwords don't match. Please re-enter to confirm.",

  // Password reset
  INVALID_RESET_TOKEN:
    'This password reset link is invalid or has expired. Please request a new one.',
  RESET_PASSWORD_FAILED:
    'Failed to reset your password. Please try again.',

  // Email verification
  INVALID_VERIFICATION_TOKEN:
    'This verification link is invalid or has expired. Please request a new verification email.',

  // Rate limiting  -  includes guidance
  RATE_LIMITED_LOGIN:
    'Too many sign-in attempts. Please wait 15 minutes before trying again, or reset your password.',
  RATE_LIMITED_REGISTER:
    'Too many registration attempts from this address. Please try again in an hour.',
  RATE_LIMITED_RESET:
    'Too many reset requests. Please wait an hour before requesting another link.',
  RATE_LIMITED_RESEND:
    'Too many verification email requests. Please try again in an hour.',

  // Input format
  INVALID_EMAIL_FORMAT:
    'Please enter a valid email address (e.g., name@company.com).',

  // Infrastructure
  NETWORK_ERROR:
    "We couldn't reach our servers. Please check your internet connection and try again.",
  SERVER_ERROR:
    'Something unexpected happened on our end. Please try again. If this continues, contact support@sheriabot.com.',
};

/**
 * Returns the user-facing message for a given auth error code.
 * Falls back to a generic server error message for unknown codes.
 */
export function getAuthErrorMessage(code: AuthErrorCode | string): string {
  return AUTH_ERROR_MESSAGES[code as AuthErrorCode] ?? AUTH_ERROR_MESSAGES.SERVER_ERROR;
}
