import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc/trpc';
import { paymentService } from '@/modules/billing/payment.service';
import { logger } from '@/utils/logger';

/**
 * Payment Router
 *
 * Routes:
 *  - payment.list    — paginated payment history for the authenticated user's org
 *  - payment.getById — single payment detail (org-scoped ownership check)
 */
export const paymentRouter = router({
  /**
   * List paginated payment history for the user's organization.
   *
   * @protected — requires authentication + organization membership
   */
  list: protectedProcedure
    .input(
      z.object({
        page:  z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { user } = ctx;

      if (!user.organizationId) {
        return { payments: [], total: 0, page: 1, limit: input.limit, totalPages: 0 };
      }

      const result = await paymentService.getPaymentsByOrg({
        orgId: user.organizationId,
        page:  input.page,
        limit: input.limit,
      });

      logger.info({
        type:   'payment_list_fetched',
        userId: user.id,
        orgId:  user.organizationId,
        page:   input.page,
      });

      return {
        payments: result.payments.map((p) => ({
          id:                    p.id,
          provider:              p.provider,
          providerTransactionId: p.providerTransactionId,
          amount:                p.amount,
          currency:              p.currency,
          status:                p.status,
          description:           p.description,
          paidAt:                p.paidAt?.toISOString() ?? null,
          createdAt:             p.createdAt.toISOString(),
          metadata:              p.metadata as Record<string, unknown> | null,
        })),
        total:      result.total,
        page:       result.page,
        limit:      result.limit,
        totalPages: result.totalPages,
      };
    }),

  /**
   * Get a single payment by ID, scoped to the user's organization.
   *
   * @protected — requires authentication + org ownership
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { user } = ctx;

      if (!user.organizationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'No organization found.' });
      }

      const payment = await paymentService.getPaymentById(input.id, user.organizationId);

      if (!payment) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment record not found.' });
      }

      return {
        id:                    payment.id,
        provider:              payment.provider,
        providerTransactionId: payment.providerTransactionId,
        amount:                payment.amount,
        currency:              payment.currency,
        status:                payment.status,
        description:           payment.description,
        paidAt:                payment.paidAt?.toISOString() ?? null,
        createdAt:             payment.createdAt.toISOString(),
        metadata:              payment.metadata as Record<string, unknown> | null,
      };
    }),
});
