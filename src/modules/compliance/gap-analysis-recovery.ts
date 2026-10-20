import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma/client";
import { getGapAnalysisDepthProfile } from "@/config/gap-analysis-depth-profiles";
import { logger } from "@/utils/logger";

const ACTIVE_ANALYSIS_STATUSES = [
  "UPLOADING",
  "QUEUED",
  "EXTRACTING",
  "ANALYZING",
  "COMPLETING",
] as const;
const ACTIVE_JOB_STATUSES = new Set(["QUEUED", "RUNNING", "RETRYING"]);
const KNOWN_DEPTHS = new Set(["quick", "standard", "deep"]);

const configuredAbandonmentGrace = Number(process.env.AI_JOB_STALE_LOCK_MS);
export const GAP_ANALYSIS_ABANDONMENT_GRACE_MS =
  Number.isFinite(configuredAbandonmentGrace) &&
  configuredAbandonmentGrace >= 100
    ? configuredAbandonmentGrace
    : 15 * 60 * 1000;

export function gapAnalysisRecoveryDeadlineMs(depth: string): number {
  const safeDepth = KNOWN_DEPTHS.has(depth)
    ? (depth as "quick" | "standard" | "deep")
    : "quick";
  return (
    getGapAnalysisDepthProfile(safeDepth).budget.maxWallClockMs +
    GAP_ANALYSIS_ABANDONMENT_GRACE_MS
  );
}

/**
 * Reconcile only analyses that are older than their depth deadline plus the
 * worker-abandonment grace and have no active durable job. Healthy queued,
 * retrying, or heartbeat-renewed RUNNING jobs are owned exclusively by the
 * AiJob runner and are never failed based on GapAnalysis.updatedAt.
 */
type RecoveryClient = Pick<Prisma.TransactionClient, "gapAnalysis" | "aiJob">;

export async function recoverAbandonedGapAnalyses(
  now = new Date(),
  db: RecoveryClient = prisma as unknown as RecoveryClient,
): Promise<number> {
  const candidates = await db.gapAnalysis.findMany({
    where: {
      deletedAt: null,
      status: { in: [...ACTIVE_ANALYSIS_STATUSES] },
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: {
      id: true,
      userId: true,
      organizationId: true,
      analysisDepth: true,
      status: true,
      updatedAt: true,
    },
  });

  let recovered = 0;
  for (const analysis of candidates) {
    const deadlineMs = gapAnalysisRecoveryDeadlineMs(analysis.analysisDepth);
    const cutoff = new Date(now.getTime() - deadlineMs);
    if (analysis.updatedAt > cutoff) continue;

    const job = await db.aiJob.findFirst({
      where: {
        type: "GAP_ANALYSIS_PIPELINE",
        targetEntityType: "GapAnalysis",
        targetEntityId: analysis.id,
        userId: analysis.userId,
        organizationId: analysis.organizationId,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, attempts: true },
    });

    if (
      job &&
      (ACTIVE_JOB_STATUSES.has(job.status) || job.status === "COMPLETED")
    )
      continue;

    const nextStatus = job?.status === "CANCELLED" ? "CANCELLED" : "FAILED";
    const updated = await db.gapAnalysis.updateMany({
      where: {
        id: analysis.id,
        userId: analysis.userId,
        organizationId: analysis.organizationId,
        deletedAt: null,
        status: analysis.status,
        updatedAt: { lte: cutoff },
      },
      data: {
        status: nextStatus,
        ...(nextStatus === "FAILED"
          ? {
              errorMessage: `Analysis exceeded its ${analysis.analysisDepth} execution deadline and no active durable job owns it. Please try again.`,
            }
          : {}),
      },
    });

    if (updated.count === 1) {
      recovered++;
      logger.warn({
        type: "gap_analysis_abandoned_recovered",
        analysisId: analysis.id,
        organizationId: analysis.organizationId,
        depth: analysis.analysisDepth,
        jobId: job?.id,
        jobStatus: job?.status ?? "MISSING",
        attempts: job?.attempts ?? 0,
        deadlineMs,
        nextStatus,
      });
    }
  }

  return recovered;
}
