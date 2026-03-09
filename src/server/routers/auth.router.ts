import { TRPCError } from '@trpc/server';
import { randomBytes } from 'crypto';
import { nanoid } from 'nanoid';

import { router, publicProcedure, protectedProcedure } from '../trpc/trpc';
import {
  registerSchema,
  loginSchema,
  resetPasswordRequestSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  refreshTokenSchema,
} from '../schemas/auth.schema';

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { hashPassword } from '@/utils/helpers';
import { authRateLimiter } from '@/lib/redis/rate-limiter';
import { logger } from '@/utils/logger';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase';

import {
  isFreeEmailDomain,
  FREE_EMAIL_ERROR_MESSAGE,
  isRegulatorDomain,
  findValidInvitation,
  consumeInvitation,
  initializeNotificationPreferences,
} from '@/lib/verification/verification.service';
import { reactMailer } from '@/lib/email/react-mailer.service';

// ── helpers ───────────────────────────────────────────────────────────────

function generateVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

function parseDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown Device';
  if (/iPhone|iPad/.test(userAgent)) return 'iOS Device';
  if (/Android/.test(userAgent)) return 'Android Device';
  if (/Windows/.test(userAgent)) return 'Windows Browser';
  if (/Mac OS/.test(userAgent)) return 'macOS Browser';
  if (/Linux/.test(userAgent)) return 'Linux Browser';
  return 'Unknown Device';
}

// ── router ────────────────────────────────────────────────────────────────

export const authRouter = router({
  /**
   * Register — creates a Supabase auth user AND a Prisma user profile.
   */
  register: publicProcedure
    .input(registerSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        await authRateLimiter.register(input.email);
        logger.info({ type: 'auth_register_attempt', email: input.email, role: input.role });

        const existingUser = await ctx.prisma.user.findUnique({ where: { email: input.email } });
        if (existingUser) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Email already registered' });
        }

        if (input.role !== 'REGULATOR' && isFreeEmailDomain(input.email)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: FREE_EMAIL_ERROR_MESSAGE });
        }

        const invitation = await findValidInvitation(input.email);

        if (input.role === 'REGULATOR' && !invitation) {
          const domainCheck = await isRegulatorDomain(input.email);
          if (!domainCheck.isRegulator) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Regulator accounts require a verified government email address.',
            });
          }
        }

        if (input.organizationId) {
          const org = await ctx.prisma.organization.findUnique({ where: { id: input.organizationId } });
          if (!org) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid organization ID' });
        }

        const resolvedRole = invitation
          ? (invitation.role as 'REGULATOR' | 'STARTUP' | 'ENTERPRISE')
          : input.role;

        // Create Supabase auth user (backend-controlled via admin API)
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email: input.email,
          password: input.password,
          email_confirm: false,
          user_metadata: { role: resolvedRole, fullName: input.name || input.email },
        });

        if (authError || !authData.user) {
          logger.error({ type: 'auth_register_supabase_error', email: input.email, error: authError?.message });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: authError?.message || 'Failed to create auth account',
          });
        }

        // Store hashed password in Prisma (migration safety / fallback)
        const hashedPw = await hashPassword(input.password);

        const verificationToken = generateVerificationToken();
        const verificationExpiry = new Date();
        verificationExpiry.setHours(verificationExpiry.getHours() + 24);

        const user = await ctx.prisma.user.create({
          data: {
            supabaseAuthId: authData.user.id,
            email: input.email,
            password: hashedPw,
            fullName: input.name || input.email,
            role: resolvedRole,
            phone: input.phone,
            organizationId: invitation?.organizationId || input.organizationId,
            emailVerificationToken: verificationToken,
            emailVerificationExpiry: verificationExpiry,
            accountStatus: 'pending',
          } as any,
          select: { id: true, email: true, fullName: true, role: true, organizationId: true, createdAt: true },
        });

        if (invitation) {
          await consumeInvitation(invitation.id).catch((err: any) =>
            logger.warn({ type: 'invitation_consume_failed', invitationId: invitation.id, error: err.message })
          );
        }

        initializeNotificationPreferences(user.id).catch(() => {});

        const verificationUrl = `${process.env.FRONTEND_URL || ''}/verify-email?token=${verificationToken}`;
        reactMailer.sendVerificationEmail(user.email, {
          userName: (user as any).fullName || user.email,
          verificationUrl,
          expiresInHours: 24,
        }).catch((err: any) => {
          logger.error({ type: 'auth_register_email_failed', userId: user.id, error: err.message });
        });

        logger.info({ type: 'auth_register_success', userId: user.id, email: user.email, duration: Date.now() - startTime });

        return {
          success: true,
          userId: user.id,
          email: user.email,
          message: 'Registration successful. Please check your email to verify your account.',
        };
      } catch (error: any) {
        logger.error({ type: 'auth_register_error', email: input.email, error: error.message, duration: Date.now() - startTime });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Registration failed. Please try again.', cause: error });
      }
    }),

  /**
   * Login — proxies credentials to Supabase and returns Supabase session tokens.
   * The frontend must store and send the access_token as Bearer on all requests.
   */
  login: publicProcedure
    .input(loginSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        await authRateLimiter.login(input.email);
        logger.info({ type: 'auth_login_attempt', email: input.email });

        const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
          email: input.email,
          password: input.password,
        });

        if (authError || !authData.session || !authData.user) {
          logger.warn({ type: 'auth_login_supabase_failed', email: input.email, error: authError?.message });
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
        }

        const user = await ctx.prisma.user.findUnique({
          where: { supabaseAuthId: authData.user.id },
          include: { organization: { select: { id: true, name: true, type: true } } },
        });

        if (!user || (user as any).deletedAt) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Account has been deactivated' });
        }

        let dbSessionId: string | undefined;
        try {
          const session = await ctx.prisma.session.create({
            data: {
              userId: user.id,
              token: nanoid(64),
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              device: parseDeviceLabel(ctx.req.headers['user-agent']),
              ipAddress: ctx.req.ip || 'Unknown',
              userAgent: ctx.req.headers['user-agent']?.substring(0, 500),
            },
          });
          dbSessionId = session.id;
        } catch (err: any) {
          logger.warn({ type: 'auth_login_session_create_failed', userId: user.id, error: err.message });
        }

        // Cache user profile in Upstash for fast context lookups (1 hour)
        const userProfile = {
          id: user.id,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId ?? undefined,
          supabaseAuthId: authData.user.id,
          sessionId: dbSessionId,
        };
        await redis.set(`user:session:${authData.user.id}`, JSON.stringify(userProfile), { ex: 3600 });

        await ctx.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

        logger.info({ type: 'auth_login_success', userId: user.id, duration: Date.now() - startTime });

        return {
          accessToken: authData.session.access_token,
          refreshToken: authData.session.refresh_token,
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
        logger.error({ type: 'auth_login_error', email: input.email, error: error.message, duration: Date.now() - startTime });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Login failed. Please try again.', cause: error });
      }
    }),

  /**
   * Logout — deletes DB session and invalidates the Upstash Redis user cache.
   */
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const userId = ctx.user!.id;
      const supabaseAuthId = ctx.user!.supabaseAuthId;

      logger.info({ type: 'auth_logout', userId });

      if (ctx.user!.sessionId) {
        await ctx.prisma.session.deleteMany({ where: { id: ctx.user!.sessionId, userId } });
      }

      // Invalidate Redis user cache so next request forces a fresh DB lookup
      await redis.del(`user:session:${supabaseAuthId}`);

      return { success: true, message: 'Logged out successfully' };
    } catch (error: any) {
      logger.error({ type: 'auth_logout_error', userId: ctx.user!.id, error: error.message });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Logout failed', cause: error });
    }
  }),

  /** Get current authenticated user */
  me: protectedProcedure.query(async ({ ctx }) => {
    try {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.user!.id },
        include: { organization: { select: { id: true, name: true, type: true, registrationNumber: true } } },
      });

      if (!user || (user as any).deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
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
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch user data', cause: error });
    }
  }),

  /**
   * Request password reset — triggers Supabase built-in reset email.
   */
  requestPasswordReset: publicProcedure
    .input(resetPasswordRequestSchema)
    .mutation(async ({ input }) => {
      try {
        const { error } = await supabaseAdmin.auth.resetPasswordForEmail(input.email, {
          redirectTo: `${process.env.FRONTEND_URL || ''}/reset-password`,
        });

        if (error) {
          logger.warn({ type: 'auth_password_reset_supabase_warn', email: input.email, error: error.message });
        }

        return {
          success: true,
          message: 'If an account exists with this email, you will receive a password reset link.',
        };
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Password reset request failed', cause: error });
      }
    }),

  /**
   * Reset password with DB token (Phase 7 compatible).
   * Also updates the Supabase auth password and invalidates the Redis cache.
   */
  resetPassword: publicProcedure
    .input(resetPasswordSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.findFirst({
          where: { passwordResetToken: input.token, passwordResetExpiry: { gt: new Date() } } as any,
        });

        if (!user) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid or expired reset token' });
        }

        const hashed = await hashPassword(input.newPassword);

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: { password: hashed, passwordResetToken: null, passwordResetExpiry: null } as any,
        });

        if ((user as any).supabaseAuthId) {
          await supabaseAdmin.auth.admin.updateUserById((user as any).supabaseAuthId, {
            password: input.newPassword,
          });
          await redis.del(`user:session:${(user as any).supabaseAuthId}`);
        }

        logger.info({ type: 'auth_password_reset_success', userId: user.id });

        return { success: true, message: 'Password reset successful. You can now log in with your new password.' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Password reset failed', cause: error });
      }
    }),

  /** Verify email with DB token (Phase 7 compatible). */
  verifyEmail: publicProcedure
    .input(verifyEmailSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.findFirst({
          where: {
            emailVerificationToken: input.token,
            emailVerificationExpiry: { gt: new Date() },
            emailVerified: false,
          } as any,
        });

        if (!user) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid or expired verification token' });
        }

        const newAccountStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            emailVerified: true,
            emailVerifiedAt: new Date(),
            emailVerificationToken: null,
            emailVerificationExpiry: null,
            accountStatus: newAccountStatus,
          } as any,
        });

        // Confirm email on the Supabase side as well
        if ((user as any).supabaseAuthId) {
          await supabaseAdmin.auth.admin.updateUserById((user as any).supabaseAuthId, {
            email_confirm: true,
          });
        }

        if (user.role !== 'REGULATOR') {
          reactMailer.sendWelcomeEmail(user.email, {
            userName: user.fullName || user.email,
            role: user.role,
            dashboardUrl: `${process.env.FRONTEND_URL || ''}/dashboard`,
          }).catch(() => {});
        }

        logger.info({ type: 'auth_email_verification_success', userId: user.id, accountStatus: newAccountStatus });

        return {
          success: true,
          message: user.role === 'REGULATOR'
            ? 'Email verified successfully. Your account is pending admin approval.'
            : 'Email verified successfully. You can now access all features.',
          requiresApproval: user.role === 'REGULATOR',
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Email verification failed', cause: error });
      }
    }),

  /** Resend email verification — rate-limited at 3/hour via Upstash. */
  resendVerification: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user!.id;
    try {
      const user = await ctx.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, fullName: true, emailVerified: true },
      });

      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      if (user.emailVerified) return { success: true, message: 'Email is already verified.' };

      const rateLimitKey = `email_resend:${userId}`;
      const count = await redis.incr(rateLimitKey);
      if (count === 1) await redis.expire(rateLimitKey, 3600);
      if (count > 3) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many verification email requests. Please try again in an hour.',
        });
      }

      const newToken = generateVerificationToken();
      const newExpiry = new Date();
      newExpiry.setHours(newExpiry.getHours() + 24);

      await ctx.prisma.user.update({
        where: { id: userId },
        data: { emailVerificationToken: newToken, emailVerificationExpiry: newExpiry } as any,
      });

      const verificationUrl = `${process.env.FRONTEND_URL || ''}/verify-email?token=${newToken}`;
      await reactMailer.sendVerificationEmail(user.email, {
        userName: user.fullName || user.email,
        verificationUrl,
        expiresInHours: 24,
      });

      logger.info({ type: 'auth_resend_verification_success', userId });
      return { success: true, message: 'Verification email sent.' };
    } catch (error: any) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to resend verification email', cause: error });
    }
  }),

  /**
   * refreshToken — deprecated endpoint.
   * Supabase handles token refresh on the frontend automatically.
   * Call supabase.auth.refreshSession() from your Supabase client instead.
   */
  refreshToken: publicProcedure
    .input(refreshTokenSchema)
    .mutation(async () => {
      throw new TRPCError({
        code: 'METHOD_NOT_SUPPORTED',
        message:
          'Token refresh is now handled by Supabase. ' +
          'Call supabase.auth.refreshSession() from your frontend client.',
      });
    }),
});
