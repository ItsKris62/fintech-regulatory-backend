/**
 * Notification Module Types
 */

// ============================================================================
// Enums
// ============================================================================

export type ExtendedNotificationType =
  | 'COMPLIANCE_ALERT'
  | 'POLICY_UPDATE'
  | 'DOCUMENT_PROCESSED'
  | 'ORGANIZATION_INVITE'
  | 'SYSTEM_ANNOUNCEMENT'
  | 'REQUIREMENT_DUE'
  | 'SUBSCRIPTION_ALERT'
  | 'REPORT_READY'
  | 'MEMBER_JOINED'
  | 'POLICY_READY'
  | 'COMMENT_ADDED'
  | 'REVIEW_REQUESTED'
  | 'SYSTEM_UPDATE'
  | 'TICKET_CREATED'
  | 'TICKET_STATUS_UPDATE'
  | 'TICKET_RESPONSE';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type EmailTemplate =
  | 'welcome'
  | 'password_reset'
  | 'compliance_alert'
  | 'policy_ready'
  | 'org_invite'
  | 'requirement_due'
  | 'subscription_alert'
  | 'report_ready';

export const NOTIFICATION_CONSTANTS = {
  REDIS_KEYS: {
    UNREAD_COUNT: 'notif:unread:',
    USER_PREFS: 'notif:prefs:',
    NOTIFICATION: 'notif:',
  },
  CACHE_TTL: {
    UNREAD_COUNT: 300,   // 5 minutes
    PREFERENCES: 3600,   // 1 hour
    NOTIFICATION: 3600,  // 1 hour
  },
  LIMITS: {
    MAX_BULK: 500,
    PAGE_SIZE: 20,
    BATCH_EMAIL_SIZE: 50,
  },
} as const;

// ============================================================================
// Preference Types
// ============================================================================

export interface NotificationPreferences {
  userId: string;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  channels: {
    compliance_alert: { email: boolean; inApp: boolean };
    policy_update: { email: boolean; inApp: boolean };
    document_processed: { email: boolean; inApp: boolean };
    organization_invite: { email: boolean; inApp: boolean };
    system_announcement: { email: boolean; inApp: boolean };
    requirement_due: { email: boolean; inApp: boolean };
    subscription_alert: { email: boolean; inApp: boolean };
    report_ready: { email: boolean; inApp: boolean };
    member_joined: { email: boolean; inApp: boolean };
  };
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Omit<NotificationPreferences, 'userId'> = {
  emailEnabled: true,
  inAppEnabled: true,
  channels: {
    compliance_alert: { email: true, inApp: true },
    policy_update: { email: true, inApp: true },
    document_processed: { email: false, inApp: true },
    organization_invite: { email: true, inApp: true },
    system_announcement: { email: true, inApp: true },
    requirement_due: { email: true, inApp: true },
    subscription_alert: { email: true, inApp: true },
    report_ready: { email: true, inApp: true },
    member_joined: { email: false, inApp: true },
  },
};

// ============================================================================
// Input Types
// ============================================================================

export interface CreateNotificationParams {
  userId: string;
  type: ExtendedNotificationType;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export interface BulkNotificationParams {
  userIds: string[];
  type: ExtendedNotificationType;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export interface AnnouncementParams {
  title: string;
  message: string;
  severity: AlertSeverity;
  link?: string;
  targetRoles?: string[];
}

export interface NotificationFilters {
  read?: boolean;
  type?: ExtendedNotificationType;
  page?: number;
  limit?: number;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface SystemNotificationFilters extends NotificationFilters {
  userId?: string;
  types?: ExtendedNotificationType[];
}

// ============================================================================
// Result Types
// ============================================================================

export interface NotificationDTO {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  readAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface PaginatedNotifications {
  items: NotificationDTO[];
  nextCursor: string | null;
  total: number;
  page: number;
  limit: number;
  unreadCount: number;
}

export interface BulkResult {
  created: number;
  failed: number;
  total: number;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  type: ExtendedNotificationType;
  titleTemplate: string;
  messageTemplate: string;
  emailTemplate: EmailTemplate | null;
  createdAt: Date;
}

export interface TemplateParams {
  name: string;
  type: ExtendedNotificationType;
  titleTemplate: string;
  messageTemplate: string;
  emailTemplate?: EmailTemplate;
}

// ============================================================================
// Email Data Types
// ============================================================================

export interface ComplianceAlertData {
  orgName: string;
  area: string;
  score: number;
  message: string;
  actionUrl: string;
}

export interface PolicyUpdateData {
  policyTitle: string;
  updatedBy: string;
  changesSummary: string;
  policyUrl: string;
}

export interface InviteEmailData {
  inviterName: string;
  orgName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}
