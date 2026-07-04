import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { MemberRole, MemberStatus, SubscriptionPlan } from '@prisma/client';
import { router, protectedProcedure, adminProcedure } from '../trpc/trpc';
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  updateOrganizationSettingsSchema,
  getOrganizationSchema,
  listOrganizationsSchema,
  addMemberSchema,
  removeMemberSchema,
  getMembersSchema,
  deleteOrganizationSchema,
} from '../schemas/organization.schema';
import { userCache } from '@/lib/redis/cache.service';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import {
  buildSeatLimitMessage,
  getSeatUsageForOrganization,
  hasSeatCapacity,
} from '../services/organization-seat.service';
import { assertCanCreateOrJoinOrganization } from '../services/organization-plan-limit.service';
import type { Context } from '../trpc/context';

async function assertActiveOrganizationMember(
  ctx: Pick<Context, 'prisma' | 'user'> & { user: NonNullable<Context['user']> },
  organizationId: string,
) {
  if (ctx.user.role === 'ADMIN') return;

  const member = await ctx.prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId: ctx.user.id, organizationId } },
    select: { status: true },
  });

  if (!member || member.status !== MemberStatus.ACTIVE) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Access denied to this organization',
    });
  }
}

async function assertOrganizationManager(
  ctx: Pick<Context, 'prisma' | 'user'> & { user: NonNullable<Context['user']> },
  organizationId: string,
) {
  if (ctx.user.role === 'ADMIN') return null;

  const member = await ctx.prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId: ctx.user.id, organizationId } },
    select: { status: true, role: true },
  });

  if (
    !member ||
    member.status !== MemberStatus.ACTIVE ||
    (member.role !== MemberRole.OWNER && member.role !== MemberRole.ADMIN)
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only organization owners and admins can manage members',
    });
  }

  return member;
}

async function assertOrganizationCanUseTeamSeats(ctx: Context, organizationId: string) {
  const organization = await ctx.prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, plan: true, deletedAt: true } as any,
  });

  if (!organization || (organization as any).deletedAt) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this organization' });
  }

  const entitlements = PLAN_ENTITLEMENTS[(organization as any).plan as SubscriptionPlan];
  if (!entitlements?.teamCollaboration && ctx.user!.role !== 'ADMIN') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Team member management requires the Business plan or higher.',
    });
  }
}

async function assertCanConsumeSeat(ctx: Context, organizationId: string) {
  const usage = await getSeatUsageForOrganization(ctx.prisma as any, organizationId);
  if (!hasSeatCapacity(usage)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: buildSeatLimitMessage(usage),
    });
  }
  return usage;
}

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

        // Build where clause  -  Organization has no deletedAt, use as any
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

        // If not admin, only show user's active organization membership
        if (ctx.user.role !== 'ADMIN') {
          if (!ctx.user.organizationId) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this organization',
            });
          }
          await assertActiveOrganizationMember(ctx, ctx.user.organizationId);
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
   * Security: non-admin callers must hold an ACTIVE OrganizationMember row
   * for the requested org. Failures always return FORBIDDEN (never NOT_FOUND)
   * to prevent callers from using the error code as an org-existence oracle.
   *
   * @protected
   */
  get: protectedProcedure
    .input(getOrganizationSchema)
    .query(async ({ input, ctx }) => {
      try {
        if (ctx.user.role === 'ADMIN') {
          // Admins see everything -- retain NOT_FOUND for their UX
          const organization = await ctx.prisma.organization.findUnique({
            where: { id: input.id },
            include: {
              users: { select: { id: true, fullName: true, email: true, role: true } },
            },
          });

          if (!organization || (organization as any).deletedAt) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
          }

          return organization;
        }

        // Non-admin: verify active OrganizationMember row BEFORE fetching org details.
        // Always FORBIDDEN on failure to prevent org-existence oracle.
        const member = await ctx.prisma.organizationMember.findUnique({
          where: { userId_organizationId: { userId: ctx.user.id, organizationId: input.id } },
          select: { status: true },
        });

        if (!member || member.status !== MemberStatus.ACTIVE) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this organization',
          });
        }

        const organization = await ctx.prisma.organization.findUnique({
          where: { id: input.id },
          include: {
            users: { select: { id: true, fullName: true, email: true, role: true } },
          },
        });

        // If the org was deleted between our membership check and this query,
        // return FORBIDDEN (not NOT_FOUND) to avoid the existence oracle.
        if (!organization || (organization as any).deletedAt) {
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
        await assertCanCreateOrJoinOrganization({
          prisma: ctx.prisma as any,
          userId: ctx.user.id,
          actorContext: {
            actorUserId: ctx.user.id,
            actorRole: ctx.user.role,
            sourceProcedure: 'organization.create',
            platformAdminOverride: ctx.user.role === 'ADMIN',
          },
        });

        const organization = await ctx.prisma.$transaction(async (tx) => {
          const org = await tx.organization.create({
            data: input,
          });

          if (ctx.user.role !== 'ADMIN') {
            await tx.organizationMember.upsert({
              where: { userId_organizationId: { userId: ctx.user.id, organizationId: org.id } },
              create: {
                userId: ctx.user.id,
                organizationId: org.id,
                role: MemberRole.OWNER,
                status: MemberStatus.ACTIVE,
              },
              update: {
                role: MemberRole.OWNER,
                status: MemberStatus.ACTIVE,
              },
            });

            if (!ctx.user.organizationId) {
              await tx.user.update({
                where: { id: ctx.user.id },
                data: { organizationId: org.id, updatedAt: new Date() },
              });
            }
          }

          return org;
        });

        if (ctx.user.role !== 'ADMIN') {
          await redis.del(`sheriabot:orgmem:${ctx.user.id}:${organization.id}`).catch(() => {});
          await userCache.delete(ctx.user.id).catch(() => {});
        }

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

        await assertActiveOrganizationMember(ctx, id);

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
   * Writes OrganizationMember as the authoritative source of truth for
   * membership checks (requireOrgMembership reads from this table).
   * Invalidates the Redis membership cache so the change is visible immediately.
   *
   * @protected
   */
  addMember: protectedProcedure
    .input(addMemberSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { organizationId, userId, role } = input;

        await assertOrganizationManager(ctx, organizationId);
        await assertOrganizationCanUseTeamSeats(ctx, organizationId);
        await assertCanCreateOrJoinOrganization({
          prisma: ctx.prisma as any,
          userId,
          targetOrganizationId: organizationId,
          actorContext: {
            actorUserId: ctx.user.id,
            actorRole: ctx.user.role,
            sourceProcedure: 'organization.addMember',
            platformAdminOverride: ctx.user.role === 'ADMIN',
          },
        });

        const existingActiveMember = await ctx.prisma.organizationMember.findUnique({
          where: { userId_organizationId: { userId, organizationId } },
          select: { status: true },
        });

        if (
          existingActiveMember?.status === MemberStatus.ACTIVE ||
          existingActiveMember?.status === MemberStatus.SUSPENDED
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This user is already a member of the organization',
          });
        }

        await assertCanConsumeSeat(ctx, organizationId);

        // Update user's organization foreign key
        await ctx.prisma.user.update({
          where: { id: userId },
          data: { organizationId, updatedAt: new Date() },
        });

        // Upsert OrganizationMember row (source of truth for membership checks)
        await ctx.prisma.organizationMember.upsert({
          where: { userId_organizationId: { userId, organizationId } },
          create: {
            userId,
            organizationId,
            role: role as MemberRole,
            status: MemberStatus.ACTIVE,
          },
          update: {
            role:   role as MemberRole,
            status: MemberStatus.ACTIVE,
          },
        });

        // Invalidate cached membership so requireOrgMembership sees the new row
        await redis.del(`sheriabot:orgmem:${userId}:${organizationId}`).catch(() => {});

        logger.info({
          type:          'organization_member_added',
          userId:        ctx.user.id,
          organizationId,
          newMemberId:   userId,
          role,
        });

        return { success: true, message: 'Member added successfully' };
      } catch (error: any) {
        logger.error({
          type:  'organization_add_member_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

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
   * Updates OrganizationMember.status to REMOVED (source of truth for
   * membership checks) and invalidates the Redis membership cache so the
   * change is visible to requireOrgMembership on the next request.
   *
   * @protected
   */
  removeMember: protectedProcedure
    .input(removeMemberSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { organizationId, userId } = input;

        await assertOrganizationManager(ctx, organizationId);

        if (ctx.user.role !== 'ADMIN' && userId === ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Organization admins cannot remove themselves',
          });
        }

        // Clear user's organization foreign key
        await ctx.prisma.user.update({
          where: { id: userId },
          data: { organizationId: null, updatedAt: new Date() },
        });

        // Update OrganizationMember status to REMOVED (source of truth)
        await ctx.prisma.organizationMember.updateMany({
          where:  { userId, organizationId },
          data:   { status: MemberStatus.REMOVED },
        });

        // Invalidate cached membership so requireOrgMembership blocks access immediately
        await redis.del(`sheriabot:orgmem:${userId}:${organizationId}`).catch(() => {});

        logger.info({
          type:            'organization_member_removed',
          userId:          ctx.user.id,
          organizationId,
          removedMemberId: userId,
        });

        return { success: true, message: 'Member removed successfully' };
      } catch (error: any) {
        logger.error({
          type:  'organization_remove_member_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

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

        await assertActiveOrganizationMember(ctx, organizationId);

        const [membersResult, total] = await Promise.all([
          ctx.prisma.organizationMember.findMany({
            where: {
              organizationId,
            },
            skip,
            take: limit,
            select: {
              role: true,
              createdAt: true,
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  role: true,
                  phone: true,
                  emailVerified: true,
                  createdAt: true,
                  lastLoginAt: true,
                }
              }
            },
            orderBy: { createdAt: 'desc' },
          }),
          ctx.prisma.organizationMember.count({
            where: {
              organizationId,
            },
          }),
        ]);

        const members = membersResult.map((m) => ({
          ...m.user,
          role: m.role, // KEEP LEGACY: Prevents breaking current frontend RBAC.
          platformRole: m.user.role, // NEW: Explicit Platform Role.
          orgRole: m.role, // NEW: Explicit Organization Role.
          joinedAt: m.createdAt,
        }));

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

  /**
   * Update a member's role within the organization
   *
   * Platform admins or org OWNER/ADMIN can change a user's organization role.
   * Updates OrganizationMember.role, not the platform-level User.role.
   *
   * @protected  -  must be ADMIN, or a member of the same organization
   */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        organizationId: z.string().optional(),
        role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const callerOrgId = input.organizationId ?? ctx.user!.organizationId;

        if (!callerOrgId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You are not a member of any organization',
          });
        }

        await assertOrganizationManager(ctx, callerOrgId);

        // Fetch target user
        const targetMember = await ctx.prisma.organizationMember.findUnique({
          where: { userId_organizationId: { userId: input.userId, organizationId: callerOrgId } },
          select: {
            id: true,
            role: true,
            status: true,
            organizationId: true,
            user: {
              select: {
                id: true,
                email: true,
                fullName: true,
                supabaseAuthId: true,
              },
            },
          },
        });

        if (!targetMember || targetMember.status !== MemberStatus.ACTIVE) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Organization member not found',
          });
        }

        if (targetMember.role === MemberRole.OWNER) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Owner role changes require ownership transfer',
          });
        }

        const updatedMember = await ctx.prisma.organizationMember.update({
          where: { userId_organizationId: { userId: input.userId, organizationId: callerOrgId } },
          data: { role: input.role as MemberRole },
          select: {
            id: true,
            userId: true,
            organizationId: true,
            role: true,
            status: true,
            user: { select: { email: true, fullName: true } },
          },
        });

        await redis.del(`sheriabot:orgmem:${input.userId}:${callerOrgId}`).catch(() => {});

        logger.info({
          type: 'org_member_role_updated',
          updatedBy: ctx.user!.id,
          targetUserId: input.userId,
          previousRole: targetMember.role,
          newRole: input.role,
          orgId: callerOrgId,
          platformAdminOverride: ctx.user.role === 'ADMIN',
        });

        return {
          success: true,
          member: updatedMember,
          message: `${updatedMember.user.fullName || updatedMember.user.email}'s organization role updated to ${input.role}`,
        };
      } catch (error: any) {
        logger.error({
          type: 'org_member_role_update_error',
          updatedBy: ctx.user!.id,
          targetUserId: input.userId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update member role',
          cause: error,
        });
      }
    }),

  // --- SETTINGS PAGE PROCEDURES ---------------------------------------------

  /**
   * Get the current user's organization settings fields
   *
   * @protected  -  resolves org from active OrganizationMember
   */
  getSettings: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
    try {
      const { organizationId } = ctx.user;

      if (!organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You are not a member of any organization',
        });
      }
      await assertActiveOrganizationMember(ctx, organizationId);

      const organization = await ctx.prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          name: true,
          registrationNumber: true,
          industry: true,
          website: true,
          address: true,
          contactPerson: true,
          contactPosition: true,
          contactEmail: true,
          contactPhone: true,
        },
      });

      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      return organization;
    } catch (error: any) {
      logger.error({
        type: 'organization_get_settings_error',
        userId: ctx.user.id,
        organizationId: ctx.user.organizationId,
        error: error.message,
      });

      if (error instanceof TRPCError) throw error;

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch organization settings',
        cause: error,
      });
    }
  }),

  getSeatUsage: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const { organizationId } = ctx.user;

      if (!organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You are not a member of any organization',
        });
      }

      const member = await ctx.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId: ctx.user.id, organizationId } },
        select: { status: true, role: true },
      });

      if (!member || member.status !== MemberStatus.ACTIVE) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Access denied to this organization',
        });
      }

      const usage = await getSeatUsageForOrganization(ctx.prisma as any, organizationId);
      return {
        ...usage,
        canManageMembers:
          ctx.user.role === 'ADMIN' ||
          member.role === MemberRole.OWNER ||
          member.role === MemberRole.ADMIN,
      };
    }),

  /**
   * Update the current user's organization settings
   *
   * @protected  -  REGULATOR role is blocked (read-only)
   */
  updateSettings: protectedProcedure
    .input(updateOrganizationSettingsSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const { organizationId } = ctx.user;

        if (!organizationId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You are not a member of any organization',
          });
        }
        await assertActiveOrganizationMember(ctx, organizationId);

        if (ctx.user.role === 'REGULATOR') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Regulators cannot modify organization settings',
          });
        }

        const organization = await ctx.prisma.organization.update({
          where: { id: organizationId },
          data: {
            ...input,
            updatedAt: new Date(),
          },
          select: {
            id: true,
            name: true,
            registrationNumber: true,
            industry: true,
            website: true,
            address: true,
            contactPerson: true,
            contactPosition: true,
            contactEmail: true,
            contactPhone: true,
          },
        });

        // Invalidate the current user's profile cache so org name changes surface immediately
        await userCache.delete(ctx.user.id);

        logger.info({
          type: 'organization_settings_updated',
          userId: ctx.user.id,
          organizationId,
          updatedFields: Object.keys(input),
        });

        return organization;
      } catch (error: any) {
        logger.error({
          type: 'organization_update_settings_error',
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update organization settings',
          cause: error,
        });
      }
    }),
});
