/**
 * Auth Module
 * Handles all authentication-related business logic for SheriaBot
 * 
 * Operations:
 * - User registration with email verification
 * - User authentication with rate limiting
 * - Token refresh with rotation
 * - Password reset flow
 * - Email verification
 * - Password change with history tracking
 * - Session management
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';
import {
  hashPassword,
  verifyPassword,
  isPasswordRecentlyUsed,
  generateToken,
  generateSessionId,
  generateRefreshTokenId,
  emailSchema,
  validatePasswordStrength,
  createSessionData,
  toSafeUser,
  calculateLockoutRemaining,
  formatLockoutMessage,
  generatePasswordResetEmail,
  generateWelcomeEmail,
} from './auth.utils';
import { sendEmail } from '@/lib/email/client';

// Stubs: JWT token generation replaced by Supabase Auth in auth.router.ts.
// These methods in AuthModule are legacy/dead code — kept for reference only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const generateAccessToken = (_user: any, _sessionId: string, _secret: string): string => '';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const generateRefreshToken = (_userId: string, _tokenId: string, _secret: string): string => '';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const verifyToken = <T>(_token: string, _secret: string): T => {
  throw new Error('JWT auth replaced by Supabase — use auth.router.ts procedures');
};
import {
  type RegisterUserInput,
  type AuthResult,
  type TokenRefreshResult,
  type PasswordResetRequestResult,
  type EmailVerificationResult,
  type SessionRevocationResult,
  type SessionData,
  type LoginAttempt,
  type RefreshTokenData,
  type PasswordResetToken,
  type EmailVerificationToken,
  type PasswordHistoryEntry,
  AUTH_CONSTANTS,
  AuthError,
} from './auth.types';

/**
 * Authentication Module Class
 * Encapsulates all authentication business logic
 */
class AuthModule {
  private readonly appUrl: string;

  constructor() {
    this.appUrl = appConfig.appUrl || 'http://localhost:3000';
  }

  // ==========================================================================
  // REGISTRATION
  // ==========================================================================

  /**
   * Register a new user
   * - Validates email uniqueness
   * - Validates password strength
   * - Creates user in database
   * - Sends verification email
   */
  async registerUser(params: RegisterUserInput): Promise<AuthResult> {
    logger.info({
      type: 'auth_register_started',
      email: params.email,
    });

    try {
      // 1. Validate email format
      const validatedEmail = emailSchema.parse(params.email);

      // 2. Validate password strength
      const passwordValidation = validatePasswordStrength(params.password);
      if (!passwordValidation.isValid) {
        // Log specific failures internally — never expose rule details to clients.
        logger.warn({
          type: 'auth_register_password_weak',
          email: params.email,
          reasons: passwordValidation.errors,
          score: passwordValidation.score,
        });
        throw new AuthError(
          'Password does not meet complexity requirements',
          'PASSWORD_TOO_WEAK',
          400
        );
      }

      // 3. Check if email already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: validatedEmail },
      });

      if (existingUser) {
        throw new AuthError(
          'An account with this email already exists',
          'EMAIL_ALREADY_EXISTS',
          409
        );
      }

      // 4. Hash password
      const hashedPassword = await hashPassword(params.password);

      // 5. Create user in database
      const user = await prisma.user.create({
        data: {
          email: validatedEmail,
          password: hashedPassword,
          fullName: params.name,
          role: (params.role as any) || 'STARTUP',
          organizationId: params.organizationId,
          phone: params.phone,
          emailVerified: false,
        },
      });

      // 6. Initialize password history
      await this.addToPasswordHistory(user.id, hashedPassword);

      // 7. Generate email verification token
      const verificationToken = generateToken(32);
      await this.storeEmailVerificationToken(user.id, validatedEmail, verificationToken);

      // 8. Send welcome email with verification link
      const verificationUrl = `${this.appUrl}/verify-email?token=${verificationToken}`;
      const emailContent = generateWelcomeEmail(user.fullName, verificationUrl);
      
      await sendEmail({
        to: user.email,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });

      // 9. Create session and generate tokens
      const sessionId = generateSessionId();
      const safeUser = toSafeUser(user);
      const sessionData = createSessionData(safeUser);
      
      await this.storeSession(sessionId, sessionData);

      const accessToken = generateAccessToken(safeUser, sessionId, (process.env.SUPABASE_JWT_SECRET!));
      const refreshTokenId = generateRefreshTokenId();
      const refreshToken = generateRefreshToken(user.id, refreshTokenId, (process.env.SUPABASE_JWT_SECRET!));
      
      await this.storeRefreshToken(refreshTokenId, user.id, sessionId);

      logger.info({
        type: 'auth_register_success',
        userId: user.id,
        email: user.email,
      });

      return {
        accessToken,
        refreshToken,
        user: safeUser,
        expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_EXPIRY,
        tokenType: 'Bearer',
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_register_error',
        email: params.email,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // AUTHENTICATION
  // ==========================================================================

  /**
   * Authenticate user with email and password
   * - Rate limits login attempts
   * - Tracks failed attempts
   * - Generates session and tokens
   */
  async authenticateUser(
    email: string,
    password: string,
    options?: { userAgent?: string; ipAddress?: string }
  ): Promise<AuthResult> {
    logger.info({
      type: 'auth_login_started',
      email,
    });

    try {
      // 1. Validate email format
      const validatedEmail = emailSchema.parse(email);

      // 2. Check rate limit / lockout
      const loginAttempts = await this.getLoginAttempts(validatedEmail);
      
      if (loginAttempts?.lockedUntil) {
        const remainingSeconds = calculateLockoutRemaining(loginAttempts.lockedUntil);
        if (remainingSeconds > 0) {
          throw new AuthError(
            formatLockoutMessage(remainingSeconds),
            'ACCOUNT_LOCKED',
            429
          );
        }
      }

      // 3. Find user by email
      const user = await prisma.user.findUnique({
        where: { email: validatedEmail },
      });

      if (!user) {
        await this.recordFailedLoginAttempt(validatedEmail);
        throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
      }

      // 4. Verify password
      if (!user.password) {
        throw new AuthError('Password verification unavailable. Please reset your password.', 'INVALID_CREDENTIALS', 401);
      }
      const isValidPassword = await verifyPassword(password, user.password);
      
      if (!isValidPassword) {
        await this.recordFailedLoginAttempt(validatedEmail);
        throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
      }

      // 5. Clear failed login attempts on success
      await this.clearLoginAttempts(validatedEmail);

      // 6. Create session
      const sessionId = generateSessionId();
      const safeUser = toSafeUser(user);
      const sessionData = createSessionData(safeUser, options);
      
      await this.storeSession(sessionId, sessionData);

      // 7. Generate tokens
      const accessToken = generateAccessToken(safeUser, sessionId, (process.env.SUPABASE_JWT_SECRET!));
      const refreshTokenId = generateRefreshTokenId();
      const refreshToken = generateRefreshToken(user.id, refreshTokenId, (process.env.SUPABASE_JWT_SECRET!));
      
      await this.storeRefreshToken(refreshTokenId, user.id, sessionId);

      // 8. Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      logger.info({
        type: 'auth_login_success',
        userId: user.id,
        email: user.email,
      });

      return {
        accessToken,
        refreshToken,
        user: safeUser,
        expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_EXPIRY,
        tokenType: 'Bearer',
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_login_error',
        email,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // TOKEN REFRESH
  // ==========================================================================

  /**
   * Refresh access token using refresh token
   * - Validates refresh token
   * - Rotates refresh token (security)
   * - Extends session
   */
  async refreshToken(refreshTokenString: string): Promise<TokenRefreshResult> {
    logger.info({ type: 'auth_token_refresh_started' });

    try {
      // 1. Verify and decode refresh token
      const decoded = verifyToken<{ sub: string; jti: string }>(
        refreshTokenString,
        (process.env.SUPABASE_JWT_SECRET!)
      );

      // 2. Check if refresh token is valid in Redis
      const refreshTokenData = await this.getRefreshToken(decoded.jti);
      
      if (!refreshTokenData) {
        throw new AuthError('Invalid refresh token', 'INVALID_REFRESH_TOKEN', 401);
      }

      // 3. Get session
      const sessionData = await this.getSession(refreshTokenData.sessionId);
      
      if (!sessionData) {
        throw new AuthError('Session expired', 'SESSION_EXPIRED', 401);
      }

      // 4. Get user
      const user = await prisma.user.findUnique({
        where: { id: decoded.sub },
      });

      if (!user) {
        // Do not reveal whether the account exists — treat as an invalid token.
        throw new AuthError('Invalid refresh token', 'INVALID_REFRESH_TOKEN', 401);
      }

      // 5. Rotate refresh token (invalidate old, create new)
      await this.deleteRefreshToken(decoded.jti);

      const safeUser = toSafeUser(user);
      const newAccessToken = generateAccessToken(
        safeUser,
        refreshTokenData.sessionId,
        (process.env.SUPABASE_JWT_SECRET!)
      );

      const newRefreshTokenId = generateRefreshTokenId();
      const newRefreshToken = generateRefreshToken(
        user.id,
        newRefreshTokenId,
        (process.env.SUPABASE_JWT_SECRET!)
      );

      await this.storeRefreshToken(
        newRefreshTokenId,
        user.id,
        refreshTokenData.sessionId,
        refreshTokenData.rotationCount + 1
      );

      // 6. Extend session
      await this.extendSession(refreshTokenData.sessionId);

      logger.info({
        type: 'auth_token_refresh_success',
        userId: user.id,
      });

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: AUTH_CONSTANTS.ACCESS_TOKEN_EXPIRY,
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_token_refresh_error',
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // PASSWORD RESET
  // ==========================================================================

  /**
   * Request password reset
   * - Rate limited (3 per hour)
   * - Generates reset token
   * - Sends email
   */
  async requestPasswordReset(email: string): Promise<PasswordResetRequestResult> {
    logger.info({
      type: 'auth_password_reset_requested',
      email,
    });

    try {
      // 1. Validate email
      const validatedEmail = emailSchema.parse(email);

      // 2. Check rate limit
      const resetKey = `${AUTH_CONSTANTS.REDIS_KEYS.PASSWORD_RESET}rate:${validatedEmail}`;
      const resetCount = await redis.incr(resetKey);
      
      if (resetCount === 1) {
        await redis.expire(resetKey, AUTH_CONSTANTS.PASSWORD_RESET_WINDOW);
      }
      
      if (resetCount > AUTH_CONSTANTS.MAX_PASSWORD_RESET_REQUESTS) {
        throw new AuthError(
          'Too many password reset requests. Please try again later.',
          'RATE_LIMIT_EXCEEDED',
          429
        );
      }

      // 3. Find user (don't reveal if user doesn't exist)
      const user = await prisma.user.findUnique({
        where: { email: validatedEmail },
      });

      // Always return success to prevent email enumeration
      if (!user) {
        logger.info({
          type: 'auth_password_reset_user_not_found',
          email: validatedEmail,
        });
        
        return {
          success: true,
          message: 'If an account exists, you will receive a password reset email.',
        };
      }

      // 4. Generate reset token
      const resetToken = generateToken(32);
      await this.storePasswordResetToken(user.id, validatedEmail, resetToken);

      // 5. Send reset email
      const resetUrl = `${this.appUrl}/reset-password?token=${resetToken}`;
      const emailContent = generatePasswordResetEmail(user.fullName, resetUrl);
      
      await sendEmail({
        to: user.email,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });

      logger.info({
        type: 'auth_password_reset_email_sent',
        userId: user.id,
      });

      return {
        success: true,
        message: 'If an account exists, you will receive a password reset email.',
        expiresAt: new Date(Date.now() + AUTH_CONSTANTS.PASSWORD_RESET_EXPIRY * 1000),
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_password_reset_error',
        email,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Reset password with token
   * - Validates token
   * - Validates new password
   * - Checks password history
   * - Updates password
   * - Revokes all sessions
   */
  async resetPassword(
    token: string,
    newPassword: string
  ): Promise<{ success: boolean; message: string }> {
    logger.info({ type: 'auth_password_reset_started' });

    try {
      // 1. Get and validate reset token
      const resetTokenData = await this.getPasswordResetToken(token);
      
      if (!resetTokenData) {
        throw new AuthError('Invalid or expired reset token', 'INVALID_TOKEN', 400);
      }

      // 2. Check token expiry
      if (new Date(resetTokenData.expiresAt) < new Date()) {
        await this.deletePasswordResetToken(token);
        throw new AuthError('Reset token has expired', 'TOKEN_EXPIRED', 400);
      }

      // 3. Validate new password strength
      const passwordValidation = validatePasswordStrength(newPassword);
      if (!passwordValidation.isValid) {
        // Log specific failures internally — never expose rule details to clients.
        logger.warn({
          type: 'auth_password_reset_weak',
          userId: resetTokenData.userId,
          reasons: passwordValidation.errors,
          score: passwordValidation.score,
        });
        throw new AuthError(
          'Password does not meet complexity requirements',
          'PASSWORD_TOO_WEAK',
          400
        );
      }

      // 4. Check password history
      const passwordHistory = await this.getPasswordHistory(resetTokenData.userId);
      const isRecentlyUsed = await isPasswordRecentlyUsed(newPassword, passwordHistory);
      
      if (isRecentlyUsed) {
        throw new AuthError(
          'Cannot reuse a recent password. Please choose a different password.',
          'PASSWORD_RECENTLY_USED',
          400
        );
      }

      // 5. Hash new password
      const hashedPassword = await hashPassword(newPassword);

      // 6. Update user password
      await prisma.user.update({
        where: { id: resetTokenData.userId },
        data: { password: hashedPassword },
      });

      // 7. Add to password history
      await this.addToPasswordHistory(resetTokenData.userId, hashedPassword);

      // 8. Invalidate reset token
      await this.deletePasswordResetToken(token);

      // 9. Revoke all sessions
      await this.revokeAllSessions(resetTokenData.userId);

      logger.info({
        type: 'auth_password_reset_success',
        userId: resetTokenData.userId,
      });

      return {
        success: true,
        message: 'Password has been reset successfully. Please log in with your new password.',
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_password_reset_error',
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // EMAIL VERIFICATION
  // ==========================================================================

  /**
   * Verify user email with token
   */
  async verifyEmail(token: string): Promise<EmailVerificationResult> {
    logger.info({ type: 'auth_email_verification_started' });

    try {
      // 1. Get verification token data
      const tokenData = await this.getEmailVerificationToken(token);
      
      if (!tokenData) {
        throw new AuthError('Invalid or expired verification token', 'INVALID_TOKEN', 400);
      }

      // 2. Check expiry
      if (new Date(tokenData.expiresAt) < new Date()) {
        await this.deleteEmailVerificationToken(token);
        throw new AuthError('Verification token has expired', 'TOKEN_EXPIRED', 400);
      }

      // 3. Update user
      const user = await prisma.user.update({
        where: { id: tokenData.userId },
        data: { emailVerified: true },
      });

      // 4. Invalidate token
      await this.deleteEmailVerificationToken(token);

      logger.info({
        type: 'auth_email_verification_success',
        userId: user.id,
      });

      return {
        success: true,
        message: 'Email verified successfully.',
        user: toSafeUser(user),
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_email_verification_error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Resend email verification
   */
  async resendEmailVerification(userId: string): Promise<{ success: boolean; message: string }> {
    logger.info({
      type: 'auth_resend_verification_started',
      userId,
    });

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new AuthError('User not found', 'USER_NOT_FOUND', 404);
      }

      if (user.emailVerified) {
        return {
          success: true,
          message: 'Email is already verified.',
        };
      }

      // Generate new verification token
      const verificationToken = generateToken(32);
      await this.storeEmailVerificationToken(user.id, user.email, verificationToken);

      // Send verification email
      const verificationUrl = `${this.appUrl}/verify-email?token=${verificationToken}`;
      const emailContent = generateWelcomeEmail(user.fullName, verificationUrl);
      
      await sendEmail({
        to: user.email,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });

      logger.info({
        type: 'auth_resend_verification_success',
        userId: user.id,
      });

      return {
        success: true,
        message: 'Verification email sent.',
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_resend_verification_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // PASSWORD CHANGE
  // ==========================================================================

  /**
   * Change password for authenticated user
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    currentSessionId?: string
  ): Promise<{ success: boolean; message: string }> {
    logger.info({
      type: 'auth_password_change_started',
      userId,
    });

    try {
      // 1. Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new AuthError('User not found', 'USER_NOT_FOUND', 404);
      }

      // 2. Verify old password
      if (!user.password) {
        throw new AuthError('Password verification unavailable. Please reset your password.', 'INVALID_CREDENTIALS', 401);
      }
      const isValidPassword = await verifyPassword(oldPassword, user.password);
      
      if (!isValidPassword) {
        throw new AuthError('Current password is incorrect', 'INVALID_CREDENTIALS', 401);
      }

      // 3. Validate new password
      const passwordValidation = validatePasswordStrength(newPassword);
      if (!passwordValidation.isValid) {
        // Log specific failures internally — never expose rule details to clients.
        logger.warn({
          type: 'auth_password_change_weak',
          userId,
          reasons: passwordValidation.errors,
          score: passwordValidation.score,
        });
        throw new AuthError(
          'Password does not meet complexity requirements',
          'PASSWORD_TOO_WEAK',
          400
        );
      }

      // 4. Check not same as old password
      if (user.password && await verifyPassword(newPassword, user.password)) {
        throw new AuthError(
          'New password must be different from current password',
          'PASSWORD_RECENTLY_USED',
          400
        );
      }

      // 5. Check password history
      const passwordHistory = await this.getPasswordHistory(userId);
      const isRecentlyUsed = await isPasswordRecentlyUsed(newPassword, passwordHistory);
      
      if (isRecentlyUsed) {
        throw new AuthError(
          'Cannot reuse a recent password',
          'PASSWORD_RECENTLY_USED',
          400
        );
      }

      // 6. Hash and update password
      const hashedPassword = await hashPassword(newPassword);
      
      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // 7. Add to password history
      await this.addToPasswordHistory(userId, hashedPassword);

      // 8. Revoke all sessions except current
      if (currentSessionId) {
        await this.revokeAllSessionsExcept(userId, currentSessionId);
      }

      logger.info({
        type: 'auth_password_change_success',
        userId,
      });

      return {
        success: true,
        message: 'Password changed successfully.',
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_password_change_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // SESSION MANAGEMENT
  // ==========================================================================

  /**
   * Revoke all user sessions (logout from all devices)
   */
  async revokeAllSessions(userId: string): Promise<SessionRevocationResult> {
    logger.info({
      type: 'auth_revoke_all_sessions_started',
      userId,
    });

    try {
      // Get all session keys for user
      const sessionPattern = `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}*`;
      const sessionKeys = await redis.keys(sessionPattern);
      
      let revokedCount = 0;
      
      for (const key of sessionKeys) {
        const sessionData = await redis.get<string>(key);
        if (sessionData) {
          const session: SessionData = JSON.parse(sessionData);
          if (session.userId === userId) {
            await redis.del(key);
            revokedCount++;
          }
        }
      }

      // Also revoke all refresh tokens
      const refreshPattern = `${AUTH_CONSTANTS.REDIS_KEYS.REFRESH_TOKEN}*`;
      const refreshKeys = await redis.keys(refreshPattern);
      
      for (const key of refreshKeys) {
        const tokenData = await redis.get<string>(key);
        if (tokenData) {
          const token: RefreshTokenData = JSON.parse(tokenData);
          if (token.userId === userId) {
            await redis.del(key);
          }
        }
      }

      logger.info({
        type: 'auth_revoke_all_sessions_success',
        userId,
        sessionsRevoked: revokedCount,
      });

      return {
        success: true,
        sessionsRevoked: revokedCount,
        message: `Revoked ${revokedCount} session(s).`,
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_revoke_all_sessions_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Revoke all sessions except the current one
   */
  async revokeAllSessionsExcept(
    userId: string,
    currentSessionId: string
  ): Promise<SessionRevocationResult> {
    logger.info({
      type: 'auth_revoke_other_sessions_started',
      userId,
    });

    try {
      const sessionPattern = `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}*`;
      const sessionKeys = await redis.keys(sessionPattern);
      
      let revokedCount = 0;
      
      for (const key of sessionKeys) {
        if (key === `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}${currentSessionId}`) {
          continue; // Skip current session
        }
        
        const sessionData = await redis.get<string>(key);
        if (sessionData) {
          const session: SessionData = JSON.parse(sessionData);
          if (session.userId === userId) {
            await redis.del(key);
            revokedCount++;
          }
        }
      }

      logger.info({
        type: 'auth_revoke_other_sessions_success',
        userId,
        sessionsRevoked: revokedCount,
      });

      return {
        success: true,
        sessionsRevoked: revokedCount,
        message: `Revoked ${revokedCount} other session(s).`,
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_revoke_other_sessions_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Logout user from current session
   */
  async logout(sessionId: string, refreshTokenId?: string): Promise<{ success: boolean }> {
    logger.info({
      type: 'auth_logout_started',
      sessionId,
    });

    try {
      // Delete session
      await redis.del(`${AUTH_CONSTANTS.REDIS_KEYS.SESSION}${sessionId}`);
      
      // Delete refresh token if provided
      if (refreshTokenId) {
        await redis.del(`${AUTH_CONSTANTS.REDIS_KEYS.REFRESH_TOKEN}${refreshTokenId}`);
      }

      logger.info({
        type: 'auth_logout_success',
        sessionId,
      });

      return { success: true };
    } catch (error: any) {
      logger.error({
        type: 'auth_logout_error',
        sessionId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get user's active sessions
   */
  async getActiveSessions(userId: string): Promise<SessionData[]> {
    const sessionPattern = `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}*`;
    const sessionKeys = await redis.keys(sessionPattern);
    
    const sessions: SessionData[] = [];
    
    for (const key of sessionKeys) {
      const sessionData = await redis.get<string>(key);
      if (sessionData) {
        const session: SessionData = JSON.parse(sessionData);
        if (session.userId === userId) {
          sessions.push(session);
        }
      }
    }
    
    return sessions;
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS - Session Storage
  // ==========================================================================

  private async storeSession(sessionId: string, data: SessionData): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}${sessionId}`;
    await redis.set(
      key,
      JSON.stringify(data),
      { ex: AUTH_CONSTANTS.SESSION_EXPIRY }
    );
  }

  private async getSession(sessionId: string): Promise<SessionData | null> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}${sessionId}`;
    const data = await redis.get<string>(key);
    return data ? JSON.parse(data) : null;
  }

  private async extendSession(sessionId: string): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.SESSION}${sessionId}`;
    await redis.expire(key, AUTH_CONSTANTS.SESSION_EXPIRY);
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS - Refresh Token Storage
  // ==========================================================================

  private async storeRefreshToken(
    tokenId: string,
    userId: string,
    sessionId: string,
    rotationCount: number = 0
  ): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.REFRESH_TOKEN}${tokenId}`;
    const data: RefreshTokenData = {
      userId,
      sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + AUTH_CONSTANTS.REFRESH_TOKEN_EXPIRY * 1000
      ).toISOString(),
      rotationCount,
    };
    
    await redis.set(
      key,
      JSON.stringify(data),
      { ex: AUTH_CONSTANTS.REFRESH_TOKEN_EXPIRY }
    );
  }

  private async getRefreshToken(tokenId: string): Promise<RefreshTokenData | null> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.REFRESH_TOKEN}${tokenId}`;
    const data = await redis.get<string>(key);
    return data ? JSON.parse(data) : null;
  }

  private async deleteRefreshToken(tokenId: string): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.REFRESH_TOKEN}${tokenId}`;
    await redis.del(key);
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS - Login Attempts
  // ==========================================================================

  private async getLoginAttempts(email: string): Promise<LoginAttempt | null> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.LOGIN_ATTEMPTS}${email}`;
    const data = await redis.get<string>(key);
    return data ? JSON.parse(data) : null;
  }

  private async recordFailedLoginAttempt(email: string): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.LOGIN_ATTEMPTS}${email}`;
    const existing = await this.getLoginAttempts(email);
    
    const attempts = existing ? existing.attempts + 1 : 1;
    const data: LoginAttempt = {
      email,
      attempts,
      lastAttempt: new Date().toISOString(),
    };

    // Lock account after max attempts
    if (attempts >= AUTH_CONSTANTS.MAX_LOGIN_ATTEMPTS) {
      data.lockedUntil = new Date(
        Date.now() + AUTH_CONSTANTS.LOGIN_LOCKOUT_DURATION * 1000
      ).toISOString();
    }

    await redis.set(
      key,
      JSON.stringify(data),
      { ex: AUTH_CONSTANTS.LOGIN_LOCKOUT_DURATION }
    );
  }

  private async clearLoginAttempts(email: string): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.LOGIN_ATTEMPTS}${email}`;
    await redis.del(key);
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS - Password Reset Token
  // ==========================================================================

  private async storePasswordResetToken(
    userId: string,
    email: string,
    token: string
  ): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.PASSWORD_RESET}${token}`;
    const data: PasswordResetToken = {
      userId,
      email,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + AUTH_CONSTANTS.PASSWORD_RESET_EXPIRY * 1000
      ).toISOString(),
    };
    
    await redis.set(
      key,
      JSON.stringify(data),
      { ex: AUTH_CONSTANTS.PASSWORD_RESET_EXPIRY }
    );
  }

  private async getPasswordResetToken(token: string): Promise<PasswordResetToken | null> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.PASSWORD_RESET}${token}`;
    const data = await redis.get<string>(key);
    return data ? JSON.parse(data) : null;
  }

  private async deletePasswordResetToken(token: string): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.PASSWORD_RESET}${token}`;
    await redis.del(key);
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS - Email Verification Token
  // ==========================================================================

  private async storeEmailVerificationToken(
    userId: string,
    email: string,
    token: string
  ): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.EMAIL_VERIFICATION}${token}`;
    const data: EmailVerificationToken = {
      userId,
      email,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + AUTH_CONSTANTS.EMAIL_VERIFICATION_EXPIRY * 1000
      ).toISOString(),
    };
    
    await redis.set(
      key,
      JSON.stringify(data),
      { ex: AUTH_CONSTANTS.EMAIL_VERIFICATION_EXPIRY }
    );
  }

  private async getEmailVerificationToken(
    token: string
  ): Promise<EmailVerificationToken | null> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.EMAIL_VERIFICATION}${token}`;
    const data = await redis.get<string>(key);
    return data ? JSON.parse(data) : null;
  }

  private async deleteEmailVerificationToken(token: string): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.EMAIL_VERIFICATION}${token}`;
    await redis.del(key);
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS - Password History
  // ==========================================================================

  private async getPasswordHistory(userId: string): Promise<string[]> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.PASSWORD_HISTORY}${userId}`;
    const data = await redis.get<string>(key);
    
    if (!data) return [];
    
    const history: PasswordHistoryEntry[] = JSON.parse(data);
    return history.map((entry) => entry.hash);
  }

  private async addToPasswordHistory(
    userId: string,
    hashedPassword: string
  ): Promise<void> {
    const key = `${AUTH_CONSTANTS.REDIS_KEYS.PASSWORD_HISTORY}${userId}`;
    const existing = await redis.get<string>(key);
    
    let history: PasswordHistoryEntry[] = existing ? JSON.parse(existing) : [];
    
    // Add new password to history
    history.unshift({
      hash: hashedPassword,
      createdAt: new Date().toISOString(),
    });
    
    // Keep only last N passwords
    history = history.slice(0, AUTH_CONSTANTS.PASSWORD_HISTORY_COUNT);
    
    // Store indefinitely (or until explicitly cleaned up)
    await redis.set(key, JSON.stringify(history));
  }
}

// Export singleton instance
export const authModule = new AuthModule();

// Export class for testing
export { AuthModule };