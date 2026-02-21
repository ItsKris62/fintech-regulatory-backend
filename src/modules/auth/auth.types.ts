/**
 * Auth Module Types
 * Type definitions for authentication operations
 */

// User and UserRole are not directly exported from @prisma/client in Prisma v7
// Using string-based type for UserRole
type UserRole = string;

// ============================================================================
// Input Types
// ============================================================================

/**
 * Input for user registration
 */
export interface RegisterUserInput {
  email: string;
  password: string;
  name: string;
  role?: UserRole;
  organizationId?: string;
  phone?: string;
}

/**
 * Input for user login
 */
export interface LoginInput {
  email: string;
  password: string;
  rememberMe?: boolean;
}

/**
 * Input for password reset
 */
export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

/**
 * Input for password change
 */
export interface ChangePasswordInput {
  userId: string;
  oldPassword: string;
  newPassword: string;
}

// ============================================================================
// Output Types
// ============================================================================

/**
 * Authentication result returned after successful login/register
 */
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: SafeUser;
  expiresIn: number;
  tokenType: 'Bearer';
}

/**
 * User data without sensitive fields
 */
export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  organizationId: string | null;
  emailVerified: boolean;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Token refresh result
 */
export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Password reset request result
 */
export interface PasswordResetRequestResult {
  success: boolean;
  message: string;
  expiresAt?: Date;
}

/**
 * Email verification result
 */
export interface EmailVerificationResult {
  success: boolean;
  message: string;
  user?: SafeUser;
}

/**
 * Session revocation result
 */
export interface SessionRevocationResult {
  success: boolean;
  sessionsRevoked: number;
  message: string;
}

// ============================================================================
// Session & Token Types
// ============================================================================

/**
 * Session data stored in Redis
 */
export interface SessionData {
  userId: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * JWT payload structure
 */
export interface JWTPayload {
  sub: string; // userId
  email: string;
  role: UserRole;
  organizationId: string | null;
  sessionId: string;
  iat: number;
  exp: number;
}

/**
 * Refresh token data stored in Redis
 */
export interface RefreshTokenData {
  userId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  rotationCount: number;
}

// ============================================================================
// Rate Limiting & Security Types
// ============================================================================

/**
 * Login attempt tracking
 */
export interface LoginAttempt {
  email: string;
  attempts: number;
  lastAttempt: string;
  lockedUntil?: string;
}

/**
 * Password reset token data
 */
export interface PasswordResetToken {
  userId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Email verification token data
 */
export interface EmailVerificationToken {
  userId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

// ============================================================================
// Password History Types
// ============================================================================

/**
 * Password history entry for preventing reuse
 */
export interface PasswordHistoryEntry {
  hash: string;
  createdAt: string;
}

// ============================================================================
// Constants
// ============================================================================

export const AUTH_CONSTANTS = {
  // Token expiration times (in seconds)
  ACCESS_TOKEN_EXPIRY: 15 * 60, // 15 minutes
  REFRESH_TOKEN_EXPIRY: 30 * 24 * 60 * 60, // 30 days
  PASSWORD_RESET_EXPIRY: 60 * 60, // 1 hour
  EMAIL_VERIFICATION_EXPIRY: 24 * 60 * 60, // 24 hours
  
  // Rate limiting
  MAX_LOGIN_ATTEMPTS: 5,
  LOGIN_LOCKOUT_DURATION: 15 * 60, // 15 minutes
  MAX_PASSWORD_RESET_REQUESTS: 3,
  PASSWORD_RESET_WINDOW: 60 * 60, // 1 hour
  
  // Password history
  PASSWORD_HISTORY_COUNT: 3,
  
  // Session settings
  SESSION_EXPIRY: 30 * 24 * 60 * 60, // 30 days
  
  // Redis key prefixes
  REDIS_KEYS: {
    SESSION: 'session:',
    REFRESH_TOKEN: 'refresh_token:',
    LOGIN_ATTEMPTS: 'login_attempts:',
    PASSWORD_RESET: 'password_reset:',
    EMAIL_VERIFICATION: 'email_verification:',
    PASSWORD_HISTORY: 'password_history:',
  },
} as const;

// ============================================================================
// Error Types
// ============================================================================

export class AuthError extends Error {
  constructor(
    message: string,
    public code: AuthErrorCode,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'USER_NOT_FOUND'
  | 'EMAIL_ALREADY_EXISTS'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'ACCOUNT_LOCKED'
  | 'EMAIL_NOT_VERIFIED'
  | 'PASSWORD_TOO_WEAK'
  | 'PASSWORD_RECENTLY_USED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SESSION_EXPIRED'
  | 'INVALID_REFRESH_TOKEN'
  | 'UNAUTHORIZED';