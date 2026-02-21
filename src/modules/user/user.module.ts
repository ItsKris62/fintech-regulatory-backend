/**
 * User Module
 * Handles all user profile and account management business logic
 * 
 * Operations:
 * - Profile management (get, update)
 * - Preferences management
 * - Activity logging and retrieval
 * - User statistics
 * - Account deletion (GDPR compliant)
 * - Data export (GDPR compliant)
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { storageService } from '@/lib/storage/storage.service';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { verifyPassword } from '@/modules/auth/auth.utils';
import {
  toUserProfile,
  parsePreferences,
  mergePreferences,
  createActivityEntry,
  generateExportFilename,
  anonymizeUserData,
  generateDeletionEmail,
  generateEmailChangeEmail,
  updateProfileSchema,
  updatePreferencesSchema,
  activityLogFiltersSchema,
  deleteAccountSchema,
  daysSince,
} from './user.utils';
import {
  type UserProfile,
  type UpdateProfileInput,
  type UserPreferences,
  type UpdatePreferencesInput,
  type ActivityLogEntry,
  type ActivityLogFilters,
  type PaginatedActivityLog,
  type ActivityAction,
  type ResourceType,
  type UserStats,
  type DeleteAccountInput,
  type DeleteAccountResult,
  type UserDataExport,
  type ExportDataResult,
  USER_CACHE_KEYS,
  USER_CACHE_TTL,
  UserError,
} from './user.types';

/**
 * User Module Class
 * Encapsulates all user-related business logic
 */
class UserModule {
  private readonly appUrl: string;

  constructor() {
    this.appUrl = config.appUrl || 'http://localhost:3000';
  }

  // ==========================================================================
  // PROFILE OPERATIONS
  // ==========================================================================

  /**
   * Get user profile by ID
   * Uses caching for performance
   */
  async getProfile(userId: string): Promise<UserProfile> {
    logger.info({
      type: 'user_get_profile_started',
      userId,
    });

    try {
      // 1. Check cache first
      const cacheKey = USER_CACHE_KEYS.PROFILE(userId);
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        logger.debug({ type: 'user_profile_cache_hit', userId });
        return JSON.parse(cached);
      }

      // 2. Get from database
      const user = await (prisma as any).user.findUnique({
        where: { id: userId },
        include: {
          organization: {
            select: { name: true },
          },
        },
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      // 3. Convert to profile
      const profile = toUserProfile(user);

      // 4. Cache result
      await redis.setex(
        cacheKey,
        USER_CACHE_TTL.PROFILE,
        JSON.stringify(profile)
      );

      logger.info({
        type: 'user_get_profile_success',
        userId,
      });

      return profile;
    } catch (error: any) {
      logger.error({
        type: 'user_get_profile_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update user profile
   */
  async updateProfile(
    userId: string,
    updates: UpdateProfileInput
  ): Promise<UserProfile> {
    logger.info({
      type: 'user_update_profile_started',
      userId,
      updates: Object.keys(updates),
    });

    try {
      // 1. Validate updates
      const validated = updateProfileSchema.parse(updates);

      // 2. Check user exists
      const existingUser = await (prisma as any).user.findUnique({
        where: { id: userId },
      });

      if (!existingUser) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      // 3. Update user
      const updatedUser = await (prisma as any).user.update({
        where: { id: userId },
        data: {
          ...(validated.name && { name: validated.name }),
          ...(validated.phone !== undefined && { phone: validated.phone }),
          ...(validated.avatarUrl !== undefined && { avatarUrl: validated.avatarUrl }),
          updatedAt: new Date(),
        },
        include: {
          organization: {
            select: { name: true },
          },
        },
      });

      // 4. Invalidate cache
      await this.invalidateUserCache(userId);

      // 5. Log activity
      await this.trackActivity(userId, 'PROFILE_UPDATE', 'USER', userId, {
        updatedFields: Object.keys(validated),
      });

      // 6. Convert and return
      const profile = toUserProfile(updatedUser);

      logger.info({
        type: 'user_update_profile_success',
        userId,
      });

      return profile;
    } catch (error: any) {
      logger.error({
        type: 'user_update_profile_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Request email change (requires verification)
   */
  async requestEmailChange(
    userId: string,
    newEmail: string,
    password: string
  ): Promise<{ success: boolean; message: string }> {
    logger.info({
      type: 'user_email_change_requested',
      userId,
      newEmail,
    });

    try {
      // 1. Get user and verify password
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      const isValidPassword = await verifyPassword(password, user.password);
      if (!isValidPassword) {
        throw new UserError('Invalid password', 'INVALID_PASSWORD', 401);
      }

      // 2. Check if new email already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: newEmail.toLowerCase() },
      });

      if (existingUser) {
        throw new UserError(
          'Email already in use',
          'EMAIL_ALREADY_EXISTS',
          409
        );
      }

      // 3. Generate verification token
      const token = crypto.randomUUID();
      const tokenKey = `email_change:${token}`;
      
      await redis.setex(
        tokenKey,
        24 * 60 * 60, // 24 hours
        JSON.stringify({
          userId,
          newEmail: newEmail.toLowerCase(),
          createdAt: new Date().toISOString(),
        })
      );

      // 4. Send verification email to NEW email
      const verificationUrl = `${this.appUrl}/verify-email-change?token=${token}`;
      const emailContent = generateEmailChangeEmail(
        user.fullName,
        newEmail,
        verificationUrl
      );

      await sendEmail({
        to: newEmail,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });

      logger.info({
        type: 'user_email_change_verification_sent',
        userId,
        newEmail,
      });

      return {
        success: true,
        message: 'Verification email sent to your new email address.',
      };
    } catch (error: any) {
      logger.error({
        type: 'user_email_change_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Confirm email change with verification token
   */
  async confirmEmailChange(token: string): Promise<UserProfile> {
    logger.info({
      type: 'user_email_change_confirm_started',
      token: token.slice(0, 8) + '...',
    });

    try {
      // 1. Get token data
      const tokenKey = `email_change:${token}`;
      const tokenData = await redis.get(tokenKey);

      if (!tokenData) {
        throw new UserError(
          'Invalid or expired verification token',
          'INVALID_UPDATE',
          400
        );
      }

      const { userId, newEmail } = JSON.parse(tokenData);

      // 2. Update user email
      const updatedUser = await (prisma as any).user.update({
        where: { id: userId },
        data: {
          email: newEmail,
          emailVerified: true,
          updatedAt: new Date(),
        },
        include: {
          organization: {
            select: { name: true },
          },
        },
      });

      // 3. Delete token
      await redis.del(tokenKey);

      // 4. Invalidate cache
      await this.invalidateUserCache(userId);

      // 5. Log activity
      await this.trackActivity(userId, 'PROFILE_UPDATE', 'USER', userId, {
        action: 'email_changed',
        newEmail,
      });

      logger.info({
        type: 'user_email_change_success',
        userId,
      });

      return toUserProfile(updatedUser);
    } catch (error: any) {
      logger.error({
        type: 'user_email_change_confirm_error',
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // PREFERENCES OPERATIONS
  // ==========================================================================

  /**
   * Get user preferences
   */
  async getPreferences(userId: string): Promise<UserPreferences> {
    logger.info({
      type: 'user_get_preferences_started',
      userId,
    });

    try {
      // 1. Check cache
      const cacheKey = USER_CACHE_KEYS.PREFERENCES(userId);
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      // 2. Get from database
      const user = await (prisma as any).user.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      // 3. Parse preferences
      const preferences = parsePreferences((user as any).preferences);

      // 4. Cache result
      await redis.setex(
        cacheKey,
        USER_CACHE_TTL.PREFERENCES,
        JSON.stringify(preferences)
      );

      return preferences;
    } catch (error: any) {
      logger.error({
        type: 'user_get_preferences_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update user preferences
   */
  async updatePreferences(
    userId: string,
    updates: UpdatePreferencesInput
  ): Promise<UserPreferences> {
    logger.info({
      type: 'user_update_preferences_started',
      userId,
    });

    try {
      // 1. Validate updates
      const validated = updatePreferencesSchema.parse(updates);

      // 2. Get current preferences
      const currentPreferences = await this.getPreferences(userId);

      // 3. Merge preferences
      const newPreferences = mergePreferences(currentPreferences, validated);

      // 4. Update database
      await (prisma as any).user.update({
        where: { id: userId },
        data: {
          preferences: newPreferences,
          updatedAt: new Date(),
        },
      });

      // 5. Invalidate cache
      const cacheKey = USER_CACHE_KEYS.PREFERENCES(userId);
      await redis.del(cacheKey);

      // 6. Log activity
      await this.trackActivity(userId, 'SETTINGS_CHANGE', 'SETTINGS', null, {
        updatedCategories: Object.keys(validated),
      });

      logger.info({
        type: 'user_update_preferences_success',
        userId,
      });

      return newPreferences;
    } catch (error: any) {
      logger.error({
        type: 'user_update_preferences_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // ACTIVITY LOGGING
  // ==========================================================================

  /**
   * Track user activity
   */
  async trackActivity(
    userId: string,
    action: ActivityAction,
    resourceType: ResourceType,
    resourceId: string | null,
    metadata: Record<string, any> = {},
    options?: { ipAddress?: string; userAgent?: string }
  ): Promise<void> {
    try {
      // Create activity entry asynchronously (don't block main operation)
      const entry = createActivityEntry({
        userId,
        action,
        resourceType,
        resourceId: resourceId || undefined,
        metadata,
        ipAddress: options?.ipAddress,
        userAgent: options?.userAgent,
      });

      await (prisma as any).activityLog.create({
        data: entry,
      });

      // Invalidate activity cache
      const cacheKey = USER_CACHE_KEYS.ACTIVITY(userId);
      await redis.del(cacheKey);

      logger.debug({
        type: 'user_activity_tracked',
        userId,
        action,
        resourceType,
      });
    } catch (error: any) {
      // Don't throw - activity logging should never break main operations
      logger.error({
        type: 'user_activity_tracking_error',
        userId,
        action,
        error: error.message,
      });
    }
  }

  /**
   * Get user activity log with pagination and filters
   */
  async getActivityLog(
    userId: string,
    filters: ActivityLogFilters = {}
  ): Promise<PaginatedActivityLog> {
    logger.info({
      type: 'user_get_activity_log_started',
      userId,
      filters,
    });

    try {
      // 1. Validate filters
      const validated = activityLogFiltersSchema.parse(filters);
      const { page, limit, action, resourceType, startDate, endDate } = validated;
      const skip = (page - 1) * limit;

      // 2. Build where clause
      const where: any = { userId };
      
      if (action) where.action = action;
      if (resourceType) where.resourceType = resourceType;
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = startDate;
        if (endDate) where.createdAt.lte = endDate;
      }

      // 3. Get total count
      const total = await (prisma as any).activityLog.count({ where });

      // 4. Get items
      const items = await (prisma as any).activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      });

      logger.info({
        type: 'user_get_activity_log_success',
        userId,
        total,
      });

      return {
        items: items as ActivityLogEntry[],
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error: any) {
      logger.error({
        type: 'user_get_activity_log_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // USER STATISTICS
  // ==========================================================================

  /**
   * Get user statistics
   */
  async getUserStats(userId: string): Promise<UserStats> {
    logger.info({
      type: 'user_get_stats_started',
      userId,
    });

    try {
      // 1. Check cache
      const cacheKey = USER_CACHE_KEYS.STATS(userId);
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      // 2. Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          createdAt: true,
          lastLoginAt: true,
        },
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      // 3. Get counts (parallel queries for performance)
      const [
        policiesCreated,
        policiesPublished,
        queriesSubmitted,
        documentsUploaded,
        loginCount,
      ] = await Promise.all([
        prisma.policy.count({ where: { userId } }),
        prisma.policy.count({ where: { userId, status: 'COMPLETED' } }),
        prisma.complianceQuery.count({ where: { userId } }),
        prisma.legalDocument.count({ where: { userId } }),
        (prisma as any).activityLog.count({
          where: { userId, action: 'LOGIN' },
        }),
      ]);

      // 4. Calculate storage used (sum of document sizes)
      const storageResult = await prisma.legalDocument.aggregate({
        where: { userId },
        _sum: { fileSize: true } as any,
      });
      const storageUsedBytes = (storageResult._sum as any)?.fileSize || 0;

      // 5. Get AI token usage (this month)
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const tokenUsageResult = await (prisma as any).aiUsage.aggregate({
        where: {
          userId,
          createdAt: { gte: startOfMonth },
        },
        _sum: { tokensUsed: true },
      });
      const aiTokensThisMonth = tokenUsageResult._sum.tokensUsed || 0;

      const totalTokensResult = await (prisma as any).aiUsage.aggregate({
        where: { userId },
        _sum: { tokensUsed: true },
      });
      const totalAITokensUsed = totalTokensResult._sum.tokensUsed || 0;

      // 6. Calculate quotas (these would come from subscription/plan)
      const quotas = {
        policiesRemaining: 100 - policiesCreated, // Example limits
        queriesRemaining: 500 - queriesSubmitted,
        storageRemaining: 1024 * 1024 * 1024 - storageUsedBytes, // 1GB limit
      };

      // 7. Build stats object
      const stats: UserStats = {
        policiesCreated,
        policiesPublished,
        queriesSubmitted,
        documentsUploaded,
        totalAITokensUsed,
        aiTokensThisMonth,
        storageUsedBytes,
        lastActiveAt: user.lastLoginAt,
        loginCount,
        daysActive: daysSince(user.createdAt),
        quotas,
      };

      // 8. Cache result
      await redis.setex(
        cacheKey,
        USER_CACHE_TTL.STATS,
        JSON.stringify(stats)
      );

      logger.info({
        type: 'user_get_stats_success',
        userId,
      });

      return stats;
    } catch (error: any) {
      logger.error({
        type: 'user_get_stats_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // ACCOUNT MANAGEMENT
  // ==========================================================================

  /**
   * Delete user account (GDPR compliant)
   * - Exports user data
   * - Schedules permanent deletion (30 days)
   * - Anonymizes immediately
   */
  async deleteAccount(
    userId: string,
    input: DeleteAccountInput
  ): Promise<DeleteAccountResult> {
    logger.info({
      type: 'user_delete_account_started',
      userId,
    });

    try {
      // 1. Validate input
      const validated = deleteAccountSchema.parse(input);

      // 2. Get user and verify password
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      const isValidPassword = await verifyPassword(validated.password, user.password);
      if (!isValidPassword) {
        throw new UserError('Invalid password', 'INVALID_PASSWORD', 401);
      }

      // 3. Export user data first
      let dataExportUrl: string | undefined;
      try {
        const exportResult = await this.exportUserData(userId);
        dataExportUrl = exportResult.downloadUrl;
      } catch (exportError) {
        logger.warn({
          type: 'user_data_export_failed_during_deletion',
          userId,
          error: (exportError as Error).message,
        });
      }

      // 4. Schedule permanent deletion (30 days from now)
      const scheduledDeletionDate = new Date();
      scheduledDeletionDate.setDate(scheduledDeletionDate.getDate() + 30);

      // 5. Anonymize user data immediately
      const anonymizedData = anonymizeUserData(userId);
      
      await (prisma as any).user.update({
        where: { id: userId },
        data: {
          ...anonymizedData,
          status: 'SUSPENDED',
          deletionScheduledAt: scheduledDeletionDate,
          deletionReason: validated.reason,
          deletionFeedback: validated.feedback,
          updatedAt: new Date(),
        },
      });

      // 6. Revoke all sessions
      const sessionPattern = `session:*`;
      const sessionKeys = await redis.keys(sessionPattern);
      
      for (const key of sessionKeys) {
        const sessionData = await redis.get(key);
        if (sessionData) {
          const session = JSON.parse(sessionData);
          if (session.userId === userId) {
            await redis.del(key);
          }
        }
      }

      // 7. Invalidate all caches
      await this.invalidateUserCache(userId);

      // 8. Send confirmation email (to original email, stored before anonymization)
      const emailContent = generateDeletionEmail(
        user.fullName,
        scheduledDeletionDate,
        dataExportUrl
      );

      await sendEmail({
        to: user.email,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });

      // 9. Log activity
      await this.trackActivity(userId, 'SETTINGS_CHANGE', 'USER', userId, {
        action: 'account_deletion_scheduled',
        scheduledDeletionDate: scheduledDeletionDate.toISOString(),
      });

      logger.info({
        type: 'user_delete_account_success',
        userId,
        scheduledDeletionDate,
      });

      return {
        success: true,
        message: 'Account scheduled for deletion.',
        scheduledDeletionDate,
        dataExportUrl,
      };
    } catch (error: any) {
      logger.error({
        type: 'user_delete_account_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Cancel account deletion (if within 30-day window)
   */
  async cancelAccountDeletion(userId: string): Promise<{ success: boolean; message: string }> {
    logger.info({
      type: 'user_cancel_deletion_started',
      userId,
    });

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, deletionScheduledAt: true } as any,
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      if ((user as any).status !== 'SUSPENDED') {
        return {
          success: false,
          message: 'No pending deletion to cancel.',
        };
      }

      // Restore user status
      await (prisma as any).user.update({
        where: { id: userId },
        data: {
          status: 'ACTIVE',
          deletionScheduledAt: null,
          deletionReason: null,
          deletionFeedback: null,
          updatedAt: new Date(),
        },
      });

      // Invalidate cache
      await this.invalidateUserCache(userId);

      logger.info({
        type: 'user_cancel_deletion_success',
        userId,
      });

      return {
        success: true,
        message: 'Account deletion cancelled. Your account is now active.',
      };
    } catch (error: any) {
      logger.error({
        type: 'user_cancel_deletion_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Export all user data (GDPR compliance)
   */
  async exportUserData(userId: string): Promise<ExportDataResult> {
    logger.info({
      type: 'user_export_data_started',
      userId,
    });

    try {
      // 1. Get user profile
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          organization: { select: { name: true } },
        },
      });

      if (!user) {
        throw new UserError('User not found', 'USER_NOT_FOUND', 404);
      }

      // 2. Get all user data (parallel queries)
      const [policies, queries, documents, activityLog] = await Promise.all([
        (prisma as any).policy.findMany({
          where: { userId },
          select: {
            id: true,
            title: true,
            content: true,
            createdAt: true,
          },
        }),
        (prisma as any).complianceQuery.findMany({
          where: { userId },
          select: {
            id: true,
            query: true,
            response: true,
            createdAt: true,
          },
        }),
        prisma.legalDocument.findMany({
          where: { userId },
          select: {
            id: true,
            title: true,
            createdAt: true,
          },
        }),
        (prisma as any).activityLog.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 1000, // Last 1000 activities
        }),
      ]);

      // 3. Build export object
      const exportData: UserDataExport = {
        user: {
          profile: toUserProfile(user as any),
          preferences: parsePreferences((user as any).preferences),
        },
        policies: policies.map((p: any) => ({
          id: p.id,
          title: p.title,
          content: p.content || '',
          createdAt: p.createdAt,
        })),
        queries: queries.map((q: any) => ({
          id: q.id,
          query: q.query,
          response: q.response || '',
          createdAt: q.createdAt,
        })),
        documents: documents.map((d) => ({
          id: d.id,
          name: (d as any).title || (d as any).name || '',
          uploadedAt: d.createdAt,
        })),
        activityLog: activityLog as ActivityLogEntry[],
        exportedAt: new Date(),
      };

      // 4. Convert to JSON
      const jsonData = JSON.stringify(exportData, null, 2);
      const buffer = Buffer.from(jsonData, 'utf-8');

      // 5. Upload to storage
      const filename = generateExportFilename(userId);
      const uploadResult = await storageService.uploadTempFile(
        buffer,
        filename,
        7 * 24 * 60 * 60
      );

      // 6. Generate download URL (expires in 7 days)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const downloadUrl = await storageService.getDownloadUrl(
        uploadResult.key,
        7 * 24 * 60 * 60
      );

      // 7. Log activity
      await this.trackActivity(userId, 'SETTINGS_CHANGE', 'USER', userId, {
        action: 'data_exported',
        filename,
      });

      logger.info({
        type: 'user_export_data_success',
        userId,
        filename,
      });

      return {
        success: true,
        downloadUrl,
        expiresAt,
        fileSizeBytes: buffer.length,
      };
    } catch (error: any) {
      logger.error({
        type: 'user_export_data_error',
        userId,
        error: error.message,
      });
      throw new UserError(
        'Failed to export user data',
        'EXPORT_FAILED',
        500
      );
    }
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS
  // ==========================================================================

  /**
   * Invalidate all user-related caches
   */
  private async invalidateUserCache(userId: string): Promise<void> {
    await Promise.all([
      redis.del(USER_CACHE_KEYS.PROFILE(userId)),
      redis.del(USER_CACHE_KEYS.PREFERENCES(userId)),
      redis.del(USER_CACHE_KEYS.STATS(userId)),
      redis.del(USER_CACHE_KEYS.ACTIVITY(userId)),
    ]);
  }
}

// Export singleton instance
export const userModule = new UserModule();

// Export class for testing
export { UserModule };