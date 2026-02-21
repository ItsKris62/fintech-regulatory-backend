import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc/trpc';
import {
  updateProfileSchema,
  updatePreferencesSchema,
  deleteAccountSchema,
} from '../schemas/user.schema';
import { changePasswordSchema } from '../schemas/auth.schema';
import { hashPassword, verifyPassword } from '@/utils/helpers';
import { userCache } from '@/lib/redis/cache.service';
import { logger } from '@/utils/logger';

/**
 * User Router
 *
 * Handles user profile management, preferences, and account operations.
 * All routes require authentication.
 */
export const userRouter = router({
  /**
   * Get current user profile
   *
   * @protected
   */
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    try {
      // Try cache first
      const cached = await userCache.get(ctx.user.id);
      if (cached) {
        return cached;
      }

      // Fetch from database
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
        emailVerified: user.emailVerified,
        organization: user.organization,
        preferences: (user as any).preferences,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      };

      // Cache for 5 minutes
      await userCache.set(ctx.user.id, profile);

      return profile;
    } catch (error: any) {
      logger.error({
        type: 'user_get_profile_error',
        userId: ctx.user.id,
        error: error.message,
      });

      if (error instanceof TRPCError) {
        throw error;
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch profile',
        cause: error,
      });
    }
  }),

  /**
   * Update user profile
   *
   * @protected
   */
  updateProfile: protectedProcedure
    .input(updateProfileSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: {
            ...input,
            updatedAt: new Date(),
          },
          select: {
            id: true,
            email: true,
            fullName: true,
            phone: true,
            role: true,
            updatedAt: true,
          },
        });

        // Invalidate cache
        await userCache.delete(ctx.user.id);

        logger.info({
          type: 'user_profile_updated',
          userId: ctx.user.id,
          fields: Object.keys(input),
        });

        return {
          success: true,
          user,
        };
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
   *
   * @protected
   */
  changePassword: protectedProcedure
    .input(changePasswordSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Get current user with password
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.user.id },
        });

        if (!user) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User not found',
          });
        }

        // Verify current password
        const validPassword = await verifyPassword(
          input.currentPassword,
          user.password
        );

        if (!validPassword) {
          logger.warn({
            type: 'user_change_password_invalid_current',
            userId: ctx.user.id,
          });

          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Current password is incorrect',
          });
        }

        // Hash new password
        const newHashedPassword = await hashPassword(input.newPassword);

        // Update password
        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: {
            password: newHashedPassword,
            updatedAt: new Date(),
          },
        });

        logger.info({
          type: 'user_password_changed',
          userId: ctx.user.id,
        });

        return {
          success: true,
          message: 'Password changed successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'user_change_password_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to change password',
          cause: error,
        });
      }
    }),

  /**
   * Update user preferences
   *
   * @protected
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

        // Invalidate cache
        await userCache.delete(ctx.user.id);

        logger.info({
          type: 'user_preferences_updated',
          userId: ctx.user.id,
        });

        return {
          success: true,
          preferences: input.preferences,
        };
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
   * Delete user account (soft delete)
   *
   * @protected
   */
  deleteAccount: protectedProcedure
    .input(deleteAccountSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Verify email confirmation
        if (input.confirmEmail !== ctx.user.email) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Email confirmation does not match',
          });
        }

        // Soft delete user
        await ctx.prisma.user.update({
          where: { id: ctx.user.id },
          data: {
            deletedAt: new Date(),
          } as any,
        });

        // Clear cache
        await userCache.delete(ctx.user.id);

        logger.info({
          type: 'user_account_deleted',
          userId: ctx.user.id,
          email: ctx.user.email,
        });

        return {
          success: true,
          message: 'Account deleted successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'user_delete_account_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete account',
          cause: error,
        });
      }
    }),
});
