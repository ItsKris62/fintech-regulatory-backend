import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { nanoid } from 'nanoid';

// tRPC setup
import { router, publicProcedure, protectedProcedure } from '../trpc/trpc';

// Schemas
import {
  registerSchema,
  loginSchema,
  resetPasswordRequestSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  refreshTokenSchema,
} from '../schemas/auth.schema';

// Phase 1 services and utilities
import { prisma } from '@/lib/prisma/client';
import { hashPassword, verifyPassword } from '@/utils/helpers';
import { authRateLimiter } from '@/lib/redis/rate-limiter';
import { sessionCache } from '@/lib/redis/cache.service';
import { logger } from '@/utils/logger';

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

/**
 * JWT Payload structure
 */
interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  sessionId?: string;
}

/** Parse a human-readable device label from a user-agent string */
function parseDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown Device';
  if (/iPhone|iPad/.test(userAgent)) return 'iOS Device';
  if (/Android/.test(userAgent)) return 'Android Device';
  if (/Windows/.test(userAgent)) {
    if (/Chrome/.test(userAgent)) return 'Chrome on Windows';
    if (/Firefox/.test(userAgent)) return 'Firefox on Windows';
    if (/Edge/.test(userAgent)) return 'Edge on Windows';
    return 'Windows Browser';
  }
  if (/Mac OS/.test(userAgent)) {
    if (/Chrome/.test(userAgent)) return 'Chrome on macOS';
    if (/Firefox/.test(userAgent)) return 'Firefox on macOS';
    if (/Safari/.test(userAgent)) return 'Safari on macOS';
    return 'macOS Browser';
  }
  if (/Linux/.test(userAgent)) return 'Linux Browser';
  return 'Unknown Device';
}

/**
 * Generate JWT access token
 */
function generateAccessToken(payload: JWTPayload): string {
  return (jwt.sign as any)(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * Generate JWT refresh token
 */
function generateRefreshToken(payload: JWTPayload): string {
  return (jwt.sign as any)(payload, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
}

/**
 * Generate random verification/reset token
 */
function generateVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Authentication Router
 *
 * Handles user registration, login, password management, and email verification.
 * All sensitive operations are rate-limited using authRateLimiter from Phase 1.
 */
export const authRouter = router({
  /**
   * Register new user
   *
   * @public
   * @rate-limited
   *
   * Flow:
   * 1. Check rate limit
   * 2. Validate email not already taken
   * 3. Hash password
   * 4. Create user in database
   * 5. Generate verification token
   * 6. Send welcome email
   * 7. Return success with userId
   */
  register: publicProcedure
    .input(registerSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        // Rate limiting - prevent abuse
        await authRateLimiter.register(input.email);

        logger.info({
          type: 'auth_register_attempt',
          email: input.email,
          role: input.role,
        });

        // Check if email already exists
        const existingUser = await ctx.prisma.user.findUnique({
          where: { email: input.email },
        });

        if (existingUser) {
          logger.warn({
            type: 'auth_register_duplicate_email',
            email: input.email,
          });

          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Email already registered',
          });
        }

        // Validate organization if provided
        if (input.organizationId) {
          const organization = await ctx.prisma.organization.findUnique({
            where: { id: input.organizationId },
          });

          if (!organization) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid organization ID',
            });
          }
        }

        // Hash password using Phase 1 helper
        const hashedPassword = await hashPassword(input.password);

        // Generate email verification token
        const verificationToken = generateVerificationToken();
        const verificationExpiry = new Date();
        verificationExpiry.setHours(verificationExpiry.getHours() + 24); // 24 hours

        // Create user in database
        const user = await ctx.prisma.user.create({
          data: {
            email: input.email,
            password: hashedPassword,
            fullName: input.name || input.email,
            role: input.role,
            phone: input.phone,
            organizationId: input.organizationId,
          } as any,
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            organizationId: true,
            createdAt: true,
          },
        });

        // Send welcome email with verification link
        try {
          await (ctx.mailer.sendWelcomeEmail as any)({
            name: (user as any).fullName || user.email,
            email: user.email,
            verificationUrl: `${process.env.APP_URL || ''}/verify-email?token=${verificationToken}`,
            role: user.role,
          });

          logger.info({
            type: 'auth_register_email_sent',
            userId: user.id,
            email: user.email,
          });
        } catch (emailError: any) {
          // Log error but don't fail registration
          logger.error({
            type: 'auth_register_email_failed',
            userId: user.id,
            error: emailError.message,
          });
        }

        const duration = Date.now() - startTime;

        logger.info({
          type: 'auth_register_success',
          userId: user.id,
          email: user.email,
          role: user.role,
          duration,
        });

        return {
          success: true,
          userId: user.id,
          email: user.email,
          message: 'Registration successful. Please check your email to verify your account.',
        };
      } catch (error: any) {
        const duration = Date.now() - startTime;

        logger.error({
          type: 'auth_register_error',
          email: input.email,
          error: error.message,
          duration,
        });

        // Re-throw TRPCError as is
        if (error instanceof TRPCError) {
          throw error;
        }

        // Wrap other errors
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Registration failed. Please try again.',
          cause: error,
        });
      }
    }),

  /**
   * Login with email and password
   *
   * @public
   * @rate-limited
   *
   * Flow:
   * 1. Check rate limit
   * 2. Find user by email
   * 3. Verify password
   * 4. Generate JWT tokens
   * 5. Cache session in Redis
   * 6. Return tokens and user data
   */
  login: publicProcedure
    .input(loginSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        // Rate limiting - prevent brute force
        await authRateLimiter.login(input.email);

        logger.info({
          type: 'auth_login_attempt',
          email: input.email,
        });

        // Find user by email
        const user = await ctx.prisma.user.findUnique({
          where: { email: input.email },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                type: true,
              },
            },
          },
        });

        if (!user) {
          logger.warn({
            type: 'auth_login_user_not_found',
            email: input.email,
          });

          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
          });
        }

        // Verify password using Phase 1 helper
        const validPassword = await verifyPassword(input.password, user.password);

        if (!validPassword) {
          logger.warn({
            type: 'auth_login_invalid_password',
            userId: user.id,
            email: input.email,
          });

          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
          });
        }

        // Check if user is active (not soft deleted)
        if ((user as any).deletedAt) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Account has been deactivated',
          });
        }

        // Create session record in database
        let dbSessionId: string | undefined;
        try {
          const sessionToken = nanoid(64);
          const session = await ctx.prisma.session.create({
            data: {
              userId: user.id,
              token: sessionToken,
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
              device: parseDeviceLabel(ctx.req.headers['user-agent']),
              ipAddress: ctx.req.ip || 'Unknown',
              userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
            },
          });
          dbSessionId = session.id;
        } catch (sessionError: any) {
          logger.warn({
            type: 'auth_login_session_create_failed',
            userId: user.id,
            error: sessionError.message,
          });
        }

        // Generate JWT tokens (include sessionId for session management)
        const tokenPayload: JWTPayload = {
          userId: user.id,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId || undefined,
          sessionId: dbSessionId,
        };

        const accessToken = generateAccessToken(tokenPayload);
        const refreshToken = generateRefreshToken(tokenPayload);

        // Store session in Redis cache (legacy, non-critical)
        const redisSessionId = `session:${user.id}:${Date.now()}`;
        try {
          await sessionCache.set(redisSessionId, {
            userId: user.id,
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
            createdAt: new Date().toISOString(),
          });
        } catch (cacheError: any) {
          logger.warn({
            type: 'auth_login_cache_failed',
            userId: user.id,
            error: cacheError.message,
          });
        }

        // Update last login timestamp
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        const duration = Date.now() - startTime;

        logger.info({
          type: 'auth_login_success',
          userId: user.id,
          email: user.email,
          role: user.role,
          duration,
        });

        return {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            name: user.fullName,
            role: user.role,
            emailVerified: user.emailVerified,
            organization: user.organization,
            createdAt: user.createdAt,
          },
        };
      } catch (error: any) {
        const duration = Date.now() - startTime;

        logger.error({
          type: 'auth_login_error',
          email: input.email,
          error: error.message,
          duration,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Login failed. Please try again.',
          cause: error,
        });
      }
    }),

  /**
   * Logout - invalidate session
   *
   * @protected
   */
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      logger.info({
        type: 'auth_logout',
        userId: ctx.user!.id,
      });

      // Delete current session from Prisma if we have a session ID
      if (ctx.user!.sessionId) {
        await ctx.prisma.session.deleteMany({
          where: {
            id: ctx.user!.sessionId,
            userId: ctx.user!.id,
          },
        });
      }

      return {
        success: true,
        message: 'Logged out successfully',
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_logout_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Logout failed',
        cause: error,
      });
    }
  }),

  /**
   * Get current user (me)
   *
   * @protected
   */
  me: protectedProcedure.query(async ({ ctx }) => {
    try {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.user!.id },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              type: true,
              registrationNumber: true,
            },
          },
        },
      });

      if (!user || (user as any).deletedAt) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }

      return {
        id: user.id,
        email: user.email,
        name: user.fullName,
        role: user.role,
        phone: user.phone,
        emailVerified: user.emailVerified,
        organization: user.organization,
        preferences: (user as any).preferences,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
    } catch (error: any) {
      logger.error({
        type: 'auth_me_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      if (error instanceof TRPCError) {
        throw error;
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch user data',
        cause: error,
      });
    }
  }),

  /**
   * Request password reset
   *
   * @public
   * @rate-limited
   */
  requestPasswordReset: publicProcedure
    .input(resetPasswordRequestSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await authRateLimiter.resetPassword(input.email);

        logger.info({
          type: 'auth_password_reset_request',
          email: input.email,
        });

        const user = await ctx.prisma.user.findUnique({
          where: { email: input.email },
        });

        // Don't reveal if user exists - always return success
        if (!user || (user as any).deletedAt) {
          logger.info({
            type: 'auth_password_reset_user_not_found',
            email: input.email,
          });

          return {
            success: true,
            message: 'If an account exists with this email, you will receive a password reset link.',
          };
        }

        // Generate reset token
        const resetToken = generateVerificationToken();
        const resetExpiry = new Date();
        resetExpiry.setHours(resetExpiry.getHours() + 1); // 1 hour

        // Save token to database
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetToken: resetToken,
            passwordResetExpiry: resetExpiry,
          } as any,
        });

        // Send password reset email
        try {
          await (ctx.mailer.sendPasswordResetEmail as any)({
            name: user.fullName || user.email,
            email: user.email,
            resetUrl: `${process.env.APP_URL || ''}/reset-password?token=${resetToken}`,
            expiresIn: '1 hour',
          });

          logger.info({
            type: 'auth_password_reset_email_sent',
            userId: user.id,
          });
        } catch (emailError: any) {
          logger.error({
            type: 'auth_password_reset_email_failed',
            userId: user.id,
            error: emailError.message,
          });
        }

        return {
          success: true,
          message: 'If an account exists with this email, you will receive a password reset link.',
        };
      } catch (error: any) {
        logger.error({
          type: 'auth_password_reset_request_error',
          email: input.email,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Password reset request failed',
          cause: error,
        });
      }
    }),

  /**
   * Reset password with token
   *
   * @public
   */
  resetPassword: publicProcedure
    .input(resetPasswordSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        logger.info({
          type: 'auth_password_reset_attempt',
        });

        // Find user with valid reset token
        const user = await ctx.prisma.user.findFirst({
          where: {
            passwordResetToken: input.token,
            passwordResetExpiry: {
              gt: new Date(), // Not expired
            },
          } as any,
        });

        if (!user) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid or expired reset token',
          });
        }

        // Hash new password
        const hashedPassword = await hashPassword(input.newPassword);

        // Update password and clear reset token
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            password: hashedPassword,
            passwordResetToken: null,
            passwordResetExpiry: null,
          } as any,
        });

        logger.info({
          type: 'auth_password_reset_success',
          userId: user.id,
        });

        return {
          success: true,
          message: 'Password reset successful. You can now login with your new password.',
        };
      } catch (error: any) {
        logger.error({
          type: 'auth_password_reset_error',
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Password reset failed',
          cause: error,
        });
      }
    }),

  /**
   * Verify email with token
   *
   * @public
   */
  verifyEmail: publicProcedure
    .input(verifyEmailSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        logger.info({
          type: 'auth_email_verification_attempt',
        });

        // Find user with valid verification token
        const user = await ctx.prisma.user.findFirst({
          where: {
            emailVerificationToken: input.token,
            emailVerificationExpiry: {
              gt: new Date(), // Not expired
            },
            emailVerified: false,
          } as any,
        });

        if (!user) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid or expired verification token',
          });
        }

        // Mark email as verified
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            emailVerified: true,
            emailVerificationToken: null,
            emailVerificationExpiry: null,
          } as any,
        });

        logger.info({
          type: 'auth_email_verification_success',
          userId: user.id,
        });

        return {
          success: true,
          message: 'Email verified successfully. You can now access all features.',
        };
      } catch (error: any) {
        logger.error({
          type: 'auth_email_verification_error',
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Email verification failed',
          cause: error,
        });
      }
    }),

  /**
   * Refresh access token
   *
   * @public
   */
  refreshToken: publicProcedure
    .input(refreshTokenSchema)
    .mutation(async ({ input }) => {
      try {
        // Verify refresh token
        const decoded = jwt.verify(input.refreshToken, JWT_SECRET) as JWTPayload;

        // Verify user still exists and is active
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
        });

        if (!user || (user as any).deletedAt) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid refresh token',
          });
        }

        // Generate new access token
        const tokenPayload: JWTPayload = {
          userId: user.id,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId || undefined,
        };

        const accessToken = generateAccessToken(tokenPayload);

        logger.info({
          type: 'auth_token_refresh_success',
          userId: user.id,
        });

        return {
          accessToken,
        };
      } catch (error: any) {
        logger.error({
          type: 'auth_token_refresh_error',
          error: error.message,
        });

        if (error instanceof jwt.JsonWebTokenError) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid refresh token',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Token refresh failed',
          cause: error,
        });
      }
    }),
});
