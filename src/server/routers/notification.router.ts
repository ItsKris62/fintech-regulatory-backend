import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure } from '../trpc/trpc';
import {
  listNotificationsSchema,
  markAsReadSchema,
  deleteNotificationSchema,
  updateNotificationPreferencesSchema,
  updateCategoryPreferenceSchema,
} from '../schemas/notification.schema';
import type { NotificationCategoryName, ExtendedNotificationType } from '@/modules/notification/notification.types';
import { notificationModule } from '@/modules/notification';
import { logger } from '@/utils/logger';

/**
 * Notification Router
 *
 * In-app notification management: list, mark-as-read, preferences.
 * Business logic delegated to NotificationModule.
 */
export const notificationRouter = router({
  /**
   * List notifications for the current user
   *
   * @protected
   */
  list: protectedProcedure
    .input(listNotificationsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, unreadOnly, type, category } = input;

        const result = await notificationModule.getNotifications(ctx.user!.id, {
          page,
          limit,
          ...(unreadOnly === true && { read: false }),
          ...(type && { type: type as ExtendedNotificationType }),
          ...(category && { category: category as NotificationCategoryName }),
        });

        return result;
      } catch (error: unknown) {
        logger.error({
          type: 'notification_list_error',
          userId: ctx.user!.id,
          error: (error as Error).message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve notifications',
          cause: error,
        });
      }
    }),

  /**
   * Get unread notification count (for bell badge)
   *
   * @protected
   */
  getUnreadCount: protectedProcedure.query(async ({ ctx }) => {
    try {
      const count = await notificationModule.getUnreadCount(ctx.user!.id);
      return { count };
    } catch (error: any) {
      logger.error({
        type: 'notification_unread_count_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get unread count',
        cause: error,
      });
    }
  }),

  /**
   * Mark a single notification as read
   *
   * @protected
   */
  markAsRead: protectedProcedure
    .input(markAsReadSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const notification = await notificationModule.markAsRead(
          input.notificationId,
          ctx.user!.id
        );

        logger.info({
          type: 'notification_marked_read',
          userId: ctx.user!.id,
          notificationId: input.notificationId,
        });

        return notification;
      } catch (error: any) {
        logger.error({
          type: 'notification_mark_read_error',
          userId: ctx.user!.id,
          notificationId: input.notificationId,
          error: error.message,
        });

        if (error.name === 'NotFoundError') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found' });
        }
        if (error.name === 'ForbiddenError') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to mark notification as read',
          cause: error,
        });
      }
    }),

  /**
   * Mark all notifications as read
   *
   * @protected
   */
  markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const count = await notificationModule.markAllAsRead(ctx.user!.id);

      logger.info({
        type: 'all_notifications_marked_read',
        userId: ctx.user!.id,
        count,
      });

      return { count, success: true };
    } catch (error: any) {
      logger.error({
        type: 'notification_mark_all_read_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to mark all notifications as read',
        cause: error,
      });
    }
  }),

  /**
   * Delete a notification
   *
   * @protected
   */
  delete: protectedProcedure
    .input(deleteNotificationSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await notificationModule.deleteNotification(input.notificationId, ctx.user!.id);

        logger.info({
          type: 'notification_deleted',
          userId: ctx.user!.id,
          notificationId: input.notificationId,
        });

        return { success: true, message: 'Notification deleted' };
      } catch (error: any) {
        logger.error({
          type: 'notification_delete_error',
          userId: ctx.user!.id,
          notificationId: input.notificationId,
          error: error.message,
        });

        if (error.name === 'NotFoundError') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found' });
        }
        if (error.name === 'ForbiddenError') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete notification',
          cause: error,
        });
      }
    }),

  /**
   * Delete all read notifications
   *
   * @protected
   */
  deleteAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      const count = await notificationModule.deleteAllRead(ctx.user!.id);

      logger.info({
        type: 'read_notifications_deleted',
        userId: ctx.user!.id,
        count,
      });

      return { count, success: true };
    } catch (error: any) {
      logger.error({
        type: 'notification_delete_all_read_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to delete read notifications',
        cause: error,
      });
    }
  }),

  /**
   * Get notification preferences
   *
   * @protected
   */
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    try {
      const prefs = await notificationModule.getNotificationPreferences(ctx.user!.id);
      return prefs;
    } catch (error: any) {
      logger.error({
        type: 'notification_prefs_get_error',
        userId: ctx.user!.id,
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
   * Update notification preferences
   *
   * @protected
   */
  updatePreferences: protectedProcedure
    .input(updateNotificationPreferencesSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const prefs = await notificationModule.updateNotificationPreferences(
          ctx.user!.id,
          input as any
        );

        logger.info({
          type: 'notification_preferences_updated',
          userId: ctx.user!.id,
        });

        return prefs;
      } catch (error: any) {
        logger.error({
          type: 'notification_prefs_update_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update notification preferences',
          cause: error,
        });
      }
    }),

  /**
   * Get unread notification count broken down by category
   *
   * @protected
   */
  unreadCountByCategory: protectedProcedure.query(async ({ ctx }) => {
    try {
      const counts = await notificationModule.getUnreadCountByCategory(ctx.user!.id);
      return counts;
    } catch (error: unknown) {
      logger.error({
        type: 'notification_unread_by_category_error',
        userId: ctx.user!.id,
        error: (error as Error).message,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get unread counts by category',
        cause: error,
      });
    }
  }),

  /**
   * Get per-category notification preferences (seeds defaults if none exist)
   *
   * @protected
   */
  getCategoryPreferences: protectedProcedure.query(async ({ ctx }) => {
    try {
      const prefs = await notificationModule.getCategoryPreferences(ctx.user!.id);
      return prefs;
    } catch (error: unknown) {
      logger.error({
        type: 'notification_category_prefs_get_error',
        userId: ctx.user!.id,
        error: (error as Error).message,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get category preferences',
        cause: error,
      });
    }
  }),

  /**
   * Update in-app or email toggle for a single notification category.
   * SECURITY category in-app toggle cannot be turned off.
   *
   * @protected
   */
  updateCategoryPreference: protectedProcedure
    .input(updateCategoryPreferenceSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const pref = await notificationModule.updateCategoryPreference(
          ctx.user!.id,
          input.category as NotificationCategoryName,
          input.inAppEnabled,
          input.emailEnabled
        );

        logger.info({
          type: 'notification_category_preference_updated',
          userId: ctx.user!.id,
          category: input.category,
        });

        return pref;
      } catch (error: unknown) {
        logger.error({
          type: 'notification_category_pref_update_error',
          userId: ctx.user!.id,
          error: (error as Error).message,
        });

        if ((error as Error & { name?: string }).name === 'ForbiddenError') {
          throw new TRPCError({ code: 'FORBIDDEN', message: (error as Error).message });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update category preference',
          cause: error,
        });
      }
    }),

  // -- Admin ------------------------------------------------------------------

  /**
   * Get all system notifications (admin only)
   *
   * @admin
   */
  getSystemNotifications: adminProcedure
    .input(listNotificationsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const result = await notificationModule.getSystemNotifications({
          page: input.page,
          limit: input.limit,
          ...(input.type && { type: input.type as import('@/modules/notification/notification.types').ExtendedNotificationType }),
        });

        logger.info({
          type: 'admin_system_notifications_retrieved',
          adminId: ctx.user!.id,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_system_notifications_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get system notifications',
          cause: error,
        });
      }
    }),
});
