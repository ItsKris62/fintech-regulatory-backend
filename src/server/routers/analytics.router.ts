import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure, orgMemberProcedure } from '../trpc/trpc';
import { withPlanContext, requirePlanFeature } from '../trpc/middleware';
import {
  getOrgDashboardSchema,
  getComplianceTrendsSchema,
  generateReportSchema,
  exportAnalyticsSchema,
  getUserGrowthSchema,
} from '../schemas/analytics.schema';
import { analyticsModule } from '@/modules/analytics';
import { logger } from '@/utils/logger';

/**
 * Analytics Router
 *
 * Powers dashboards and data export for all user roles.
 * User-level and org-level analytics for protected procedures.
 * Platform-wide analytics for admins only.
 *
 * Business logic delegated to AnalyticsModule.
 */
export const analyticsRouter = router({
  /**
   * Get activity summary for the current user
   *
   * @protected
   */
  getUserSummary: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .input(getUserGrowthSchema)
    .query(async ({ input, ctx }) => {
      try {
        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const summary = await analyticsModule.getUserActivitySummary(
          ctx.user!.id,
          dateRange
        );

        logger.info({
          type: 'analytics_user_summary',
          userId: ctx.user!.id,
        });

        return summary;
      } catch (error: any) {
        logger.error({
          type: 'analytics_user_summary_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get user activity summary',
          cause: error,
        });
      }
    }),

  /**
   * Get organization dashboard analytics
   *
   * @protected  -  uses caller's org if orgId not supplied
   */
  getOrgDashboard: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .input(getOrgDashboardSchema)
    .query(async ({ input, ctx }) => {
      try {
        const memberOrgId = ctx.orgMembership!.organizationId;
        const orgId = input.orgId ?? memberOrgId;

        // Non-admins can only access their own org
        if (orgId !== memberOrgId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const dashboard = await analyticsModule.getOrganizationDashboard(orgId, dateRange);

        logger.info({
          type: 'analytics_org_dashboard',
          userId: ctx.user!.id,
          orgId,
        });

        return dashboard;
      } catch (error: any) {
        logger.error({
          type: 'analytics_org_dashboard_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get organization dashboard',
          cause: error,
        });
      }
    }),

  /**
   * Get compliance score for the user's organization
   *
   * @protected
   */
  getOrgComplianceScore: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .query(async ({ ctx }) => {
    try {
      const orgId = ctx.orgMembership!.organizationId;

      const score = await analyticsModule.getOrganizationComplianceScore(orgId);
      return score;
    } catch (error: any) {
      logger.error({
        type: 'analytics_org_compliance_score_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get compliance score',
        cause: error,
      });
    }
  }),

  /**
   * Get compliance trend data over time
   *
   * @protected
   */
  getComplianceTrends: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .input(getComplianceTrendsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const memberOrgId = ctx.orgMembership!.organizationId;
        const orgId = input.orgId ?? memberOrgId;

        if (orgId !== memberOrgId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const trends = await analyticsModule.getComplianceTrends(orgId, input.periods);

        logger.info({
          type: 'analytics_compliance_trends',
          userId: ctx.user!.id,
          orgId,
          periods: input.periods,
        });

        return trends;
      } catch (error: any) {
        logger.error({
          type: 'analytics_compliance_trends_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get compliance trends',
          cause: error,
        });
      }
    }),

  /**
   * Get compliance gap analysis for the organization
   *
   * @protected
   */
  getGapAnalysis: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .query(async ({ ctx }) => {
    try {
      const orgId = ctx.orgMembership!.organizationId;

      const gapAnalysis = await analyticsModule.getComplianceGapAnalysis(
        orgId
      );

      logger.info({
        type: 'analytics_gap_analysis',
        userId: ctx.user!.id,
        orgId,
      });

      return gapAnalysis;
    } catch (error: any) {
      logger.error({
        type: 'analytics_gap_analysis_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get gap analysis',
        cause: error,
      });
    }
  }),

  /**
   * Get deadline alerts for the user's organization
   *
   * @protected
   */
  getDeadlineAlerts: orgMemberProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.orgMembership!.organizationId;

      const alerts = await analyticsModule.getDeadlineAlerts(orgId);
      return alerts;
    } catch (error: any) {
      logger.error({
        type: 'analytics_deadline_alerts_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get deadline alerts',
        cause: error,
      });
    }
  }),

  /**
   * Get document usage statistics for the organization
   *
   * @protected
   */
  getDocumentStats: orgMemberProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.orgMembership!.organizationId;

      const stats = await analyticsModule.getOrganizationDocumentStats(orgId);
      return stats;
    } catch (error: any) {
      logger.error({
        type: 'analytics_doc_stats_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get document statistics',
        cause: error,
      });
    }
  }),

  /**
   * Generate a compliance report
   *
   * @protected
   */
  generateReport: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .input(generateReportSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const memberOrgId = ctx.orgMembership!.organizationId;
        const orgId = input.orgId ?? memberOrgId;

        if (orgId !== memberOrgId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const report = await analyticsModule.generateComplianceReport(
          orgId,
          {
            dateRange,
          }
        );

        logger.info({
          type: 'analytics_report_generated',
          userId: ctx.user!.id,
          orgId,
          reportType: input.reportType,
        });

        return report;
      } catch (error: any) {
        logger.error({
          type: 'analytics_generate_report_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate report',
          cause: error,
        });
      }
    }),

  /**
   * Export analytics data as CSV or JSON
   *
   * @protected
   */
  exportData: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('analytics'))
    .input(exportAnalyticsSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const memberOrgId = ctx.orgMembership!.organizationId;
        const orgId = input.orgId ?? memberOrgId;

        if (orgId !== memberOrgId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const result = await analyticsModule.exportAnalytics({
          orgId,
          format: input.format,
          reportType: input.type as any,
          dateRange,
        });

        logger.info({
          type: 'analytics_data_exported',
          userId: ctx.user!.id,
          format: input.format,
          dataType: input.type,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'analytics_export_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to export analytics data',
          cause: error,
        });
      }
    }),

  // -- Admin-only endpoints ---------------------------------------------------

  /**
   * Get platform-wide overview (admin only)
   *
   * @admin
   */
  getPlatformOverview: adminProcedure
    .input(getUserGrowthSchema)
    .query(async ({ input, ctx }) => {
      try {
        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const overview = await analyticsModule.getPlatformOverview(dateRange);

        logger.info({
          type: 'analytics_platform_overview',
          adminId: ctx.user!.id,
        });

        return overview;
      } catch (error: any) {
        logger.error({
          type: 'analytics_platform_overview_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get platform overview',
          cause: error,
        });
      }
    }),

  /**
   * Get user growth metrics (admin only)
   *
   * @admin
   */
  getUserGrowth: adminProcedure
    .input(getUserGrowthSchema)
    .query(async ({ input, ctx }) => {
      try {
        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const metrics = await analyticsModule.getUserGrowthMetrics(dateRange);

        logger.info({
          type: 'analytics_user_growth',
          adminId: ctx.user!.id,
        });

        return metrics;
      } catch (error: any) {
        logger.error({
          type: 'analytics_user_growth_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get user growth metrics',
          cause: error,
        });
      }
    }),

  /**
   * Get organization growth metrics (admin only)
   *
   * @admin
   */
  getOrgGrowth: adminProcedure
    .input(getUserGrowthSchema)
    .query(async ({ input, ctx }) => {
      try {
        const dateRange = input.dateRange?.from
          ? { from: new Date(input.dateRange.from), to: new Date(input.dateRange.to ?? Date.now()) }
          : undefined;

        const metrics = await analyticsModule.getOrganizationGrowthMetrics(dateRange);

        logger.info({
          type: 'analytics_org_growth',
          adminId: ctx.user!.id,
        });

        return metrics;
      } catch (error: any) {
        logger.error({
          type: 'analytics_org_growth_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get organization growth metrics',
          cause: error,
        });
      }
    }),
});
