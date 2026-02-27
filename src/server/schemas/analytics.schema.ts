import { z } from 'zod';

export const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  days: z.number().min(1).max(365).optional(),
});

export const getOrgDashboardSchema = z.object({
  orgId: z.string().optional(),
  dateRange: dateRangeSchema.optional(),
});

export const getComplianceTrendsSchema = z.object({
  orgId: z.string().optional(),
  periods: z.number().min(1).max(12).default(3),
});

export const generateReportSchema = z.object({
  orgId: z.string().optional(),
  reportType: z.enum(['compliance', 'audit', 'executive']).default('compliance'),
  dateRange: dateRangeSchema.optional(),
  includeDetails: z.boolean().default(true),
});

export const exportAnalyticsSchema = z.object({
  format: z.enum(['csv', 'json']).default('json'),
  type: z.enum(['queries', 'policies', 'documents', 'users', 'audit']).default('queries'),
  dateRange: dateRangeSchema.optional(),
  orgId: z.string().optional(),
});

export const getUserGrowthSchema = z.object({
  dateRange: dateRangeSchema.optional(),
});
