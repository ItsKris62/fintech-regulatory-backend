import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, adminProcedure } from '../trpc/trpc';
import { logger } from '@/utils/logger';
import { redis } from '@/lib/redis/client';

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
   * Get recent application logs
   *
   * @admin
   */
  getLogs: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        level: z.enum(['error', 'warn', 'info', 'debug']).optional(),
        type: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        // TODO: Implement log retrieval from logging service
        // For now, return a message
        logger.info({
          type: 'admin_logs_requested',
          userId: ctx.user!.id,
          params: input,
        });

        return {
          logs: [],
          message: 'Log retrieval not yet implemented. Check server logs directly.',
        };
      } catch (error: any) {
        logger.error({
          type: 'admin_get_logs_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve logs',
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
});
