import { TRPCError } from '@trpc/server';
import { randomBytes } from 'crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { router, publicProcedure, protectedProcedure } from '../trpc/trpc';
import {
  registerSchema,
  loginSchema,
  resetPasswordRequestSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  refreshTokenSchema,
} from '../schemas/auth.schema';

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

/**
 * Enforce a rate limit result — throws TRPCError(TOO_MANY_REQUESTS) when
 * the limit is exceeded so the router's existing catch blocks handle it cleanly.
 */
function enforceRateLimit(
  result: { allowed: boolean; retryAfter?: number },
  message = 'Too many requests. Please try again later.'
): void {
  if (!result.allowed) {
    const suffix = result.retryAfter ? ` Try again in ${result.retryAfter} seconds.` : '';
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: message + suffix });
  }
}

// ── router ────────────────────────────────────────────────────────────────

export const authRouter = router({
  /**
   * Register — creates a Supabase auth user AND a Prisma user profile.
   * If Prisma creation fails, the Supabase user is deleted as a compensating
   * transaction so no orphaned auth records are left behind.
   */
  register: publicProcedure
    .input(registerSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        // F5.6 — rate limiting enforced (was silently ignored before)
        const rlResult = await authRateLimiter.register(input.email);
        enforceRateLimit(rlResult, 'Too many registration attempts. Please try again later.');

        logger.info({ type: 'auth_register_attempt', email: input.email, role: input.role });

        const existingUser = await ctx.prisma.user.findUnique({
          where: { email: input.email },
          select: { emailVerified: true, accountStatus: true },
        });
        if (existingUser) {
          const hint = !existingUser.emailVerified
            ? ' Please check your inbox for a verification email, or use the "Resend verification" option on the login page.'
            : existingUser.accountStatus === 'pending_approval'
            ? ' Your account is pending admin approval. You will receive an email once it is approved.'
            : ' Please sign in instead.';
          throw new TRPCError({ code: 'CONFLICT', message: `An account with this email already exists.${hint}` });
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

        // Create Supabase auth user AND generate a native OTP verification link.
        // admin.generateLink does NOT send any email — it returns the link so we
        // can embed it in our own custom React Email template.
        // The link is: https://<project>.supabase.co/auth/v1/verify?token=xxx&type=signup&redirect_to=<callback>
        const appCallbackUrl = process.env.APP_CALLBACK_URL || 'https://sheriabot.com/auth/callback';
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.generateLink({
          type: 'signup',
          email: input.email,
          password: input.password,
          options: {
            redirectTo: appCallbackUrl,
            data: { role: resolvedRole, fullName: input.name || input.email },
          },
        });

        if (authError || !authData?.user || !authData?.properties?.action_link) {
          logger.error({ type: 'auth_register_supabase_error', email: input.email, error: authError?.message });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: authError?.message || 'Failed to create auth account',
          });
        }

        // Store hashed password in Prisma (migration safety / fallback)
        const hashedPw = await hashPassword(input.password);

        // F3.2b — if Prisma creation fails, delete the Supabase user so there
        // are no orphaned auth records that block re-registration.
        let user: any;
        try {
          user = await ctx.prisma.user.create({
            data: {
              supabaseAuthId: authData.user.id,
              email: input.email,
              password: hashedPw,
              fullName: input.name || input.email,
              role: resolvedRole,
              phone: input.phone,
              organizationId: invitation?.organizationId || input.organizationId,
              accountStatus: 'pending',
            } as any,
            select: { id: true, email: true, fullName: true, role: true, organizationId: true, createdAt: true },
          });
        } catch (prismaErr: any) {
          logger.error({
            type: 'auth_register_prisma_error',
            email: input.email,
            error: prismaErr.message,
          });
          // Compensating transaction: remove the Supabase user to keep systems consistent
          await supabaseAdmin.auth.admin.deleteUser(authData.user.id).catch((delErr: any) => {
            logger.error({
              type: 'auth_register_supabase_rollback_error',
              supabaseUserId: authData.user.id,
              error: delErr.message,
            });
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Registration failed. Please try again.',
          });
        }

        if (invitation) {
          await consumeInvitation(invitation.id).catch((err: any) =>
            logger.warn({ type: 'invitation_consume_failed', invitationId: invitation.id, error: err.message })
          );
        }

        // F3.1 — Create and link Organization if companyName was provided and user has no org yet
        if (input.companyName && !user.organizationId) {
          ctx.prisma.organization.create({
            data: {
              name: input.companyName,
              type: resolvedRole,
              users: { connect: { id: user.id } },
            } as any,
          }).catch((err: any) => {
            logger.warn({ type: 'auth_register_org_create_failed', userId: user.id, error: err.message });
          });
        }

        initializeNotificationPreferences(user.id).catch(() => {});

        // Use the Supabase-generated OTP link so that clicking it marks
        // email_confirmed_at in Supabase natively, then redirects to our
        // /auth/callback page which syncs Prisma emailVerified.
        const verificationUrl = authData.properties.action_link;
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
   * Enforces email verification and account status before granting access.
   * The frontend must store and send the access_token as Bearer on all requests.
   */
  login: publicProcedure
    .input(loginSchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        // F5.6 — rate limiting enforced (was silently ignored before)
        const rlResult = await authRateLimiter.login(input.email);
        enforceRateLimit(rlResult, 'Too many login attempts. Please try again later.');

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

        // Safety-net sync: if Supabase has confirmed the email but Prisma hasn't
        // been updated yet (e.g. user closed the callback page before sync completed),
        // reconcile here so login isn't permanently blocked.
        if (!user.emailVerified && authData.user.email_confirmed_at) {
          const syncedStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';
          try {
            await ctx.prisma.user.update({
              where: { id: user.id },
              data: {
                emailVerified: true,
                emailVerifiedAt: new Date(authData.user.email_confirmed_at),
                accountStatus: syncedStatus,
              } as any,
            });
            (user as any).emailVerified = true;
            (user as any).accountStatus = syncedStatus;
            logger.info({ type: 'auth_login_prisma_email_synced', userId: user.id });
          } catch (syncErr: any) {
            logger.warn({ type: 'auth_login_prisma_sync_failed', userId: user.id, error: syncErr.message });
          }
        }

        // F2.3b — block login if email is not yet verified
        if (!user.emailVerified) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Please verify your email before logging in. Check your inbox for the verification link.',
          });
        }

        // F2.3c — block login if account is not in active status
        const status = (user as any).accountStatus as string | undefined;
        if (status && status !== 'active') {
          if (status === 'pending_approval') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Your account is pending admin approval. You will be notified by email once approved.',
            });
          }
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Your account is not active. Please contact support.',
          });
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
   * Request password reset — F4.2 (complete rewrite).
   *
   * Uses a fully custom Prisma token flow instead of the Supabase-native
   * resetPasswordForEmail(), which sends tokens in a format incompatible with
   * the /reset-password?token= frontend pattern.
   *
   * Flow: generate token → store in Prisma → send via React Email template.
   * Always returns success to prevent email enumeration.
   */
  requestPasswordReset: publicProcedure
    .input(resetPasswordRequestSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // F5.6 — rate limiting on password reset (was missing entirely)
        const rlResult = await authRateLimiter.resetPassword(input.email);
        enforceRateLimit(rlResult, 'Too many password reset requests. Please try again later.');

        const user = await ctx.prisma.user.findUnique({
          where: { email: input.email },
          select: { id: true, email: true, fullName: true, supabaseAuthId: true },
        });

        // Always return success — never reveal whether an account exists
        if (!user) {
          logger.info({ type: 'auth_password_reset_email_not_found', email: input.email });
          return {
            success: true,
            message: 'If an account exists with this email, you will receive a password reset link.',
          };
        }

        const resetToken = generateVerificationToken();
        const resetExpiry = new Date();
        resetExpiry.setMinutes(resetExpiry.getMinutes() + 60); // 60-minute window

        await ctx.prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetToken: resetToken,
            passwordResetExpiry: resetExpiry,
          } as any,
        });

        // F3.5 — FRONTEND_URL is validated at startup, no fallback needed
        const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
        reactMailer.sendPasswordResetEmail(user.email, {
          userName: user.fullName || user.email,
          resetUrl,
          expiresInMinutes: 60,
          ipAddress: undefined,
        }).catch((err: any) => {
          logger.error({ type: 'auth_password_reset_email_failed', userId: user.id, error: err.message });
        });

        logger.info({ type: 'auth_password_reset_email_sent', userId: user.id });

        return {
          success: true,
          message: 'If an account exists with this email, you will receive a password reset link.',
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Password reset request failed', cause: error });
      }
    }),

  /**
   * Reset password with Prisma DB token.
   * F4.5a — error-checks supabaseAdmin.auth.admin.updateUserById().
   * F4.5b — revokes all Supabase sessions for the user after reset.
   * F4.6  — sends a post-reset confirmation email.
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

        // Clear the reset token first so it can't be replayed even if later steps fail
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: { password: hashed, passwordResetToken: null, passwordResetExpiry: null } as any,
        });

        if ((user as any).supabaseAuthId) {
          const supabaseAuthId = (user as any).supabaseAuthId as string;

          // F4.5a — check the return value; if Supabase update fails log it but
          // don't silently swallow the error as it leaves credentials out of sync
          const { error: supabaseUpdateError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseAuthId,
            { password: input.newPassword },
          );
          if (supabaseUpdateError) {
            logger.error({
              type: 'auth_password_reset_supabase_update_error',
              userId: user.id,
              error: supabaseUpdateError.message,
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to update password. Please try again.',
            });
          }

          // F4.5b — revoke all active Supabase sessions so the old password
          // can no longer be used on any logged-in device
          await supabaseAdmin.auth.admin.signOut(supabaseAuthId).catch((signOutErr: any) => {
            logger.warn({
              type: 'auth_password_reset_session_revoke_warn',
              userId: user.id,
              error: signOutErr.message,
            });
          });

          // Invalidate Redis user cache
          await redis.del(`user:session:${supabaseAuthId}`);
        }

        // F4.6 — notify the user that their password was changed
        reactMailer.sendPasswordResetEmail(user.email, {
          userName: user.fullName || user.email,
          resetUrl: `${process.env.FRONTEND_URL}/login`,
          expiresInMinutes: 0, // confirmation email — not a new reset link
        }).catch(() => {});

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

        // Confirm email in Supabase FIRST — if this fails the whole mutation fails,
        // keeping Prisma consistent (not marked verified when Supabase isn't).
        if ((user as any).supabaseAuthId) {
          const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(
            (user as any).supabaseAuthId,
            { email_confirm: true },
          );
          if (supabaseError) {
            logger.error({
              type: 'auth_email_verify_supabase_error',
              userId: user.id,
              error: supabaseError.message,
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to confirm email with auth provider. Please try again.',
            });
          }
        }

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

        if (user.role !== 'REGULATOR') {
          reactMailer.sendWelcomeEmail(user.email, {
            userName: user.fullName || user.email,
            role: user.role,
            dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
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

  /**
   * Resend email verification — F3.6 (converted from protectedProcedure to publicProcedure).
   *
   * Previously required an authenticated session, which created a UX deadlock
   * once login enforces emailVerified. Now takes an email address and looks up
   * the user directly, rate-limited at 3/hour by email address.
   */
  resendVerification: publicProcedure
    .input(z.object({ email: z.string().email('Please provide a valid email address') }))
    .mutation(async ({ input, ctx }) => {
      try {
        const rateLimitKey = `email_resend:${input.email.toLowerCase()}`;
        const count = await redis.incr(rateLimitKey);
        if (count === 1) await redis.expire(rateLimitKey, 3600);
        if (count > 3) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many verification email requests. Please try again in an hour.',
          });
        }

        const user = await ctx.prisma.user.findUnique({
          where: { email: input.email.toLowerCase() },
          select: { id: true, email: true, fullName: true, emailVerified: true },
        });

        // Always return success — don't reveal whether the email is registered
        if (!user) {
          return { success: true, message: 'If an account exists with this email, a verification link has been sent.' };
        }

        if (user.emailVerified) {
          return { success: true, message: 'This email address is already verified.' };
        }

        // Generate a Supabase magic-link for the existing unverified user.
        // This does NOT require the password and produces a real Supabase OTP URL
        // that sets email_confirmed_at when clicked, then redirects to /auth/callback.
        const appCallbackUrl = process.env.APP_CALLBACK_URL || 'https://sheriabot.com/auth/callback';
        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: 'magiclink',
          email: user.email,
          options: { redirectTo: appCallbackUrl },
        });

        if (linkError || !linkData?.properties?.action_link) {
          logger.error({ type: 'auth_resend_supabase_link_error', userId: user.id, error: linkError?.message });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate verification link. Please try again.' });
        }

        const verificationUrl = linkData.properties.action_link;
        await reactMailer.sendVerificationEmail(user.email, {
          userName: user.fullName || user.email,
          verificationUrl,
          expiresInHours: 24,
        });

        logger.info({ type: 'auth_resend_verification_success', userId: user.id });
        return { success: true, message: 'Verification email sent.' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to resend verification email', cause: error });
      }
    }),

  /**
   * Confirm email via Supabase callback.
   *
   * Called by the /auth/callback frontend page after the user clicks the
   * Supabase OTP verification link in their email.  Supabase has already set
   * email_confirmed_at by the time this is reached; we use the issued
   * access_token to identify the user and sync Prisma emailVerified.
   *
   * Flow:
   *  1. User clicks Supabase link in email → Supabase verifies → redirects to
   *     https://sheriabot.com/auth/callback#access_token=xxx&...
   *  2. Frontend /auth/callback page reads the session via supabase.auth.getSession()
   *  3. Frontend calls this procedure with the access_token
   *  4. We verify the token with Supabase admin, find the Prisma user, and mark
   *     emailVerified = true.
   */
  confirmEmailCallback: publicProcedure
    .input(z.object({ accessToken: z.string().min(1, 'Access token is required') }))
    .mutation(async ({ input, ctx }) => {
      try {
        // 1. Verify the access token with Supabase and get the authenticated user
        const { data: { user: supabaseUser }, error: supabaseError } =
          await supabaseAdmin.auth.getUser(input.accessToken);

        if (supabaseError || !supabaseUser) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification token' });
        }

        // 2. Find the matching Prisma user
        const user = await ctx.prisma.user.findUnique({
          where: { supabaseAuthId: supabaseUser.id },
          select: { id: true, email: true, fullName: true, role: true, emailVerified: true },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User account not found' });
        }

        // 3. Idempotent — return early if already verified
        if (user.emailVerified) {
          return {
            success: true,
            requiresApproval: user.role === 'REGULATOR',
            alreadyVerified: true,
          };
        }

        const newAccountStatus = user.role === 'REGULATOR' ? 'pending_approval' : 'active';

        // 4. Mark Prisma user as verified
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

        // 5. Send welcome email for non-regulator users
        if (user.role !== 'REGULATOR') {
          reactMailer.sendWelcomeEmail(user.email, {
            userName: user.fullName || user.email,
            role: user.role,
            dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
          }).catch(() => {});
        }

        logger.info({ type: 'auth_email_callback_verified', userId: user.id, accountStatus: newAccountStatus });

        return {
          success: true,
          requiresApproval: user.role === 'REGULATOR',
          alreadyVerified: false,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Email confirmation failed', cause: error });
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
