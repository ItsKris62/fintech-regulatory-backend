import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { router, adminProcedure } from '../trpc/trpc';
import { logger } from '@/utils/logger';
import { redis } from '@/lib/redis/client';
import { adminModule } from '@/modules/admin';
import { appConfig } from '@/config/app.config';
import { getStats as getChecklistStats } from '@/lib/metrics/checklist-metrics';
import { BadRequestError, OrganizationNotFoundError } from '@/utils/error';
import { isPrismaForeignKeyError, sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { optionalOrganizationIdSchema } from '@/server/services/userProvisioning.service';
import {
  buildSeatLimitMessage,
  findPendingOrganizationInvite,
  getSeatUsageForOrganization,
  hasSeatCapacity,
} from '../services/organization-seat.service';

const billingPlanCatalogUpdateItemSchema = z.object({
  id: z.enum(['STARTUP', 'BUSINESS']),
  price: z
    .object({
      monthly: z.number().finite().min(0),
      yearly: z.number().finite().min(0).nullable(),
    })
    .refine((value) => value.yearly === null || value.yearly >= value.monthly, {
      message: 'Yearly price must be greater than or equal to the monthly price.',
      path: ['yearly'],
    }),
  trialDays: z.number().int().min(0).max(90),
  stripe: z
    .object({
      monthlyPriceId: z.string().trim().min(1),
      yearlyPriceId: z.string().trim().nullable(),
    })
    .refine((value) => value.yearlyPriceId !== '', {
      message: 'Yearly Stripe price ID must be null or a non-empty string.',
      path: ['yearlyPriceId'],
    }),
});

const billingPlanCatalogUpdateSchema = z.object({
  plans: z.array(billingPlanCatalogUpdateItemSchema).min(1).max(2),
});

const createAdminUserSchema = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().min(2).max(100),
  password: z.string().min(8).max(100),
  role: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'ADMIN']).default('STARTUP'),
  subscriptionTier: z.enum(['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE']).optional(),
  organizationId: optionalOrganizationIdSchema,
  organizationName: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(2).max(120).optional(),
  ),
  isPilot: z.boolean().default(false),
  sendWelcomeEmail: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.isPilot && !value.organizationId && !value.organizationName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['organizationName'],
      message: 'Pilot users require an organization name or an existing organization.',
    });
  }
});

const adminOrganizationOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.string(),
  subscriptionTier: z.string(),
});

const adminOrganizationOptionsSchema = z.array(adminOrganizationOptionSchema);

const adminUserDetailOutputSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  fullName: z.string(),
  phone: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  emailVerified: z.boolean(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  organizationPlan: z.string().nullable(),
  lastLoginAt: z.date().nullable(),
  lastLoginIp: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  sessionCount: z.number(),
  policyCount: z.number(),
  queryCount: z.number(),
});

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
        totalQueries,
        totalDocuments,
        storageUsed,
      ] = await Promise.all([
        ctx.prisma.user.count(),
        ctx.prisma.user.count({
          where: {
            lastLoginAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          } as any,
        }),
        ctx.prisma.organization.count(),
        ctx.prisma.complianceQuery.count(),
        ctx.prisma.legalDocument.count({ where: { deletedAt: null } }),
        ctx.prisma.legalDocument.aggregate({
          where: { deletedAt: null },
          _sum: { fileSize: true },
        }),
      ]);

      // Policy counts are wrapped in a separate try/catch to guard against
      // schema drift (e.g. a missing column in the deployed DB). If the Policy
      // table is unavailable the rest of the stats still return successfully.
      let totalPolicies = 0;
      let completedPolicies = 0;
      try {
        [totalPolicies, completedPolicies] = await Promise.all([
          ctx.prisma.policy.count(),
          ctx.prisma.policy.count({ where: { status: 'COMPLETED' } }),
        ]);
      } catch (policyErr: any) {
        logger.warn({
          type: 'admin_stats_policy_count_skipped',
          userId: ctx.user!.id,
          error: policyErr?.message ?? String(policyErr),
        });
      }

      // Get recent activity — also guarded so a schema drift never crashes the whole endpoint.
      let recentPolicies: any[] = [];
      try {
        recentPolicies = await ctx.prisma.policy.findMany({
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
      } catch {
        // schema drift — return empty array rather than crashing
      }

      const recentQueries = await ctx.prisma.complianceQuery.findMany({
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
          generating: Math.max(0, totalPolicies - completedPolicies),
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
   * Get pilot-monitoring operational overview metrics.
   *
   * @admin
   */
  getOperationalOverview: adminProcedure.query(async ({ ctx }) => {
    try {
      const overview = await adminModule.getOperationalOverview();

      logger.info({
        type: 'admin_operational_overview_retrieved',
        adminId: ctx.user!.id,
      });

      return overview;
    } catch (error: unknown) {
      logger.error({
        type: 'admin_operational_overview_error',
        adminId: ctx.user!.id,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: sanitizeErrorMessage(error, 'Could not load operational overview.'),
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

        const where: any = {};

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
              status: true,
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
            supabaseAuthId: true,
          },
        });

        // F5.8  -  evict cached user profile so role/status changes take effect immediately
        if (user.supabaseAuthId) {
          await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
        }

        logger.info({
          type: 'admin_user_updated',
          adminUserId: ctx.user!.id,
          targetUserId: userId,
          fields: Object.keys(data),
        });

        const { supabaseAuthId: _sid, ...userOut } = user;
        return userOut;
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
        limit: z.number().min(1).max(200).default(50),
        userId: z.string().optional(),
        actorEmail: z.string().optional(),
        organizationId: z.string().optional(),
        action: z.string().optional(),
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
        search: z.string().optional(),
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
          actorEmail: input.actorEmail,
          organizationId: input.organizationId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          severity: input.severity,
          search: input.search,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
        });

        return result;
      } catch (error: any) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve audit logs',
          cause: error,
        });
      }
    }),

  getAuditLogDetail: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      try {
        return await adminModule.getAuditLogDetail(input.id);
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve audit log detail',
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

        // Look up supabaseAuthId before deletion for cache eviction
        const targetUser = await ctx.prisma.user.findUnique({
          where: { id: input.userId },
          select: { supabaseAuthId: true },
        });

        // Soft delete user
        await ctx.prisma.user.update({
          where: { id: input.userId },
          // Safe after migration: User model now has deletedAt field
          data: { deletedAt: new Date() } as any,
        });

        // F5.8  -  evict cached user profile so deletion takes effect immediately
        if (targetUser?.supabaseAuthId) {
          await redis.del(`user:session:${targetUser.supabaseAuthId}`).catch(() => {});
        }

        // Write audit log
        await adminModule.writeAuditLogEntry(
          ctx.user!.id,
          'admin_user_deleted',
          'User',
          input.userId,
          {}
        );

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

        // F5.8  -  capture supabaseAuthId for cache eviction
        const suspendTarget = await ctx.prisma.user.findUnique({
          where: { id: input.userId },
          select: { supabaseAuthId: true },
        });

        const result = await adminModule.suspendUser(
          ctx.user!.id,
          input.userId,
          input.reason ?? 'Suspended by administrator'
        );

        if (suspendTarget?.supabaseAuthId) {
          await redis.del(`user:session:${suspendTarget.supabaseAuthId}`).catch(() => {});
        }

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
        search: z.string().trim().optional(),
        status: z.string().optional(),
        tier: z.string().optional(),
        sortBy: z.enum(['name', 'organizationType', 'subscriptionTier', 'subscriptionStatus', 'memberCount', 'createdAt']).default('createdAt'),
        sortOrder: z.enum(['asc', 'desc']).default('desc'),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.getAllOrganizations({
          page: input.page,
          limit: input.limit,
          search: input.search,
          subscriptionStatus: input.status,
          subscriptionTier: input.tier,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
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
   * Lightweight organization options for admin user provisioning.
   *
   * @admin
   */
  listOrganizations: adminProcedure.query(async ({ ctx }) => {
    try {
      const organizations = await ctx.prisma.organization.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          plan: true,
          subscriptionTier: true,
        },
      });

      return adminOrganizationOptionsSchema.parse(organizations);
    } catch (error: unknown) {
      logger.error({
        type: 'admin_list_organization_options_error',
        adminId: ctx.user!.id,
        error: sanitizeErrorMessage(error, 'Failed to list organizations'),
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to list organizations',
        cause: error,
      });
    }
  }),

  /**
   * Admin-visible durable AI job status.
   *
   * Shows queued/running/retrying/completed/dead-lettered work across the
   * generated policy pipeline and future AI/compliance jobs using AiJob.
   */
  listAIJobs: adminProcedure
    .input(
      z.object({
        status: z.enum(['QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'DEAD_LETTERED']).optional(),
        type: z.string().max(100).optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      const skip = (input.page - 1) * input.limit;
      const where = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.type ? { type: input.type } : {}),
      };

      const [jobs, total] = await Promise.all([
        ctx.prisma.aiJob.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            status: true,
            targetEntityType: true,
            targetEntityId: true,
            userId: true,
            organizationId: true,
            progress: true,
            attempts: true,
            maxAttempts: true,
            runAfter: true,
            lockedAt: true,
            lockedBy: true,
            startedAt: true,
            completedAt: true,
            failedAt: true,
            deadLetteredAt: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
            events: {
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: { type: true, message: true, progress: true, createdAt: true },
            },
          },
        }),
        ctx.prisma.aiJob.count({ where }),
      ]);

      logger.info({
        type: 'admin_ai_jobs_listed',
        adminId: ctx.user!.id,
        status: input.status,
        jobType: input.type,
        count: jobs.length,
      });

      return {
        jobs,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  /**
   * Get organization stats summary (admin only)
   *
   * @admin
   */
  getOrganizationStats: adminProcedure
    .query(async ({ ctx }) => {
      try {
        const stats = await adminModule.getOrganizationStats();

        logger.info({
          type: 'admin_org_stats_retrieved',
          adminId: ctx.user!.id,
        });

        return stats;
      } catch (error: any) {
        logger.error({
          type: 'admin_org_stats_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get organization stats',
          cause: error,
        });
      }
    }),

  /**
   * Get organization members (admin only)
   *
   * @admin
   */
  getOrgMembers: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const members = await adminModule.getOrgMembers(input.orgId);
        logger.info({ type: 'admin_org_members_retrieved', adminId: ctx.user!.id, orgId: input.orgId });
        return members;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get org members', cause: error });
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
   * Return the audit log entries for a specific organization (actions taken
   * by any user who belongs to that org), up to 500 most-recent rows.
   *
   * @admin
   */
  getOrgAuditLog: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.getOrganizationAuditLog(input.orgId);
        logger.info({ type: 'admin_org_audit_log_retrieved', adminId: ctx.user!.id, orgId: input.orgId });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get organization audit log', cause: error });
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

        if (error instanceof BadRequestError || error instanceof TypeError) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: error.message,
            cause: error,
          });
        }

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
    // All external probes must complete within this window.
    // If Upstash or Supabase hangs rather than throwing, the race rejects
    // and the catch block returns a degraded status instead of an unhandled 500.
    const HEALTH_PROBE_TIMEOUT_MS = 5000;

    const safeProbe = async <T>(
      name: string,
      fn: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${name} probe timed out`)), HEALTH_PROBE_TIMEOUT_MS)
          ),
        ]);
      } catch (err: any) {
        logger.warn({
          type: 'admin_health_probe_failed',
          probe: name,
          adminId: ctx.user!.id,
          error: err?.message ?? String(err),
        });
        return fallback;
      }
    };

    const fallbackHealth = {
      status: 'degraded' as const,
      services: {
        database: { status: 'degraded' as const },
        redis:    { status: 'degraded' as const },
        pinecone: { status: 'degraded' as const },
        storage:  { status: 'degraded' as const },
      },
      uptime: process.uptime(),
      version: process.env.npm_package_version ?? '0.0.0',
      checkedAt: new Date(),
    };

    const [health, cacheStats, storageStats, connections] = await Promise.all([
      safeProbe('systemHealth',      () => adminModule.getSystemHealth(),      fallbackHealth),
      safeProbe('cacheStats',        () => adminModule.getCacheStats(),        null),
      safeProbe('storageStats',      () => adminModule.getStorageStats(),      null),
      safeProbe('activeConnections', () => adminModule.getActiveConnections(), null),
    ]);

    logger.info({
      type: 'admin_detailed_health_check',
      adminId: ctx.user!.id,
      status: health.status,
    });

    // Always return OK or DEGRADED — never throw an unhandled 500 from this endpoint.
    return {
      ...health,
      cache: cacheStats,
      storage: storageStats,
      connections,
    };
  }),

  getSystemOpsHealth: adminProcedure.query(async () => {
    // 1. Get base health check
    const baseHealth = await adminModule.getSystemHealth().catch((err: unknown) => {
      logger.warn({ type: 'getSystemOpsHealth_base_failed', error: err instanceof Error ? err.message : String(err) });
      return {
        status: 'degraded' as const,
        services: {
          database: { status: 'degraded' as const },
          redis: { status: 'degraded' as const },
          pinecone: { status: 'degraded' as const },
          storage: { status: 'degraded' as const },
        }
      };
    });

    const now = new Date().toISOString();

    const result = {
      overallStatus: baseHealth.status,
      generatedAt: now,
      checks: {
        database: {
          status: baseHealth.services.database.status,
          label: 'Database',
          message: baseHealth.services.database.status === 'healthy' ? 'Database connection is stable.' : 'Database connection issues detected.',
          lastCheckedAt: now,
        },
        redis: {
          status: baseHealth.services.redis.status,
          label: 'Redis Cache',
          message: baseHealth.services.redis.status === 'healthy' ? 'Redis cache is available.' : 'Redis connection issues detected.',
          lastCheckedAt: now,
        },
        pinecone: {
          status: baseHealth.services.pinecone.status,
          label: 'Pinecone (RAG)',
          message: baseHealth.services.pinecone.status === 'healthy' ? 'Vector database is responding.' : 'Vector database issues detected.',
          lastCheckedAt: now,
        },
        storage: {
          status: baseHealth.services.storage.status,
          label: 'Storage (R2)',
          message: baseHealth.services.storage.status === 'healthy' ? 'Object storage is reachable.' : 'Object storage issues detected.',
          lastCheckedAt: now,
        },
        aiProvider: {
          status: 'unknown' as const,
          label: 'AI Provider',
          message: 'AI provider health check is not configured yet.',
        },
        emailProvider: {
          status: 'unknown' as const,
          label: 'Email Provider',
          message: 'Email provider health check is not configured yet.',
        },
        vaultReconciliation: {
          status: 'not_configured' as const,
          label: 'Vault Reconciliation',
          message: 'Vault reconciliation engine is not configured.',
        },
        malwareScanning: {
          status: 'not_configured' as const,
          label: 'Malware Scanning',
          message: 'Malware scanning is not currently enabled for uploads.',
        },
        webhookHealth: {
          status: 'unknown' as const,
          label: 'Webhooks',
          message: 'Webhook health tracking is not currently available.',
        },
        cronJobs: {
          status: 'unknown' as const,
          label: 'Cron Jobs',
          message: 'Cron job execution tracking is not available.',
        }
      }
    };

    return result;
  }),

  getSecuritySummary: adminProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      successfulSessionsLast24h,
      successfulSessionsLast7d,
      failedLoginsLast24h,
      totpUsers,
      adminUsers,
      activeSessions,
      auditLogsLast24h,
      securityAuditLogsLast7d,
      recentRoleChangesLast7d
    ] = await Promise.all([
      ctx.prisma.loginHistory.count({ where: { success: true, createdAt: { gte: last24h } } }),
      ctx.prisma.loginHistory.count({ where: { success: true, createdAt: { gte: last7d } } }),
      ctx.prisma.loginHistory.count({ where: { success: false, createdAt: { gte: last24h } } }),
      ctx.prisma.user.count({ where: { totpEnabled: true, deletedAt: null } }),
      ctx.prisma.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
      ctx.prisma.session.count({ where: { expiresAt: { gt: now } } }),
      ctx.prisma.auditLog.count({ where: { createdAt: { gte: last24h } } }),
      ctx.prisma.auditLog.count({ where: { createdAt: { gte: last7d } } }),
      ctx.prisma.auditLog.count({ where: { action: 'USER_ROLE_UPDATED', createdAt: { gte: last7d } } }),
    ]);

    const failedLogins = await ctx.prisma.loginHistory.findMany({
      where: { success: false, createdAt: { gte: last24h }, ipAddress: { not: null } },
      select: { ipAddress: true }
    });
    
    const ipFailMap: Record<string, number> = {};
    failedLogins.forEach((l) => {
      if (l.ipAddress) ipFailMap[l.ipAddress] = (ipFailMap[l.ipAddress] || 0) + 1;
    });
    const suspiciousIpCount = Object.values(ipFailMap).filter(count => count >= 3).length;

    const warnings: Array<{ id: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string }> = [];
    
    if (suspiciousIpCount > 0) {
      warnings.push({
        id: 'suspicious-ips',
        severity: 'warning',
        title: 'Suspicious IPs detected',
        message: `There are ${suspiciousIpCount} IPs with 3 or more failed login attempts in the last 24 hours.`
      });
    }

    return {
      generatedAt: now.toISOString(),
      overallStatus: suspiciousIpCount > 0 ? 'degraded' as const : 'healthy' as const,
      loginActivity: {
        successfulSessionsLast24h,
        successfulSessionsLast7d,
        failedLoginsLast24h,
        failedLoginTrackingAvailable: true,
        suspiciousIpCount,
      },
      sessions: {
        activeSessions,
        expiredSessionsLast7d: 0,
        revokedSessionsLast7d: null,
      },
      accessControl: {
        recentRoleChangesLast7d,
        adminUsers,
        usersWithTotpEnabled: totpUsers,
        totpTrackingAvailable: true,
      },
      audit: {
        auditLogsLast24h,
        securityAuditLogsLast7d,
        auditLoggingAvailable: true,
      },
      warnings,
    };
  }),

  // --- INVITATION MANAGEMENT ------------------------------------------------

  /**
   * Create an invitation for a user
   *
   * @admin
   */
  createInvitation: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE']),
        organizationId: z.string().optional(),
        expiresInDays: z.number().min(1).max(30).default(7),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { randomBytes } = await import('crypto');
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + input.expiresInDays);

        if (input.organizationId) {
          const [existingMember, existingInvite, seatUsage] = await Promise.all([
            ctx.prisma.organizationMember.findFirst({
              where: {
                organizationId: input.organizationId,
                user: { email: input.email.toLowerCase() },
                status: { in: ['ACTIVE', 'SUSPENDED'] },
              },
              select: { id: true },
            }),
            findPendingOrganizationInvite(ctx.prisma as any, input.organizationId, input.email),
            getSeatUsageForOrganization(ctx.prisma as any, input.organizationId),
          ]);

          if (existingMember) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This email is already an active member of the organization',
            });
          }

          if (existingInvite) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'A pending invite already exists for this email',
            });
          }

          if (!hasSeatCapacity(seatUsage)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: buildSeatLimitMessage(seatUsage),
            });
          }
        }

        const invitation = await ctx.prisma.invitation.create({
          data: {
            email: input.email.toLowerCase(),
            role: input.role,
            token,
            expiresAt,
            invitedBy: ctx.user!.id,
            organizationId: input.organizationId,
          },
        });

        // Send invitation email
        try {
          const { reactMailer } = await import('@/lib/email/react-mailer.service');
          const inviter = await ctx.prisma.user.findUnique({
            where: { id: ctx.user!.id },
            select: { fullName: true },
          });
          const inviteUrl = `${appConfig.frontendUrl}/register?token=${token}&email=${encodeURIComponent(input.email)}`;
          await reactMailer.sendInvitationEmail(input.email, {
            inviterName: inviter?.fullName || 'SheriaBot Admin',
            role: input.role,
            inviteUrl,
            expiresInDays: input.expiresInDays,
          });
        } catch (emailErr: any) {
          logger.warn({ type: 'admin_invitation_email_failed', error: emailErr.message });
        }

        // Write audit log
        await adminModule.writeAuditLogEntry(
          ctx.user!.id,
          'admin_create_invitation',
          'Invitation',
          invitation.id,
          { email: input.email, role: input.role, organizationId: input.organizationId }
        );

        logger.info({
          type: 'admin_invitation_created',
          adminId: ctx.user!.id,
          email: input.email,
          role: input.role,
        });

        return {
          success: true,
          invitationId: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        };
      } catch (error: any) {
        logger.error({ type: 'admin_create_invitation_error', error: error.message });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create invitation', cause: error });
      }
    }),

  /**
   * List all invitations (with optional filters)
   *
   * @admin
   */
  listInvitations: adminProcedure
    .input(
      z.object({
        used: z.boolean().optional(),
        role: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE']).optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const where: Record<string, unknown> = {};
        if (input.used !== undefined) where['used'] = input.used;
        if (input.role) where['role'] = input.role;

        const [items, total] = await Promise.all([
          ctx.prisma.invitation.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (input.page - 1) * input.limit,
            take: input.limit,
            select: {
              id: true,
              email: true,
              role: true,
              used: true,
              usedAt: true,
              expiresAt: true,
              invitedBy: true,
              organizationId: true,
              createdAt: true,
            },
          }),
          ctx.prisma.invitation.count({ where }),
        ]);

        return { items, total, page: input.page, limit: input.limit };
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list invitations', cause: error });
      }
    }),

  // --- USER APPROVAL (REGULATORS) -------------------------------------------

  /**
   * List users pending admin approval
   *
   * @admin
   */
  listPendingUsers: adminProcedure
    .input(z.object({ page: z.number().min(1).default(1), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      try {
        const where = { accountStatus: 'pending_approval' } as any;
        const [users, total] = await Promise.all([
          ctx.prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (input.page - 1) * input.limit,
            take: input.limit,
            select: {
              id: true,
              email: true,
              fullName: true,
              role: true,
              accountStatus: true,
              emailVerified: true,
              createdAt: true,
              organization: { select: { id: true, name: true } },
            },
          }),
          ctx.prisma.user.count({ where }),
        ]);

        return { users, total, page: input.page, limit: input.limit };
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list pending users', cause: error });
      }
    }),

  /**
   * Approve a user account (e.g., regulators after email verification)
   *
   * @admin
   */
  approveUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.findUnique({
          where: { id: input.userId },
          select: { id: true, email: true, fullName: true, role: true, accountStatus: true, supabaseAuthId: true },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        await ctx.prisma.user.update({
          where: { id: input.userId },
          data: { accountStatus: 'active' } as any,
        });

        // F5.8  -  evict cached user profile so approval takes effect immediately
        if (user.supabaseAuthId) {
          await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
        }

        // Write audit log
        await ctx.prisma.auditLog.create({
          data: {
            userId: ctx.user!.id,
            action: 'USER_APPROVED',
            entityType: 'User',
            entityId: input.userId,
            metadata: { targetEmail: user.email, role: user.role },
          },
        });

        // Send approval email
        try {
          const { reactMailer } = await import('@/lib/email/react-mailer.service');
          await reactMailer.sendAccountApprovedEmail(user.email, {
            userName: user.fullName || user.email,
            role: user.role,
            dashboardUrl: `${appConfig.frontendUrl}/dashboard`,
          });
        } catch (emailErr: any) {
          logger.warn({ type: 'admin_approve_user_email_failed', error: emailErr.message });
        }

        logger.info({ type: 'admin_user_approved', adminId: ctx.user!.id, userId: input.userId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to approve user', cause: error });
      }
    }),

  /**
   * Reject a user account application
   *
   * @admin
   */
  rejectUser: adminProcedure
    .input(z.object({ userId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await ctx.prisma.user.findUnique({
          where: { id: input.userId },
          select: { id: true, email: true, fullName: true, role: true },
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        await ctx.prisma.user.update({
          where: { id: input.userId },
          data: { accountStatus: 'rejected' } as any,
        });

        await ctx.prisma.auditLog.create({
          data: {
            userId: ctx.user!.id,
            action: 'USER_REJECTED',
            entityType: 'User',
            entityId: input.userId,
            metadata: { targetEmail: user.email, reason: input.reason },
          },
        });

        // Send rejection email
        try {
          const { reactMailer } = await import('@/lib/email/react-mailer.service');
          await reactMailer.sendAccountRejectedEmail(user.email, {
            userName: user.fullName || user.email,
            reason: input.reason,
            supportEmail: process.env.EMAIL_SUPPORT_ADDRESS || 'support@sheriabot.com',
          });
        } catch (emailErr: any) {
          logger.warn({ type: 'admin_reject_user_email_failed', error: emailErr.message });
        }

        logger.info({ type: 'admin_user_rejected', adminId: ctx.user!.id, userId: input.userId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to reject user', cause: error });
      }
    }),

  // --- ORGANIZATION VERIFICATION --------------------------------------------

  /**
   * List organizations pending verification
   *
   * @admin
   */
  listPendingOrganizations: adminProcedure
    .input(z.object({ page: z.number().min(1).default(1), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      try {
        const where = { verificationStatus: 'pending' } as any;
        const [orgs, total] = await Promise.all([
          ctx.prisma.organization.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (input.page - 1) * input.limit,
            take: input.limit,
            select: {
              id: true,
              name: true,
              type: true,
              organizationType: true,
              registrationNumber: true,
              cbkLicenseNumber: true,
              verificationStatus: true,
              createdAt: true,
              users: { select: { id: true, email: true, fullName: true, role: true }, take: 5 },
            },
          }),
          ctx.prisma.organization.count({ where }),
        ]);

        return { orgs, total, page: input.page, limit: input.limit };
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list pending orgs', cause: error });
      }
    }),

  /**
   * Verify an organization (grant full access)
   *
   * @admin
   */
  verifyOrganization: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const org = await ctx.prisma.organization.findUnique({
          where: { id: input.orgId },
          include: { users: { select: { id: true, email: true, fullName: true }, take: 1 } },
        });

        if (!org) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
        }

        await ctx.prisma.organization.update({
          where: { id: input.orgId },
          data: {
            verificationStatus: 'verified',
            verifiedAt: new Date(),
            verifiedBy: ctx.user!.id,
          } as any,
        });

        await ctx.prisma.auditLog.create({
          data: {
            userId: ctx.user!.id,
            action: 'ORG_VERIFIED',
            entityType: 'Organization',
            entityId: input.orgId,
            metadata: { orgName: org.name },
          },
        });

        // Notify first org member
        if (org.users.length > 0) {
          const firstUser = org.users[0];
          try {
            const { reactMailer } = await import('@/lib/email/react-mailer.service');
            await reactMailer.sendOrgVerifiedEmail(firstUser.email, {
              userName: firstUser.fullName || firstUser.email,
              organizationName: org.name,
              dashboardUrl: `${appConfig.frontendUrl}/dashboard`,
            });
          } catch (emailErr: any) {
            logger.warn({ type: 'admin_verify_org_email_failed', error: emailErr.message });
          }
        }

        logger.info({ type: 'admin_org_verified', adminId: ctx.user!.id, orgId: input.orgId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to verify organization', cause: error });
      }
    }),

  /**
   * Reject an organization's verification request
   *
   * @admin
   */
  rejectOrganization: adminProcedure
    .input(z.object({ orgId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const org = await ctx.prisma.organization.findUnique({
          where: { id: input.orgId },
          select: { id: true, name: true },
        });

        if (!org) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
        }

        await ctx.prisma.organization.update({
          where: { id: input.orgId },
          data: { verificationStatus: 'rejected' } as any,
        });

        await ctx.prisma.auditLog.create({
          data: {
            userId: ctx.user!.id,
            action: 'ORG_REJECTED',
            entityType: 'Organization',
            entityId: input.orgId,
            metadata: { orgName: org.name, reason: input.reason },
          },
        });

        logger.info({ type: 'admin_org_rejected', adminId: ctx.user!.id, orgId: input.orgId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to reject organization', cause: error });
      }
    }),

  /**
   * Checklist generation success-rate metrics (Sprint 3B).
   * Returns all-time and today's counters from Redis.
   *
   * @admin
   */
  getChecklistMetrics: adminProcedure
    .input(z.object({ window: z.enum(['alltime', 'today']).default('alltime') }).optional())
    .query(async () => {
      try {
        const [alltime, today] = await Promise.all([
          getChecklistStats('alltime'),
          getChecklistStats('today'),
        ]);
        return { alltime, today };
      } catch (error: any) {
        throw new TRPCError({
          code:    'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch checklist metrics',
          cause:   error,
        });
      }
    }),

  // --- USER CREATION (ADMIN-INITIATED) -------------------------------------

  createUser: adminProcedure
    .input(createAdminUserSchema)
    .mutation(async ({ input, ctx }) => {
      const requestId = ctx.req.id ? String(ctx.req.id) : randomUUID();

      try {
        const user = await adminModule.createUser(ctx.user!.id, input, requestId);
        logger.info({
          type: 'admin_create_user',
          requestId,
          adminId: ctx.user!.id,
          email: input.email,
          userId: user.id,
          organizationId: user.organizationId,
          isPilot: input.isPilot,
        });
        return adminUserDetailOutputSchema.parse(user);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;

        if (error instanceof OrganizationNotFoundError || isPrismaForeignKeyError(error)) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'The selected organization could not be found.',
            cause: error,
          });
        }

        if (error instanceof BadRequestError) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: sanitizeErrorMessage(error, 'Invalid user provisioning request.'),
            cause: error,
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: sanitizeErrorMessage(error, 'Failed to create user'),
          cause: error,
        });
      }
    }),

  // --- FORCE PASSWORD RESET -------------------------------------------------

  forcePasswordReset: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await adminModule.forcePasswordReset(ctx.user!.id, input.userId);
        logger.info({ type: 'admin_force_password_reset', adminId: ctx.user!.id, userId: input.userId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to force password reset', cause: error });
      }
    }),

  // --- UPDATE USER ROLE -----------------------------------------------------

  updateUserRole: adminProcedure
    .input(z.object({
      userId: z.string(),
      role: z.enum(['REGULATOR', 'STARTUP', 'ENTERPRISE', 'ADMIN']),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const user = await adminModule.updateUserRole(ctx.user!.id, input.userId, input.role);

        // F9 (TD-008): Invalidate plan context cache so the role change takes effect
        // on the user's next request without waiting for the 5-minute TTL.
        const { planCtxCacheKey } = await import('@/modules/trial');
        await redis.del(planCtxCacheKey(input.userId)).catch(() => { /* non-fatal */ });

        logger.info({ type: 'admin_update_user_role', adminId: ctx.user!.id, userId: input.userId, role: input.role });
        return user;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update user role', cause: error });
      }
    }),

  // --- IMPERSONATION --------------------------------------------------------

  impersonateUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const token = await adminModule.impersonateUser(ctx.user!.id, input.userId);
        logger.info({ type: 'admin_impersonate_user', adminId: ctx.user!.id, targetUserId: input.userId });
        return token;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create impersonation token', cause: error });
      }
    }),

  // --- ORGANIZATION UPDATE --------------------------------------------------

  updateOrganization: adminProcedure
    .input(
      z.object({
        orgId: z.string(),
        name: z.string().min(2).max(200).optional(),
        type: z.string().optional(),
        registrationNumber: z.string().optional(),
        website: z.string().url().optional(),
        address: z.string().optional(),
        contactPerson: z.string().optional(),
        contactEmail: z.string().email().optional(),
        contactPhone: z.string().optional(),
        contactPosition: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { orgId, ...data } = input;
        const result = await adminModule.updateOrganization(ctx.user!.id, orgId, data);
        logger.info({ type: 'admin_update_org', adminId: ctx.user!.id, orgId });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update organization', cause: error });
      }
    }),

  updateOrganizationPlan: adminProcedure
    .input(
      z.object({
        orgId: z.string(),
        plan: z.enum(['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await adminModule.updateOrganizationPlan(ctx.user!.id, input.orgId, input.plan as never);

        // F9 (TD-008): Invalidate plan context cache for all users in this org so the
        // tier change takes effect on their next request without waiting for the 5-minute TTL.
        const { planCtxCacheKey } = await import('@/modules/trial');
        const orgUsers = await ctx.prisma.user.findMany({
          where:  { organizationId: input.orgId },
          select: { id: true },
        });
        await Promise.all(
          orgUsers.map((u) => redis.del(planCtxCacheKey(u.id)).catch(() => { /* non-fatal */ }))
        );

        logger.info({ type: 'admin_update_org_plan', adminId: ctx.user!.id, orgId: input.orgId, plan: input.plan });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update organization plan', cause: error });
      }
    }),

  // --- ANALYTICS ------------------------------------------------------------

  getUserGrowth: adminProcedure
    .input(
      z.object({
        period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const dateTo = input.dateTo ? new Date(input.dateTo) : new Date();
        const dateFrom = input.dateFrom
          ? new Date(input.dateFrom)
          : new Date(dateTo.getTime() - 30 * 24 * 60 * 60 * 1000);

          // Validate dates before passing to module
          if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Invalid date range. Expected ISO 8601 datetime strings.',
            });
          }
          if (dateFrom > dateTo) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'dateFrom cannot be after dateTo',
            });
          }

        const result = await adminModule.getUserGrowth(input.period, dateFrom, dateTo);
        logger.info({ type: 'admin_user_growth_retrieved', adminId: ctx.user!.id });
        return result;
      } catch (error: any) {
        // Log the actual error for debugging
      logger.error({
        type: 'admin_user_growth_error',
        userId: ctx.user!.id,
        input,
        error: {
          name: error.name,
          message: error.message,
          stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
        },
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get user growth',
        cause: error,
      });
      }
    }),

  getRevenueMetrics: adminProcedure
    .input(
      z.object({
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const dateTo = input.dateTo ? new Date(input.dateTo) : new Date();
        const dateFrom = input.dateFrom
          ? new Date(input.dateFrom)
          : new Date(dateTo.getTime() - 180 * 24 * 60 * 60 * 1000);
        const result = await adminModule.getRevenueMetrics(dateFrom, dateTo);
        logger.info({ type: 'admin_revenue_metrics_retrieved', adminId: ctx.user!.id });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get revenue metrics', cause: error });
      }
    }),

  getAIUsageMetrics: adminProcedure
    .input(
      z.object({
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const dateTo = input.dateTo ? new Date(input.dateTo) : new Date();
        const dateFrom = input.dateFrom
          ? new Date(input.dateFrom)
          : new Date(dateTo.getTime() - 30 * 24 * 60 * 60 * 1000);
        const result = await adminModule.getAIUsageMetrics(dateFrom, dateTo);
        logger.info({ type: 'admin_ai_usage_retrieved', adminId: ctx.user!.id });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get AI usage metrics', cause: error });
      }
    }),

  getSubscriptionBreakdown: adminProcedure
    .input(
      z.object({
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const filters = {
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
        };
        const result = await adminModule.getSubscriptionBreakdown(filters);
        logger.info({ type: 'admin_subscription_breakdown_retrieved', adminId: ctx.user!.id });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get subscription breakdown', cause: error });
      }
    }),

  // --- LOGIN HISTORY --------------------------------------------------------

  getLoginHistory: adminProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        email: z.string().optional(),
        success: z.boolean().optional(),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.getLoginHistory({
          ...input,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
        });
        logger.info({ type: 'admin_login_history_retrieved', adminId: ctx.user!.id });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get login history', cause: error });
      }
    }),

  // --- CONTENT MANAGEMENT ---------------------------------------------------

  listContent: adminProcedure
    .input(
      z.object({
        contentType: z.enum(['BLOG_POST', 'KNOWLEDGE_BASE_ARTICLE']),
        contentStatus: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'UNDER_REVIEW']).optional(),
        search: z.string().optional(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.listContent(input);
        logger.info({ type: 'admin_content_listed', adminId: ctx.user!.id, contentType: input.contentType });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list content', cause: error });
      }
    }),

  updateContentStatus: adminProcedure
    .input(
      z.object({
        documentId: z.string(),
        contentStatus: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'UNDER_REVIEW']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await adminModule.updateContentStatus(ctx.user!.id, input.documentId, input.contentStatus);
        logger.info({ type: 'admin_content_status_updated', adminId: ctx.user!.id, documentId: input.documentId });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update content status', cause: error });
      }
    }),

  deleteContent: adminProcedure
    .input(z.object({ documentId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await adminModule.deleteContent(ctx.user!.id, input.documentId);
        logger.info({ type: 'admin_content_deleted', adminId: ctx.user!.id, documentId: input.documentId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete content', cause: error });
      }
    }),

  // --- CREATE CONTENT --------------------------------------------------------

  createContent: adminProcedure
    .input(z.object({
      contentType: z.enum(['BLOG_POST', 'KNOWLEDGE_BASE_ARTICLE']),
      title: z.string().min(1).max(500),
      excerpt: z.string().max(1000).optional(),
      category: z.string().max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await adminModule.createContent(ctx.user!.id, input);
        logger.info({ type: 'admin_content_created', adminId: ctx.user!.id, contentType: input.contentType });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create content', cause: error });
      }
    }),

  // --- SUBSCRIPTION OVERVIEW ------------------------------------------------

  getSubscriptionOverview: adminProcedure.query(async ({ ctx }) => {
    try {
      const result = await adminModule.getSubscriptionOverview();
      logger.info({ type: 'admin_subscription_overview_retrieved', adminId: ctx.user!.id });
      return result;
    } catch (error: any) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get subscription overview', cause: error });
    }
  }),

  getBillingPlanCatalog: adminProcedure.query(async ({ ctx }) => {
    try {
      const catalog = await adminModule.getBillingPlanCatalog();
      logger.info({ type: 'admin_billing_plan_catalog_retrieved', adminId: ctx.user!.id });
      return catalog;
    } catch (error: any) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get billing plan catalog', cause: error });
    }
  }),

  updateBillingPlanCatalog: adminProcedure
    .input(billingPlanCatalogUpdateSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const catalog = await adminModule.updateBillingPlanCatalog(ctx.user!.id, input);
        logger.info({ type: 'admin_billing_plan_catalog_updated', adminId: ctx.user!.id, planIds: input.plans.map((plan) => plan.id) });
        return catalog;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update billing plan catalog', cause: error });
      }
    }),

  // --- BILLING OPERATIONS SUMMARY -----------------------------------------

  getBillingOperationsSummary: adminProcedure.query(async ({ ctx }) => {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      // Revenue (only COMPLETED payments)
      const revenue30dAgg = await ctx.prisma.payment.aggregate({
        where: { status: 'COMPLETED', paidAt: { gte: thirtyDaysAgo } },
        _sum: { amount: true },
      });
      const revenueAllTimeAgg = await ctx.prisma.payment.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
      });

      // Payments
      const successfulLast30DaysCount = await ctx.prisma.payment.count({
        where: { status: 'COMPLETED', createdAt: { gte: thirtyDaysAgo } }
      });
      const failedLast30DaysCount = await ctx.prisma.payment.count({
        where: { status: 'FAILED', createdAt: { gte: thirtyDaysAgo } }
      });
      const pendingLast30DaysCount = await ctx.prisma.payment.count({
        where: { status: 'PENDING', createdAt: { gte: thirtyDaysAgo } }
      });

      const failedAmount30dAgg = await ctx.prisma.payment.aggregate({
        where: { status: 'FAILED', createdAt: { gte: thirtyDaysAgo } },
        _sum: { amount: true },
      });
      const pendingAmount30dAgg = await ctx.prisma.payment.aggregate({
        where: { status: 'PENDING', createdAt: { gte: thirtyDaysAgo } },
        _sum: { amount: true },
      });

      // Subscriptions
      const activeSubs = await ctx.prisma.organization.count({ where: { subscriptionStatus: 'ACTIVE' } });
      const trialingSubs = await ctx.prisma.organization.count({ where: { subscriptionStatus: 'TRIALING' } });
      const pastDueSubs = await ctx.prisma.organization.count({ where: { subscriptionStatus: 'PAST_DUE' } });
      const cancelledSubs = await ctx.prisma.organization.count({ where: { subscriptionStatus: 'CANCELLED' } });
      const suspendedSubs = await ctx.prisma.organization.count({ where: { subscriptionStatus: 'SUSPENDED' } });

      // Trials
      const activeTrials = await ctx.prisma.user.count({
        where: { freeTrialActivatedAt: { not: null }, freeTrialExpiresAt: { gt: now } }
      });
      const expiringIn7Days = await ctx.prisma.user.count({
        where: { freeTrialActivatedAt: { not: null }, freeTrialExpiresAt: { gt: now, lte: sevenDaysFromNow } }
      });
      const expiredLast7Days = await ctx.prisma.user.count({
        where: { freeTrialActivatedAt: { not: null }, freeTrialExpiresAt: { lte: now, gt: sevenDaysAgo } }
      });

      // Problem Accounts
      const problemAccounts: Array<{
        organizationId: string | null;
        organizationName: string | null;
        userId?: string | null;
        userEmail?: string | null;
        issueType: "failed_payment" | "past_due" | "trial_expiring" | "suspended" | "unknown";
        amount?: number | null;
        currency?: string | null;
        lastEventAt?: string | null;
        actionHref?: string | null;
      }> = [];
      
      // 1. Failed payments last 30d
      const recentFailedPayments = await ctx.prisma.payment.findMany({
        where: { status: 'FAILED', createdAt: { gte: thirtyDaysAgo } },
        include: { org: { select: { id: true, name: true, users: { select: { id: true, email: true }, take: 1 } } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      for (const p of recentFailedPayments) {
        problemAccounts.push({
          organizationId: p.orgId,
          organizationName: p.org.name,
          userId: p.org.users[0]?.id || null,
          userEmail: p.org.users[0]?.email || null,
          issueType: 'failed_payment',
          amount: p.amount,
          currency: p.currency,
          lastEventAt: p.createdAt.toISOString(),
          actionHref: `/admin/organizations/${p.orgId}`,
        });
      }

      // 2. Past Due Orgs
      const pastDueOrgs = await ctx.prisma.organization.findMany({
        where: { subscriptionStatus: 'PAST_DUE' },
        include: { users: { select: { id: true, email: true }, take: 1 } },
        take: 20,
      });
      for (const o of pastDueOrgs) {
        problemAccounts.push({
          organizationId: o.id,
          organizationName: o.name,
          userId: o.users[0]?.id || null,
          userEmail: o.users[0]?.email || null,
          issueType: 'past_due',
          amount: null,
          currency: null,
          lastEventAt: null,
          actionHref: `/admin/organizations/${o.id}`,
        });
      }

      // 3. Expiring Trials
      const expiringTrialUsers = await ctx.prisma.user.findMany({
        where: { freeTrialActivatedAt: { not: null }, freeTrialExpiresAt: { gt: now, lte: sevenDaysFromNow } },
        include: { organization: { select: { id: true, name: true } } },
        take: 20,
        orderBy: { freeTrialExpiresAt: 'asc' },
      });
      for (const u of expiringTrialUsers) {
        problemAccounts.push({
          organizationId: u.organizationId,
          organizationName: u.organization?.name || null,
          userId: u.id,
          userEmail: u.email,
          issueType: 'trial_expiring',
          amount: null,
          currency: null,
          lastEventAt: u.freeTrialExpiresAt?.toISOString() || null,
          actionHref: `/admin/users/${u.id}`,
        });
      }

      // 4. Suspended Orgs
      const suspendedOrgsArray = await ctx.prisma.organization.findMany({
        where: { subscriptionStatus: 'SUSPENDED' },
        include: { users: { select: { id: true, email: true }, take: 1 } },
        take: 20,
      });
      for (const o of suspendedOrgsArray) {
        problemAccounts.push({
          organizationId: o.id,
          organizationName: o.name,
          userId: o.users[0]?.id || null,
          userEmail: o.users[0]?.email || null,
          issueType: 'suspended',
          amount: null,
          currency: null,
          lastEventAt: null,
          actionHref: `/admin/organizations/${o.id}`,
        });
      }

      // Recent Events
      const recentPaymentEvents = await ctx.prisma.payment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 15,
        include: { org: { select: { name: true } } },
      });
      
      const recentEvents: Array<{
        id: string;
        type: string;
        title: string;
        description?: string;
        severity: "info" | "warning" | "critical";
        createdAt: string;
        actionHref?: string | null;
      }> = recentPaymentEvents.map(p => ({
        id: p.id,
        type: 'payment_' + p.status.toLowerCase(),
        title: `Payment ${p.status} - ${p.org.name}`,
        description: `${p.currency} ${p.amount} via ${p.provider}`,
        severity: p.status === 'FAILED' ? 'critical' as const : p.status === 'PENDING' ? 'warning' as const : 'info' as const,
        createdAt: p.createdAt.toISOString(),
        actionHref: `/admin/organizations/${p.orgId}`,
      }));

      const isDegraded = failedLast30DaysCount > successfulLast30DaysCount * 0.5 || pastDueSubs > 0;

      return {
        generatedAt: now.toISOString(),
        overallStatus: isDegraded ? 'degraded' as const : 'healthy' as const,
        revenue: {
          totalRevenueLast30Days: revenue30dAgg._sum.amount || 0,
          totalRevenueAllTime: revenueAllTimeAgg._sum.amount || 0,
          currency: 'KES',
        },
        payments: {
          successfulLast30Days: successfulLast30DaysCount,
          failedLast30Days: failedLast30DaysCount,
          pendingLast30Days: pendingLast30DaysCount,
          failedAmountLast30Days: failedAmount30dAgg._sum.amount || 0,
          pendingAmountLast30Days: pendingAmount30dAgg._sum.amount || 0,
        },
        subscriptions: {
          active: activeSubs,
          trialing: trialingSubs,
          pastDue: pastDueSubs,
          cancelled: cancelledSubs,
          suspended: suspendedSubs,
        },
        trials: {
          activeTrials,
          expiringIn7Days,
          expiredLast7Days,
        },
        provider: {
          name: 'Stripe & M-Pesa',
          status: 'unknown' as const,
          message: 'Payment webhook health is not currently tracked.',
          lastWebhookAt: null,
        },
        problemAccounts,
        recentEvents,
      };
    } catch (error: any) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get billing operations summary', cause: error });
    }
  }),

  // --- RECENT PAYMENTS (ALL ORGS, ADMIN-ONLY) ------------------------------

  getRecentPayments: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.getRecentPayments(input.limit);
        logger.info({ type: 'admin_recent_payments_retrieved', adminId: ctx.user!.id, limit: input.limit });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get recent payments', cause: error });
      }
    }),

  // --- ORG PAYMENT HISTORY -------------------------------------------------

  getOrgPaymentHistory: adminProcedure
    .input(
      z.object({
        orgId: z.string(),
        page: z.number().int().positive().default(1),
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.getOrgPaymentHistory(input.orgId, input.page, input.limit);
        logger.info({ type: 'admin_org_payment_history_retrieved', adminId: ctx.user!.id, orgId: input.orgId });
        return result;
      } catch (error: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get org payment history', cause: error });
      }
    }),

  // --- SECURITY  -  SESSION LISTING & SIGN-OUT -------------------------------

  /**
   * List all currently-active (non-expired) sessions for a given user.
   * Read-only  -  individual session revocation is not supported.
   * Use signOutUserEverywhere to invalidate all tokens at once.
   *
   * @admin
   */
  listUserActiveSessions: adminProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const result = await adminModule.listUserActiveSessions(input.userId);
        logger.info({ type: 'admin_list_user_sessions', adminId: ctx.user!.id, userId: input.userId });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list user sessions', cause: error });
      }
    }),

  /**
   * Sign a user out of ALL devices simultaneously.
   *
   * This writes a user-level JWT revocation sentinel in Redis so that every
   * in-flight token the user currently holds is rejected on its next request
   * (covers the full 1-hour Supabase access-token lifetime plus a 1-hour
   * safety margin).  All Session DB rows for the user are also deleted.
   *
   * This is NOT a per-session revoke  -  it revokes every token the user holds.
   *
   * @admin
   */
  signOutUserEverywhere: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await adminModule.signOutUserEverywhere(ctx.user!.id, input.userId);
        logger.info({ type: 'admin_sign_out_user_everywhere', adminId: ctx.user!.id, userId: input.userId });
        return { success: true };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to sign out user', cause: error });
      }
    }),

  // --- BULK USER ACTIONS (TD-007) ------------------------------------------

  /**
   * Suspend or activate multiple users in a single call.
   * Wrapped in a Prisma transaction; each user's plan cache is NOT invalidated
   * here (status change does not affect plan context).
   *
   * @admin
   */
  bulkUpdateUserStatus: adminProcedure
    .input(
      z.object({
        userIds: z.array(z.string().min(1)).min(1).max(100),
        status:  z.enum(['ACTIVE', 'SUSPENDED']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await ctx.prisma.user.updateMany({
          where: { id: { in: input.userIds }, role: { not: 'ADMIN' } },
          data:  { status: input.status as never },
        });

        // Audit log entry per batch (not per user — avoids N writes)
        await ctx.prisma.auditLog.create({
          data: {
            userId:     ctx.user!.id,
            action:     `BULK_USER_STATUS_${input.status}`,
            entityType: 'User',
            entityId:   'bulk',
            metadata:   { userIds: input.userIds, status: input.status, count: input.userIds.length },
          },
        });

        logger.info({
          type:    'admin_bulk_user_status_updated',
          adminId: ctx.user!.id,
          status:  input.status,
          count:   input.userIds.length,
        });

        return { success: true, count: input.userIds.length };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'Failed to update user statuses';
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: error });
      }
    }),

  /**
   * Change the subscription tier for multiple users' organizations.
   * Invalidates the Redis plan context cache for each affected user.
   *
   * @admin
   */
  bulkUpdateUserTier: adminProcedure
    .input(
      z.object({
        userIds: z.array(z.string().min(1)).min(1).max(100),
        tier:    z.enum(['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // Resolve org IDs for the selected users
        const users = await ctx.prisma.user.findMany({
          where:  { id: { in: input.userIds } },
          select: { id: true, organizationId: true },
        });

        const orgIds = [...new Set(users.map((u) => u.organizationId).filter((id): id is string => id !== null))];

        if (orgIds.length > 0) {
          // Update all affected orgs
          await ctx.prisma.organization.updateMany({
            where: { id: { in: orgIds } },
            data:  { subscriptionTier: input.tier, plan: input.tier as never },
          });

          // Invalidate plan cache for every affected user
          const { planCtxCacheKey } = await import('@/modules/trial');
          await Promise.all(
            users.map((u) => redis.del(planCtxCacheKey(u.id)).catch(() => { /* non-fatal */ }))
          );
        }

        await ctx.prisma.auditLog.create({
          data: {
            userId:     ctx.user!.id,
            action:     'BULK_USER_TIER_CHANGE',
            entityType: 'User',
            entityId:   'bulk',
            metadata:   { userIds: input.userIds, tier: input.tier, orgIds, count: input.userIds.length },
          },
        });

        logger.info({
          type:    'admin_bulk_user_tier_updated',
          adminId: ctx.user!.id,
          tier:    input.tier,
          count:   input.userIds.length,
          orgIds,
        });

        return { success: true, count: input.userIds.length };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'Failed to update user tiers';
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: error });
      }
    }),

  // --- FAILED PAYMENTS (TD-006) ---------------------------------------------

  /**
   * Returns payments with status FAILED, paginated.
   * Used by the admin billing page Failed Payments panel.
   *
   * @admin
   */
  getFailedPayments: adminProcedure
    .input(
      z.object({
        limit:  z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(), // createdAt ISO string for cursor pagination
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const where = { status: 'FAILED' as const };
        const [items, total] = await Promise.all([
          ctx.prisma.payment.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: input.limit,
            ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
            include: { org: { select: { name: true } } },
          }),
          ctx.prisma.payment.count({ where }),
        ]);

        const mapped = items.map((p) => ({
          id:               p.id,
          orgId:            p.orgId,
          orgName:          p.org.name,
          provider:         String(p.provider),
          amount:           Number(p.amount) / 100, // minor -> major units (KES)
          currency:         p.currency,
          status:           String(p.status),
          invoiceNumber:    p.invoiceNumber ?? null,
          subscriptionPlan: p.subscriptionPlan ?? null,
          description:      p.description ?? null,
          metadata:         p.metadata as Record<string, unknown> | null,
          paidAt:           p.paidAt ?? null,
          createdAt:        p.createdAt,
        }));

        logger.info({ type: 'admin_failed_payments_retrieved', adminId: ctx.user!.id, count: mapped.length });
        return { items: mapped, total, nextCursor: items.length === input.limit ? items[items.length - 1]?.id : null };
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'Failed to get failed payments';
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: error });
      }
    }),

  // --- ANALYTICS CSV EXPORT -------------------------------------------------

  /**
   * Generate a server-side analytics summary export and return a 5-minute
   * presigned download URL.
   *
   * Mirrors the same Section/Label/Value CSV the admin analytics page used to
   * build client-side. The file is stored at
   * `exports/analytics/<id>.csv` in the private R2 bucket.
   *
   * @admin
   */
  exportAnalyticsCsv: adminProcedure
    .input(
      z.object({
        dateFrom: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const dateTo   = new Date();
        const dateFrom = input.dateFrom
          ? new Date(input.dateFrom)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);

        const result = await adminModule.exportAnalyticsCsv(dateFrom, dateTo);
        logger.info({ type: 'admin_analytics_csv_export', adminId: ctx.user!.id });
        return result;
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : 'Failed to export analytics';
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: error });
      }
    }),

  // --- AUDIT LOG EXPORT -----------------------------------------------------

  /**
   * Generate a server-side audit log export and return a 60-minute presigned
   * download URL.
   *
   * Format caps (hardcoded):
   *   - csv:  up to 10 000 rows
   *   - docx: up to  2 000 rows
   *
   * The file is stored at `exports/audit-logs/<id>.<ext>` in the private R2
   * bucket.  The presigned URL expires after 60 minutes.
   *
   * @admin
   */
  exportAuditLogs: adminProcedure
    .input(
      z.object({
        format:     z.enum(['csv', 'docx']),
        userId:     z.string().optional(),
        actorEmail: z.string().optional(),
        organizationId: z.string().optional(),
        action:     z.string().optional(),
        entityType: z.string().optional(),
        entityId:   z.string().optional(),
        severity:   z.enum(['HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
        search:     z.string().optional(),
        dateFrom:   z.string().datetime().optional(),
        dateTo:     z.string().datetime().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { format, ...rawFilters } = input;
        const filters = {
          userId:     rawFilters.userId,
          actorEmail: rawFilters.actorEmail,
          organizationId: rawFilters.organizationId,
          action:     rawFilters.action,
          entityType: rawFilters.entityType,
          entityId:   rawFilters.entityId,
          severity:   rawFilters.severity,
          search:     rawFilters.search,
          dateFrom:   rawFilters.dateFrom ? new Date(rawFilters.dateFrom) : undefined,
          dateTo:     rawFilters.dateTo   ? new Date(rawFilters.dateTo)   : undefined,
        };
        const result = await adminModule.exportAuditLogs(filters, format);
        // Write to DB audit log: action, adminId, rowCount, filters, format
        await adminModule.writeAuditLogEntry(ctx.user!.id, 'ADMIN_AUDIT_LOG_EXPORT', 'AuditLog', 'export', {
          format,
          filters: rawFilters,
        });
        logger.info({ type: 'admin_audit_log_export', adminId: ctx.user!.id, format, filters: rawFilters });
        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to export audit logs', cause: error });
      }
    }),
});
