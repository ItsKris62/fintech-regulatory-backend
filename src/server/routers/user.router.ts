import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc/trpc';
import {
  updateProfileSchema,
  updatePreferencesSchema,
  deleteAccountSchema,
  setupTotpSchema,
  confirmTotpSchema,
  disableTotpSchema,
  revokeSessionSchema,
} from '../schemas/user.schema';
import { changePasswordSchema } from '../schemas/auth.schema';
import { hashPassword, verifyPassword } from '@/utils/helpers';
import { userCache } from '@/lib/redis/cache.service';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

const TOTP_PENDING_PREFIX = 'totp:pending:';
const TOTP_PENDING_TTL = 600; // 10 minutes

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
  getProfile: protectedProcedure.query(async ({ ctx }) => {
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
   * Change password
   */
  changePassword: protectedProcedure
    .input(changePasswordSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user.id },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        const validPassword = await verifyPassword(input.currentPassword, user.password);
        if (!validPassword) {
          logger.warn({ type: 'user_change_password_invalid_current', userId: ctx.user.id });
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Current password is incorrect',
          });
        }

        const newHashedPassword = await hashPassword(input.newPassword);

        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: { password: newHashedPassword, updatedAt: new Date() },
        });

        // Revoke all other sessions after password change
        if (ctx.user.sessionId) {
          await ctx.prisma.session.deleteMany({
            where: {
              userId: ctx.user.id,
              id: { not: ctx.user.sessionId },
            },
          });
        }

        logger.info({ type: 'user_password_changed', userId: ctx.user.id });

        return { success: true, message: 'Password changed successfully' };
      } catch (error: any) {
        logger.error({
          type: 'user_change_password_error',
          userId: ctx.user.id,
          error: error.message,
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
   * Initiate TOTP setup — returns secret + otpauth URI for QR code display
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
      await redis.setex(
        `${TOTP_PENDING_PREFIX}${ctx.user.id}`,
        TOTP_PENDING_TTL,
        secret,
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
   * Confirm TOTP setup — verify first code from authenticator app and enable 2FA
   */
  confirmTotpSetup: protectedProcedure
    .input(confirmTotpSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const otplib = require('otplib');

        const secret = await redis.get(`${TOTP_PENDING_PREFIX}${ctx.user.id}`);
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

        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: {
            totpSecret: secret,
            totpEnabled: true,
          } as any,
        });

        await redis.del(`${TOTP_PENDING_PREFIX}${ctx.user.id}`);
        await userCache.delete(ctx.user.id);

        logger.info({ type: 'user_totp_enabled', userId: ctx.user.id });

        return { success: true, message: 'Two-factor authentication enabled successfully.' };
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
   * Disable TOTP 2FA — requires current password for security confirmation
   */
  disableTotp: protectedProcedure
    .input(disableTotpSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user.id },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        const isValid = await verifyPassword(input.password, user.password);
        if (!isValid) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Incorrect password. Please try again.',
          });
        }

        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: {
            totpSecret: null,
            totpEnabled: false,
          } as any,
        });

        await userCache.delete(ctx.user.id);

        logger.info({ type: 'user_totp_disabled', userId: ctx.user.id });

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

  // ─── NOTIFICATION PREFERENCES ─────────────────────────────────────────────

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
          paymentDueReminder: true,
          complianceQueryReady: true,
          policyDocumentReady: true,
          documentIngestionComplete: true,
        };
      }

      return {
        paymentDueReminder: prefs.paymentDueReminder,
        complianceQueryReady: prefs.complianceQueryReady,
        policyDocumentReady: prefs.policyDocumentReady,
        documentIngestionComplete: prefs.documentIngestionComplete,
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

  /**
   * Update the current user's notification preferences
   */
  updateNotificationPreferences: protectedProcedure
    .input(
      z.object({
        paymentDueReminder: z.boolean().optional(),
        complianceQueryReady: z.boolean().optional(),
        policyDocumentReady: z.boolean().optional(),
        documentIngestionComplete: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const prefs = await ctx.prisma.notificationPreference.upsert({
          where: { userId: ctx.user.id },
          create: {
            userId: ctx.user.id,
            ...input,
          },
          update: input,
        });

        logger.info({
          type: 'user_notification_prefs_updated',
          userId: ctx.user.id,
        });

        return {
          paymentDueReminder: prefs.paymentDueReminder,
          complianceQueryReady: prefs.complianceQueryReady,
          policyDocumentReady: prefs.policyDocumentReady,
          documentIngestionComplete: prefs.documentIngestionComplete,
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
});
