import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma/client";

export interface AiJobExecutionLease {
  jobId: string;
  workerId: string;
  attempt: number;
}

export class AiJobLeaseLostError extends Error {
  readonly retryable = false;

  constructor() {
    super("AI job execution lease is no longer owned by this attempt.");
    this.name = "AiJobLeaseLostError";
  }
}

export function isAiJobLeaseLostError(
  error: unknown,
): error is AiJobLeaseLostError {
  return error instanceof AiJobLeaseLostError;
}

export function aiJobLeaseWhere(lease: AiJobExecutionLease) {
  return {
    id: lease.jobId,
    status: "RUNNING",
    lockedBy: lease.workerId,
    attempts: lease.attempt,
  } as const;
}

export interface AiJobLeaseClient {
  aiJob: {
    updateMany(
      args: Prisma.AiJobUpdateManyArgs,
    ): PromiseLike<Prisma.BatchPayload>;
    findFirst(
      args: Prisma.AiJobFindFirstArgs,
    ): PromiseLike<{ id: string } | null>;
  };
}

/**
 * Renew the lease only if this exact execution generation still owns the job.
 * `attempts` is incremented atomically by claimNextJob and acts as the fencing
 * token; a reclaimed job therefore cannot be renewed by its previous worker.
 */
export async function renewAiJobLease(
  lease: AiJobExecutionLease,
  now = new Date(),
  db: AiJobLeaseClient = prisma as unknown as AiJobLeaseClient,
): Promise<void> {
  const renewed = await db.aiJob.updateMany({
    where: aiJobLeaseWhere(lease),
    data: { lockedAt: now },
  });

  if (renewed.count !== 1) throw new AiJobLeaseLostError();
}

export async function assertAiJobLeaseOwned(
  lease: AiJobExecutionLease,
  db: AiJobLeaseClient = prisma as unknown as AiJobLeaseClient,
): Promise<void> {
  const owned = await db.aiJob.findFirst({
    where: aiJobLeaseWhere(lease),
    select: { id: true },
  });

  if (!owned) throw new AiJobLeaseLostError();
}
