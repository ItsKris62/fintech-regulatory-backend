/**
 * Analytics Module Types
 */

// ============================================================================
// Constants
// ============================================================================

export const ANALYTICS_CONSTANTS = {
  REDIS_KEYS: {
    ORG_DASHBOARD: 'analytics:org:dashboard:',
    ORG_SCORE: 'analytics:org:score:',
    PLATFORM_OVERVIEW: 'analytics:platform:overview',
    SYSTEM_HEALTH: 'analytics:system:health',
    REPORT_JOB: 'analytics:report:job:',
    REPORT_RESULT: 'analytics:report:result:',
  },
  CACHE_TTL: {
    ORG_DASHBOARD: 900,      // 15 minutes
    PLATFORM_OVERVIEW: 300,  // 5 minutes
    SYSTEM_HEALTH: 60,       // 1 minute
    REPORT_RESULT: 86400,    // 24 hours
  },
  DEFAULT_DATE_RANGE_DAYS: 30,
} as const;

// ============================================================================
// Shared Types
// ============================================================================

export interface DateRange {
  from: Date;
  to: Date;
}

export type DocumentAction = 'view' | 'download' | 'share' | 'delete';

// ============================================================================
// Event Tracking Types
// ============================================================================

export interface TrackEventParams {
  event: string;
  userId?: string;
  orgId?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface PageViewParams {
  userId: string;
  path: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

export interface QueryMetadata {
  regulatoryAreas?: string[];
  responseTimeMs?: number;
  tokensUsed?: number;
  cached?: boolean;
}

export interface PolicyMetadata {
  regulatoryAreas?: string[];
  generationTimeMs?: number;
  tokensUsed?: number;
  template?: string;
}

// ============================================================================
// User Analytics
// ============================================================================

export interface UserActivitySummary {
  userId: string;
  totalQueries: number;
  totalPoliciesGenerated: number;
  totalDocumentsUploaded: number;
  totalDocumentsViewed: number;
  avgSessionDurationMinutes: number;
  lastActiveAt: Date | null;
  activeStreak: number;
  dateRange: DateRange;
}

export interface UserEngagementMetrics {
  userId: string;
  loginCount30d: number;
  queryCount30d: number;
  policyCount30d: number;
  documentCount30d: number;
  engagementScore: number;
}

export interface ComplianceHistory {
  userId: string;
  scores: Array<{ date: Date; score: number; grade: string }>;
  trend: 'improving' | 'declining' | 'stable';
  dateRange: DateRange;
}

// ============================================================================
// Organization Analytics
// ============================================================================

export interface OrgDashboard {
  orgId: string;
  summary: {
    complianceScore: number;
    complianceGrade: string;
    totalMembers: number;
    activeMembers: number;
    totalDocuments: number;
    totalPolicies: number;
    openRequirements: number;
    overdueRequirements: number;
  };
  recentActivity: Array<{
    type: string;
    description: string;
    userId: string;
    createdAt: Date;
  }>;
  complianceTrend: ComplianceTrend[];
  topRisks: string[];
  dateRange: DateRange;
}

export interface ComplianceScoreReport {
  orgId: string;
  currentScore: number;
  previousScore: number;
  change: number;
  grade: string;
  areaBreakdown: Array<{ area: string; score: number; status: string }>;
  generatedAt: Date;
}

export interface DocumentStats {
  orgId: string;
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  totalSizeMB: number;
  recentUploads: number;
}

export interface MemberActivityReport {
  orgId: string;
  members: Array<{
    userId: string;
    name: string;
    email: string;
    role: string;
    queries: number;
    policies: number;
    lastActive: Date | null;
  }>;
  dateRange: DateRange;
}

export interface ComplianceTrend {
  date: Date;
  score: number;
  grade: string;
}

// ============================================================================
// Compliance Analytics
// ============================================================================

export interface ComplianceOverview {
  orgId: string;
  overallScore: number;
  grade: string;
  totalRequirements: number;
  completedRequirements: number;
  pendingRequirements: number;
  overdueRequirements: number;
  completionRate: number;
  areaScores: Record<string, number>;
}

export interface RequirementStats {
  orgId: string;
  byArea: Array<{
    area: string;
    total: number;
    completed: number;
    completionRate: number;
  }>;
  overallCompletionRate: number;
}

export interface RiskSummary {
  orgId: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore: number;
  topRisks: Array<{ area: string; description: string; severity: string }>;
  mitigatedRisks: number;
  openRisks: number;
}

export interface DeadlineAlert {
  requirementId: string;
  area: string;
  description: string;
  dueDate: Date;
  daysRemaining: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface GapAnalysis {
  orgId: string;
  gaps: Array<{
    area: string;
    gapType: string;
    severity: string;
    description: string;
    recommendation: string;
  }>;
  totalGaps: number;
  criticalGaps: number;
}

// ============================================================================
// Document Analytics
// ============================================================================

export interface DocumentUsageStats {
  orgId: string;
  totalViews: number;
  totalDownloads: number;
  uniqueViewers: number;
  mostViewedTypes: Array<{ type: string; count: number }>;
  dateRange: DateRange;
}

export interface DocumentAccessStats {
  documentId: string;
  title: string;
  views: number;
  downloads: number;
  lastAccessed: Date;
}

export interface SearchAnalytics {
  orgId: string;
  totalSearches: number;
  topQueries: Array<{ query: string; count: number }>;
  avgResultsReturned: number;
  zeroResultRate: number;
  dateRange: DateRange;
}

// ============================================================================
// Platform Analytics (Admin)
// ============================================================================

export interface PlatformOverview {
  totalUsers: number;
  activeUsers: number;
  totalOrganizations: number;
  activeOrganizations: number;
  totalPolicies: number;
  totalQueries: number;
  totalDocuments: number;
  newUsersToday: number;
  newOrgsToday: number;
  dateRange: DateRange;
}

export interface GrowthMetrics {
  current: number;
  previous: number;
  percentChange: number;
  trend: Array<{ date: Date; count: number }>;
  dateRange: DateRange;
}

export interface SystemHealthMetrics {
  status: 'healthy' | 'degraded' | 'down';
  database: { status: string; latencyMs: number; connections: number };
  redis: { status: string; latencyMs: number; memoryUsedMB: number };
  pinecone: { status: string; vectorCount: number };
  storage: { status: string };
  uptime: number;
  checkedAt: Date;
}

export interface APIUsageMetrics {
  totalRequests: number;
  successRate: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  errorsByType: Record<string, number>;
  topEndpoints: Array<{ path: string; count: number; avgMs: number }>;
  dateRange: DateRange;
}

export interface RevenueMetrics {
  mrr: number;
  arr: number;
  newMrr: number;
  churnedMrr: number;
  byPlan: Record<string, { count: number; mrr: number }>;
  dateRange: DateRange;
}

// ============================================================================
// Report Types
// ============================================================================

export interface ReportParams {
  title?: string;
  includeScoring?: boolean;
  includeGaps?: boolean;
  includeRisks?: boolean;
  includeTimeline?: boolean;
  dateRange?: DateRange;
}

export interface GeneratedReport {
  reportId: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  orgId: string;
  type: string;
  downloadUrl?: string;
  generatedAt?: Date;
  expiresAt?: Date;
}

export interface AuditReport {
  reportId: string;
  orgId: string;
  events: Array<{
    action: string;
    userId: string;
    entityType: string;
    entityId: string;
    metadata: unknown;
    createdAt: Date;
  }>;
  dateRange: DateRange;
  generatedAt: Date;
}

export interface ExecutiveSummary {
  orgId: string;
  complianceScore: number;
  complianceGrade: string;
  highlights: string[];
  risks: string[];
  recommendations: string[];
  trendDirection: 'up' | 'down' | 'stable';
  generatedAt: Date;
}

export interface ScheduleReportParams {
  orgId: string;
  reportType: 'compliance' | 'audit' | 'executive';
  frequency: 'daily' | 'weekly' | 'monthly';
  recipientUserIds: string[];
  params?: ReportParams;
}

export interface ScheduledReport {
  scheduleId: string;
  orgId: string;
  reportType: string;
  frequency: string;
  nextRunAt: Date;
  createdAt: Date;
}

export interface ExportParams {
  orgId?: string;
  userId?: string;
  reportType: 'compliance' | 'audit' | 'usage' | 'platform';
  format: 'csv' | 'json' | 'pdf';
  dateRange?: DateRange;
}

export interface ExportResult {
  exportId: string;
  downloadUrl: string;
  format: string;
  expiresAt: Date;
}
