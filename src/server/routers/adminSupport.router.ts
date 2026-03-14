import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc/trpc';
import {
  getTicketByNumberSchema,
  adminListTicketsSchema,
  adminUpdateStatusSchema,
  adminAddResponseSchema,
} from '../schemas/support.schema';
import {
  getAdminTickets,
  getAdminTicketDetail,
  adminUpdateStatus,
  adminAddResponse,
  getTicketStats,
} from '@/services/support/supportService';
import { logger } from '@/utils/logger';

/**
 * Admin Support Router
 *
 * Admin-only ticket management: view all tickets, update statuses, respond.
 * All business logic is delegated to supportService.
 */
export const adminSupportRouter = router({
  /**
   * List all tickets with filtering, search, and pagination
   * @admin
   */
  list: adminProcedure
    .input(adminListTicketsSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await getAdminTickets(ctx.prisma, input);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'admin_support_list_error', adminId: ctx.user!.id, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve tickets' });
      }
    }),

  /**
   * Get full ticket detail including user info and all comments
   * @admin
   */
  getByTicketNumber: adminProcedure
    .input(getTicketByNumberSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await getAdminTicketDetail(ctx.prisma, input.ticketNumber);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'admin_support_get_error', adminId: ctx.user!.id, ticketNumber: input.ticketNumber, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve ticket' });
      }
    }),

  /**
   * Update ticket status and notify the user
   * @admin
   */
  updateStatus: adminProcedure
    .input(adminUpdateStatusSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await adminUpdateStatus(ctx.prisma, input.ticketId, input.status, ctx.user!.id);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'admin_update_status_error', adminId: ctx.user!.id, ticketId: input.ticketId, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update ticket status' });
      }
    }),

  /**
   * Add an admin response to a ticket, optionally updating the status
   * @admin
   */
  addResponse: adminProcedure
    .input(adminAddResponseSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await adminAddResponse(ctx.prisma, input.ticketId, ctx.user!.id, input.message, input.updateStatusTo);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'admin_add_response_error', adminId: ctx.user!.id, ticketId: input.ticketId, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to add response' });
      }
    }),

  /**
   * Get aggregate ticket stats for the admin dashboard
   * @admin
   */
  stats: adminProcedure.query(async ({ ctx }) => {
    try {
      return await getTicketStats(ctx.prisma);
    } catch (error: unknown) {
      if (error instanceof TRPCError) throw error;
      logger.error({ type: 'admin_support_stats_error', adminId: ctx.user!.id, error: (error as Error).message });
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve ticket stats' });
    }
  }),
});
