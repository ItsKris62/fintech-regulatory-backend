import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure } from '../trpc/trpc';
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  getOrganizationSchema,
  listOrganizationsSchema,
  addMemberSchema,
  removeMemberSchema,
  getMembersSchema,
  deleteOrganizationSchema,
} from '../schemas/organization.schema';
import { logger } from '@/utils/logger';

/**
 * Organization Router
 *
 * Handles organization CRUD operations and member management.
 */
export const organizationRouter = router({
  /**
   * List organizations with pagination
   *
   * @protected
   */
  list: protectedProcedure
    .input(listOrganizationsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, type, search } = input;
        const skip = (page - 1) * limit;

        // Build where clause — Organization has no deletedAt, use as any
        const where: any = {};

        if (type) {
          where.type = type;
        }

        if (search) {
          where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { registrationNumber: { contains: search, mode: 'insensitive' } },
            { industry: { contains: search, mode: 'insensitive' } },
          ];
        }

        // If not admin, only show user's organization
        if (ctx.user.role !== 'ADMIN') {
          where.id = ctx.user.organizationId;
        }

        const [organizations, total] = await Promise.all([
          ctx.prisma.organization.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
              _count: {
                select: { users: true },
              },
            },
          }),
          ctx.prisma.organization.count({ where }),
        ]);

        return {
          organizations,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'organization_list_error',
          userId: ctx.user.id,
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
   * Get organization by ID
   *
   * @protected
   */
  get: protectedProcedure
    .input(getOrganizationSchema)
    .query(async ({ input, ctx }) => {
      try {
        const organization = await ctx.prisma.organization.findUnique({
          where: { id: input.id },
          include: {
            users: {
              select: {
                id: true,
                fullName: true,
                email: true,
                role: true,
              },
            },
          },
        });

        if (!organization || (organization as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Organization not found',
          });
        }

        // Check access
        if (ctx.user.role !== 'ADMIN' && ctx.user.organizationId !== organization.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        return organization;
      } catch (error: any) {
        logger.error({
          type: 'organization_get_error',
          userId: ctx.user.id,
          organizationId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get organization',
          cause: error,
        });
      }
    }),

  /**
   * Create organization
   *
   * @protected
   */
  create: protectedProcedure
    .input(createOrganizationSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const organization = await ctx.prisma.organization.create({
          data: input,
        });

        logger.info({
          type: 'organization_created',
          userId: ctx.user.id,
          organizationId: organization.id,
          organizationName: organization.name,
        });

        return organization;
      } catch (error: any) {
        logger.error({
          type: 'organization_create_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create organization',
          cause: error,
        });
      }
    }),

  /**
   * Update organization
   *
   * @protected
   */
  update: protectedProcedure
    .input(updateOrganizationSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;

        // Check if organization exists and user has access
        const existingOrg = await ctx.prisma.organization.findUnique({
          where: { id },
        });

        if (!existingOrg || (existingOrg as any).deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Organization not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN' && ctx.user!.organizationId !== id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const organization = await ctx.prisma.organization.update({
          where: { id },
          data: {
            ...data,
            updatedAt: new Date(),
          },
        });

        logger.info({
          type: 'organization_updated',
          userId: ctx.user!.id,
          organizationId: organization.id,
          fields: Object.keys(data),
        });

        return organization;
      } catch (error: any) {
        logger.error({
          type: 'organization_update_error',
          userId: ctx.user.id,
          organizationId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update organization',
          cause: error,
        });
      }
    }),

  /**
   * Delete organization (soft delete)
   *
   * @admin Only admins can delete organizations
   */
  delete: adminProcedure
    .input(deleteOrganizationSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await ctx.prisma.organization.update({
          where: { id: input.id },
          data: {
            deletedAt: new Date(),
          } as any,
        });

        logger.info({
          type: 'organization_deleted',
          userId: ctx.user!.id,
          organizationId: input.id,
        });

        return {
          success: true,
          message: 'Organization deleted successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'organization_delete_error',
          userId: ctx.user!.id,
          organizationId: input.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete organization',
          cause: error,
        });
      }
    }),

  /**
   * Add member to organization
   *
   * @protected
   */
  addMember: protectedProcedure
    .input(addMemberSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { organizationId, userId } = input;

        // Check access
        if (ctx.user.role !== 'ADMIN' && ctx.user.organizationId !== organizationId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        // Update user's organization
        await ctx.prisma.user.update({
          where: { id: userId },
          data: {
            organizationId,
            updatedAt: new Date(),
          },
        });

        logger.info({
          type: 'organization_member_added',
          userId: ctx.user.id,
          organizationId,
          newMemberId: userId,
        });

        return {
          success: true,
          message: 'Member added successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'organization_add_member_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to add member',
          cause: error,
        });
      }
    }),

  /**
   * Remove member from organization
   *
   * @protected
   */
  removeMember: protectedProcedure
    .input(removeMemberSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { organizationId, userId } = input;

        // Check access
        if (ctx.user.role !== 'ADMIN' && ctx.user.organizationId !== organizationId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        // Remove user from organization
        await ctx.prisma.user.update({
          where: { id: userId },
          data: {
            organizationId: null,
            updatedAt: new Date(),
          },
        });

        logger.info({
          type: 'organization_member_removed',
          userId: ctx.user.id,
          organizationId,
          removedMemberId: userId,
        });

        return {
          success: true,
          message: 'Member removed successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'organization_remove_member_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to remove member',
          cause: error,
        });
      }
    }),

  /**
   * Get organization members
   *
   * @protected
   */
  getMembers: protectedProcedure
    .input(getMembersSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { organizationId, page, limit } = input;
        const skip = (page - 1) * limit;

        // Check access
        if (ctx.user.role !== 'ADMIN' && ctx.user.organizationId !== organizationId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const [members, total] = await Promise.all([
          ctx.prisma.user.findMany({
            where: {
              organizationId,
            } as any,
            skip,
            take: limit,
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
              phone: true,
              emailVerified: true,
              createdAt: true,
              lastLoginAt: true,
            },
            orderBy: { createdAt: 'desc' },
          }),
          ctx.prisma.user.count({
            where: {
              organizationId,
            } as any,
          }),
        ]);

        return {
          members,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'organization_get_members_error',
          userId: ctx.user.id,
          organizationId: input.organizationId,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get members',
          cause: error,
        });
      }
    }),
});
