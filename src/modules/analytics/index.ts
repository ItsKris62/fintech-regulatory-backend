/**
 * Analytics Module  -  Public API
 */

export { analyticsModule, AnalyticsModule } from './analytics.module';

export type {
  DateRange,
  DocumentAction,
  TrackEventParams,
  PageViewParams,
  QueryMetadata,
  PolicyMetadata,
  UserActivitySummary,
  UserEngagementMetrics,
  ComplianceHistory,
  OrgDashboard,
  ComplianceScoreReport,
  DocumentStats,
  MemberActivityReport,
  ComplianceTrend,
  ComplianceOverview,
  RequirementStats,
  RiskSummary,
  DeadlineAlert,
  GapAnalysis,
  DocumentUsageStats,
  DocumentAccessStats,
  SearchAnalytics,
  PlatformOverview,
  GrowthMetrics,
  SystemHealthMetrics,
  APIUsageMetrics,
  RevenueMetrics,
  ReportParams,
  GeneratedReport,
  AuditReport,
  ExecutiveSummary,
  ScheduleReportParams,
  ScheduledReport,
  ExportParams,
  ExportResult,
} from './analytics.types';

export { ANALYTICS_CONSTANTS } from './analytics.types';

export {
  dateRangeSchema,
  trackEventSchema,
  reportParamsSchema,
  scheduleReportSchema,
  exportParamsSchema,
  defaultDateRange,
  parseDateRange,
  gradeFromScore,
  calculatePercentChange,
  determineTrend,
} from './analytics.utils';
