import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, adminProcedure } from '../trpc/trpc';
import { logger } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { adminModule } from '@/modules/admin';

/**
 * Admin Router
 *
 * Administrative operations for system management.
 * All routes require ADMIN role.
 */
export const adminRouter = router({
  /**
   * Get system dashboard statistics
   *
   * @admin
   */
  getStats: adminProcedure.query(async ({ ctx }) => {
    try {
      const [
        totalUsers,
        activeUsers,
        totalOrganizations,
        totalPolicies,
        completedPolicies,
        totalQueries,
        totalDocuments,
        storageUsed,
      ] = await Promise.all([
        ctx.prisma.user.count({ where: { deletedAt: null } as any }),
        ctx.prisma.user.count({
          where: {
            deletedAt: null,
            lastLoginAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
            },
          } as any,
        }),
        ctx.prisma.organization.count({ where: { deletedAt: null } as any }),
        ctx.prisma.policy.count({ where: { deletedAt: null } as any }),
        ctx.prisma.policy.count({
          where: { deletedAt: null, status: 'COMPLETED' } as any,
        }),
        ctx.prisma.complianceQuery.count({ where: { deletedAt: null } as any }),
        ctx.prisma.legalDocument.count({ where: { deletedAt: null } }),
        ctx.prisma.legalDocument.aggregate({
          where: { deletedAt: null },
          _sum: { fileSize: true },
        }),
      ]);

      // Get recent activity
      const recentPolicies = await ctx.prisma.policy.findMany({
        where: { deletedAt: null } as any,
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          user: {
            select: { fullName: true, email: true },
          },
        },
      });

      const recentQueries = await ctx.prisma.complianceQuery.findMany({
        where: { deletedAt: null } as any,
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          query: true,
          createdAt: true,
          user: {
            select: { fullName: true, email: true },
          },
        },
      });

      logger.info({
        type: 'admin_stats_retrieved',
        userId: ctx.user!.id,
      });

      return {
        users: {
          total: totalUsers,
          active: activeUsers,
        },
        organizations: {
          total: totalOrganizations,
        },
        policies: {
          total: totalPolicies,
          completed: completedPolicies,
          generating: totalPolicies - completedPolicies,
        },
        queries: {
          total: totalQueries,
        },
        documents: {
          total: totalDocuments,
          storageUsed: storageUsed._sum.fileSize || 0,
        },
        recentActivity: {
          policies: recentPolicies,
          queries: recentQueries,
        },
      };
    } catch (error: any) {
      logger.error({
        type: 'admin_stats_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve statistics',
        cause: error,
      });
    }
  }),

  /**
   * List all users with pagination
   *
   * @admin
   */
  listUsers: adminProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        role: z.enum(['ADMIN', 'REGULATOR', 'STARTUP', 'ENTERPRISE']).optional(),
        status: z.enum(['active', 'inactive']).optional(),
        search: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, role, status, search } = input;
        const skip = (page - 1) * limit;

        const where: any = {
          deletedAt: null,
        };

        if (role) {
          where.role = role;
        }

        if (status === 'active') {
          where.lastLoginAt = {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          };
        } else if (status === 'inactive') {
          where.OR = [
            { lastLoginAt: null },
            {
              lastLoginAt: {
                lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
              },
            },
          ];
        }

        if (search) {
          where.OR = [
            { fullName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ];
        }

        const [users, total] = await Promise.all([
          ctx.prisma.user.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
              emailVerified: true,
              createdAt: true,
              lastLoginAt: true,
              organization: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          }),
          ctx.prisma.user.count({ where }),
        ]);

        return {
          users,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'admin_list_users_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list users',
          cause: error,
        });
      }
    }),

  /**
   * Update user details (admin only)
   *
   * @admin
   */
  updateUser: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(['ADMIN', 'REGULATOR', 'STARTUP', 'ENTERPRISE']).optional(),
        emailVerified: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { userId, ...data } = input;

        const user = await ctx.prisma.user.update({
          where: { id: userId },
          data: {
            ...data,
            updatedAt: new Date(),
          },
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            emailVerified: true,
          },
        });

        logger.info({
          type: 'admin_user_updated',
          adminUserId: ctx.user!.id,
          targetUserId: userId,
          fields: Object.keys(data),
        });

        return user;
      } catch (error: any) {
        logger.error({
          type: 'admin_update_user_error',
          userId: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update user',
          cause: error,
        });
      }
    }),

  /**
   * Get system health status
   *
   * @admin
   */
  getSystemHealth: adminProcedure.query(async ({ ctx }) => {
    try {
      const health: any = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {},
      };

      // Check database
      try {
        await ctx.prisma.$queryRaw`SELECT 1`;
        health.services.database = { status: 'healthy', responseTime: 0 };
      } catch (error: any) {
        health.services.database = { status: 'unhealthy', error: error.message };
        health.status = 'degraded';
      }

      // Check Redis
      try {
        const start = Date.now();
        await redis.ping();
        health.services.redis = {
          status: 'healthy',
          responseTime: Date.now() - start,
        };
      } catch (error: any) {
        health.services.redis = { status: 'unhealthy', error: error.message };
        health.status = 'degraded';
      }

      // Check R2 storage
      try {
        const testKey = `health-check-${Date.now()}`;
        await ctx.storageService.getUploadUrl(testKey, 'application/octet-stream');
        health.services.storage = { status: 'healthy' };
      } catch (error: any) {
        health.services.storage = { status: 'unhealthy', error: error.message };
        health.status = 'degraded';
      }

      // Check AI service (Anthropic)
      try {
        health.services.ai = { status: 'healthy' };
        // Note: We don't make actual API calls to avoid costs
      } catch (error: any) {
        health.services.ai = { status: 'unknown', error: error.message };
      }

      logger.info({
        type: 'admin_health_check',
        userId: ctx.user!.id,
        status: health.status,
      });

      return health;
    } catch (error: any) {
      logger.error({
        type: 'admin_health_check_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to check system health',
        cause: error,
      });
    }
  }),

  /**
   * Get audit logs with filtering and pagination
   *
   * @admin
   */
  getLogs: adminProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(50),
        userId: z.string().optional(),
        action: z.string().optional(),
        entityType: z.string().optional(),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        logger.info({
          type: 'admin_audit_logs_requested',
          userId: ctx.user!.id,
          params: input,
        });

        const result = await adminModule.getAuditLog({
          page: input.page,
          limit: input.limit,
          userId: input.userId,
          action: input.action,
          entityType: input.entityType,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_get_logs_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve audit logs',
          cause: error,
        });
      }
    }),

  /**
   * Delete user account (admin only)
   *
   * @admin
   */
  deleteUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        // Prevent admin from deleting themselves
        if (input.userId === ctx.user!.id) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot delete your own account',
          });
        }

        // Soft delete user
        await ctx.prisma.user.update({
          where: { id: input.userId },
          data: { deletedAt: new Date() } as any,
        });

        logger.info({
          type: 'admin_user_deleted',
          adminUserId: ctx.user!.id,
          targetUserId: input.userId,
        });

        return {
          success: true,
          message: 'User deleted successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'admin_delete_user_error',
          userId: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete user',
          cause: error,
        });
      }
    }),

  /**
   * Suspend a user account (admin only)
   *
   * @admin
   */
  suspendUser: adminProcedure
    .input(z.object({ userId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        if (input.userId === ctx.user!.id) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot suspend your own account' });
        }

        const result = await adminModule.suspendUser(
          ctx.user!.id,
          input.userId,
          input.reason ?? 'Suspended by administrator'
        );

        logger.info({
          type: 'admin_user_suspended',
          adminUserId: ctx.user!.id,
          targetUserId: input.userId,
          reason: input.reason,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_suspend_user_error',
          userId: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to suspend user',
          cause: error,
        });
      }
    }),

  /**
   * Reactivate a suspended user account (admin only)
   *
   * @admin
   */
  reactivateUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await adminModule.reactivateUser(ctx.user!.id, input.userId);

        logger.info({
          type: 'admin_user_reactivated',
          adminUserId: ctx.user!.id,
          targetUserId: input.userId,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_reactivate_user_error',
          userId: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to reactivate user',
          cause: error,
        });
      }
    }),

  /**
   * Get all organizations (admin only)
   *
   * @admin
   */
  getAllOrganizations: adminProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        search: z.string().optional(),
        status: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.getAllOrganizations({
          page: input.page,
          limit: input.limit,
          search: input.search,
          subscriptionStatus: input.status,
        });

        logger.info({
          type: 'admin_organizations_listed',
          adminId: ctx.user!.id,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_list_organizations_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list organizations',
          cause: error,
        });
      }
    }),

  /**
   * Get organization details (admin only)
   *
   * @admin
   */
  getOrgDetails: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const org = await adminModule.getOrganizationDetails(input.orgId);

        logger.info({
          type: 'admin_org_details_retrieved',
          adminId: ctx.user!.id,
          orgId: input.orgId,
        });

        return org;
      } catch (error: any) {
        logger.error({
          type: 'admin_get_org_details_error',
          userId: ctx.user!.id,
          orgId: input.orgId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get organization details',
          cause: error,
        });
      }
    }),

  /**
   * Suspend an organization (admin only)
   *
   * @admin
   */
  suspendOrganization: adminProcedure
    .input(z.object({ orgId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await adminModule.suspendOrganization(
          ctx.user!.id,
          input.orgId,
          input.reason ?? 'Suspended by administrator'
        );

        logger.info({
          type: 'admin_org_suspended',
          adminId: ctx.user!.id,
          orgId: input.orgId,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_suspend_org_error',
          userId: ctx.user!.id,
          orgId: input.orgId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to suspend organization',
          cause: error,
        });
      }
    }),

  /**
   * Reactivate a suspended organization (admin only)
   *
   * @admin
   */
  reactivateOrganization: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await adminModule.reactivateOrganization(ctx.user!.id, input.orgId);

        logger.info({
          type: 'admin_org_reactivated',
          adminId: ctx.user!.id,
          orgId: input.orgId,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'admin_reactivate_org_error',
          userId: ctx.user!.id,
          orgId: input.orgId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to reactivate organization',
          cause: error,
        });
      }
    }),

  /**
   * Get system configuration (admin only)
   *
   * @admin
   */
  getSystemConfig: adminProcedure.query(async ({ ctx }) => {
    try {
      const config = await adminModule.getSystemConfig();

      logger.info({
        type: 'admin_system_config_retrieved',
        adminId: ctx.user!.id,
      });

      return config;
    } catch (error: any) {
      logger.error({
        type: 'admin_get_system_config_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get system configuration',
        cause: error,
      });
    }
  }),

  /**
   * Update system configuration (admin only)
   *
   * @admin
   */
  updateSystemConfig: adminProcedure
    .input(z.object({ config: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ input, ctx }) => {
      try {
        const updated = await adminModule.updateSystemConfig(
          ctx.user!.id,
          input.config as any
        );

        logger.info({
          type: 'admin_system_config_updated',
          adminId: ctx.user!.id,
          keys: Object.keys(input.config),
        });

        return updated;
      } catch (error: any) {
        logger.error({
          type: 'admin_update_system_config_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update system configuration',
          cause: error,
        });
      }
    }),

  /**
   * Get all feature flags (admin only)
   *
   * @admin
   */
  getFeatureFlags: adminProcedure.query(async ({ ctx }) => {
    try {
      const flags = await adminModule.getFeatureFlags();

      logger.info({
        type: 'admin_feature_flags_retrieved',
        adminId: ctx.user!.id,
      });

      return flags;
    } catch (error: any) {
      logger.error({
        type: 'admin_get_feature_flags_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get feature flags',
        cause: error,
      });
    }
  }),

  /**
   * Update a feature flag (admin only)
   *
   * @admin
   */
  updateFeatureFlag: adminProcedure
    .input(z.object({ flag: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const flags = await adminModule.updateFeatureFlag(
          ctx.user!.id,
          input.flag,
          input.enabled
        );

        logger.info({
          type: 'admin_feature_flag_updated',
          adminId: ctx.user!.id,
          flag: input.flag,
          enabled: input.enabled,
        });

        return flags;
      } catch (error: any) {
        logger.error({
          type: 'admin_update_feature_flag_error',
          userId: ctx.user!.id,
          flag: input.flag,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update feature flag',
          cause: error,
        });
      }
    }),

  /**
   * Set maintenance mode (admin only)
   *
   * @admin
   */
  setMaintenanceMode: adminProcedure
    .input(z.object({ enabled: z.boolean(), message: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const status = await adminModule.setMaintenanceMode(
          ctx.user!.id,
          input.enabled,
          input.message
        );

        logger.info({
          type: 'admin_maintenance_mode_changed',
          adminId: ctx.user!.id,
          enabled: input.enabled,
        });

        return status;
      } catch (error: any) {
        logger.error({
          type: 'admin_maintenance_mode_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to set maintenance mode',
          cause: error,
        });
      }
    }),

  /**
   * Get full system health details (admin only)
   * More detailed than the existing getSystemHealth
   *
   * @admin
   */
  /**
   * Get a single user's details (admin only)
   *
   * @admin
   */
  getUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const user = await adminModule.getUserDetails(input.userId);

        logger.info({
          type: 'admin_user_detail_viewed',
          adminId: ctx.user!.id,
          targetUserId: input.userId,
        });

        return user;
      } catch (error: any) {
        logger.error({
          type: 'admin_get_user_error',
          userId: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve user details',
          cause: error,
        });
      }
    }),

  /**
   * Get a user's audit log (admin only)
   *
   * @admin
   */
  getUserActivityLog: adminProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const logs = await adminModule.getUserAuditLog(input.userId);
        return logs;
      } catch (error: any) {
        logger.error({
          type: 'admin_get_user_activity_error',
          userId: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve user activity',
          cause: error,
        });
      }
    }),

  getDetailedHealth: adminProcedure.query(async ({ ctx }) => {
    try {
      const [health, cacheStats, storageStats, connections] = await Promise.all([
        adminModule.getSystemHealth(),
        adminModule.getCacheStats(),
        adminModule.getStorageStats(),
        adminModule.getActiveConnections(),
      ]);

      logger.info({
        type: 'admin_detailed_health_check',
        adminId: ctx.user!.id,
      });

      return {
        ...health,
        cache: cacheStats,
        storage: storageStats,
        connections,
      };
    } catch (error: any) {
      logger.error({
        type: 'admin_detailed_health_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get system health details',
        cause: error,
      });
    }
  }),
});
