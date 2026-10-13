import { prisma } from '@/lib/prisma/client';

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
  jobId?: string,
): Promise<void> {
  const [analysis, job] = await Promise.all([
    prisma.gapAnalysis.findUnique({
      where: { id: analysisId },
      select: { deletedAt: true, status: true },
    }),
    jobId
      ? prisma.aiJob.findUnique({ where: { id: jobId }, select: { status: true } })
      : Promise.resolve(null),
  ]);

  if (
    !analysis ||
    analysis.deletedAt !== null ||
    analysis.status === 'CANCELLED' ||
    (jobId && (!job || job.status === 'CANCELLED'))
  ) {
    throw new GapAnalysisCancelledError();
  }
}

export function monitorGapAnalysisCancellation(
  analysisId: string,
  jobId?: string,
  intervalMs = 1000,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  if (!jobId) return { signal: controller.signal, stop: () => undefined };

  let checking = false;
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void assertGapAnalysisStillActive(analysisId, jobId)
      .catch((error: unknown) => {
        if (isGapAnalysisCancelledError(error)) controller.abort(error);
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

