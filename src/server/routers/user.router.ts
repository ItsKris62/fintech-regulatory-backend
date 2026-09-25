import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, adminMfaEnforced, recordFreshMfaVerification } from '../trpc/trpc';
import { notificationModule } from '@/modules/notification';
import {
  updateProfileSchema,
  updatePreferencesSchema,
  deleteAccountSchema,
  setupTotpSchema,
  confirmTotpSchema,
  disableTotpSchema,
  revokeSessionSchema,
  updateAllNotificationPreferencesSchema,
  getAvatarUploadUrlSchema,
  confirmAvatarUploadSchema,
  recordActivationSchema,
} from '../schemas/user.schema';
import { avatarService } from '@/modules/user/avatar.service';
import { changePasswordSchema } from '../schemas/auth.schema';
import { hashPassword, verifyPassword } from '@/utils/helpers';
import { userCache } from '@/lib/redis/cache.service';
import { redis } from '@/lib/redis/client';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase';
import { logger } from '@/utils/logger';
import { getSystemConfigNumber } from '@/lib/system-config';
import { validatePassword } from '@/shared/validation/password.schema';
import { logSecurityEvent, SECURITY_EVENT_TYPES } from '@/server/services/audit.service';

const TOTP_PENDING_PREFIX = 'totp:pending:';
const TOTP_PENDING_TTL = 600; // 10 minutes

function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

/**
 * User Router
 *
 * Handles user profile management, preferences, session management, and 2FA.
 * All routes require authentication.
 */
export const userRouter = router({
  /**
   * Get current user profile
   */
  getProfile: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    try {
      const cached = await userCache.get(ctx.user.id);
      if (cached) {
        return cached;
      }

      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.id },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              type: true,
              registrationNumber: true,
              industry: true,
              requireMfa: true,
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

      const profile = {
        id: user.id,
        email: user.email,
        name: user.fullName,
        role: user.role,
        phone: user.phone,
        avatar: user.avatar,
        emailVerified: user.emailVerified,
        organization: user.organization,
        preferences: (user as any).preferences ?? {},
        totpEnabled: (user as any).totpEnabled ?? false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      };

      await userCache.set(ctx.user.id, profile);
      return profile;
    } catch (error: any) {
      logger.error({
        type: 'user_get_profile_error',
        userId: ctx.user.id,
        error: error.message,
      });

      if (error instanceof TRPCError) throw error;

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch profile',
        cause: error,
      });
    }
  }),

  /**
   * Update user profile (name, phone)
   */
  updateProfile: protectedProcedure
    .input(updateProfileSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const updateData: Record<string, any> = { updatedAt: new Date() };
        if (input.name !== undefined) updateData.fullName = input.name;
        if (input.phone !== undefined) updateData.phone = input.phone;

        const user = await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: updateData,
          select: {
            id: true,
            email: true,
            fullName: true,
            phone: true,
            role: true,
            updatedAt: true,
          },
        });

        await userCache.delete(ctx.user.id);

        logger.info({
          type: 'user_profile_updated',
          userId: ctx.user.id,
          fields: Object.keys(input),
        });

        notificationModule.createCategorizedNotification({
          userId: ctx.user.id,
          type: 'PROFILE_UPDATED',
          category: 'ACCOUNT',
          title: 'Profile Updated',
          message: 'Your profile information was successfully updated.',
        }).catch(() => { /* non-blocking */ });

        return { success: true, user };
      } catch (error: any) {
        logger.error({
          type: 'user_update_profile_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update profile',
          cause: error,
        });
      }
    }),

  /**
   * Change password (hardened)
   *
   * Security controls applied in order:
   * 1. Rate limiting (5 per 15 min per userId) before any DB work.
   * 2. Current password verification via bcrypt.
   * 3. New password hashed and saved to Prisma.
   * 4. Supabase Auth password updated so Supabase-native flows also reflect the change.
   * 5. All Supabase sessions revoked (old token can no longer be used).
   * 6. Redis user-session cache cleared.
   * 7. Other Prisma sessions deleted.
   * 8. Success logged.
   *
   * The caller (frontend) must call logout() after receiving success  -  all
   * Supabase sessions are invalidated so the current token is no longer valid.
   */
  changePassword: protectedProcedure
    .input(changePasswordSchema)
    .mutation(async ({ input, ctx }) => {
      // -- 1. Rate limit (must be first, before any DB queries) -------------
      const rateCheck = await rateLimiter.check(ctx.user.id, 'change-password', 5, 900);
      if (!rateCheck.allowed) {
        logger.warn({
          type: 'user_password_change_rate_limited',
          userId: ctx.user.id,
          retryAfter: rateCheck.retryAfter,
        }, 'Password change rate limited');
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many password change attempts. Please try again in 15 minutes.',
        });
      }

      try {
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user.id },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        // -- 2. Verify current password ------------------------------------
        // Users registered after the B4 migration have no local bcrypt hash
        // (Supabase is the authoritative credential store). They must reset
        // their password via the "Forgot Password" flow before using this endpoint.
        if (!user.password) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Password verification is unavailable for your account. Please use "Forgot Password" to set a new password.',
          });
        }
        const validPassword = await verifyPassword(input.currentPassword, user.password);
        if (!validPassword) {
          logger.warn({
            type: 'user_password_change_failed',
            userId: ctx.user.id,
            reason: 'invalid_current_password',
          }, 'Password change failed - wrong current password');

          notificationModule.createCategorizedNotification({
            userId: ctx.user.id,
            type: 'PASSWORD_CHANGE_FAILED',
            category: 'SECURITY',
            title: 'Failed Password Change Attempt',
            message: "A failed attempt was made to change your password. If this wasn't you, please secure your account.",
          }).catch(() => { /* non-blocking */ });

          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Current password is incorrect',
          });
        }

        const passwordMinLength = await getSystemConfigNumber('passwordMinLength', 10);
        const pwValidation = validatePassword(input.newPassword, user.email, { minLength: passwordMinLength });
        if (!pwValidation.isValid) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: pwValidation.errors[0] });
        }

        // -- 3. Hash and save new password to Prisma -----------------------
        const newHashedPassword = await hashPassword(input.newPassword);

        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: { password: newHashedPassword, updatedAt: new Date() },
        });

        // -- 4. Sync Supabase Auth password (CRITICAL) ---------------------
        // Without this, the old password continues to work via Supabase-native
        // auth flows (SDK, mobile, etc.) even after a successful change here.
        const supabaseAuthId = (user as { supabaseAuthId?: string | null }).supabaseAuthId;
        if (supabaseAuthId) {
          const { error: supabaseUpdateError } = await supabaseAdmin.auth.admin.updateUserById(
            supabaseAuthId,
            { password: input.newPassword },
          );
          if (supabaseUpdateError) {
            logger.error({
              type: 'user_password_change_supabase_update_error',
              userId: ctx.user.id,
              error: supabaseUpdateError.message,
            });
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to sync password  -  please try again.',
            });
          }

          // -- 5. Revoke all Supabase sessions ---------------------------
          // Mirrors auth.resetPassword. All existing JWTs become invalid.
          // The frontend must call logout() after success.
          await supabaseAdmin.auth.admin.signOut(supabaseAuthId).catch((signOutErr: unknown) => {
            logger.warn({
              type: 'user_password_change_session_revoke_warn',
              userId: ctx.user.id,
              error: signOutErr instanceof Error ? signOutErr.message : String(signOutErr),
            });
          });

          // -- 6. Clear Redis user-session cache -------------------------
          await redis.del(`user:session:${supabaseAuthId}`);
        }

        await redis.del(`sheriabot:admin:mfa_verified:${ctx.user.id}`).catch(() => {});

        // -- 7. Revoke other Prisma sessions -------------------------------
        if (ctx.user.sessionId) {
          await ctx.prisma.session.deleteMany({
            where: {
              userId: ctx.user.id,
              id: { not: ctx.user.sessionId },
            },
          });
        }

        logger.info({ type: 'user_password_changed', userId: ctx.user.id });

        notificationModule.createCategorizedNotification({
          userId: ctx.user.id,
          type: 'PASSWORD_CHANGED',
          category: 'SECURITY',
          title: 'Password Changed',
          message: "Your password was successfully changed. If you didn't make this change, please contact support immediately.",
        }).catch(() => { /* non-blocking */ });

        return { success: true, message: 'Password changed successfully. Please log in again.' };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({
          type: 'user_change_password_error',
          userId: ctx.user.id,
          error: message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to change password',
          cause: error,
        });
      }
    }),

  /**
   * Update user preferences (timezone, language, currency, jobTitle, etc.)
   */
  updatePreferences: protectedProcedure
    .input(updatePreferencesSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: {
            preferences: input.preferences,
            updatedAt: new Date(),
          } as any,
        });

        await userCache.delete(ctx.user.id);

        logger.info({ type: 'user_preferences_updated', userId: ctx.user.id });

        return { success: true, preferences: input.preferences };
      } catch (error: any) {
        logger.error({
          type: 'user_update_preferences_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update preferences',
          cause: error,
        });
      }
    }),

  /**
   * Record atomic account activation for core product workflows
   *
   * Database-enforced atomic conditional UPDATE compare-and-set:
   * Only updates if preferences->>'accountActivatedAt' is NULL.
   * Exactly one caller succeeds and receives firstActivation = true.
   */
  recordActivation: protectedProcedure
    .input(recordActivationSchema)
    .mutation(async ({ input, ctx }) => {
      const now = new Date().toISOString();
      try {
        const updatedUsers = await ctx.prisma.$queryRaw<Array<{ id: string; preferences: any }>>`
          UPDATE "User"
          SET preferences = jsonb_set(
            jsonb_set(
              COALESCE(preferences::jsonb, '{}'::jsonb),
              '{accountActivatedAt}',
              to_jsonb(${now}::text),
              true
            ),
            '{firstActivatedFeature}',
            to_jsonb(${input.featureName}::text),
            true
          ),
          "updatedAt" = NOW()
          WHERE id = ${ctx.user.id}
            AND (preferences IS NULL OR (preferences->>'accountActivatedAt') IS NULL)
          RETURNING id, preferences;
        `;

        if (updatedUsers && updatedUsers.length > 0) {
          await userCache.delete(ctx.user.id);

          logger.info({
            type: 'account_first_activation',
            userId: ctx.user.id,
            featureName: input.featureName,
            jurisdictionCode: input.jurisdictionCode,
            activatedAt: now,
          });

          return {
            firstActivation: true,
            activatedAt: now,
          };
        }

        // If 0 rows updated, fetch existing activation timestamp
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user.id },
          select: { preferences: true },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        const prefs = (user.preferences as Record<string, any>) || {};
        return {
          firstActivation: false,
          activatedAt: (prefs.accountActivatedAt as string) || undefined,
        };
      } catch (error: any) {
        logger.error({
          type: 'user_record_activation_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to record account activation',
          cause: error,
        });
      }
    }),

  // ============================================================
  // SESSION MANAGEMENT
  // ============================================================

  /**
   * Get all active sessions for the current user
   */
  getSessions: protectedProcedure.query(async ({ ctx }) => {
    try {
      const sessions = await ctx.prisma.session.findMany({
        where: {
          userId: ctx.user.id,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          device: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          expiresAt: true,
        },
      });

      return sessions.map((s: any) => ({
        id: s.id,
        device: s.device || 'Unknown Device',
        ipAddress: s.ipAddress || 'Unknown',
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        isCurrent: s.id === ctx.user.sessionId,
      }));
    } catch (error: any) {
      logger.error({
        type: 'user_get_sessions_error',
        userId: ctx.user.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch sessions',
        cause: error,
      });
    }
  }),

  /**
   * Revoke a specific session by ID
   */
  revokeSession: protectedProcedure
    .input(revokeSessionSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await ctx.prisma.session.deleteMany({
          where: {
            id: input.sessionId,
            userId: ctx.user.id, // Ensure user owns this session
          },
        });

        logger.info({
          type: 'user_session_revoked',
          userId: ctx.user.id,
          sessionId: input.sessionId,
        });

        await redis.del(`sheriabot:admin:mfa_verified:${ctx.user.id}`).catch(() => {});

        return { success: true };
      } catch (error: any) {
        logger.error({
          type: 'user_revoke_session_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to revoke session',
          cause: error,
        });
      }
    }),

  /**
   * Revoke all sessions except the current one
   */
  revokeOtherSessions: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const where: any = { userId: ctx.user.id };
      if (ctx.user.sessionId) {
        where.id = { not: ctx.user.sessionId };
      }

      const result = await ctx.prisma.session.deleteMany({ where });

      logger.info({
        type: 'user_other_sessions_revoked',
        userId: ctx.user.id,
        count: result.count,
      });

      return { success: true, sessionsRevoked: result.count };
    } catch (error: any) {
      logger.error({
        type: 'user_revoke_other_sessions_error',
        userId: ctx.user.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to revoke other sessions',
        cause: error,
      });
    }
  }),

  /**
   * Revoke ALL sessions (logout from all devices)
   */
  revokeAllSessions: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const result = await ctx.prisma.session.deleteMany({
        where: { userId: ctx.user.id },
      });

      logger.info({
        type: 'user_all_sessions_revoked',
        userId: ctx.user.id,
        count: result.count,
      });

      await redis.del(`sheriabot:admin:mfa_verified:${ctx.user.id}`).catch(() => {});

      return { success: true, sessionsRevoked: result.count };
    } catch (error: any) {
      logger.error({
        type: 'user_revoke_all_sessions_error',
        userId: ctx.user.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to revoke all sessions',
        cause: error,
      });
    }
  }),

  // ============================================================
  // TOTP 2FA
  // ============================================================

  /**
   * Get TOTP / 2FA status for current user
   */
  getTotpStatus: protectedProcedure.query(async ({ ctx }) => {
    try {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.id },
        select: { id: true },
      });

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const enabled: boolean = (user as any).totpEnabled ?? false;
      return { enabled };
    } catch (error: any) {
      if (error instanceof TRPCError) throw error;

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch 2FA status',
        cause: error,
      });
    }
  }),

  /**
   * Initiate TOTP setup  -  returns secret + otpauth URI for QR code display
   */
  setupTotp: protectedProcedure.input(setupTotpSchema).mutation(async ({ ctx }) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const otplib = require('otplib');

      const secret: string = otplib.generateSecret();
      const otpauth: string = await otplib.generateURI({
        issuer: 'SheriaBot',
        label: ctx.user.email,
        secret,
      });

      // Store pending secret in Redis for 10 minutes
      await redis.set(
        `${TOTP_PENDING_PREFIX}${ctx.user.id}`,
        secret,
        { ex: TOTP_PENDING_TTL },
      );

      logger.info({ type: 'user_totp_setup_initiated', userId: ctx.user.id });

      return { secret, otpauth };
    } catch (error: any) {
      logger.error({
        type: 'user_totp_setup_error',
        userId: ctx.user.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to initiate 2FA setup. Please try again.',
        cause: error,
      });
    }
  }),

  /**
   * Confirm TOTP setup  -  verify first code from authenticator app, generate backup codes, and enable 2FA
   */
  confirmTotpSetup: protectedProcedure
    .input(confirmTotpSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const otplib = require('otplib');

        const secret = await redis.get<string>(`${TOTP_PENDING_PREFIX}${ctx.user.id}`);
        if (!secret) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Setup session expired. Please start the 2FA setup again.',
          });
        }

        const result = await otplib.verify({ secret, token: input.code });
        const isValid = result?.valid === true;
        if (!isValid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid code. Please check your authenticator app and try again.',
          });
        }

        // Generate 8 cryptographically secure single-use backup codes
        const backupCodes = generateBackupCodes(8);
        const hashedCodes = await Promise.all(backupCodes.map((c) => hashPassword(c)));

        await ctx.prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: ctx.user.id },
            data: {
              totpSecret: secret,
              totpEnabled: true,
            } as any,
          });

          await tx.userBackupCode.deleteMany({
            where: { userId: ctx.user.id },
          });

          await tx.userBackupCode.createMany({
            data: hashedCodes.map((codeHash) => ({
              userId: ctx.user.id,
              codeHash,
            })),
          });
        });

        await redis.del(`${TOTP_PENDING_PREFIX}${ctx.user.id}`);
        await userCache.delete(ctx.user.id);

        await recordFreshMfaVerification(ctx.user.id);
        logger.info({ type: 'user_totp_enabled', userId: ctx.user.id });

        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.MFA_ENROLLED,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId,
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'],
        });

        return {
          success: true,
          message: 'Two-factor authentication enabled successfully.',
          backupCodes,
        };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        logger.error({
          type: 'user_totp_confirm_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to confirm 2FA setup',
          cause: error,
        });
      }
    }),

  /**
   * Step-up MFA verification: verifies a TOTP code or backup code for an already-enrolled user/admin
   * and records fresh MFA verification in Redis (sheriabot:admin:mfa_verified:${userId})
   * allowing high-risk operations within the step-up window.
   */
  verifyStepUp: protectedProcedure
    .input(z.object({
      code: z.string().min(6).max(12),
      isBackupCode: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const stepUpAttemptKey = `sheriabot:auth:mfa_step_up_attempts:${ctx.user.id}`;
      const attempts = await redis.incr(stepUpAttemptKey);
      if (attempts === 1) {
        await redis.expire(stepUpAttemptKey, 900); // 15-minute rate limit window
      }
      if (attempts > 5) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.MFA_RATE_LIMITED,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId,
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'],
          metadata: { action: 'verifyStepUp', attempts },
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many verification attempts. Please wait 15 minutes before trying again.',
        });
      }

      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.id },
        select: { totpSecret: true, totpEnabled: true },
      });

      if (!user?.totpEnabled) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'MFA is not enabled on this account.',
        });
      }

      let verified = false;

      if (input.isBackupCode) {
        const backupCodes = await ctx.prisma.userBackupCode.findMany({
          where: { userId: ctx.user.id },
        });
        for (const record of backupCodes) {
          if (await verifyPassword(input.code, record.codeHash)) {
            await ctx.prisma.userBackupCode.delete({ where: { id: record.id } });
            verified = true;
            await logSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.MFA_BACKUP_CODE_USED,
              userId: ctx.user.id,
              organizationId: ctx.user.organizationId,
              ipAddress: ctx.req.ip,
              userAgent: ctx.req.headers['user-agent'],
              metadata: { action: 'verifyStepUp', backupCodeId: record.id },
            });
            break;
          }
        }
      } else if (user.totpSecret) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const otplib = require('otplib');
        const result = await otplib.verify({ secret: user.totpSecret, token: input.code });
        verified = result === true || (result as any)?.valid === true;
      }

      if (!verified) {
        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.MFA_STEP_UP_FAILED,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId,
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'],
          metadata: { action: 'verifyStepUp', isBackupCode: !!input.isBackupCode },
        });
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid MFA verification code.',
        });
      }

      // Reset attempt counter on success
      await redis.del(stepUpAttemptKey).catch(() => {});

      await recordFreshMfaVerification(ctx.user.id);

      await logSecurityEvent({
        eventType: SECURITY_EVENT_TYPES.MFA_STEP_UP_VERIFIED,
        userId: ctx.user.id,
        organizationId: ctx.user.organizationId,
        ipAddress: ctx.req.ip,
        userAgent: ctx.req.headers['user-agent'],
        metadata: { action: 'verifyStepUp', isBackupCode: !!input.isBackupCode },
      });

      logger.info({ type: 'mfa_step_up_verified', userId: ctx.user.id });

      return { success: true };
    }),

  /**
   * Disable TOTP 2FA  -  requires current password and second factor (TOTP or backup code)
   */
  disableTotp: protectedProcedure
    .use(adminMfaEnforced)
    .input(disableTotpSchema)
    .mutation(async ({ input, ctx }) => {
      const disableAttemptKey = `sheriabot:auth:mfa_disable_attempts:${ctx.user.id}`;

      try {
        // Rate limiting for disableTotp: 5 attempts per 5 minutes per user
        const attempts = await redis.incr(disableAttemptKey);
        if (attempts === 1) {
          await redis.expire(disableAttemptKey, 300);
        }

        if (attempts > 5) {
          await logSecurityEvent({
            eventType: SECURITY_EVENT_TYPES.MFA_RATE_LIMITED,
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,
            ipAddress: ctx.req.ip,
            userAgent: ctx.req.headers['user-agent'],
            metadata: { action: 'disableTotp', attempts },
          });
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'MFA_ATTEMPTS_EXCEEDED',
          });
        }

        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user.id },
          include: {
            backupCodes: { where: { usedAt: null } },
          },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        if (!user.totpEnabled) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Two-factor authentication is not enabled on this account.',
          });
        }

        // 1. Password factor verification
        let isPasswordValid = false;
        if (user.password) {
          isPasswordValid = await verifyPassword(input.password, user.password);
        } else if (user.email) {
          // Fallback to Supabase authentication for Supabase-only registered users
          const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
            email: user.email,
            password: input.password,
          });
          if (!authError && authData?.user) {
            isPasswordValid = true;
          }
        }

        if (!isPasswordValid) {
          await logSecurityEvent({
            eventType: SECURITY_EVENT_TYPES.MFA_VERIFY_FAILED,
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,
            ipAddress: ctx.req.ip,
            userAgent: ctx.req.headers['user-agent'],
            metadata: { action: 'disableTotp', failedFactor: 'password' },
          });
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Incorrect password. Please try again.',
          });
        }

        // 2. Second factor verification (TOTP code or Backup Code)
        let isValidSecondFactor = false;

        if (input.isBackupCode) {
          const cleanCode = input.code.trim().replace(/[-\s]/g, '').toUpperCase();
          let matchedBackupCodeId: string | null = null;
          for (const bc of user.backupCodes) {
            const matches = await verifyPassword(cleanCode, bc.codeHash);
            if (matches) {
              matchedBackupCodeId = bc.id;
              break;
            }
          }

          if (matchedBackupCodeId) {
            const claimResult = await ctx.prisma.userBackupCode.updateMany({
              where: {
                id: matchedBackupCodeId,
                userId: ctx.user.id,
                usedAt: null,
              },
              data: {
                usedAt: new Date(),
              },
            });
            if (claimResult.count === 1) {
              isValidSecondFactor = true;
              await logSecurityEvent({
                eventType: SECURITY_EVENT_TYPES.MFA_BACKUP_CODE_USED,
                userId: ctx.user.id,
                organizationId: ctx.user.organizationId,
                ipAddress: ctx.req.ip,
                userAgent: ctx.req.headers['user-agent'],
                metadata: { action: 'disableTotp', backupCodeId: matchedBackupCodeId },
              });
            }
          }

          if (!isValidSecondFactor) {
            await logSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.MFA_VERIFY_FAILED,
              userId: ctx.user.id,
              organizationId: ctx.user.organizationId,
              ipAddress: ctx.req.ip,
              userAgent: ctx.req.headers['user-agent'],
              metadata: { action: 'disableTotp', failedFactor: 'backup_code' },
            });
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Invalid backup code. Please check and try again.',
            });
          }
        } else {
          if (!user.totpSecret) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Two-factor secret is missing on account.',
            });
          }
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const otplib = require('otplib');
          const verified = await otplib.verify({
            secret: user.totpSecret,
            token: input.code.trim(),
          });
          if (verified?.valid !== true) {
            await logSecurityEvent({
              eventType: SECURITY_EVENT_TYPES.MFA_VERIFY_FAILED,
              userId: ctx.user.id,
              organizationId: ctx.user.organizationId,
              ipAddress: ctx.req.ip,
              userAgent: ctx.req.headers['user-agent'],
              metadata: { action: 'disableTotp', failedFactor: 'totp' },
            });
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Invalid authentication code. Please check your authenticator app.',
            });
          }
          isValidSecondFactor = true;
        }

        // 3. Persist disable state and clean up backup codes
        await ctx.prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: ctx.user.id },
            data: {
              totpSecret: null,
              totpEnabled: false,
            } as any,
          });

          await tx.userBackupCode.deleteMany({
            where: { userId: ctx.user.id },
          });
        });

        // 4. Explicit session eviction: Revoke DB sessions and Redis session caches
        await ctx.prisma.session.deleteMany({
          where: { userId: ctx.user.id },
        });

        await userCache.delete(ctx.user.id);
        if ((user as any).supabaseAuthId) {
          await redis.del(`user:session:${(user as any).supabaseAuthId}`).catch(() => {});
        }
        // No userId-keyed session cache exists; fingerprint keys are keyed by sessionId and become unreachable once DB rows are deleted.
        await redis.del(disableAttemptKey).catch(() => {});
        await redis.del(`sheriabot:admin:mfa_verified:${ctx.user.id}`).catch(() => {});

        logger.info({ type: 'user_totp_disabled', userId: ctx.user.id });

        await logSecurityEvent({
          eventType: SECURITY_EVENT_TYPES.MFA_DISABLED,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId,
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'],
        });

        return { success: true, message: 'Two-factor authentication disabled.' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        logger.error({
          type: 'user_totp_disable_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to disable 2FA',
          cause: error,
        });
      }
    }),

  /**
   * Delete user account (soft delete)
   */
  deleteAccount: protectedProcedure
    .input(deleteAccountSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        if (input.confirmEmail !== ctx.user.email) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Email confirmation does not match',
          });
        }

        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: { deletedAt: new Date() } as any,
        });

        await ctx.prisma.session.deleteMany({ where: { userId: ctx.user.id } });
        await userCache.delete(ctx.user.id);

        logger.info({
          type: 'user_account_deleted',
          userId: ctx.user.id,
          email: ctx.user.email,
        });

        return { success: true, message: 'Account deleted successfully' };
      } catch (error: any) {
        logger.error({
          type: 'user_delete_account_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete account',
          cause: error,
        });
      }
    }),

  // --- NOTIFICATION PREFERENCES ---------------------------------------------

  /**
   * Get the current user's notification preferences
   */
  getNotificationPreferences: protectedProcedure.query(async ({ ctx }) => {
    try {
      const prefs = await ctx.prisma.notificationPreference.findUnique({
        where: { userId: ctx.user.id },
      });

      // Return defaults if no record exists yet
      if (!prefs) {
        return {
          // General Email Notifications
          regulatoryUpdates: true,
          deadlineReminders: true,
          reportReady: true,
          supportResponses: true,
          // Specific Email Alerts
          paymentDueReminder: true,
          complianceQueryReady: true,
          policyDocumentReady: true,
          documentIngestionComplete: true,
          // In-App Notifications
          realTimeAlerts: true,
          inAppSoundsEnabled: true,
          // Email Digest
          emailDigestEnabled: false,
          digestFrequency: 'weekly' as const,
        };
      }

      return {
        // General Email Notifications
        regulatoryUpdates: prefs.regulatoryUpdates,
        deadlineReminders: prefs.deadlineReminders,
        reportReady: prefs.reportReady,
        supportResponses: prefs.supportResponses,
        // Specific Email Alerts
        paymentDueReminder: prefs.paymentDueReminder,
        complianceQueryReady: prefs.complianceQueryReady,
        policyDocumentReady: prefs.policyDocumentReady,
        documentIngestionComplete: prefs.documentIngestionComplete,
        // In-App Notifications
        realTimeAlerts: prefs.realTimeAlerts,
        inAppSoundsEnabled: (prefs as any).inAppSoundsEnabled ?? true,
        // Email Digest
        emailDigestEnabled: prefs.emailDigestEnabled,
        digestFrequency: prefs.digestFrequency,
      };
    } catch (error: any) {
      logger.error({
        type: 'user_get_notification_prefs_error',
        userId: ctx.user.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get notification preferences',
        cause: error,
      });
    }
  }),

  // --- AVATAR ---------------------------------------------------------------

  /**
   * Get a presigned PUT URL for direct browser-to-R2 avatar upload.
   * The client must PUT the image file to `uploadUrl`, then call
   * `confirmAvatarUpload` with the returned `publicUrl`.
   */
  getAvatarUploadUrl: protectedProcedure
    .input(getAvatarUploadUrlSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await avatarService.getUploadUrl(ctx.user.id, input.contentType, input.fileSize);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ type: 'avatar_get_upload_url_error', userId: ctx.user.id, error: message });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate upload URL',
          cause: error,
        });
      }
    }),

  /**
   * Confirm a completed avatar upload  -  persists the public URL to the user
   * profile and invalidates the profile cache.
   */
  confirmAvatarUpload: protectedProcedure
    .input(confirmAvatarUploadSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await avatarService.confirmUpload(ctx.user.id, input.publicUrl);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ type: 'avatar_confirm_upload_error', userId: ctx.user.id, error: message });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to confirm avatar upload',
          cause: error,
        });
      }
    }),

  /**
   * Delete the current user's avatar from R2 and clear the profile field.
   */
  deleteAvatar: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await avatarService.deleteAvatar(ctx.user.id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ type: 'avatar_delete_error', userId: ctx.user.id, error: message });
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to delete avatar',
        cause: error,
      });
    }
  }),

  /**
   * Update the current user's notification preferences
   */
  updateNotificationPreferences: protectedProcedure
    .input(updateAllNotificationPreferencesSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const prefs = await ctx.prisma.notificationPreference.upsert({
          where: { userId: ctx.user.id },
          create: {
            userId: ctx.user.id,
            ...input,
          } as any,
          update: input as any,
        });

        logger.info({
          type: 'user_notification_prefs_updated',
          userId: ctx.user.id,
          updatedFields: Object.keys(input),
        });

        return {
          // General Email Notifications
          regulatoryUpdates: prefs.regulatoryUpdates,
          deadlineReminders: prefs.deadlineReminders,
          reportReady: prefs.reportReady,
          supportResponses: prefs.supportResponses,
          // Specific Email Alerts
          paymentDueReminder: prefs.paymentDueReminder,
          complianceQueryReady: prefs.complianceQueryReady,
          policyDocumentReady: prefs.policyDocumentReady,
          documentIngestionComplete: prefs.documentIngestionComplete,
          // In-App Notifications
          realTimeAlerts: prefs.realTimeAlerts,
          inAppSoundsEnabled: (prefs as any).inAppSoundsEnabled ?? true,
          // Email Digest
          emailDigestEnabled: prefs.emailDigestEnabled,
          digestFrequency: prefs.digestFrequency,
        };
      } catch (error: any) {
        logger.error({
          type: 'user_update_notification_prefs_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update notification preferences',
          cause: error,
        });
      }
    }),

  // ============================================================
  // Section 34 Restriction of Processing (DPA 2019 / DSAR)
  // ============================================================

  /**
   * Get Section 34 restriction status for the current or specified user
   */
  getRestrictionStatus: protectedProcedure
    .input(z.object({ userId: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const targetUserId = input?.userId ?? ctx.user.id;
      const { section34RestrictionService } = await import('@/modules/user/restriction.service');
      return await section34RestrictionService.getRestrictionStatus(targetUserId);
    }),

  /**
   * Apply Section 34 restriction (DPO / Admin / DSAR Workflow)
   */
  restrictProcessing: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        reason: z.enum([
          'ACCURACY_CONTESTED',
          'DATA_NO_LONGER_REQUIRED_LEGAL_CLAIM',
          'UNLAWFUL_PROCESSING_ERASURE_OPPOSED',
          'OBJECTION_PENDING_VERIFICATION',
        ]),
        requestId: z.string(),
        restrictedPurposes: z
          .array(
            z.enum([
              'AI_QUERYING',
              'DIRECT_MARKETING',
              'PRODUCT_TELEMETRY',
              'POLICY_GENERATION',
              'GAP_ANALYSIS',
            ]),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { section34RestrictionService } = await import('@/modules/user/restriction.service');
      return await section34RestrictionService.restrictProcessing({
        ...input,
        dpoAdminId: ctx.user.id,
      });
    }),

  /**
   * Lift Section 34 restriction after accuracy verification or statutory resolution
   */
  liftProcessingRestriction: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        liftReason: z.string().min(5),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { section34RestrictionService } = await import('@/modules/user/restriction.service');
      return await section34RestrictionService.liftRestriction({
        ...input,
        dpoAdminId: ctx.user.id,
      });
    }),
});
