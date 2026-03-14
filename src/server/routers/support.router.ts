import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc/trpc';
import {
  createTicketSchema,
  listTicketsSchema,
  getTicketByNumberSchema,
  addCommentSchema,
} from '../schemas/support.schema';
import {
  createTicket,
  getUserTickets,
  getTicketDetail,
  addUserComment,
} from '@/services/support/supportService';
import { logger } from '@/utils/logger';

/**
 * Support Router (User-facing)
 *
 * Handles ticket creation, listing, viewing, and commenting for authenticated users.
 * All business logic is delegated to supportService.
 */
export const supportRouter = router({
  /**
   * Submit a new support ticket
   * @protected
   */
  create: protectedProcedure
    .input(createTicketSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const ticket = await createTicket(ctx.prisma, ctx.user!.id, input);
        return ticket;
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'support_create_error', userId: ctx.user!.id, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create support ticket' });
      }
    }),

  /**
   * List tickets for the current user with optional status filter and pagination
   * @protected
   */
  list: protectedProcedure
    .input(listTicketsSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await getUserTickets(ctx.prisma, ctx.user!.id, input);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'support_list_error', userId: ctx.user!.id, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve tickets' });
      }
    }),

  /**
   * Get full ticket detail including comments (only the owner can view)
   * @protected
   */
  getByTicketNumber: protectedProcedure
    .input(getTicketByNumberSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await getTicketDetail(ctx.prisma, input.ticketNumber, ctx.user!.id);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'support_get_error', userId: ctx.user!.id, ticketNumber: input.ticketNumber, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to retrieve ticket' });
      }
    }),

  /**
   * Add a comment to a ticket (user reply)
   * @protected
   */
  addComment: protectedProcedure
    .input(addCommentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await addUserComment(ctx.prisma, input.ticketId, ctx.user!.id, input.message);
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'support_add_comment_error', userId: ctx.user!.id, ticketId: input.ticketId, error: (error as Error).message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to add comment' });
      }
    }),
});
