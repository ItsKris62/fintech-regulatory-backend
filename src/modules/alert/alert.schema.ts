import { z } from 'zod';

export const REGULATORY_BODIES = ['CBK', 'CMA', 'ODPC', 'CA', 'GAZETTE'] as const;
export const ALERT_CATEGORIES = [
  'PRUDENTIAL',
  'DATA_PROTECTION',
  'AML_CFT',
  'LICENSING',
  'CAPITAL_MARKETS',
  'GENERAL',
] as const;
export const ALERT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const EMAIL_FREQUENCIES = ['REALTIME', 'DAILY', 'WEEKLY'] as const;

export const createAlertSchema = z.object({
  title: z.string().min(5).max(200),
  summary: z.string().min(10).max(500),
  body: z.string().min(20),
  sourceUrl: z.string().url().optional(),
  regulatoryBody: z.enum(REGULATORY_BODIES),
  category: z.enum(ALERT_CATEGORIES),
  severity: z.enum(ALERT_SEVERITIES).default('MEDIUM'),
  effectiveDate: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const getAlertsSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20),
  regulatoryBody: z.enum(REGULATORY_BODIES).optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  unreadOnly: z.boolean().optional(),
});

export const upsertSubscriptionSchema = z.object({
  regulatoryBodies: z.array(z.enum(REGULATORY_BODIES)).min(0),
  categories: z.array(z.enum(ALERT_CATEGORIES)).min(0),
  severityThreshold: z.enum(ALERT_SEVERITIES),
  emailEnabled: z.boolean(),
  inAppEnabled: z.boolean(),
  emailFrequency: z.enum(EMAIL_FREQUENCIES),
});

export const markAsReadSchema = z.object({
  notificationId: z.string().min(1),
});

export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export type GetAlertsInput = z.infer<typeof getAlertsSchema>;
export type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>;
export type MarkAsReadInput = z.infer<typeof markAsReadSchema>;
