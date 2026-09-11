import { TRPCError } from '@trpc/server';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { alertPubSub } from '@/lib/redis/pubsub';
import { reactMailer } from '@/lib/email/react-mailer.service';
import type { EffectivePlan } from '@/types/plan.types';
import type { RegulatoryAlert, AlertSubscription } from '@prisma/client';
import type { AlertWithReadStatus, GetAlertsResult } from './alert.types';
import type { 
  CreateAlertInput, 
  UpdateAlertInput, 
  RejectAlertInput, 
  GetAlertsInput, 
  UpsertSubscriptionInput 
} from './alert.schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const UNREAD_CACHE_TTL = 30; // seconds

const unreadCountKey = (userId: string) => `alerts:unread:${userId}`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type EmailTarget = {
  userId: string;
  email: string;
  fullName: string;
  organizationId: string;
};

type NotificationRow = {
  alertId: string;
  userId: string;
  organizationId: string;
  channel: string;
  status: string;
};

// ---------------------------------------------------------------------------
// AlertService
// ---------------------------------------------------------------------------

class AlertService {
  private readonly prisma: typeof defaultPrisma;

  constructor(deps: { prisma?: typeof defaultPrisma } = {}) {
    this.prisma = deps.prisma ?? defaultPrisma;
  }

  // -------------------------------------------------------------------------
  // createAlert -- creates a draft (isActive: false)
  // -------------------------------------------------------------------------

  async createAlert(
    input: CreateAlertInput,
    publishedById: string
  ): Promise<RegulatoryAlert> {
    const alert = await this.prisma.regulatoryAlert.create({
      data: {
        title: input.title,
        summary: input.summary,
        body: input.body,
        sourceUrl: input.sourceUrl ?? null,
        jurisdictionCode: input.jurisdictionCode,
        regulatoryBody: input.regulatoryBody,
        category: input.category,
        severity: input.severity,
        effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        isActive: false,
        publishedById,
      },
    });

    logger.info({ type: 'alert_created', alertId: alert.id, publishedById });
    return alert;
  }

  // -------------------------------------------------------------------------
  // publishAlert -- activates a draft and fans out notifications
  // -------------------------------------------------------------------------

  async publishAlert(alertId: string, publishedById: string): Promise<void> {
    const alert = await this.prisma.regulatoryAlert.findUnique({ where: { id: alertId } });
    if (!alert) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Alert not found.' });
    }
    if (alert.isActive) {
      logger.info({ type: 'alert_already_published_noop', alertId, publishedById });
      return;
    }

    const publishedAlert = await this.prisma.regulatoryAlert.update({
      where: { id: alertId },
      data: { isActive: true, publishedById, publishedAt: new Date(), updatedAt: new Date() },
    });

    const subscriptions = await this.prisma.alertSubscription.findMany({
      where: {
        jurisdictions: { has: publishedAlert.jurisdictionCode },
        regulatoryBodies: { has: publishedAlert.regulatoryBody },
        categories: { has: publishedAlert.category },
      },
    });

    if (subscriptions.length === 0) {
      logger.info({ type: 'alert_published_no_subscribers', alertId, publishedById });
      return;
    }

    const alertRank = SEVERITY_RANK[publishedAlert.severity] ?? 1;
    const inAppRows: NotificationRow[] = [];
    const emailRows: NotificationRow[] = [];
    const realtimeEmailTargets: EmailTarget[] = [];

    for (const subscription of subscriptions) {
      const thresholdRank = SEVERITY_RANK[subscription.severityThreshold] ?? 1;
      if (alertRank < thresholdRank) continue;

      const orgUsers = await this.prisma.user.findMany({
        where: { organizationId: subscription.organizationId, deletedAt: null },
        select: { id: true, email: true, fullName: true },
      });

      for (const user of orgUsers) {
        if (subscription.inAppEnabled) {
          inAppRows.push({
            alertId: publishedAlert.id,
            userId: user.id,
            organizationId: subscription.organizationId,
            channel: 'IN_APP',
            status: 'PENDING',
          });
        }
        if (subscription.emailEnabled) {
          emailRows.push({
            alertId: publishedAlert.id,
            userId: user.id,
            organizationId: subscription.organizationId,
            channel: 'EMAIL',
            status: 'PENDING',
          });
          if (subscription.emailFrequency === 'REALTIME') {
            realtimeEmailTargets.push({
              userId: user.id,
              email: user.email,
              fullName: user.fullName,
              organizationId: subscription.organizationId,
            });
          }
        }
      }
    }

    const allRows = [...inAppRows, ...emailRows];
    if (allRows.length > 0) {
      await this.prisma.alertNotification.createMany({ data: allRows, skipDuplicates: true });
    }

    // Fan out SSE events - deduplicate by userId
    const ssePayload = {
      type: 'NEW_ALERT' as const,
      alertId: publishedAlert.id,
      title: publishedAlert.title,
      severity: publishedAlert.severity,
      regulatoryBody: publishedAlert.regulatoryBody,
      publishedAt: publishedAlert.publishedAt.toISOString(),
    };

    const notifiedUsers = new Set<string>();
    for (const row of inAppRows) {
      if (!notifiedUsers.has(row.userId)) {
        notifiedUsers.add(row.userId);
        await alertPubSub.publish(row.userId, ssePayload);
        await redis.del(unreadCountKey(row.userId));
      }
    }

    for (const target of realtimeEmailTargets) {
      await this.dispatchAlertEmail(publishedAlert, target);
    }

    logger.info({
      type: 'alert_published',
      alertId: publishedAlert.id,
      publishedById,
      inAppCount: inAppRows.length,
      emailCount: emailRows.length,
      realtimeEmailCount: realtimeEmailTargets.length,
    });
  }

  // -------------------------------------------------------------------------
  // getAlerts -- paginated list with read status, plan-scoped history window
  // -------------------------------------------------------------------------

  async getAlerts(
    userId: string,
    _organizationId: string | undefined,
    plan: EffectivePlan,
    params: GetAlertsInput
  ): Promise<GetAlertsResult> {
    const { page, limit, jurisdictionCode, regulatoryBody, severity, unreadOnly } = params;

    const historyDays = PLAN_ENTITLEMENTS[plan]?.alerts?.historyDays ?? 90;
    const publishedAfter =
      historyDays === -1
        ? undefined
        : new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);

    const baseWhere = {
      isActive: true,
      ...(publishedAfter ? { publishedAt: { gte: publishedAfter } } : {}),
      ...(jurisdictionCode ? { jurisdictionCode } : {}),
      ...(regulatoryBody ? { regulatoryBody } : {}),
      ...(severity ? { severity } : {}),
    };

    const unreadFilter = unreadOnly
      ? {
          NOT: {
            notifications: {
              some: {
                userId,
                channel: 'IN_APP',
                status: { in: ['READ', 'DISMISSED'] },
              },
            },
          },
        }
      : {};

    const whereClause = { ...baseWhere, ...unreadFilter };

    const [rawAlerts, total] = await Promise.all([
      this.prisma.regulatoryAlert.findMany({
        where: whereClause,
        include: {
          notifications: {
            where: { userId, channel: 'IN_APP' },
            select: { id: true, status: true },
            take: 1,
          },
        },
        orderBy: { publishedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.regulatoryAlert.count({ where: whereClause }),
    ]);

    const alerts: AlertWithReadStatus[] = rawAlerts.map(({ notifications, ...alertData }) => {
      const notification = notifications[0] ?? null;
      const isRead =
        notification !== null &&
        (notification.status === 'READ' || notification.status === 'DISMISSED');
      return {
        ...alertData,
        isRead,
        notificationId: notification?.id ?? null,
      };
    });

    return {
      alerts,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // -------------------------------------------------------------------------
  // getUnreadCount -- Redis-cached for 30 seconds
  // -------------------------------------------------------------------------

  async getUnreadCount(userId: string): Promise<number> {
    const cacheKey = unreadCountKey(userId);
    const cached = await redis.get<string>(cacheKey);
    if (cached !== null) return parseInt(cached, 10);

    const count = await this.prisma.alertNotification.count({
      where: {
        userId,
        channel: 'IN_APP',
        status: { notIn: ['READ', 'DISMISSED'] },
      },
    });

    await redis.set(cacheKey, String(count), { ex: UNREAD_CACHE_TTL });
    return count;
  }

  // -------------------------------------------------------------------------
  // markAsRead -- userId guard prevents cross-user access
  // -------------------------------------------------------------------------

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const notification = await this.prisma.alertNotification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true, status: true },
    });
    if (!notification) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
    }
    if (notification.status === 'READ') return;

    await this.prisma.alertNotification.update({
      where: { id: notificationId },
      data: { status: 'READ', readAt: new Date() },
    });

    await redis.del(unreadCountKey(userId));
  }

  // -------------------------------------------------------------------------
  // markAllAsRead
  // -------------------------------------------------------------------------

  async markAllAsRead(
    userId: string,
    _organizationId: string | undefined
  ): Promise<void> {
    await this.prisma.alertNotification.updateMany({
      where: {
        userId,
        channel: 'IN_APP',
        status: { notIn: ['READ', 'DISMISSED'] },
      },
      data: { status: 'READ', readAt: new Date() },
    });

    await redis.del(unreadCountKey(userId));
  }

  // -------------------------------------------------------------------------
  // getAlertById -- auto-marks as read on first view
  // -------------------------------------------------------------------------

  async getAlertById(alertId: string, userId: string): Promise<AlertWithReadStatus> {
    const alert = await this.prisma.regulatoryAlert.findFirst({
      where: { id: alertId, isActive: true },
      include: {
        notifications: {
          where: { userId, channel: 'IN_APP' },
          select: { id: true, status: true },
          take: 1,
        },
      },
    });

    if (!alert) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Alert not found.' });
    }

    const { notifications, ...alertData } = alert;
    const notification = notifications[0] ?? null;
    const wasRead =
      notification !== null &&
      (notification.status === 'READ' || notification.status === 'DISMISSED');

    if (notification && !wasRead) {
      await this.markAsRead(notification.id, userId);
    }

    return {
      ...alertData,
      isRead: true,
      notificationId: notification?.id ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // upsertSubscription -- requires org context
  // -------------------------------------------------------------------------

  async upsertSubscription(
    organizationId: string | undefined,
    input: UpsertSubscriptionInput
  ): Promise<AlertSubscription> {
    if (!organizationId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Organisation context required.',
      });
    }

    return this.prisma.alertSubscription.upsert({
      where: { organizationId },
      create: { organizationId, ...input },
      update: { ...input, updatedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // getSubscription -- returns null when no org context or no subscription
  // -------------------------------------------------------------------------

  async getSubscription(
    organizationId: string | undefined
  ): Promise<AlertSubscription | null> {
    if (!organizationId) return null;

    return this.prisma.alertSubscription.findUnique({ where: { organizationId } });
  }

  // -------------------------------------------------------------------------
  // getAdminAlerts -- all alerts including drafts, newest first
  // -------------------------------------------------------------------------

  async getAdminAlerts(params: {
    page: number;
    limit: number;
  }): Promise<{ alerts: RegulatoryAlert[]; total: number }> {
    const { page, limit } = params;
    const skip = (page - 1) * limit;

    const [alerts, total] = await Promise.all([
      this.prisma.regulatoryAlert.findMany({
        include: {
          primaryRegulatorySourceItem: {
            include: {
              source: {
                select: {
                  sourceKey: true,
                  name: true,
                  authorityType: true,
                  sourceType: true,
                  baseUrl: true,
                },
              },
              evidenceLinks: {
                include: {
                  snapshot: {
                    select: {
                      id: true,
                      canonicalUrl: true,
                      retrievedAt: true,
                      contentHash: true,
                      httpStatus: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.regulatoryAlert.count(),
    ]);

    return { alerts, total };
  }

  // -------------------------------------------------------------------------
  // dispatchAlertEmail -- private, never throws
  // -------------------------------------------------------------------------

  private async dispatchAlertEmail(
    alert: RegulatoryAlert,
    target: EmailTarget
  ): Promise<void> {
    try {
      const frontendUrl = (process.env.FRONTEND_URL ?? 'https://sheriabot.com')
        .split(',')[0]
        .trim();

      await reactMailer.sendRegulatoryAlertEmail(target.email, {
        recipientName: target.fullName,
        alertTitle: alert.title,
        alertSummary: alert.summary,
        alertBody: alert.body,
        regulatoryBody: alert.regulatoryBody,
        severity: alert.severity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
        effectiveDate: alert.effectiveDate
          ? alert.effectiveDate.toLocaleDateString('en-KE', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : undefined,
        sourceUrl: alert.sourceUrl ?? undefined,
        alertUrl: `${frontendUrl}/dashboard/alerts/${alert.id}`,
        unsubscribeUrl: `${frontendUrl}/settings/notifications`,
      });

      await this.prisma.alertNotification.updateMany({
        where: { alertId: alert.id, userId: target.userId, channel: 'EMAIL' },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({
        type: 'alert_email_dispatch_failed',
        alertId: alert.id,
        userId: target.userId,
        error: message,
      });
      // Never throw -- email failure must not block the publish flow
    }
  }

  // -------------------------------------------------------------------------
  // updateDraft -- updates editable customer copy on a draft alert
  // -------------------------------------------------------------------------

  async updateDraft(input: UpdateAlertInput, userId: string): Promise<RegulatoryAlert> {
    const alert = await this.prisma.regulatoryAlert.findUnique({ where: { id: input.alertId } });
    if (!alert) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Alert not found.' });
    }
    if (alert.isActive) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot edit an already published alert directly.' });
    }

    const updated = await this.prisma.regulatoryAlert.update({
      where: { id: input.alertId },
      data: {
        title: input.title ?? alert.title,
        summary: input.summary ?? alert.summary,
        body: input.body ?? alert.body,
        category: input.category ?? alert.category,
        severity: input.severity ?? alert.severity,
        sourceUrl: input.sourceUrl !== undefined ? (input.sourceUrl || null) : alert.sourceUrl,
        effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : alert.effectiveDate,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : alert.expiresAt,
        updatedAt: new Date(),
      },
    });

    logger.info({ type: 'alert_draft_updated', alertId: alert.id, updatedBy: userId });
    return updated;
  }

  // -------------------------------------------------------------------------
  // rejectDraft -- rejects an unpublished draft and marks provenance
  // -------------------------------------------------------------------------

  async rejectDraft(
    input: RejectAlertInput,
    reviewerId: string
  ): Promise<{ success: boolean; alertId: string }> {
    const alert = await this.prisma.regulatoryAlert.findUnique({
      where: { id: input.alertId },
      include: { primaryRegulatorySourceItem: true },
    });
    if (!alert) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Alert not found.' });
    }
    if (alert.isActive) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Cannot reject an already published alert.' });
    }

    // Mark source item verificationState as REJECTED if linked
    if (alert.primaryRegulatorySourceItemId) {
      await this.prisma.regulatorySourceItem.update({
        where: { id: alert.primaryRegulatorySourceItemId },
        data: {
          verificationState: 'REJECTED' as any,
          updatedAt: new Date(),
        },
      });
    }

    // Mark AgentRun as rejected if automation key exists
    if (alert.automationDraftKey) {
      await this.prisma.agentRun.updateMany({
        where: { idempotencyKey: alert.automationDraftKey },
        data: {
          metadata: {
            rejected: true,
            rejectedById: reviewerId,
            rejectionReason: input.reason || 'Rejected by administrator',
            rejectedAt: new Date().toISOString(),
          },
        },
      });
    }

    // Remove the draft alert
    await this.prisma.regulatoryAlert.delete({ where: { id: input.alertId } });

    logger.info({
      type: 'alert_draft_rejected',
      alertId: input.alertId,
      reviewerId,
      reason: input.reason,
      primaryRegulatorySourceItemId: alert.primaryRegulatorySourceItemId,
    });

    return { success: true, alertId: input.alertId };
  }
}

export const alertService = new AlertService();
export { AlertService };
