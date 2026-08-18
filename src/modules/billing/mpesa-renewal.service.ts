import {
  PaymentProvider,
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { reactMailer } from '@/lib/email/react-mailer.service';
import { appConfig } from '@/config/app.config';
import { getRuntimePlan, resolvePlanPriceForInterval } from '@/lib/runtime-billing-plans';
import { invalidateOrganizationPlanCaches } from './intasend-finalization.service';

const REMINDER_WINDOWS_DAYS = [7, 3, 1, 0] as const;

interface RenewalResult {
  scanned: number;
  remindersSent: number;
  transitionedPastDue: number;
  expired: number;
  skipped: number;
  errors: number;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function daysUntil(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
}

function formatAmountKes(amount: number): string {
  return `KES ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function claimReminder(orgId: string, dueDate: Date, days: number): Promise<boolean> {
  const dueKey = dueDate.toISOString().slice(0, 10);
  const key = `sheriabot:mpesa-renewal-reminder:${orgId}:${dueKey}:${days}`;
  const claimed = await redis.set(key, '1', { nx: true, ex: 60 * 60 * 24 * 45 });
  return claimed !== null;
}

async function ownerContact(orgId: string): Promise<{ id: string; email: string; fullName: string } | null> {
  const membership = await prisma.organizationMember.findFirst({
    where: { organizationId: orgId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
    select: { user: { select: { id: true, email: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  if (membership?.user) {
    return {
      id: membership.user.id,
      email: membership.user.email,
      fullName: membership.user.fullName ?? membership.user.email,
    };
  }

  const user = await prisma.user.findFirst({
    where: { organizationId: orgId },
    select: { id: true, email: true, fullName: true },
    orderBy: { createdAt: 'asc' },
  });

  return user
    ? { id: user.id, email: user.email, fullName: user.fullName ?? user.email }
    : null;
}

class MpesaRenewalService {
  async run(): Promise<RenewalResult> {
    const now = new Date();
    const scanUntil = addDays(now, Math.max(...REMINDER_WINDOWS_DAYS));

    const orgs = await prisma.organization.findMany({
      where: {
        preferredPaymentMethod: PaymentProvider.MPESA,
        mpesaCancelledByUserAt: null,
        plan: { in: [SubscriptionPlan.STARTUP, SubscriptionPlan.BUSINESS] },
        subscriptionStatus: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
        OR: [
          { subscriptionCycleEnd: { lte: scanUntil } },
          { mpesaNextPaymentDueDate: { lte: scanUntil } },
        ],
      },
      select: {
        id: true,
        name: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCycleEnd: true,
        mpesaNextPaymentDueDate: true,
      },
      take: 200,
      orderBy: { subscriptionCycleEnd: 'asc' },
    });

    const result: RenewalResult = {
      scanned: orgs.length,
      remindersSent: 0,
      transitionedPastDue: 0,
      expired: 0,
      skipped: 0,
      errors: 0,
    };

    for (const org of orgs) {
      try {
        const dueDate = org.subscriptionCycleEnd ?? org.mpesaNextPaymentDueDate;
        if (!dueDate) {
          result.skipped++;
          continue;
        }

        const days = daysUntil(dueDate, now);
        const graceEnd = addDays(dueDate, appConfig.intasend.renewal.graceDays);

        if (now > graceEnd) {
          await prisma.$transaction(async (tx) => {
            await tx.organization.update({
              where: { id: org.id },
              data: {
                plan: SubscriptionPlan.REGULATOR,
                subscriptionTier: SubscriptionPlan.REGULATOR,
                subscriptionStatus: SubscriptionStatus.EXPIRED,
                planEndDate: dueDate,
                subscriptionEndsAt: dueDate,
                cancelledAt: now,
                gracePeriodEndsAt: graceEnd,
                mpesaNextRenewalRetryAt: null,
              },
            });
            await tx.auditLog.create({
              data: {
                action: 'subscription_downgraded',
                entityType: 'Organization',
                entityId: org.id,
                metadata: {
                  source: 'mpesa_renewal_cron',
                  previousPlan: org.plan,
                  dueDate: dueDate.toISOString(),
                  graceEnd: graceEnd.toISOString(),
                } as Prisma.InputJsonObject,
              },
            });
          });
          await invalidateOrganizationPlanCaches(org.id);
          result.expired++;
          continue;
        }

        if (days < 0 && org.subscriptionStatus === SubscriptionStatus.ACTIVE) {
          await prisma.$transaction(async (tx) => {
            await tx.organization.update({
              where: { id: org.id },
              data: {
                subscriptionStatus: SubscriptionStatus.PAST_DUE,
                mpesaNextRenewalRetryAt: addDays(now, 1),
              },
            });
            await tx.auditLog.create({
              data: {
                action: 'subscription_past_due',
                entityType: 'Organization',
                entityId: org.id,
                metadata: {
                  source: 'mpesa_renewal_cron',
                  plan: org.plan,
                  dueDate: dueDate.toISOString(),
                } as Prisma.InputJsonObject,
              },
            });
          });
          await invalidateOrganizationPlanCaches(org.id);
          result.transitionedPastDue++;
        }

        if (REMINDER_WINDOWS_DAYS.includes(Math.max(days, 0) as typeof REMINDER_WINDOWS_DAYS[number])) {
          const reminderDays = Math.max(days, 0) as typeof REMINDER_WINDOWS_DAYS[number];
          const claimed = await claimReminder(org.id, dueDate, reminderDays);
          if (!claimed) {
            result.skipped++;
            continue;
          }

          const contact = await ownerContact(org.id);
          if (!contact) {
            result.skipped++;
            continue;
          }

          const runtimePlan = await getRuntimePlan(org.plan);
          const amountKes = resolvePlanPriceForInterval(runtimePlan, 'monthly') ?? 0;
          await reactMailer.sendPaymentDueEmail(contact.email, contact.id, {
            userName: contact.fullName,
            amount: formatAmountKes(amountKes),
            dueDate: dueDate.toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' }),
            planName: runtimePlan.name,
            paymentUrl: `${appConfig.frontendUrl.replace(/\/$/, '')}/settings/billing`,
            daysUntilDue: reminderDays,
          });

          await prisma.auditLog.create({
            data: {
              userId: contact.id,
              action: 'renewal_reminder_sent',
              entityType: 'Organization',
              entityId: org.id,
              metadata: {
                source: 'mpesa_renewal_cron',
                dueDate: dueDate.toISOString(),
                daysUntilDue: reminderDays,
                amountKes,
              } as Prisma.InputJsonObject,
            },
          });
          result.remindersSent++;
        }
      } catch (err: unknown) {
        result.errors++;
        logger.error({
          type: 'mpesa_renewal_org_error',
          orgId: org.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({ type: 'mpesa_renewal_complete', ...result });
    return result;
  }
}

export const mpesaRenewalService = new MpesaRenewalService();
export { MpesaRenewalService };
