/**
 * Notification Module Utilities
 */

import { z } from 'zod';
import type { NotificationDTO } from './notification.types';

// ============================================================================
// Validation Schemas
// ============================================================================

export const createNotificationSchema = z.object({
  userId: z.string().cuid(),
  type: z.string().min(1),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  link: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const bulkNotificationSchema = z.object({
  userIds: z.array(z.string().cuid()).min(1).max(500),
  type: z.string().min(1),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  link: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const notificationFiltersSchema = z.object({
  read: z.boolean().optional(),
  type: z.string().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(20),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const preferencesUpdateSchema = z.object({
  emailEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  channels: z
    .record(
      z.string(),
      z.object({
        email: z.boolean(),
        inApp: z.boolean(),
      })
    )
    .optional(),
});

// ============================================================================
// Transformer
// ============================================================================

export function toNotificationDTO(n: Record<string, unknown>): NotificationDTO {
  return {
    id: n.id as string,
    userId: n.userId as string,
    type: n.type as string,
    title: n.title as string,
    message: n.message as string,
    link: n.link as string | null,
    read: n.read as boolean,
    readAt: n.readAt as Date | null,
    metadata: n.metadata as Record<string, unknown> | null,
    createdAt: n.createdAt as Date,
  };
}

// ============================================================================
// Template Interpolation
// ============================================================================

/**
 * Interpolate a template string with data values.
 * e.g. "Hello {{name}}" + { name: "Alice" } => "Hello Alice"
 */
export function interpolateTemplate(
  template: string,
  data: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return key in data ? String(data[key]) : `{{${key}}}`;
  });
}

// ============================================================================
// Cache Key Helpers
// ============================================================================

export function unreadCountKey(userId: string): string {
  return `notif:unread:${userId}`;
}

export function prefsKey(userId: string): string {
  return `notif:prefs:${userId}`;
}
