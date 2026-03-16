/**
 * Payment Service
 *
 * Handles creation and retrieval of Payment records. Designed to be
 * called from:
 *   1. Stripe webhook handlers (after successful/failed payments)
 *   2. tRPC payment router (for paginated history reads)
 *
 * All writes are idempotent — duplicate providerTransactionId entries
 * are silently ignored (upsert semantics via `createOrUpdate` guard).
 */

import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

export interface CreatePaymentInput {
  orgId:                 string;
  subscriptionId?:       string;
  provider:              PaymentProvider;
  providerTransactionId?: string;
  amount:                number;        // smallest currency unit
  currency?:             string;        // defaults to KES
  status:                PaymentStatus;
  description?:          string;
  paidAt?:               Date;
  metadata?:             Record<string, unknown>;
}

export interface GetPaymentsInput {
  orgId:  string;
  page:   number;    // 1-indexed
  limit:  number;    // max 50
}

// ── Payment service ─────────────────────────────────────────────────────────

class PaymentService {
  /**
   * Create a new payment record.
   *
   * Idempotent: if a record with the same `providerTransactionId` already
   * exists for this org, the existing record is returned without creating
   * a duplicate.
   */
  async createPaymentRecord(input: CreatePaymentInput) {
    // Idempotency guard — skip if this transaction was already recorded
    if (input.providerTransactionId) {
      const existing = await prisma.payment.findFirst({
        where: {
          orgId:                 input.orgId,
          providerTransactionId: input.providerTransactionId,
        },
      });
      if (existing) {
        logger.debug({
          type:                  'payment_record_already_exists',
          orgId:                 input.orgId,
          providerTransactionId: input.providerTransactionId,
        });
        return existing;
      }
    }

    const payment = await prisma.payment.create({
      data: {
        orgId:                 input.orgId,
        subscriptionId:        input.subscriptionId,
        provider:              input.provider,
        providerTransactionId: input.providerTransactionId,
        amount:                input.amount,
        currency:              input.currency ?? 'KES',
        status:                input.status,
        description:           input.description,
        paidAt:                input.paidAt,
        metadata:              input.metadata ?? {},
      },
    });

    logger.info({
      type:      'payment_record_created',
      paymentId: payment.id,
      orgId:     input.orgId,
      provider:  input.provider,
      status:    input.status,
      amount:    input.amount,
    });

    return payment;
  }

  /**
   * Retrieve paginated payment history for an organization.
   * Returns records newest-first.
   */
  async getPaymentsByOrg(input: GetPaymentsInput) {
    const limit = Math.min(input.limit, 50);
    const skip  = (input.page - 1) * limit;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where:   { orgId: input.orgId },
        orderBy: { createdAt: 'desc' },
        skip,
        take:    limit,
      }),
      prisma.payment.count({ where: { orgId: input.orgId } }),
    ]);

    return {
      payments,
      total,
      page:       input.page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieve a single payment by ID, restricted to a specific org.
   * Returns null if not found or if the payment belongs to a different org.
   */
  async getPaymentById(paymentId: string, orgId: string) {
    return prisma.payment.findFirst({
      where: { id: paymentId, orgId },
    });
  }

  /**
   * Update the status of an existing payment.
   * Used by webhooks to flip PENDING -> COMPLETED/FAILED.
   */
  async updatePaymentStatus(
    paymentId: string,
    status:    PaymentStatus,
    metadata?: Record<string, unknown>,
  ) {
    const payment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status,
        ...(metadata ? { metadata } : {}),
        ...(status === PaymentStatus.COMPLETED ? { paidAt: new Date() } : {}),
      },
    });

    logger.info({
      type:      'payment_status_updated',
      paymentId: payment.id,
      status,
    });

    return payment;
  }
}

export const paymentService = new PaymentService();
export { PaymentService };
