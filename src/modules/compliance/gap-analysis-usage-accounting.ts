import { prisma } from "@/lib/prisma/client";
import { redis } from "@/lib/redis/client";
import { decrementTrialUsageAtomic } from "@/modules/trial";
import { logger } from "@/utils/logger";
import type { UsageReservationDescriptor } from "@/server/trpc/middleware";

export interface GapAnalysisUsageReservation extends UsageReservationDescriptor {
  reservationKey: string;
}

const REFUND_MARKER_TTL_SECONDS = 45 * 24 * 60 * 60;

export async function compensateGapAnalysisUsage(input: {
  analysisId?: string;
  reservationKey?: string;
  organizationId: string;
  userId: string;
  failureClass: string;
}): Promise<boolean> {
  const where = input.analysisId
    ? {
        analysisId: input.analysisId,
        organizationId: input.organizationId,
        userId: input.userId,
      }
    : {
        reservationKey: input.reservationKey!,
        organizationId: input.organizationId,
        userId: input.userId,
      };
  const ledger = await prisma.gapAnalysisUsageLedger.findFirst({ where });
  if (!ledger) return false;
  if (ledger.state === "RELEASED" || ledger.state === "SETTLED") return true;

  if (ledger.scope === "TRIAL") {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.gapAnalysisUsageLedger.updateMany({
        where: {
          id: ledger.id,
          organizationId: input.organizationId,
          userId: input.userId,
          state: { in: ["RESERVED", "COMPENSATION_PENDING"] },
        },
        data: {
          state: "COMPENSATING",
          failureClass: input.failureClass,
          lastError: null,
        },
      });
      if (claimed.count !== 1) return;
      await decrementTrialUsageAtomic(
        input.userId,
        "gapAnalyses",
        ledger.units,
        tx as never,
      );
      await tx.gapAnalysisUsageLedger.update({
        where: { id: ledger.id },
        data: { state: "RELEASED", releasedAt: new Date() },
      });
    });
    return true;
  }

  if (ledger.scope === "UNLIMITED") {
    await prisma.gapAnalysisUsageLedger.updateMany({
      where: {
        id: ledger.id,
        organizationId: input.organizationId,
        userId: input.userId,
        state: "RESERVED",
      },
      data: {
        state: "RELEASED",
        releasedAt: new Date(),
        failureClass: input.failureClass,
      },
    });
    return true;
  }

  if (!ledger.counterKey)
    throw new Error("Redis usage ledger is missing its tenant counter key.");
  await prisma.gapAnalysisUsageLedger.updateMany({
    where: {
      id: ledger.id,
      organizationId: input.organizationId,
      userId: input.userId,
      state: { in: ["RESERVED", "COMPENSATION_PENDING", "COMPENSATING"] },
    },
    data: {
      state: "COMPENSATING",
      failureClass: input.failureClass,
      lastError: null,
    },
  });

  const refundKey = `sheriabot:gap-analysis:usage-refund:${ledger.id}`;
  const script = `
    if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
    local current = tonumber(redis.call('GET', KEYS[1]) or '0')
    local next = math.max(0, current - tonumber(ARGV[1]))
    redis.call('SET', KEYS[1], tostring(next))
    redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
    return 1
  `;
  try {
    await (redis as any).eval(
      script,
      [ledger.counterKey, refundKey],
      [String(ledger.units), String(REFUND_MARKER_TTL_SECONDS)],
    );
    await prisma.gapAnalysisUsageLedger.update({
      where: { id: ledger.id },
      data: { state: "RELEASED", releasedAt: new Date(), lastError: null },
    });
    logger.info({
      type: "gap_analysis_usage_released",
      analysisId: ledger.analysisId,
      orgId: input.organizationId,
      units: ledger.units,
      failureClass: input.failureClass,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.gapAnalysisUsageLedger
      .update({
        where: { id: ledger.id },
        data: { state: "COMPENSATION_PENDING", lastError: message },
      })
      .catch(() => undefined);
    logger.error({
      type: "gap_analysis_usage_compensation_failed",
      analysisId: ledger.analysisId,
      orgId: input.organizationId,
      failureClass: input.failureClass,
      error: message,
    });
    throw error;
  }
}

/**
 * Bounded operator/cron reconciliation for a Redis outage that occurred after
 * the terminal failure was durably recorded. It never touches another tenant:
 * every compensation call carries the ledger's persisted owner and org.
 */
export async function reconcilePendingGapAnalysisUsage(
  limit = 100,
): Promise<{ reconciled: number; failed: number }> {
  const pending = await prisma.gapAnalysisUsageLedger.findMany({
    where: { state: "COMPENSATION_PENDING" },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 500),
    select: {
      analysisId: true,
      organizationId: true,
      userId: true,
      failureClass: true,
    },
  });
  let reconciled = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      await compensateGapAnalysisUsage({
        analysisId: row.analysisId,
        organizationId: row.organizationId,
        userId: row.userId,
        failureClass: row.failureClass ?? "RECONCILIATION",
      });
      reconciled++;
    } catch {
      failed++;
    }
  }
  return { reconciled, failed };
}
