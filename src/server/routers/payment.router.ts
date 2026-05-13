import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { PaymentProvider } from '@prisma/client';
import { router, orgMemberProcedure } from '../trpc/trpc';
import { paymentService } from '@/modules/billing/payment.service';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

/**
 * Payment Router
 *
 * Routes:
 *  - payment.list       -  paginated payment history for the authenticated user's org
 *  - payment.getById    -  single payment detail (org-scoped ownership check)
 *  - payment.getDetail  -  full invoice data with org + user join for the invoice modal
 */
export const paymentRouter = router({
  /**
   * List paginated payment history for the user's organization.
   *
   * orgMemberProcedure enforces an active OrganizationMember row, so a user
   * removed from the org loses access immediately (60 s cache TTL), not at
   * JWT expiry. User-scoped only — orgId always comes from ctx, never input.
   */
  list: orgMemberProcedure
    .input(
      z.object({
        page:  z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = ctx.user!;

      const result = await paymentService.getPaymentsByOrg({
        orgId: user.organizationId!,
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
   * orgId is always sourced from ctx — user cannot supply it.
   */
  getById: orgMemberProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const user = ctx.user!;

      const payment = await paymentService.getPaymentById(input.id, user.organizationId!);

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

  /**
   * Get full invoice detail for a single payment.
   *
   * Joins Payment + Organization + User for the invoice modal.
   * Org-scoped — returns 404 if payment does not belong to the authenticated
   * user's organization. orgId always sourced from ctx, never input.
   */
  getDetail: orgMemberProcedure
    .input(z.object({ paymentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = ctx.user!;

      // Fetch payment with org join
      const payment = await prisma.payment.findFirst({
        where: { id: input.paymentId, orgId: user.organizationId! },
        include: {
          org: {
            select: {
              name:         true,
              address:      true,
              contactEmail: true,
            },
          },
        },
      });

      if (!payment) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment record not found.' });
      }

      // Fetch user name separately (not in context)
      const dbUser = await prisma.user.findUnique({
        where:  { id: user.id },
        select: { fullName: true, email: true },
      });

      // Build paymentMethodDisplay string
      const meta = payment.metadata as Record<string, unknown> | null;
      let paymentMethodDisplay: string;
      if (payment.provider === PaymentProvider.MPESA) {
        const phone = (meta?.['phone_number'] as string | undefined) ?? null;
        paymentMethodDisplay = phone
          ? `M-Pesa (**** ${phone.slice(-4)})`
          : 'M-Pesa';
      } else {
        // Stripe  -  try to extract card last4 from metadata
        const last4 = (meta?.['card_last4'] as string | undefined) ?? null;
        paymentMethodDisplay = last4 ? `Card ending in ${last4}` : 'Card (Stripe)';
      }

      logger.info({
        type:      'payment_detail_fetched',
        userId:    user.id,
        orgId:     user.organizationId,
        paymentId: payment.id,
      });

      return {
        id:                    payment.id,
        invoiceNumber:         payment.invoiceNumber ?? null,
        amount:                payment.amount,
        currency:              payment.currency,
        status:                payment.status,
        provider:              payment.provider,
        subscriptionPlan:      payment.subscriptionPlan ?? null,
        billingPeriodStart:    payment.billingPeriodStart?.toISOString() ?? null,
        billingPeriodEnd:      payment.billingPeriodEnd?.toISOString() ?? null,
        providerTransactionId: payment.providerTransactionId ?? null,
        description:           payment.description ?? null,
        paidAt:                payment.paidAt?.toISOString() ?? null,
        createdAt:             payment.createdAt.toISOString(),
        metadata:              meta,
        paymentMethodDisplay,
        organization: {
          name:         payment.org.name,
          address:      payment.org.address ?? null,
          contactEmail: payment.org.contactEmail ?? null,
        },
        user: {
          email:    dbUser?.email ?? user.email,
          fullName: dbUser?.fullName ?? null,
        },
      };
    }),
});
