import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, orgMemberProcedure } from '../trpc/trpc';
import { withPlanContext } from '../trpc/middleware';
import { createAlertStreamToken } from '@/lib/alerts/stream-token';
import { alertService } from '@/modules/alert';
import {
  createAlertSchema,
  getAlertsSchema,
  upsertSubscriptionSchema,
  markAsReadSchema,
} from '@/modules/alert';

export const alertRouter = router({
  // ---------------------------------------------------------------------------
  // createStreamToken -- short-lived credential for EventSource
  // ---------------------------------------------------------------------------

  createStreamToken: protectedProcedure
    .mutation(async ({ ctx }) => {
      return createAlertStreamToken(ctx.user!.id);
    }),

  // ---------------------------------------------------------------------------
  // create -- draft only; ADMIN or REGULATOR
  // ---------------------------------------------------------------------------

  create: protectedProcedure
    .input(createAlertSchema)
    .mutation(async ({ input, ctx }) => {
      if (!['ADMIN', 'REGULATOR'].includes(ctx.user!.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return alertService.createAlert(input, ctx.user!.id);
    }),

  // ---------------------------------------------------------------------------
  // publish -- activates draft + fans out notifications; ADMIN or REGULATOR
  // ---------------------------------------------------------------------------

  publish: protectedProcedure
    .input(z.object({ alertId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (!['ADMIN', 'REGULATOR'].includes(ctx.user!.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      await alertService.publishAlert(input.alertId, ctx.user!.id);
    }),

  // ---------------------------------------------------------------------------
  // getAlerts -- paginated list, plan-scoped history window
  // ---------------------------------------------------------------------------

  getAlerts: orgMemberProcedure
    .use(withPlanContext)
    .input(getAlertsSchema)
    .query(async ({ input, ctx }) => {
      return alertService.getAlerts(
        ctx.user!.id,
        ctx.orgMembership!.organizationId,
        ctx.plan,
        input,
      );
    }),

  // ---------------------------------------------------------------------------
  // getById -- single alert, auto-marks in-app notification as read
  // ---------------------------------------------------------------------------

  getById: protectedProcedure
    .input(z.object({ alertId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      return alertService.getAlertById(input.alertId, ctx.user!.id);
    }),

  // ---------------------------------------------------------------------------
  // getUnreadCount -- Redis-cached 30s
  // ---------------------------------------------------------------------------

  getUnreadCount: protectedProcedure
    .query(async ({ ctx }) => {
      const count = await alertService.getUnreadCount(ctx.user!.id);
      return { count };
    }),

  // ---------------------------------------------------------------------------
  // markAsRead -- single in-app notification
  // ---------------------------------------------------------------------------

  markAsRead: protectedProcedure
    .input(markAsReadSchema)
    .mutation(async ({ input, ctx }) => {
      await alertService.markAsRead(input.notificationId, ctx.user!.id);
    }),

  // ---------------------------------------------------------------------------
  // markAllAsRead
  // ---------------------------------------------------------------------------

  markAllAsRead: orgMemberProcedure
    .mutation(async ({ ctx }) => {
      await alertService.markAllAsRead(
        ctx.user!.id,
        ctx.orgMembership!.organizationId,
      );
    }),

  // ---------------------------------------------------------------------------
  // upsertSubscription -- per-org alert preferences
  // ---------------------------------------------------------------------------

  upsertSubscription: orgMemberProcedure
    .input(upsertSubscriptionSchema)
    .mutation(async ({ input, ctx }) => {
      return alertService.upsertSubscription(
        ctx.orgMembership!.organizationId,
        input,
      );
    }),

  // ---------------------------------------------------------------------------
  // getSubscription -- returns null if no org context or no subscription
  // ---------------------------------------------------------------------------

  getSubscription: orgMemberProcedure
    .query(async ({ ctx }) => {
      return alertService.getSubscription(ctx.orgMembership!.organizationId);
    }),

  // ---------------------------------------------------------------------------
  // getAdminAlerts -- all alerts including drafts; ADMIN only
  // ---------------------------------------------------------------------------

  getAdminAlerts: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      if (ctx.user!.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return alertService.getAdminAlerts(input);
    }),
});
