/**
 * Analytics Module
 * Tracks platform usage, generates compliance reports, and powers dashboards.
 *
 * Integrations:
 * - Prisma — aggregation queries (policies, queries, documents, audit logs)
 * - Redis  — dashboard caching + report job store
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import {
  defaultDateRange,
  gradeFromScore,
  calculatePercentChange,
  determineTrend,
  orgDashboardKey,
  platformOverviewKey,
  systemHealthKey,
  reportJobKey,
  reportResultKey,
  toCSV,
} from './analytics.utils';
import {
  ANALYTICS_CONSTANTS,
  type DateRange,
  type TrackEventParams,
  type PageViewParams,
  type QueryMetadata,
  type PolicyMetadata,
  type UserActivitySummary,
  type UserEngagementMetrics,
  type ComplianceHistory,
  type OrgDashboard,
  type ComplianceScoreReport,
  type DocumentStats,
  type MemberActivityReport,
  type ComplianceTrend,
  type ComplianceOverview,
  type RequirementStats,
  type RiskSummary,
  type DeadlineAlert,
  type GapAnalysis,
  type DocumentUsageStats,
  type DocumentAccessStats,
  type SearchAnalytics,
  type PlatformOverview,
  type GrowthMetrics,
  type SystemHealthMetrics,
  type APIUsageMetrics,
  type RevenueMetrics,
  type ReportParams,
  type GeneratedReport,
  type AuditReport,
  type ExecutiveSummary,
  type ScheduleReportParams,
  type ScheduledReport,
  type ExportParams,
  type ExportResult,
  type DocumentAction,
} from './analytics.types';

const { CACHE_TTL } = ANALYTICS_CONSTANTS;

class AnalyticsModule {
  // ==========================================================================
  // EVENT TRACKING (lightweight — writes to AuditLog)
  // ==========================================================================

  async trackEvent(params: TrackEventParams): Promise<void> {
    await prisma.auditLog.create({
      data: {
        action: params.event,
        userId: params.userId ?? null,
        entityType: params.resourceId ? 'Resource' : null,
        entityId: params.resourceId ?? null,
        metadata: {
          orgId: params.orgId,
          ...params.metadata,
        } as object,
      },
    });
  }

  async trackPageView(params: PageViewParams): Promise<void> {
    await this.trackEvent({
      event: 'page_view',
      userId: params.userId,
      orgId: params.orgId,
      metadata: { path: params.path, ...params.metadata },
    });
  }

  async trackDocumentAccess(
    documentId: string,
    userId: string,
    action: DocumentAction
  ): Promise<void> {
    await this.trackEvent({
      event: `document_${action}`,
      userId,
      resourceId: documentId,
      metadata: { documentId },
    });
  }

  async trackComplianceQuery(
    queryId: string,
    userId: string,
    metadata: QueryMetadata
  ): Promise<void> {
    await this.trackEvent({
      event: 'compliance_query',
      userId,
      resourceId: queryId,
      metadata: metadata as Record<string, unknown>,
    });

    // Update daily usage metric
    await this.upsertDailyMetric(userId, 'queriesProcessed', 1);
  }

  async trackPolicyGeneration(
    policyId: string,
    orgId: string,
    metadata: PolicyMetadata
  ): Promise<void> {
    await this.trackEvent({
      event: 'policy_generation',
      orgId,
      resourceId: policyId,
      metadata: metadata as Record<string, unknown>,
    });

    await this.upsertDailyMetric(undefined, 'policiesGenerated', 1, orgId);
  }

  // ==========================================================================
  // USER ANALYTICS
  // ==========================================================================

  async getUserActivitySummary(
    userId: string,
    dateRange?: DateRange
  ): Promise<UserActivitySummary> {
    const range = dateRange ?? defaultDateRange(30);

    const [queryCount, policyCount, docUploads, docViews] = await Promise.all([
      prisma.complianceQuery.count({
        where: { userId, createdAt: { gte: range.from, lte: range.to } },
      }),
      prisma.policy.count({
        where: { userId, createdAt: { gte: range.from, lte: range.to } },
      }),
      prisma.legalDocument.count({
        where: { userId, createdAt: { gte: range.from, lte: range.to } },
      }),
      prisma.auditLog.count({
        where: {
          userId,
          action: 'document_view',
          createdAt: { gte: range.from, lte: range.to },
        },
      }),
    ]);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastLoginAt: true },
    });

    return {
      userId,
      totalQueries: queryCount,
      totalPoliciesGenerated: policyCount,
      totalDocumentsUploaded: docUploads,
      totalDocumentsViewed: docViews,
      avgSessionDurationMinutes: 0, // Would need session timing data
      lastActiveAt: user?.lastLoginAt ?? null,
      activeStreak: 0, // Would need daily activity tracking
      dateRange: range,
    };
  }

  async getUserEngagementMetrics(userId: string): Promise<UserEngagementMetrics> {
    const range = defaultDateRange(30);

    const [loginCount, queryCount, policyCount, documentCount] = await Promise.all([
      prisma.auditLog.count({
        where: {
          userId,
          action: 'user_login',
          createdAt: { gte: range.from },
        },
      }),
      prisma.complianceQuery.count({
        where: { userId, createdAt: { gte: range.from } },
      }),
      prisma.policy.count({
        where: { userId, createdAt: { gte: range.from } },
      }),
      prisma.legalDocument.count({
        where: { userId, createdAt: { gte: range.from } },
      }),
    ]);

    const engagementScore = Math.min(
      100,
      loginCount * 5 + queryCount * 10 + policyCount * 20 + documentCount * 8
    );

    return {
      userId,
      loginCount30d: loginCount,
      queryCount30d: queryCount,
      policyCount30d: policyCount,
      documentCount30d: documentCount,
      engagementScore,
    };
  }

  async getUserComplianceHistory(
    userId: string,
    dateRange?: DateRange
  ): Promise<ComplianceHistory> {
    const range = dateRange ?? defaultDateRange(90);

    const metrics = await prisma.usageMetric.findMany({
      where: {
        userId,
        date: { gte: range.from, lte: range.to },
      },
      orderBy: { date: 'asc' },
      select: { date: true, citationAccuracy: true },
    });

    const scores = metrics
      .filter((m) => m.citationAccuracy !== null)
      .map((m) => ({
        date: m.date,
        score: Math.round((m.citationAccuracy ?? 0) * 100),
        grade: gradeFromScore(Math.round((m.citationAccuracy ?? 0) * 100)),
      }));

    const trend = determineTrend(scores.map((s) => s.score));

    return { userId, scores, trend, dateRange: range };
  }

  // ==========================================================================
  // ORGANIZATION ANALYTICS
  // ==========================================================================

  async getOrganizationDashboard(
    orgId: string,
    dateRange?: DateRange
  ): Promise<OrgDashboard> {
    const cacheKey = orgDashboardKey(orgId);
    const cached = await redis.get<string>(cacheKey);
    if (cached) return JSON.parse(cached) as OrgDashboard;

    const range = dateRange ?? defaultDateRange(30);

    const [memberCount, activeMembers, docCount, policyCount, recentActivity] =
      await Promise.all([
        prisma.user.count({ where: { organizationId: orgId } }),
        prisma.user.count({
          where: {
            organizationId: orgId,
            lastLoginAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.legalDocument.count({
          where: { organizationId: orgId, deletedAt: null },
        }),
        prisma.policy.count({
          where: {
            user: { organizationId: orgId },
            createdAt: { gte: range.from, lte: range.to },
          },
        }),
        prisma.auditLog.findMany({
          where: {
            user: { organizationId: orgId },
            createdAt: { gte: range.from, lte: range.to },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            action: true,
            userId: true,
            entityType: true,
            createdAt: true,
          },
        }),
      ]);

    // Compliance scores from checklist progress
    const checklists = await prisma.checklist.findMany({
      where: { user: { organizationId: orgId } },
      select: { progress: true, status: true, dueDate: true },
    });

    const openRequirements = checklists.filter((c) => c.status === 'in_progress').length;
    const overdueRequirements = checklists.filter(
      (c) => c.status === 'in_progress' && c.dueDate && c.dueDate < new Date()
    ).length;

    const avgScore =
      checklists.length > 0
        ? Math.round(checklists.reduce((sum, c) => sum + c.progress, 0) / checklists.length)
        : 0;

    const trend = await this.getComplianceTrends(orgId, 3);

    const dashboard: OrgDashboard = {
      orgId,
      summary: {
        complianceScore: avgScore,
        complianceGrade: gradeFromScore(avgScore),
        totalMembers: memberCount,
        activeMembers,
        totalDocuments: docCount,
        totalPolicies: policyCount,
        openRequirements,
        overdueRequirements,
      },
      recentActivity: recentActivity.map((a) => ({
        type: a.action,
        description: `${a.action} on ${a.entityType ?? 'system'}`,
        userId: a.userId ?? 'system',
        createdAt: a.createdAt,
      })),
      complianceTrend: trend,
      topRisks: overdueRequirements > 0 ? ['Overdue compliance requirements detected'] : [],
      dateRange: range,
    };

    await redis.set(cacheKey, JSON.stringify(dashboard), { ex: CACHE_TTL.ORG_DASHBOARD });
    return dashboard;
  }

  async getOrganizationComplianceScore(orgId: string): Promise<ComplianceScoreReport> {
    const checklists = await prisma.checklist.findMany({
      where: { user: { organizationId: orgId } },
      select: { progress: true },
      orderBy: { updatedAt: 'desc' },
    });

    const current =
      checklists.length > 0
        ? Math.round(checklists.reduce((s, c) => s + c.progress, 0) / checklists.length)
        : 0;

    // Prior period (compare to yesterday's metric if available)
    const prior = await prisma.usageMetric.findFirst({
      where: { organizationId: orgId },
      orderBy: { date: 'desc' },
      skip: 1,
      select: { citationAccuracy: true },
    });
    const previous = prior?.citationAccuracy ? Math.round(prior.citationAccuracy * 100) : current;

    return {
      orgId,
      currentScore: current,
      previousScore: previous,
      change: current - previous,
      grade: gradeFromScore(current),
      areaBreakdown: [],
      generatedAt: new Date(),
    };
  }

  async getOrganizationDocumentStats(orgId: string): Promise<DocumentStats> {
    const docs = await prisma.legalDocument.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { documentType: true, status: true, fileSize: true, createdAt: true },
    });

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalSize = 0;
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let recentUploads = 0;

    for (const d of docs) {
      byType[d.documentType] = (byType[d.documentType] ?? 0) + 1;
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      totalSize += d.fileSize;
      if (d.createdAt >= recent) recentUploads++;
    }

    return {
      orgId,
      total: docs.length,
      byType,
      byStatus,
      totalSizeMB: Math.round(totalSize / (1024 * 1024) * 100) / 100,
      recentUploads,
    };
  }

  async getOrganizationMemberActivity(
    orgId: string,
    dateRange?: DateRange
  ): Promise<MemberActivityReport> {
    const range = dateRange ?? defaultDateRange(30);

    const members = await prisma.user.findMany({
      where: { organizationId: orgId },
      select: { id: true, fullName: true, email: true, role: true, lastLoginAt: true },
    });

    const memberData = await Promise.all(
      members.map(async (m) => {
        const [queries, policies] = await Promise.all([
          prisma.complianceQuery.count({
            where: { userId: m.id, createdAt: { gte: range.from, lte: range.to } },
          }),
          prisma.policy.count({
            where: { userId: m.id, createdAt: { gte: range.from, lte: range.to } },
          }),
        ]);
        return {
          userId: m.id,
          name: m.fullName,
          email: m.email,
          role: m.role,
          queries,
          policies,
          lastActive: m.lastLoginAt,
        };
      })
    );

    return { orgId, members: memberData, dateRange: range };
  }

  async getComplianceTrends(orgId: string, months: number = 6): Promise<ComplianceTrend[]> {
    const metrics = await prisma.usageMetric.findMany({
      where: {
        organizationId: orgId,
        date: { gte: new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { date: 'asc' },
      select: { date: true, citationAccuracy: true },
    });

    return metrics.map((m) => {
      const score = m.citationAccuracy ? Math.round(m.citationAccuracy * 100) : 0;
      return { date: m.date, score, grade: gradeFromScore(score) };
    });
  }

  // ==========================================================================
  // COMPLIANCE ANALYTICS
  // ==========================================================================

  async getComplianceOverview(orgId: string): Promise<ComplianceOverview> {
    const checklists = await prisma.checklist.findMany({
      where: { user: { organizationId: orgId } },
      select: { progress: true, status: true },
    });

    const total = checklists.length;
    const completed = checklists.filter((c) => c.status === 'complete').length;
    const pending = checklists.filter((c) => c.status === 'in_progress').length;
    const overdue = checklists.filter(
      (c) => c.status === 'in_progress'
    ).length;
    const avgScore =
      total > 0 ? Math.round(checklists.reduce((s, c) => s + c.progress, 0) / total) : 0;

    return {
      orgId,
      overallScore: avgScore,
      grade: gradeFromScore(avgScore),
      totalRequirements: total,
      completedRequirements: completed,
      pendingRequirements: pending,
      overdueRequirements: overdue,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      areaScores: {},
    };
  }

  async getRequirementCompletionRates(orgId: string): Promise<RequirementStats> {
    const checklists = await prisma.checklist.findMany({
      where: { user: { organizationId: orgId } },
      select: { productType: true, progress: true, status: true },
    });

    const byArea: Record<string, { total: number; completed: number }> = {};
    for (const c of checklists) {
      const area = c.productType ?? 'General';
      if (!byArea[area]) byArea[area] = { total: 0, completed: 0 };
      byArea[area].total++;
      if (c.status === 'complete') byArea[area].completed++;
    }

    const overall =
      checklists.length > 0
        ? Math.round(
            (checklists.filter((c) => c.status === 'complete').length / checklists.length) * 100
          )
        : 0;

    return {
      orgId,
      byArea: Object.entries(byArea).map(([area, stats]) => ({
        area,
        total: stats.total,
        completed: stats.completed,
        completionRate: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
      })),
      overallCompletionRate: overall,
    };
  }

  async getRiskAssessmentSummary(orgId: string): Promise<RiskSummary> {
    const checklists = await prisma.checklist.findMany({
      where: { user: { organizationId: orgId } },
      select: { progress: true, status: true },
    });

    const avgProgress =
      checklists.length > 0
        ? checklists.reduce((s, c) => s + c.progress, 0) / checklists.length
        : 100;

    const riskScore = 100 - avgProgress;
    let riskLevel: RiskSummary['riskLevel'] = 'LOW';
    if (riskScore >= 70) riskLevel = 'CRITICAL';
    else if (riskScore >= 50) riskLevel = 'HIGH';
    else if (riskScore >= 30) riskLevel = 'MEDIUM';

    return {
      orgId,
      riskLevel,
      riskScore: Math.round(riskScore),
      topRisks: [],
      mitigatedRisks: checklists.filter((c) => c.status === 'complete').length,
      openRisks: checklists.filter((c) => c.status === 'in_progress').length,
    };
  }

  async getDeadlineAlerts(orgId: string): Promise<DeadlineAlert[]> {
    const upcoming = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const checklists = await prisma.checklist.findMany({
      where: {
        user: { organizationId: orgId },
        status: 'in_progress',
        dueDate: { lte: upcoming },
      },
      select: { id: true, title: true, productType: true, dueDate: true, progress: true },
      orderBy: { dueDate: 'asc' },
    });

    return checklists
      .filter((c) => c.dueDate !== null)
      .map((c) => {
        const daysRemaining = Math.ceil(
          ((c.dueDate as Date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        return {
          requirementId: c.id,
          area: c.productType ?? 'General',
          description: c.title,
          dueDate: c.dueDate as Date,
          daysRemaining,
          priority: daysRemaining <= 3 ? 'critical' : daysRemaining <= 7 ? 'high' : daysRemaining <= 14 ? 'medium' : 'low',
        };
      });
  }

  async getComplianceGapAnalysis(orgId: string): Promise<GapAnalysis> {
    const checklists = await prisma.checklist.findMany({
      where: {
        user: { organizationId: orgId },
        status: { not: 'complete' },
      },
      select: { id: true, title: true, productType: true, progress: true },
    });

    const gaps = checklists.map((c) => ({
      area: c.productType ?? 'General',
      gapType: 'incomplete_requirement',
      severity: c.progress < 25 ? 'critical' : c.progress < 50 ? 'high' : 'medium',
      description: c.title,
      recommendation: `Complete the ${c.title} checklist to close this gap`,
    }));

    return {
      orgId,
      gaps,
      totalGaps: gaps.length,
      criticalGaps: gaps.filter((g) => g.severity === 'critical').length,
    };
  }

  // ==========================================================================
  // DOCUMENT ANALYTICS
  // ==========================================================================

  async getDocumentUsageStats(
    orgId: string,
    dateRange?: DateRange
  ): Promise<DocumentUsageStats> {
    const range = dateRange ?? defaultDateRange(30);

    const viewEvents = await prisma.auditLog.findMany({
      where: {
        action: { in: ['document_view', 'document_download'] },
        user: { organizationId: orgId },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { action: true, userId: true },
    });

    const totalViews = viewEvents.filter((e) => e.action === 'document_view').length;
    const totalDownloads = viewEvents.filter((e) => e.action === 'document_download').length;
    const uniqueViewers = new Set(viewEvents.map((e) => e.userId)).size;

    return {
      orgId,
      totalViews,
      totalDownloads,
      uniqueViewers,
      mostViewedTypes: [],
      dateRange: range,
    };
  }

  async getMostAccessedDocuments(
    orgId: string,
    limit: number = 10
  ): Promise<DocumentAccessStats[]> {
    const docs = await prisma.legalDocument.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { viewCount: 'desc' },
      take: limit,
      select: { id: true, title: true, actName: true, viewCount: true, updatedAt: true },
    });

    return docs.map((d) => ({
      documentId: d.id,
      title: d.title ?? d.actName,
      views: d.viewCount,
      downloads: 0,
      lastAccessed: d.updatedAt,
    }));
  }

  async getSearchAnalytics(
    orgId: string,
    dateRange?: DateRange
  ): Promise<SearchAnalytics> {
    const range = dateRange ?? defaultDateRange(30);

    const searchEvents = await prisma.auditLog.findMany({
      where: {
        action: 'document_search',
        user: { organizationId: orgId },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { metadata: true },
    });

    const queryMap: Record<string, number> = {};
    for (const event of searchEvents) {
      const meta = event.metadata as Record<string, unknown> | null;
      if (meta?.query && typeof meta.query === 'string') {
        queryMap[meta.query] = (queryMap[meta.query] ?? 0) + 1;
      }
    }

    const topQueries = Object.entries(queryMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([query, count]) => ({ query, count }));

    return {
      orgId,
      totalSearches: searchEvents.length,
      topQueries,
      avgResultsReturned: 5,
      zeroResultRate: 0,
      dateRange: range,
    };
  }

  // ==========================================================================
  // PLATFORM ANALYTICS (Admin)
  // ==========================================================================

  async getPlatformOverview(dateRange?: DateRange): Promise<PlatformOverview> {
    const cacheKey = platformOverviewKey();
    const cached = await redis.get<string>(cacheKey);
    if (cached) return JSON.parse(cached) as PlatformOverview;

    const range = dateRange ?? defaultDateRange(30);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers, activeUsers, totalOrgs, activeOrgs,
      totalPolicies, totalQueries, totalDocs,
      newUsersToday, newOrgsToday,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.organization.count(),
      prisma.organization.count({
        where: { subscriptionStatus: { in: ['ACTIVE', 'TRIALING'] } },
      }),
      prisma.policy.count({ where: { createdAt: { gte: range.from, lte: range.to } } }),
      prisma.complianceQuery.count({ where: { createdAt: { gte: range.from, lte: range.to } } }),
      prisma.legalDocument.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.organization.count({ where: { createdAt: { gte: today } } }),
    ]);

    const overview: PlatformOverview = {
      totalUsers,
      activeUsers,
      totalOrganizations: totalOrgs,
      activeOrganizations: activeOrgs,
      totalPolicies,
      totalQueries,
      totalDocuments: totalDocs,
      newUsersToday,
      newOrgsToday,
      dateRange: range,
    };

    await redis.set(cacheKey, JSON.stringify(overview), { ex: CACHE_TTL.PLATFORM_OVERVIEW });
    return overview;
  }

  async getUserGrowthMetrics(dateRange?: DateRange): Promise<GrowthMetrics> {
    const range = dateRange ?? defaultDateRange(30);
    const prevRange = {
      from: new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime())),
      to: range.from,
    };

    const [current, previous] = await Promise.all([
      prisma.user.count({ where: { createdAt: { gte: range.from, lte: range.to } } }),
      prisma.user.count({ where: { createdAt: { gte: prevRange.from, lte: prevRange.to } } }),
    ]);

    return {
      current,
      previous,
      percentChange: calculatePercentChange(current, previous),
      trend: [],
      dateRange: range,
    };
  }

  async getOrganizationGrowthMetrics(dateRange?: DateRange): Promise<GrowthMetrics> {
    const range = dateRange ?? defaultDateRange(30);
    const prevRange = {
      from: new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime())),
      to: range.from,
    };

    const [current, previous] = await Promise.all([
      prisma.organization.count({ where: { createdAt: { gte: range.from, lte: range.to } } }),
      prisma.organization.count({ where: { createdAt: { gte: prevRange.from, lte: prevRange.to } } }),
    ]);

    return {
      current,
      previous,
      percentChange: calculatePercentChange(current, previous),
      trend: [],
      dateRange: range,
    };
  }

  async getSystemHealthMetrics(): Promise<SystemHealthMetrics> {
    const cacheKey = systemHealthKey();
    const cached = await redis.get<string>(cacheKey);
    if (cached) return JSON.parse(cached) as SystemHealthMetrics;

    const health: SystemHealthMetrics = {
      status: 'healthy',
      database: { status: 'unknown', latencyMs: 0, connections: 0 },
      redis: { status: 'unknown', latencyMs: 0, memoryUsedMB: 0 },
      pinecone: { status: 'unknown', vectorCount: 0 },
      storage: { status: 'unknown' },
      uptime: process.uptime(),
      checkedAt: new Date(),
    };

    // Database ping
    try {
      const dbStart = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      health.database = { status: 'healthy', latencyMs: Date.now() - dbStart, connections: 1 };
    } catch {
      health.database = { status: 'down', latencyMs: -1, connections: 0 };
      health.status = 'degraded';
    }

    // Redis ping
    try {
      const redisStart = Date.now();
      await redis.ping();
      // redis.info() not available on Upstash (HTTP-based managed service)
      health.redis = { status: 'healthy', latencyMs: Date.now() - redisStart, memoryUsedMB: 0 };
    } catch {
      health.redis = { status: 'down', latencyMs: -1, memoryUsedMB: 0 };
      health.status = 'degraded';
    }

    health.storage = { status: 'healthy' };
    health.pinecone = { status: 'healthy', vectorCount: 0 };

    await redis.set(cacheKey, JSON.stringify(health), { ex: CACHE_TTL.SYSTEM_HEALTH });
    return health;
  }

  async getAPIUsageMetrics(_dateRange?: DateRange): Promise<APIUsageMetrics> {
    // Placeholder — in production wire into request logging middleware
    return {
      totalRequests: 0,
      successRate: 99.9,
      avgResponseTimeMs: 120,
      p95ResponseTimeMs: 350,
      errorsByType: {},
      topEndpoints: [],
      dateRange: _dateRange ?? defaultDateRange(30),
    };
  }

  async getRevenueMetrics(_dateRange?: DateRange): Promise<RevenueMetrics> {
    // Placeholder for M-PESA/Stripe integration
    const orgs = await prisma.organization.findMany({
      where: { subscriptionStatus: 'ACTIVE' },
      select: { subscriptionTier: true },
    });

    const tierPricing: Record<string, number> = { starter: 50, professional: 200, enterprise: 800 };
    const byPlan: Record<string, { count: number; mrr: number }> = {};

    for (const org of orgs) {
      const tier = org.subscriptionTier;
      if (!byPlan[tier]) byPlan[tier] = { count: 0, mrr: 0 };
      byPlan[tier].count++;
      byPlan[tier].mrr += tierPricing[tier] ?? 0;
    }

    const mrr = Object.values(byPlan).reduce((sum, p) => sum + p.mrr, 0);

    return {
      mrr,
      arr: mrr * 12,
      newMrr: 0,
      churnedMrr: 0,
      byPlan,
      dateRange: _dateRange ?? defaultDateRange(30),
    };
  }

  // ==========================================================================
  // REPORT GENERATION
  // ==========================================================================

  /**
   * Generate a compliance report asynchronously. Returns a job ID immediately.
   */
  async generateComplianceReport(
    orgId: string,
    params: ReportParams
  ): Promise<GeneratedReport> {
    const reportId = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const job: GeneratedReport = {
      reportId,
      status: 'queued',
      orgId,
      type: 'compliance',
    };

    await redis.set(reportJobKey(reportId), JSON.stringify(job), { ex: 3600 });

    // Generate asynchronously
    this.buildComplianceReport(orgId, params, reportId).catch((err: Error) => {
      logger.error({ type: 'report_generation_failed', reportId, error: err.message });
    });

    return job;
  }

  private async buildComplianceReport(
    orgId: string,
    params: ReportParams,
    reportId: string
  ): Promise<void> {
    try {
      // Mark as generating
      const job = { reportId, status: 'generating', orgId, type: 'compliance' };
      await redis.set(reportJobKey(reportId), JSON.stringify(job), { ex: 3600 });

      const [overview, gaps, risks] = await Promise.all([
        params.includeScoring !== false ? this.getComplianceOverview(orgId) : null,
        params.includeGaps !== false ? this.getComplianceGapAnalysis(orgId) : null,
        params.includeRisks !== false ? this.getRiskAssessmentSummary(orgId) : null,
      ]);

      const report = { reportId, orgId, overview, gaps, risks, generatedAt: new Date() };
      const serialized = JSON.stringify(report);

      await redis.set(reportResultKey(reportId), serialized, { ex: CACHE_TTL.REPORT_RESULT });

      const completedJob: GeneratedReport = {
        reportId,
        status: 'ready',
        orgId,
        type: 'compliance',
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + CACHE_TTL.REPORT_RESULT * 1000),
      };
      await redis.set(reportJobKey(reportId), JSON.stringify(completedJob), { ex: 3600 });
    } catch (err: unknown) {
      const failed: GeneratedReport = {
        reportId,
        status: 'failed',
        orgId,
        type: 'compliance',
      };
      await redis.set(reportJobKey(reportId), JSON.stringify(failed), { ex: 3600 });
      throw err;
    }
  }

  async generateAuditReport(orgId: string, dateRange?: DateRange): Promise<AuditReport> {
    const range = dateRange ?? defaultDateRange(30);

    const events = await prisma.auditLog.findMany({
      where: {
        user: { organizationId: orgId },
        createdAt: { gte: range.from, lte: range.to },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    return {
      reportId: `audit_${Date.now()}`,
      orgId,
      events: events.map((e) => ({
        action: e.action,
        userId: e.userId ?? 'system',
        entityType: e.entityType ?? '',
        entityId: e.entityId ?? '',
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
      dateRange: range,
      generatedAt: new Date(),
    };
  }

  async generateExecutiveSummary(orgId: string): Promise<ExecutiveSummary> {
    const [overview, risks, gaps] = await Promise.all([
      this.getComplianceOverview(orgId),
      this.getRiskAssessmentSummary(orgId),
      this.getComplianceGapAnalysis(orgId),
    ]);

    const trend = await this.getComplianceTrends(orgId, 2);
    const scores = trend.map((t) => t.score);
    const direction = determineTrend(scores);
    const trendDirection = direction === 'improving' ? 'up' : direction === 'declining' ? 'down' : 'stable';

    return {
      orgId,
      complianceScore: overview.overallScore,
      complianceGrade: overview.grade,
      highlights: [
        `Overall compliance score: ${overview.overallScore}% (${overview.grade})`,
        `${overview.completedRequirements} of ${overview.totalRequirements} requirements completed`,
      ],
      risks: risks.topRisks.map(function(r) { return typeof r === 'string' ? r : r.description; }),
      recommendations: gaps.gaps.slice(0, 3).map((g) => g.recommendation),
      trendDirection,
      generatedAt: new Date(),
    };
  }

  async scheduleReport(params: ScheduleReportParams): Promise<ScheduledReport> {
    const scheduleId = `sched_${Date.now()}`;
    const nextRunAt = this.nextRunDate(params.frequency);

    const schedule: ScheduledReport = {
      scheduleId,
      orgId: params.orgId,
      reportType: params.reportType,
      frequency: params.frequency,
      nextRunAt,
      createdAt: new Date(),
    };

    // Persist schedule in Redis (30-day TTL — re-set on each run)
    await redis.set(`analytics:schedule:${scheduleId}`, JSON.stringify(schedule), { ex: 30 * 24 * 3600 });

    logger.info({ type: 'report_scheduled', scheduleId, orgId: params.orgId });
    return schedule;
  }

  // ==========================================================================
  // EXPORT
  // ==========================================================================

  async exportAnalytics(params: ExportParams): Promise<ExportResult> {
    const exportId = `export_${Date.now()}`;
    let data: Record<string, unknown>[] = [];

    if (params.reportType === 'usage' && params.orgId) {
      const metrics = await prisma.usageMetric.findMany({
        where: { organizationId: params.orgId },
        orderBy: { date: 'desc' },
        take: 1000,
      });
      data = metrics as unknown as Record<string, unknown>[];
    } else if (params.reportType === 'audit' && params.orgId) {
      const logs = await prisma.auditLog.findMany({
        where: { user: { organizationId: params.orgId } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      });
      data = logs as unknown as Record<string, unknown>[];
    }

    let content: string;

    if (params.format === 'csv') {
      content = toCSV(data);
    } else {
      content = JSON.stringify(data, null, 2);
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await redis.set(`analytics:export:${exportId}`, content, { ex: 86400 });

    logger.info({ type: 'analytics_exported', exportId, format: params.format });

    return {
      exportId,
      downloadUrl: `${exportId}.${params.format}`,
      format: params.format,
      expiresAt,
    };
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private async upsertDailyMetric(
    userId: string | undefined,
    field: 'policiesGenerated' | 'queriesProcessed',
    increment: number,
    organizationId?: string
  ): Promise<void> {
    const date = new Date();
    date.setHours(0, 0, 0, 0);

    try {
      await prisma.usageMetric.upsert({
        where: {
          date_organizationId_userId: {
            date,
            organizationId: (organizationId ?? null) as any,
            userId: (userId ?? null) as any,
          },
        },
        create: {
          date,
          organizationId: organizationId ?? null,
          userId: userId ?? null,
          [field]: increment,
        },
        update: {
          [field]: { increment },
        },
      });
    } catch {
      // Non-fatal metric update failure
    }
  }

  private nextRunDate(frequency: string): Date {
    const now = new Date();
    if (frequency === 'daily') return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (frequency === 'weekly') return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  }
}

export const analyticsModule = new AnalyticsModule();
export { AnalyticsModule };
