import { TRPCError } from '@trpc/server';
import { MemberRole } from '@prisma/client';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc/trpc';
import { requireOrgMember, requireMemberRole } from '../trpc/middleware';
import { complianceModule } from '@/modules/compliance';
import { logger } from '@/utils/logger';

export const complianceDashboardRouter = router({
  /**
   * Get full compliance dashboard data for the user's organization.
   * Auto-seeds default checklist items on first access.
   * Requires: authenticated + active OrganizationMember (any role).
   */
  getComplianceDashboard: protectedProcedure
    .use(requireOrgMember)
    .input(z.void())
    .query(async ({ ctx }) => {
    try {
      // orgId is guaranteed non-null by requireOrgMember middleware
      const orgId = ctx.user!.organizationId!;
      const data = await complianceModule.getComplianceDashboardData(orgId);

      logger.info({
        type: 'compliance_dashboard.retrieved',
        userId: ctx.user!.id,
        orgId,
        overallScore: data.overallScore,
        trendLabel: data.trend.label,
      });

      return data;
    } catch (error: unknown) {
      if (error instanceof TRPCError) throw error;
      const msg = error instanceof Error ? error.message : 'Failed to load compliance dashboard';
      logger.error({ type: 'compliance_dashboard.error', userId: ctx.user!.id, error: msg });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to load compliance dashboard', cause: error });
    }
  }),

  /**
   * Mark a compliance dashboard item as completed or incomplete.
   * Operates on the ComplianceItem model (the seeded startup dashboard checklist).
   * Requires: authenticated + active OrganizationMember with at least MEMBER role
   * (VIEWER cannot mutate).
   */
  updateDashboardItem: protectedProcedure
    .use(requireOrgMember)
    .use(requireMemberRole([MemberRole.MEMBER, MemberRole.ADMIN, MemberRole.OWNER]))
    .input(
      z.object({
        itemId: z.string().min(1),
        isCompleted: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'User has no organization' });
        }

        const result = await complianceModule.updateChecklistItem(
          ctx.user!.id,
          orgId,
          input.itemId,
          input.isCompleted
        );

        logger.info({
          type: 'compliance_item_updated',
          userId: ctx.user!.id,
          orgId,
          itemId: input.itemId,
          isCompleted: input.isCompleted,
        });

        return result;
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        const msg = error instanceof Error ? error.message : 'Failed to update compliance item';
        if (msg === 'Compliance item not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        logger.error({ type: 'compliance_item_update_error', userId: ctx.user!.id, error: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update compliance item', cause: error });
      }
    }),

  /**
   * Get all checklist items for a specific compliance category.
   * Requires: authenticated + active OrganizationMember (any role).
   */
  getChecklistByCategory: protectedProcedure
    .use(requireOrgMember)
    .input(
      z.object({
        category: z.enum([
          'DATA_PROTECTION',
          'AML_KYC',
          'CONSUMER_PROTECTION',
          'CBK_LICENSING',
          'CYBERSECURITY',
        ]),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;
        if (!orgId) return [];

        const items = await complianceModule.getChecklistByCategory(
          ctx.user!.id,
          orgId,
          input.category as import('@prisma/client').ComplianceCategory
        );

        logger.info({
          type: 'compliance_checklist_by_category_retrieved',
          userId: ctx.user!.id,
          orgId,
          category: input.category,
          count: items.length,
        });

        return items;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to get checklist items';
        logger.error({ type: 'compliance_checklist_by_category_error', userId: ctx.user!.id, error: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get checklist items', cause: error });
      }
    }),
});
