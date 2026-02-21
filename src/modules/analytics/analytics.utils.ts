/**
 * Analytics Module Utilities
 */

import { z } from 'zod';
import type { DateRange } from './analytics.types';

// ============================================================================
// Validation Schemas
// ============================================================================

export const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const trackEventSchema = z.object({
  event: z.string().min(1).max(100),
  userId: z.string().optional(),
  orgId: z.string().optional(),
  resourceId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const reportParamsSchema = z.object({
  title: z.string().optional(),
  includeScoring: z.boolean().default(true),
  includeGaps: z.boolean().default(true),
  includeRisks: z.boolean().default(true),
  includeTimeline: z.boolean().default(true),
  dateRange: dateRangeSchema.optional(),
});

export const scheduleReportSchema = z.object({
  orgId: z.string().cuid(),
  reportType: z.enum(['compliance', 'audit', 'executive']),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  recipientUserIds: z.array(z.string().cuid()).min(1).max(20),
});

export const exportParamsSchema = z.object({
  orgId: z.string().optional(),
  userId: z.string().optional(),
  reportType: z.enum(['compliance', 'audit', 'usage', 'platform']),
  format: z.enum(['csv', 'json', 'pdf']),
});

// ============================================================================
// Date Range Utilities
// ============================================================================

/**
 * Build default date range (last N days)
 */
export function defaultDateRange(days: number = 30): DateRange {
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * Parse date range from optional input, defaulting to last 30 days
 */
export function parseDateRange(
  from?: string | Date,
  to?: string | Date,
  defaultDays: number = 30
): DateRange {
  if (from && to) {
    return {
      from: from instanceof Date ? from : new Date(from),
      to: to instanceof Date ? to : new Date(to),
    };
  }
  return defaultDateRange(defaultDays);
}

/**
 * Split a date range into daily buckets for trend charts
 */
export function splitIntoDailyBuckets(range: DateRange): Date[] {
  const buckets: Date[] = [];
  const current = new Date(range.from);
  current.setHours(0, 0, 0, 0);

  while (current <= range.to) {
    buckets.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return buckets;
}

// ============================================================================
// Score Helpers
// ============================================================================

export function gradeFromScore(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function calculatePercentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

export function determineTrend(
  values: number[]
): 'improving' | 'declining' | 'stable' {
  if (values.length < 2) return 'stable';
  const recent = values.slice(-3);
  const older = values.slice(-6, -3);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : recentAvg;

  if (recentAvg > olderAvg + 2) return 'improving';
  if (recentAvg < olderAvg - 2) return 'declining';
  return 'stable';
}

// ============================================================================
// Cache Key Helpers
// ============================================================================

export function orgDashboardKey(orgId: string): string {
  return `analytics:org:dashboard:${orgId}`;
}

export function platformOverviewKey(): string {
  return 'analytics:platform:overview';
}

export function systemHealthKey(): string {
  return 'analytics:system:health';
}

export function reportJobKey(jobId: string): string {
  return `analytics:report:job:${jobId}`;
}

export function reportResultKey(jobId: string): string {
  return `analytics:report:result:${jobId}`;
}

// ============================================================================
// CSV Serialisation (lightweight)
// ============================================================================

export function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        })
        .join(',')
    ),
  ];
  return lines.join('\n');
}
