/**
 * Notification Module  -  Public API
 */

export { notificationModule, NotificationModule } from './notification.module';

export type {
  ExtendedNotificationType,
  AlertSeverity,
  EmailTemplate,
  NotificationPreferences,
  CreateNotificationParams,
  BulkNotificationParams,
  AnnouncementParams,
  NotificationFilters,
  SystemNotificationFilters,
  NotificationDTO,
  PaginatedNotifications,
  BulkResult,
  NotificationTemplate,
  TemplateParams,
  ComplianceAlertData,
  PolicyUpdateData,
  InviteEmailData,
} from './notification.types';

export {
  NOTIFICATION_CONSTANTS,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from './notification.types';

export {
  createNotificationSchema,
  bulkNotificationSchema,
  notificationFiltersSchema,
  preferencesUpdateSchema,
  toNotificationDTO,
  interpolateTemplate,
} from './notification.utils';
