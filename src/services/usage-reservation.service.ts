/**
 * Usage Reservation & Settlement Service
 *
 * Durable two-phase usage accounting mechanism:
 * 1. Atomically reserves capacity before starting expensive or AI operations.
 * 2. Settles and commits usage durably to the database upon successful completion.
 * 3. Releases reserved units upon failure, timeout, or cancellation.
 * 4. Ensures idempotency: duplicate requests with same operationId retrieve existing result without re-charging.
 * 5. Fails closed: Redis outage falls back to durable DB period checks without granting unlimited usage.
 */

import { BillingMetric } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { getPlanEntitlements, type PlanEntitlementConfig } from '@/config/entitlements.config';
import { getMonthlyQuotaPeriod } from '@/utils/billing-dates';
import type { EffectivePlan } from '@/types/plan.types';

export const RESERVATION_TTL_SECONDS = 15 * 60; // 15 minutes

export interface ReserveUsageInput {
  orgId: string;
  userId?: string;
  metric: BillingMetric;
  units: number;
  operationId: string;
  plan: EffectivePlan;
  entitlements?: PlanEntitlementConfig;
}

export interface ReserveUsageResult {
  allowed: boolean;
  reservationId: string;
  current: number;
  limit: number;
  remaining: number;
  isDuplicateSettled?: boolean;
}

export interface SettleUsageInput {
  orgId: string;
  userId?: string;
  reservationId: string;
  operationId: string;
  metric: BillingMetric;
  units: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface ReleaseUsageInput {
  orgId: string;
  reservationId: string;
  metric: BillingMetric;
  units: number;
  reason?: string;
}

function getQuotaLimit(entitlements: PlanEntitlementConfig, metric: BillingMetric): number {
  switch (metric) {
    case BillingMetric.COMPLIANCE_QUERIES:
      return typeof entitlements.complianceQueries === 'object' ? entitlements.complianceQueries.limit : 0;
    case BillingMetric.CHECKLIST_GENERATIONS:
      return typeof entitlements.checklistGenerations === 'object' ? entitlements.checklistGenerations.limit : 0;
    case BillingMetric.GAP_ANALYSES:
      return typeof entitlements.gapAnalysis === 'object' ? entitlements.gapAnalysis.limit : 0;
    case BillingMetric.POLICY_GENERATIONS:
      return entitlements.policyGeneration ? 5 : 0;
    case BillingMetric.API_CALLS:
      return typeof entitlements.apiAccess === 'object' ? entitlements.apiAccess.limit : 0;
    case BillingMetric.DOCUMENT_STORAGE_MB:
      return typeof entitlements.documentRepository === 'object' ? entitlements.documentRepository.limitMB : 0;
    default:
      return 0;
  }
}

class UsageReservationService {
  /**
   * Atomically reserves usage units before processing.
   */
  async reserveUsage(input: ReserveUsageInput): Promise<ReserveUsageResult> {
    const { orgId, metric, units, operationId, plan } = input;
    const entitlements = input.entitlements ?? getPlanEntitlements(plan);
    const limit = getQuotaLimit(entitlements, metric);

    // 1. Unlimited tier
    if (limit === -1) {
      return {
        allowed: true,
        reservationId: `unlimited_${operationId}`,
        current: 0,
        limit: -1,
        remaining: -1,
      };
    }

    // 2. Feature unavailable
    if (limit === 0) {
      return {
        allowed: false,
        reservationId: '',
        current: 0,
        limit: 0,
        remaining: 0,
      };
    }

    try {
      const { periodKey } = getMonthlyQuotaPeriod();
      const usageKey = `sheriabot:usage:${orgId}:${metric}:${periodKey}`;
      const reservationKey = `sheriabot:reservation:${orgId}:${operationId}`;

      // 3. Check if this operation was already settled (idempotent retry)
      const existingSettled = await redis.get<string>(`sheriabot:settled:${orgId}:${operationId}`);
      if (existingSettled) {
        return {
          allowed: true,
          reservationId: `settled_${operationId}`,
          current: 0,
          limit,
          remaining: limit,
          isDuplicateSettled: true,
        };
      }

      // Atomic reservation via Redis INCRBY: increment by units
      const newCount = await redis.incrby(usageKey, units);

      if (newCount > limit) {
        // Rollback overspent units
        await redis.decrby(usageKey, units);
        const current = newCount - units;
        logger.warn({
          type: 'usage_reservation_quota_exceeded',
          orgId,
          metric,
          units,
          current,
          limit,
        });
        return {
          allowed: false,
          reservationId: '',
          current,
          limit,
          remaining: Math.max(0, limit - current),
        };
      }

      // Record reservation details
      const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const reservationData = {
        reservationId,
        orgId,
        userId: input.userId ?? null,
        operationId,
        metric,
        units,
        periodKey,
        createdAt: new Date().toISOString(),
      };

      await redis.set(reservationKey, JSON.stringify(reservationData), {
        ex: RESERVATION_TTL_SECONDS,
      });

      logger.debug({
        type: 'usage_reserved',
        orgId,
        metric,
        units,
        newCount,
        limit,
        reservationId,
      });

      return {
        allowed: true,
        reservationId,
        current: newCount,
        limit,
        remaining: Math.max(0, limit - newCount),
      };
    } catch (err: unknown) {
      logger.error({
        type: 'usage_reservation_redis_error',
        orgId,
        metric,
        error: err instanceof Error ? err.message : String(err),
      });

      // Fail-closed safety: query DB if Redis fails, do not allow unbounded overspend
      return this.fallbackDbCheck(orgId, metric, units, limit, operationId);
    }
  }

  /**
   * Settles a previously reserved usage after successful execution.
   */
  async settleUsage(input: SettleUsageInput): Promise<void> {
    const { orgId, userId, reservationId, operationId, metric, units, costUsd } = input;

    if (reservationId.startsWith('unlimited_') || reservationId.startsWith('settled_')) {
      return;
    }

    const { periodStart, periodEnd } = getMonthlyQuotaPeriod();
    const reservationKey = `sheriabot:reservation:${orgId}:${operationId}`;
    const settledKey = `sheriabot:settled:${orgId}:${operationId}`;

    try {
      // 1. Mark operation as settled in Redis for idempotency (TTL: 7 days)
      await redis.set(settledKey, reservationId, { ex: 7 * 24 * 60 * 60 });

      // 2. Remove temporary reservation record
      await redis.del(reservationKey);

      // 3. Persist durable UsageRecord in database via upsert
      await prisma.usageRecord.upsert({
        where: {
          organizationId_metric_periodStart: {
            organizationId: orgId,
            metric,
            periodStart,
          },
        },
        create: {
          organizationId: orgId,
          metric,
          count: units,
          periodStart,
          periodEnd,
        },
        update: {
          count: {
            increment: units,
          },
          periodEnd,
        },
      }).catch((err: unknown) => {
        logger.error({
          type: 'usage_record_persistence_error',
          orgId,
          operationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      logger.info({
        type: 'usage_settled',
        orgId,
        userId,
        operationId,
        metric,
        units,
        costUsd,
      });
    } catch (err: unknown) {
      logger.error({
        type: 'usage_settlement_failed',
        orgId,
        operationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Releases a reserved usage back to the quota if the operation failed.
   */
  async releaseUsage(input: ReleaseUsageInput): Promise<void> {
    const { orgId, reservationId, metric, units, reason } = input;

    if (reservationId.startsWith('unlimited_') || reservationId.startsWith('settled_')) {
      return;
    }

    const { periodKey } = getMonthlyQuotaPeriod();
    const usageKey = `sheriabot:usage:${orgId}:${metric}:${periodKey}`;

    try {
      // Decrement the reserved units back from the counter
      await redis.decrby(usageKey, units);

      logger.info({
        type: 'usage_reservation_released',
        orgId,
        reservationId,
        metric,
        units,
        reason: reason ?? 'operation_failed',
      });
    } catch (err: unknown) {
      logger.error({
        type: 'usage_release_failed',
        orgId,
        reservationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async fallbackDbCheck(
    orgId: string,
    metric: BillingMetric,
    units: number,
    limit: number,
    operationId: string,
  ): Promise<ReserveUsageResult> {
    try {
      const { periodStart } = getMonthlyQuotaPeriod();
      const record = await prisma.usageRecord.findUnique({
        where: {
          organizationId_metric_periodStart: {
            organizationId: orgId,
            metric,
            periodStart,
          },
        },
      });

      const currentDb = record?.count ?? 0;
      if (currentDb + units > limit) {
        return {
          allowed: false,
          reservationId: '',
          current: currentDb,
          limit,
          remaining: Math.max(0, limit - currentDb),
        };
      }

      return {
        allowed: true,
        reservationId: `db_fallback_${operationId}`,
        current: currentDb,
        limit,
        remaining: Math.max(0, limit - currentDb - units),
      };
    } catch {
      // Fail closed
      return {
        allowed: false,
        reservationId: '',
        current: limit,
        limit,
        remaining: 0,
      };
    }
  }
}

export const usageReservationService = new UsageReservationService();
