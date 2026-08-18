import {
  PaymentProvider,
  PaymentStatus,
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { AppError } from '@/utils/error';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';
import { planCtxCacheKey } from '@/modules/trial';
import type { PaymentStatusResponse } from '@/modules/intasend/intasend.types';

const MPESA_SUBSCRIPTION_DAYS = 30;
const GRACE_PERIOD_DAYS = 7;
const KES_MINOR_UNITS = 100;
const PAYMENT_PURPOSE_INITIAL = 'INITIAL_PURCHASE';
const PAYMENT_PURPOSE_RENEWAL = 'RENEWAL';

const PLAN_LABELS: Record<string, string> = {
  STARTUP: 'Startup',
  BUSINESS: 'Business',
  ENTERPRISE: 'Enterprise',
};

const purchasablePlans = new Set<SubscriptionPlan>([
  SubscriptionPlan.STARTUP,
  SubscriptionPlan.BUSINESS,
]);

type FinalizationSource = 'webhook' | 'polling' | 'reconciliation' | 'admin';

interface FinalizeIntaSendPaymentInput {
  invoiceId?: string;
  paymentId?: string;
  verifiedStatus: PaymentStatusResponse;
  source: FinalizationSource;
  actorUserId?: string | null;
  operationalReason?: string | null;
}

export interface FinalizeIntaSendPaymentResult {
  paymentId: string;
  orgId: string;
  status: 'finalized' | 'already_finalized' | 'repaired';
  plan: SubscriptionPlan;
  newlyFinalized: boolean;
}

interface MarkFailedInput {
  invoiceId: string;
  source: FinalizationSource;
  failedReason?: string | null;
  failedCode?: string | null;
}

function frontendUrl(): string {
  return appConfig.frontendUrl.replace(/\/$/, '');
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseProviderAmountMinor(status: PaymentStatusResponse): number | null {
  if (typeof status.amount === 'number' && Number.isFinite(status.amount)) {
    return Math.round(status.amount * KES_MINOR_UNITS);
  }

  const raw = status.raw;
  const candidate =
    raw['amount'] ??
    raw['value'] ??
    raw['net_amount'] ??
    raw['amount_paid'] ??
    raw['paid_amount'];

  if (candidate === undefined || candidate === null) return null;
  const amountMajor = typeof candidate === 'number'
    ? candidate
    : Number(String(candidate).replace(/,/g, '').trim());
  if (!Number.isFinite(amountMajor)) return null;
  return Math.round(amountMajor * KES_MINOR_UNITS);
}

function parseProviderCurrency(status: PaymentStatusResponse): string | null {
  if (status.currency && status.currency.trim().length > 0) {
    return status.currency.trim().toUpperCase();
  }

  const raw = status.raw;
  const candidate = raw['currency'] ?? raw['currency_code'];
  if (candidate === undefined || candidate === null) return null;
  const normalized = String(candidate).trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function latestDate(...dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((date): date is Date => date instanceof Date);
  if (valid.length === 0) return null;
  return valid.reduce((latest, date) => date > latest ? date : latest, valid[0]);
}

type PaymentPurposeValue = typeof PAYMENT_PURPOSE_INITIAL | typeof PAYMENT_PURPOSE_RENEWAL;

function resolvePaymentPurpose(payment: { paymentPurpose?: PaymentPurposeValue | string | null; metadata: unknown }): PaymentPurposeValue | null {
  if (payment.paymentPurpose === PAYMENT_PURPOSE_INITIAL || payment.paymentPurpose === PAYMENT_PURPOSE_RENEWAL) {
    return payment.paymentPurpose;
  }
  const metadata = toRecord(payment.metadata);
  const raw = metadata['paymentPurpose'] ?? metadata['paymentKind'];
  if (raw === PAYMENT_PURPOSE_RENEWAL || raw === 'renewal') return PAYMENT_PURPOSE_RENEWAL;
  if (raw === PAYMENT_PURPOSE_INITIAL || raw === 'initial_purchase') return PAYMENT_PURPOSE_INITIAL;
  return null;
}

function computeBillingPeriod(payment: {
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  paymentPurpose?: PaymentPurposeValue | string | null;
  metadata: unknown;
  org: {
    planEndDate: Date | null;
    subscriptionCycleEnd: Date | null;
  };
}, now: Date): { periodStart: Date; periodEnd: Date; paymentPurpose: PaymentPurposeValue | null } {
  const paymentPurpose = resolvePaymentPurpose(payment);
  const paidThrough = latestDate(payment.org.subscriptionCycleEnd, payment.org.planEndDate);
  const renewalStart = paidThrough && paidThrough > now ? paidThrough : now;
  const defaultStart = paymentPurpose === PAYMENT_PURPOSE_RENEWAL ? renewalStart : now;
  const periodStart = payment.billingPeriodStart ?? defaultStart;
  const periodEnd = payment.billingPeriodEnd ?? addDays(periodStart, MPESA_SUBSCRIPTION_DAYS);
  return { periodStart, periodEnd, paymentPurpose };
}

function orgHasAppliedPlan(org: {
  plan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus;
  planEndDate: Date | null;
  subscriptionCycleEnd: Date | null;
}, plan: SubscriptionPlan, paymentPeriodEnd: Date | null): boolean {
  const appliedThrough = latestDate(paymentPeriodEnd, org.planEndDate, org.subscriptionCycleEnd);
  return org.plan === plan &&
    org.subscriptionStatus === SubscriptionStatus.ACTIVE &&
    appliedThrough !== null;
}

async function writePaymentAuditLog(
  action: string,
  paymentId: string,
  metadata: Record<string, unknown>,
  userId?: string | null,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId ?? null,
        action,
        entityType: 'Payment',
        entityId: paymentId,
        metadata: metadata as Prisma.InputJsonObject,
      },
    });
  } catch (err: unknown) {
    logger.error({
      type: 'payment_audit_log_write_failed',
      action,
      paymentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function invalidateOrganizationPlanCaches(orgId: string): Promise<void> {
  try {
    const [legacyUsers, members] = await Promise.all([
      prisma.user.findMany({
        where: { organizationId: orgId },
        select: { id: true },
      }),
      prisma.organizationMember.findMany({
        where: { organizationId: orgId, status: 'ACTIVE' },
        select: { userId: true },
      }),
    ]);

    const userIds = new Set<string>([
      ...legacyUsers.map((user) => user.id),
      ...members.map((member) => member.userId),
    ]);

    await Promise.all([
      redis.del(`sheriabot:plan:${orgId}`),
      ...Array.from(userIds).map((userId) => redis.del(planCtxCacheKey(userId))),
    ]);

    logger.debug({
      type: 'organization_plan_caches_invalidated',
      orgId,
      userCount: userIds.size,
    });
  } catch (err: unknown) {
    logger.error({
      type: 'organization_plan_cache_invalidation_failed',
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function findOrgOwnerContact(
  orgId: string,
): Promise<{ email: string; fullName: string } | null> {
  const membership = await prisma.organizationMember.findFirst({
    where: { organizationId: orgId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
    select: { user: { select: { email: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  if (membership?.user) return membership.user;

  return prisma.user.findFirst({
    where: { organizationId: orgId },
    select: { email: true, fullName: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function sendReceiptEmail(args: {
  orgId: string;
  plan: SubscriptionPlan;
  amountMinor: number;
  invoiceNumber: string | null;
  paymentMetadata: Record<string, unknown>;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const contact = await findOrgOwnerContact(args.orgId);
  if (!contact || !args.invoiceNumber) return;

  const amountKes = args.amountMinor / KES_MINOR_UNITS;
  const amountStr = `KES ${amountKes.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  const planLabel = PLAN_LABELS[args.plan] ?? args.plan;
  const phone = args.paymentMetadata['phone_number'] as string | undefined;
  const maskedPhone = phone ? `M-Pesa (**** ${phone.slice(-4)})` : 'M-Pesa';
  const base = frontendUrl();

  void reactMailer.sendPaymentReceiptEmail(contact.email, {
    userName: contact.fullName,
    invoiceNumber: args.invoiceNumber,
    amount: amountStr,
    currency: 'KES',
    paymentDate: args.periodStart.toLocaleDateString('en-KE', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    paymentMethod: maskedPhone,
    planName: planLabel,
    billingPeriod: `${args.periodStart.toLocaleDateString('en-KE', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })} to ${args.periodEnd.toLocaleDateString('en-KE', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`,
    receiptUrl: `${base}/settings/billing`,
    items: [{ description: `${planLabel} Plan - Monthly Subscription`, amount: amountStr }],
  });
}

function throwIntegrityError(paymentId: string, reason: string): never {
  throw new AppError(409, 'INTASEND_PAYMENT_INTEGRITY_FAILED', reason, { paymentId });
}

class IntaSendFinalizationService {
  async finalizePayment(input: FinalizeIntaSendPaymentInput): Promise<FinalizeIntaSendPaymentResult> {
    if (input.verifiedStatus.state !== 'COMPLETE') {
      throw new AppError(400, 'INTASEND_PAYMENT_NOT_COMPLETE', 'IntaSend has not confirmed this payment as complete.');
    }

    const invoiceId = input.invoiceId ?? input.verifiedStatus.invoiceId;
    if (!invoiceId && !input.paymentId) {
      throw new AppError(400, 'INTASEND_PAYMENT_REFERENCE_REQUIRED', 'Payment ID or IntaSend invoice ID is required.');
    }

    const payment = await prisma.payment.findFirst({
      where: {
        ...(input.paymentId ? { id: input.paymentId } : {}),
        ...(invoiceId ? { providerTransactionId: invoiceId } : {}),
        provider: PaymentProvider.MPESA,
      },
      include: {
        org: {
          select: {
            id: true,
            plan: true,
            subscriptionStatus: true,
            planEndDate: true,
            subscriptionCycleEnd: true,
          },
        },
      },
    });

    if (!payment) {
      throw new AppError(404, 'INTASEND_PAYMENT_NOT_FOUND', 'Payment record not found for this IntaSend invoice.');
    }

    const purchasedPlan = payment.subscriptionPlan
      ? SubscriptionPlan[payment.subscriptionPlan as keyof typeof SubscriptionPlan]
      : null;

    if (!purchasedPlan || !purchasablePlans.has(purchasedPlan)) {
      await this.recordFinalizationFailure(payment.id, {
        reason: 'invalid_subscription_plan',
        source: input.source,
        subscriptionPlan: payment.subscriptionPlan ?? null,
      });
      throwIntegrityError(payment.id, 'Payment does not contain a valid purchasable subscription plan.');
    }

    if (invoiceId && payment.providerTransactionId !== invoiceId) {
      await this.recordFinalizationFailure(payment.id, {
        reason: 'provider_invoice_mismatch',
        source: input.source,
        expectedInvoiceId: payment.providerTransactionId,
        receivedInvoiceId: invoiceId,
      });
      throwIntegrityError(payment.id, 'IntaSend invoice reference does not match the payment record.');
    }

    const providerAmountMinor = parseProviderAmountMinor(input.verifiedStatus);
    const providerCurrency = parseProviderCurrency(input.verifiedStatus);

    if (providerAmountMinor === null || providerAmountMinor !== payment.amount) {
      await this.recordFinalizationFailure(payment.id, {
        reason: 'amount_mismatch',
        source: input.source,
        expectedAmountMinor: payment.amount,
        providerAmountMinor,
      });
      throwIntegrityError(payment.id, 'Confirmed IntaSend amount does not match the stored payment amount.');
    }

    if (providerCurrency === null || providerCurrency !== payment.currency.toUpperCase()) {
      await this.recordFinalizationFailure(payment.id, {
        reason: 'currency_mismatch',
        source: input.source,
        expectedCurrency: payment.currency,
        providerCurrency,
      });
      throwIntegrityError(payment.id, 'Confirmed IntaSend currency does not match the stored payment currency.');
    }

    const metadata = toRecord(payment.metadata);
    const orgAlreadyApplied = orgHasAppliedPlan(payment.org, purchasedPlan, payment.billingPeriodEnd);

    if (payment.status === PaymentStatus.COMPLETED && orgAlreadyApplied) {
      logger.info({
        type: 'intasend_payment_finalization_idempotent',
        paymentId: payment.id,
        orgId: payment.orgId,
        invoiceId: payment.providerTransactionId,
      });
      return {
        paymentId: payment.id,
        orgId: payment.orgId,
        status: 'already_finalized',
        plan: purchasedPlan,
        newlyFinalized: false,
      };
    }

    const now = new Date();
    const { periodStart, periodEnd, paymentPurpose } = computeBillingPeriod(payment, now);
    const finalizationMetadata = {
      ...metadata,
      intasendInvoiceId: payment.providerTransactionId,
      intasendProviderRef: input.verifiedStatus.providerRef,
      intasendState: input.verifiedStatus.state,
      intasendAmountMinor: providerAmountMinor,
      intasendCurrency: providerCurrency,
      finalizedAt: now.toISOString(),
      finalizedBy: input.source,
      operationalReason: input.operationalReason ?? null,
      paymentPurpose: paymentPurpose ?? null,
    };

    const outcome = await prisma.$transaction(async (tx) => {
      const transition = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.COMPLETED,
          paidAt: payment.paidAt ?? now,
          metadata: finalizationMetadata as Prisma.InputJsonObject,
          invoiceNumber: payment.invoiceNumber,
          subscriptionPlan: purchasedPlan,
          paymentPurpose: paymentPurpose ?? undefined,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
        },
      });

      if (transition.count === 0) {
        const current = await tx.payment.findUnique({
          where: { id: payment.id },
          include: {
            org: {
              select: {
                id: true,
                plan: true,
                subscriptionStatus: true,
                planEndDate: true,
                subscriptionCycleEnd: true,
              },
            },
          },
        });

        if (current?.status === PaymentStatus.COMPLETED) {
          const currentPlan = current.subscriptionPlan
            ? SubscriptionPlan[current.subscriptionPlan as keyof typeof SubscriptionPlan]
            : purchasedPlan;

          if (currentPlan === purchasedPlan && orgHasAppliedPlan(current.org, purchasedPlan, current.billingPeriodEnd)) {
            return {
              payment: current,
              status: 'already_finalized' as const,
              newlyFinalized: false,
              shouldInvalidateCache: false,
            };
          }

          const repairStart = current.billingPeriodStart ?? periodStart;
          const repairEnd = current.billingPeriodEnd ?? periodEnd;
          await tx.organization.update({
            where: { id: payment.orgId },
            data: {
              plan: purchasedPlan,
              subscriptionTier: purchasedPlan,
              subscriptionStatus: SubscriptionStatus.ACTIVE,
              preferredPaymentMethod: PaymentProvider.MPESA,
              planStartDate: repairStart,
              planEndDate: repairEnd,
              mpesaNextPaymentDueDate: repairEnd,
              subscriptionCycleEnd: repairEnd,
              mpesaFailedRenewalAttempts: 0,
              mpesaLastRenewalAttemptAt: null,
              mpesaNextRenewalRetryAt: null,
              mpesaCancelledByUserAt: null,
              cancelledAt: null,
              gracePeriodEndsAt: null,
              subscriptionEndsAt: null,
            },
          });
          await tx.auditLog.create({
            data: {
              userId: input.actorUserId ?? null,
              action: 'payment_completion_repaired',
              entityType: 'Payment',
              entityId: payment.id,
              metadata: {
                orgId: payment.orgId,
                provider: PaymentProvider.MPESA,
                invoiceId: payment.providerTransactionId,
                providerRef: input.verifiedStatus.providerRef,
                plan: purchasedPlan,
                source: input.source,
              } as Prisma.InputJsonObject,
            },
          });
          return {
            payment: current,
            status: 'repaired' as const,
            newlyFinalized: false,
            shouldInvalidateCache: true,
          };
        }

        throw new AppError(
          409,
          'INTASEND_PAYMENT_NOT_FINALIZABLE',
          `Payment is no longer pending and cannot be finalized from status ${current?.status ?? 'UNKNOWN'}.`,
          { paymentId: payment.id },
        );
      }

      const updatedPayment = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });

      await tx.organization.update({
        where: { id: payment.orgId },
        data: {
          plan: purchasedPlan,
          subscriptionTier: purchasedPlan,
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          preferredPaymentMethod: PaymentProvider.MPESA,
          planStartDate: periodStart,
          planEndDate: periodEnd,
          mpesaNextPaymentDueDate: periodEnd,
          subscriptionCycleEnd: periodEnd,
          mpesaFailedRenewalAttempts: 0,
          mpesaLastRenewalAttemptAt: null,
          mpesaNextRenewalRetryAt: null,
          mpesaCancelledByUserAt: null,
          cancelledAt: null,
          gracePeriodEndsAt: null,
          subscriptionEndsAt: null,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: input.actorUserId ?? null,
          action: payment.status === PaymentStatus.COMPLETED
            ? 'payment_completion_repaired'
            : 'payment_completed',
          entityType: 'Payment',
          entityId: payment.id,
          metadata: {
            orgId: payment.orgId,
            provider: PaymentProvider.MPESA,
            invoiceId: payment.providerTransactionId,
            providerRef: input.verifiedStatus.providerRef,
            plan: purchasedPlan,
            amountMinor: payment.amount,
            currency: payment.currency,
            source: input.source,
          } as Prisma.InputJsonObject,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: input.actorUserId ?? null,
          action: 'subscription_activated',
          entityType: 'Organization',
          entityId: payment.orgId,
          metadata: {
            paymentId: payment.id,
            plan: purchasedPlan,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            source: input.source,
          } as Prisma.InputJsonObject,
        },
      });

      return {
        payment: updatedPayment,
        status: 'finalized' as const,
        newlyFinalized: true,
        shouldInvalidateCache: true,
      };
    });

    if (outcome.shouldInvalidateCache) {
      await invalidateOrganizationPlanCaches(payment.orgId);
    }

    if (outcome.newlyFinalized) {
      logger.info({
        type: 'intasend_payment_finalized',
        paymentId: payment.id,
        orgId: payment.orgId,
        invoiceId: payment.providerTransactionId,
        plan: purchasedPlan,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        source: input.source,
      });

      await sendReceiptEmail({
        orgId: payment.orgId,
        plan: purchasedPlan,
        amountMinor: outcome.payment.amount,
        invoiceNumber: outcome.payment.invoiceNumber ?? null,
        paymentMetadata: finalizationMetadata,
        periodStart,
        periodEnd,
      });
    } else {
      logger.info({
        type: 'intasend_payment_finalization_idempotent_after_cas',
        paymentId: payment.id,
        orgId: payment.orgId,
        invoiceId: payment.providerTransactionId,
        status: outcome.status,
        source: input.source,
      });
    }

    return {
      paymentId: payment.id,
      orgId: payment.orgId,
      status: outcome.status,
      plan: purchasedPlan,
      newlyFinalized: outcome.newlyFinalized,
    };
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    const payment = await prisma.payment.findFirst({
      where: { providerTransactionId: input.invoiceId, provider: PaymentProvider.MPESA },
      include: { org: { select: { subscriptionStatus: true } } },
    });

    if (!payment || payment.status === PaymentStatus.COMPLETED || payment.status === PaymentStatus.FAILED) {
      return;
    }

    const now = new Date();
    const metadata = {
      ...toRecord(payment.metadata),
      failedReason: input.failedReason ?? null,
      failedCode: input.failedCode ?? null,
      failedAt: now.toISOString(),
      resolvedBy: input.source,
    };
    const paymentPurpose = resolvePaymentPurpose(payment);

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          metadata: metadata as Prisma.InputJsonObject,
        },
      });

      if (paymentPurpose === PAYMENT_PURPOSE_RENEWAL) {
        await tx.organization.update({
          where: { id: payment.orgId },
          data: {
            mpesaFailedRenewalAttempts: { increment: 1 },
            mpesaLastRenewalAttemptAt: now,
            mpesaNextRenewalRetryAt: addDays(now, 1),
            ...(payment.org.subscriptionStatus === SubscriptionStatus.ACTIVE
              ? { subscriptionStatus: SubscriptionStatus.PAST_DUE }
              : {}),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'payment_failed',
          entityType: 'Payment',
          entityId: payment.id,
          metadata: {
            orgId: payment.orgId,
            invoiceId: input.invoiceId,
            reason: input.failedReason ?? null,
            source: input.source,
            paymentPurpose: paymentPurpose ?? null,
          } as Prisma.InputJsonObject,
        },
      });
    });

    logger.warn({
      type: 'intasend_payment_failed',
      paymentId: payment.id,
      orgId: payment.orgId,
      invoiceId: input.invoiceId,
      source: input.source,
      failedReason: input.failedReason ?? null,
    });

    const contact = await findOrgOwnerContact(payment.orgId);
    if (contact) {
      const amountKes = payment.amount / KES_MINOR_UNITS;
      const planLabel = PLAN_LABELS[payment.subscriptionPlan ?? ''] ?? 'Subscription';
      void reactMailer.sendPaymentFailedEmail(contact.email, {
        userName: contact.fullName,
        amount: `KES ${amountKes.toLocaleString('en-KE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
        planName: planLabel,
        retryUrl: `${frontendUrl()}/settings/billing`,
        gracePeriodDays: GRACE_PERIOD_DAYS,
      });
    }
  }

  private async recordFinalizationFailure(
    paymentId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date();
    try {
      const current = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { metadata: true },
      });
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          metadata: {
            ...toRecord(current?.metadata),
            lastFinalizationFailure: {
              ...metadata,
              at: now.toISOString(),
            },
          } as Prisma.InputJsonObject,
        },
      });
    } catch (err: unknown) {
      logger.error({
        type: 'intasend_finalization_failure_metadata_write_failed',
        paymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await writePaymentAuditLog('payment_finalization_rejected', paymentId, metadata);

    logger.error({
      type: 'intasend_finalization_rejected',
      paymentId,
      ...metadata,
    });
  }
}

export const intaSendFinalizationService = new IntaSendFinalizationService();
export { IntaSendFinalizationService };
