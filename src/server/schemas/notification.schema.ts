import { z } from 'zod';

export const notificationCategorySchema = z.enum([
  'SECURITY',
  'COMPLIANCE',
  'DOCUMENTS',
  'ACCOUNT',
  'SUPPORT',
  'SYSTEM',
]);

export const listNotificationsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
  unreadOnly: z.boolean().optional(),
  type: z.string().optional(),
  category: notificationCategorySchema.optional(),
});

export const markAsReadSchema = z.object({
  notificationId: z.string().min(1),
});

export const deleteNotificationSchema = z.object({
  notificationId: z.string().min(1),
});

export const updateCategoryPreferenceSchema = z.object({
  category: notificationCategorySchema,
  inAppEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
});

export const updateNotificationPreferencesSchema = z.object({
  emailEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
  digestFrequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
  channels: z
    .record(
      z.string(),
      z.object({
        email: z.boolean().optional(),
        inApp: z.boolean().optional(),
      })
    )
    .optional(),
});
