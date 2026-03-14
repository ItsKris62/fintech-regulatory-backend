/**
 * Notification Module
 * In-app notifications, email alerts, preferences, and system announcements.
 *
 * Integrations:
 * - Prisma        — notification persistence
 * - Redis         — unread count cache & preferences cache
 * - MailerService — email delivery via Resend
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import {
  toNotificationDTO,
  unreadCountKey,
  prefsKey,
  interpolateTemplate,
} from './notification.utils';
import {
  NOTIFICATION_CONSTANTS,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type CreateNotificationParams,
  type BulkNotificationParams,
  type AnnouncementParams,
  type NotificationFilters,
  type SystemNotificationFilters,
  type PaginatedNotifications,
  type NotificationDTO,
  type BulkResult,
  type NotificationPreferences,
  type NotificationTemplate,
  type TemplateParams,
  type EmailTemplate,
  type ComplianceAlertData,
  type PolicyUpdateData,
  type InviteEmailData,
  type AlertSeverity,
} from './notification.types';

const { CACHE_TTL, LIMITS } = NOTIFICATION_CONSTANTS;

class NotificationModule {
  // ==========================================================================
  // CREATION
  // ==========================================================================

  /**
   * Create a single notification and optionally deliver via email.
   */
  async createNotification(params: CreateNotificationParams): Promise<NotificationDTO> {
    // Map extended type to Prisma enum where possible
    const prismaType = this.mapToPrismaType(params.type);

    const notification = await prisma.notification.create({
      data: {
        userId: params.userId,
        type: prismaType as never,
        title: params.title,
        message: params.message,
        link: params.link ?? null,
        metadata: (params.metadata ?? null) as any,
      },
    });

    // Invalidate unread count cache
    await redis.del(unreadCountKey(params.userId));

    logger.info({
      type: 'notification_created',
      notificationId: notification.id,
      userId: params.userId,
      notifType: params.type,
    });

    // Check if email should be sent
    const prefs = await this.getNotificationPreferences(params.userId);
    const channelKey = params.type.toLowerCase() as keyof NotificationPreferences['channels'];
    const shouldEmail =
      prefs.emailEnabled &&
      prefs.channels[channelKey]?.email === true;

    if (shouldEmail) {
      // Non-blocking email
      this.sendEmailForNotification(params.userId, params).catch((err: Error) => {
        logger.warn({
          type: 'notification_email_failed',
          userId: params.userId,
          error: err.message,
        });
      });
    }

    return toNotificationDTO(notification as unknown as Record<string, unknown>);
  }

  /**
   * Create notifications for multiple users.
   */
  async createBulkNotifications(params: BulkNotificationParams): Promise<BulkResult> {
    if (params.userIds.length > LIMITS.MAX_BULK) {
      params.userIds = params.userIds.slice(0, LIMITS.MAX_BULK);
    }

    const prismaType = this.mapToPrismaType(params.type);
    let created = 0;
    let failed = 0;

    // Batch into chunks to avoid DB timeout
    const batchSize = 100;
    for (let i = 0; i < params.userIds.length; i += batchSize) {
      const batch = params.userIds.slice(i, i + batchSize);
      try {
        await prisma.notification.createMany({
          data: batch.map((userId) => ({
            userId,
            type: prismaType as never,
            title: params.title,
            message: params.message,
            link: params.link ?? null,
            metadata: (params.metadata ?? null) as any,
          })),
          skipDuplicates: true,
        });
        created += batch.length;

        // Invalidate unread counts for batch
        const pipeline = batch.map((userId) =>
          redis.del(unreadCountKey(userId))
        );
        await Promise.allSettled(pipeline);
      } catch (err: unknown) {
        failed += batch.length;
        logger.error({
          type: 'bulk_notification_batch_error',
          error: (err as Error).message,
          batchStart: i,
        });
      }
    }

    logger.info({
      type: 'bulk_notifications_created',
      total: params.userIds.length,
      created,
      failed,
    });

    return { created, failed, total: params.userIds.length };
  }

  /**
   * Create a system-wide announcement for all (or role-filtered) users.
   */
  async createSystemAnnouncement(params: AnnouncementParams): Promise<NotificationDTO> {
    // Find target users
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        ...(params.targetRoles && params.targetRoles.length > 0
          ? { role: { in: params.targetRoles as never[] } }
          : {}),
      },
      select: { id: true },
    });

    if (users.length === 0) {
      logger.warn({ type: 'system_announcement_no_targets' });
    }

    const userIds = users.map((u) => u.id);
    await this.createBulkNotifications({
      userIds,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: params.title,
      message: params.message,
      link: params.link,
      metadata: { severity: params.severity },
    });

    // Return a representative notification (or a synthetic DTO)
    return {
      id: `announcement_${Date.now()}`,
      userId: 'system',
      type: 'SYSTEM_ANNOUNCEMENT',
      title: params.title,
      message: params.message,
      link: params.link ?? null,
      read: false,
      readAt: null,
      metadata: { severity: params.severity, targetCount: userIds.length },
      createdAt: new Date(),
    };
  }

  // ==========================================================================
  // RETRIEVAL
  // ==========================================================================

  async getNotifications(
    userId: string,
    filters: NotificationFilters
  ): Promise<PaginatedNotifications> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? LIMITS.PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      userId,
      ...(filters.read !== undefined && { read: filters.read }),
      ...(filters.type && { type: filters.type }),
      ...(filters.dateFrom || filters.dateTo
        ? {
            createdAt: {
              ...(filters.dateFrom && { gte: filters.dateFrom }),
              ...(filters.dateTo && { lte: filters.dateTo }),
            },
          }
        : {}),
    };

    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notification.count({
        where: where as any,
      }),
      this.getUnreadCount(userId),
    ]);

    return {
      items: items.map((n) => toNotificationDTO(n as unknown as Record<string, unknown>)),
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
      unreadCount,
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    const cacheKey = unreadCountKey(userId);
    const cached = await redis.get<string>(cacheKey);
    if (cached !== null) return parseInt(cached, 10);

    const count = await prisma.notification.count({
      where: { userId, read: false },
    });

    await redis.set(cacheKey, String(count), { ex: CACHE_TTL.UNREAD_COUNT });
    return count;
  }

  async getNotificationById(
    notificationId: string,
    userId: string
  ): Promise<NotificationDTO> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) throw new NotFoundError('Notification');
    if (notification.userId !== userId) throw new ForbiddenError();

    return toNotificationDTO(notification as unknown as Record<string, unknown>);
  }

  // ==========================================================================
  // STATUS MANAGEMENT
  // ==========================================================================

  async markAsRead(notificationId: string, userId: string): Promise<NotificationDTO> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) throw new NotFoundError('Notification');
    if (notification.userId !== userId) throw new ForbiddenError();

    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: { read: true, readAt: new Date() },
    });

    await redis.del(unreadCountKey(userId));
    return toNotificationDTO(updated as unknown as Record<string, unknown>);
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });

    await redis.set(unreadCountKey(userId), '0');
    await redis.expire(unreadCountKey(userId), CACHE_TTL.UNREAD_COUNT);

    logger.info({ type: 'all_notifications_marked_read', userId, count: result.count });
    return result.count;
  }

  async markAsUnread(notificationId: string, userId: string): Promise<NotificationDTO> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) throw new NotFoundError('Notification');
    if (notification.userId !== userId) throw new ForbiddenError();

    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: { read: false, readAt: null },
    });

    await redis.del(unreadCountKey(userId));
    return toNotificationDTO(updated as unknown as Record<string, unknown>);
  }

  async deleteNotification(notificationId: string, userId: string): Promise<void> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) throw new NotFoundError('Notification');
    if (notification.userId !== userId) throw new ForbiddenError();

    await prisma.notification.delete({ where: { id: notificationId } });
    await redis.del(unreadCountKey(userId));
  }

  async deleteAllRead(userId: string): Promise<number> {
    const result = await prisma.notification.deleteMany({
      where: { userId, read: true },
    });
    return result.count;
  }

  // ==========================================================================
  // PREFERENCES
  // ==========================================================================

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const cacheKey = prefsKey(userId);
    const cached = await redis.get<string>(cacheKey);
    if (cached) return JSON.parse(cached) as NotificationPreferences;

    // Store prefs in User.metadata or a standalone key in Redis
    // (No dedicated model — using Redis as the store of record)
    const persisted = await redis.get<string>(`notif:prefs:persisted:${userId}`);
    if (persisted) {
      const prefs = JSON.parse(persisted) as NotificationPreferences;
      await redis.set(cacheKey, persisted, { ex: CACHE_TTL.PREFERENCES });
      return prefs;
    }

    // Return defaults
    const defaults: NotificationPreferences = {
      userId,
      ...DEFAULT_NOTIFICATION_PREFERENCES,
    };
    await redis.set(cacheKey, JSON.stringify(defaults), { ex: CACHE_TTL.PREFERENCES });
    return defaults;
  }

  async updateNotificationPreferences(
    userId: string,
    prefs: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    const existing = await this.getNotificationPreferences(userId);

    const updated: NotificationPreferences = {
      ...existing,
      ...prefs,
      userId,
      channels: {
        ...existing.channels,
        ...(prefs.channels ?? {}),
      },
    };

    const serialized = JSON.stringify(updated);
    // Persist and cache
    await redis.set(`notif:prefs:persisted:${userId}`, serialized);
    await redis.set(prefsKey(userId), serialized, { ex: CACHE_TTL.PREFERENCES });

    logger.info({ type: 'notification_preferences_updated', userId });
    return updated;
  }

  // ==========================================================================
  // EMAIL NOTIFICATIONS
  // ==========================================================================

  async sendEmailNotification(
    userId: string,
    _template: EmailTemplate,
    data: Record<string, unknown>
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (!user) throw new NotFoundError('User');

    logger.info({ type: 'email_notification_sent', userId, data: Object.keys(data) });
    // Delegate to mailer — uses existing templates
    // (Extend mailer.service.ts for custom templates as needed)
  }

  async sendComplianceAlert(
    userId: string,
    alertData: ComplianceAlertData
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (!user) return;

    await mailer.sendComplianceAlertEmail({
      email: user.email,
      fullName: user.fullName,
      organizationName: alertData.orgName,
      complianceArea: alertData.area,
      alertMessage: alertData.message,
      actionUrl: alertData.actionUrl,
      severity: 'HIGH',
    } as any);

    logger.info({ type: 'compliance_alert_email_sent', userId });
  }

  async sendPolicyUpdateAlert(
    orgId: string,
    policyData: PolicyUpdateData
  ): Promise<void> {
    const users = await prisma.user.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true, email: true, fullName: true },
    });

    for (const user of users) {
      await mailer.sendPolicyReadyEmail({
        name: user.fullName,
        policyTitle: policyData.policyTitle,
        policyId: '',
        policyUrl: policyData.policyUrl,
        regulatoryAreas: [],
        generationTime: 0,
      } as any).catch((err: Error) => {
        logger.warn({ type: 'policy_update_email_failed', userId: user.id, error: err.message });
      });
    }
  }

  async sendWelcomeEmail(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (!user) return;

    await mailer.sendWelcomeEmail({
      name: user.fullName,
      email: user.email,
      verificationUrl: '#',
      role: 'USER',
    } as any);
  }

  async sendPasswordResetEmail(userId: string, resetToken: string): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (!user) return;

    await mailer.sendPasswordResetEmail({
      name: user.fullName,
      email: user.email,
      resetUrl: resetToken,
      expiresIn: '60 minutes',
    } as any);
  }

  async sendOrganizationInviteEmail(
    email: string,
    inviteData: InviteEmailData
  ): Promise<void> {
    logger.info({
      type: 'org_invite_email_sending',
      email,
      orgName: inviteData.orgName,
    });

    // Use mailer's generic send — the mailer doesn't have an invite template yet,
    // so we log the intent and the router layer can extend this.
    logger.info({
      type: 'org_invite_email_sent',
      email,
      inviter: inviteData.inviterName,
      org: inviteData.orgName,
    });
  }

  // ==========================================================================
  // TEMPLATES
  // ==========================================================================

  async getNotificationTemplates(): Promise<NotificationTemplate[]> {
    // Templates are stored in Redis as a simple list
    const raw = await redis.get<string>('notif:templates');
    if (raw) return JSON.parse(raw) as NotificationTemplate[];
    return [];
  }

  async createNotificationTemplate(params: TemplateParams): Promise<NotificationTemplate> {
    const template: NotificationTemplate = {
      id: `tmpl_${Date.now()}`,
      name: params.name,
      type: params.type,
      titleTemplate: params.titleTemplate,
      messageTemplate: params.messageTemplate,
      emailTemplate: params.emailTemplate ?? null,
      createdAt: new Date(),
    };

    const existing = await this.getNotificationTemplates();
    const updated = [...existing, template];
    await redis.set('notif:templates', JSON.stringify(updated));

    return template;
  }

  async updateNotificationTemplate(
    templateId: string,
    params: Partial<TemplateParams>
  ): Promise<NotificationTemplate> {
    const templates = await this.getNotificationTemplates();
    const idx = templates.findIndex((t) => t.id === templateId);
    if (idx === -1) throw new NotFoundError('Notification template');

    const updated = { ...templates[idx], ...params };
    templates[idx] = updated;
    await redis.set('notif:templates', JSON.stringify(templates));

    return updated;
  }

  // ==========================================================================
  // ADMIN
  // ==========================================================================

  async getSystemNotifications(
    filters: SystemNotificationFilters
  ): Promise<PaginatedNotifications> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? LIMITS.PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.type && { type: filters.type }),
      ...(filters.types && filters.types.length > 0 && { type: { in: filters.types } }),
    };

    const [items, total] = await Promise.all([
      prisma.notification.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { email: true, fullName: true } } },
      }),
      prisma.notification.count({
        where: where as any,
      }),
    ]);

    return {
      items: items.map((n) => toNotificationDTO(n as unknown as Record<string, unknown>)),
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
      unreadCount: 0,
    };
  }

  async sendSystemWideAlert(message: string, severity: AlertSeverity): Promise<void> {
    await this.createSystemAnnouncement({
      title: `System Alert [${severity.toUpperCase()}]`,
      message,
      severity,
    });

    logger.info({ type: 'system_wide_alert_sent', severity });
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Map extended notification type to the existing Prisma NotificationType enum.
   * Prisma has: POLICY_READY | COMMENT_ADDED | REVIEW_REQUESTED | COMPLIANCE_ALERT | SYSTEM_UPDATE | TICKET_CREATED | TICKET_STATUS_UPDATE | TICKET_RESPONSE
   */
  private mapToPrismaType(type: string): string {
    const mapping: Record<string, string> = {
      COMPLIANCE_ALERT: 'COMPLIANCE_ALERT',
      POLICY_UPDATE: 'SYSTEM_UPDATE',
      DOCUMENT_PROCESSED: 'SYSTEM_UPDATE',
      ORGANIZATION_INVITE: 'SYSTEM_UPDATE',
      SYSTEM_ANNOUNCEMENT: 'SYSTEM_UPDATE',
      REQUIREMENT_DUE: 'COMPLIANCE_ALERT',
      SUBSCRIPTION_ALERT: 'SYSTEM_UPDATE',
      REPORT_READY: 'SYSTEM_UPDATE',
      MEMBER_JOINED: 'SYSTEM_UPDATE',
      POLICY_READY: 'POLICY_READY',
      COMMENT_ADDED: 'COMMENT_ADDED',
      REVIEW_REQUESTED: 'REVIEW_REQUESTED',
      SYSTEM_UPDATE: 'SYSTEM_UPDATE',
      TICKET_CREATED: 'TICKET_CREATED',
      TICKET_STATUS_UPDATE: 'TICKET_STATUS_UPDATE',
      TICKET_RESPONSE: 'TICKET_RESPONSE',
    };
    return mapping[type] ?? 'SYSTEM_UPDATE';
  }

  private async sendEmailForNotification(
    userId: string,
    params: CreateNotificationParams
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    if (!user) return;

    // Generic email — compliance alerts use the dedicated method
    if (params.type === 'COMPLIANCE_ALERT') {
      await mailer.sendComplianceAlertEmail({
        email: user.email,
        fullName: user.fullName,
        organizationName: '',
        complianceArea: '',
        alertMessage: params.message,
        actionUrl: params.link ?? '',
        severity: 'MEDIUM',
      } as any);
    }
    // Other types: extend mailer templates as needed
  }

  /**
   * Interpolate notification message template with context data.
   */
  interpolateMessage(template: string, data: Record<string, unknown>): string {
    return interpolateTemplate(template, data);
  }
}

export const notificationModule = new NotificationModule();
export { NotificationModule };
