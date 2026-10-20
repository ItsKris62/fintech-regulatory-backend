import type { Prisma } from "@prisma/client";
import {
  AiJobLeaseLostError,
  type AiJobExecutionLease,
} from "@/modules/ai-jobs/ai-job-lease";
import { GapAnalysisCancelledError } from "./gap-analysis-cancellation";

export const GAP_ANALYSIS_ACTIVE_STATUSES = [
  "UPLOADING",
  "QUEUED",
  "EXTRACTING",
  "ANALYZING",
  "COMPLETING",
] as const;

export type GapAnalysisFinalizationClient = Pick<
  Prisma.TransactionClient,
  "gapAnalysis" | "gapAnalysisUsageLedger" | "aiJob"
>;

/**
 * Commit the customer-visible result and the durable job terminal transition
 * in one PostgreSQL transaction. The analysis row is locked first, matching
 * deletion's lock order; a failed job fencing CAS rolls the result write back.
 */
export async function finalizeGapAnalysisAttempt(
  tx: GapAnalysisFinalizationClient,
  params: {
    analysisId: string;
    userId: string;
    organizationId: string | null;
    execution: AiJobExecutionLease;
    analysisData: Prisma.GapAnalysisUpdateManyMutationInput;
    completedAt: Date;
  },
): Promise<void> {
  const finalWrite = await tx.gapAnalysis.updateMany({
    where: {
      id: params.analysisId,
      userId: params.userId,
      organizationId: params.organizationId,
      deletedAt: null,
      status: { in: [...GAP_ANALYSIS_ACTIVE_STATUSES] },
    },
    data: params.analysisData,
  });
  if (finalWrite.count !== 1) throw new GapAnalysisCancelledError();

  await tx.gapAnalysisUsageLedger.updateMany({
    where: {
      analysisId: params.analysisId,
      organizationId: params.organizationId ?? params.userId,
      userId: params.userId,
      state: "RESERVED",
    },
    data: { state: "SETTLED", settledAt: params.completedAt, lastError: null },
  });

  const completedJob = await tx.aiJob.updateMany({
    where: {
      id: params.execution.jobId,
      status: "RUNNING",
      lockedBy: params.execution.workerId,
      attempts: params.execution.attempt,
      targetEntityType: "GapAnalysis",
      targetEntityId: params.analysisId,
      userId: params.userId,
      organizationId: params.organizationId,
    },
    data: {
      status: "COMPLETED",
      progress: 100,
      completedAt: params.completedAt,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
  if (completedJob.count !== 1) throw new AiJobLeaseLostError();
}
