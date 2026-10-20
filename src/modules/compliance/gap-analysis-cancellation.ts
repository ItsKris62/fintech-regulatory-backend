import { prisma } from '@/lib/prisma/client';
import {
  AiJobLeaseLostError,
  type AiJobExecutionLease,
} from '@/modules/ai-jobs/ai-job-lease';

export class GapAnalysisCancelledError extends Error {
  readonly retryable = false;

  constructor() {
    super('Gap Analysis processing was cancelled.');
    this.name = 'GapAnalysisCancelledError';
  }
}

export function isGapAnalysisCancelledError(error: unknown): error is GapAnalysisCancelledError {
  return error instanceof GapAnalysisCancelledError;
}

/**
 * Cooperative cancellation boundary. The error is deliberately content-free
 * so it is safe in job events, logs, and error monitoring.
 */
export async function assertGapAnalysisStillActive(
  analysisId: string,
  execution?: string | AiJobExecutionLease,
): Promise<void> {
  const jobId = typeof execution === 'string' ? execution : execution?.jobId;
  const [analysis, job] = await Promise.all([
    prisma.gapAnalysis.findUnique({
      where: { id: analysisId },
      select: { deletedAt: true, status: true },
    }),
    jobId
      ? prisma.aiJob.findUnique({
          where: { id: jobId },
          select: { status: true, lockedBy: true, attempts: true },
        })
      : Promise.resolve(null),
  ]);

  if (
    !analysis ||
    analysis.deletedAt !== null ||
    ['CANCELLED', 'COMPLETED', 'FAILED'].includes(analysis.status) ||
    (jobId && (!job || job.status === 'CANCELLED'))
  ) {
    throw new GapAnalysisCancelledError();
  }

  if (
    typeof execution !== 'string' &&
    execution &&
    (
      job?.status !== 'RUNNING' ||
      job.lockedBy !== execution.workerId ||
      job.attempts !== execution.attempt
    )
  ) {
    throw new AiJobLeaseLostError();
  }
}

export function monitorGapAnalysisCancellation(
  analysisId: string,
  execution?: string | AiJobExecutionLease,
  intervalMs = 1000,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const jobId = typeof execution === 'string' ? execution : execution?.jobId;
  if (!jobId) return { signal: controller.signal, stop: () => undefined };

  let checking = false;
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void assertGapAnalysisStillActive(analysisId, execution)
      .catch((error: unknown) => {
        if (isGapAnalysisCancelledError(error) || error instanceof AiJobLeaseLostError) {
          controller.abort(error);
        }
      })
      .finally(() => {
        checking = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}
