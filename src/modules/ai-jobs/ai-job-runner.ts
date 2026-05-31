import os from 'os';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { runEnterprisePolicyJob } from '@/modules/enterprise-policy/enterprise-policy.pipeline';
import { runPolicyGenerationJob } from '@/modules/policy/policy-generation.pipeline';

type ClaimedJob = {
  id: string;
  type: string;
  status: string;
  targetEntityType: string;
  targetEntityId: string;
  userId: string | null;
  organizationId: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

export type EnqueueAiJobInput = {
  type: string;
  idempotencyKey: string;
  targetEntityType: string;
  targetEntityId: string;
  userId?: string;
  organizationId?: string;
  payload: Prisma.InputJsonValue;
  maxAttempts?: number;
  priority?: number;
  runAfter?: Date;
};

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.AI_JOB_POLL_INTERVAL_MS ?? 5000);
const STALE_LOCK_MS = Number(process.env.AI_JOB_STALE_LOCK_MS ?? 15 * 60 * 1000);

class AiJobRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;

  async enqueue(input: EnqueueAiJobInput) {
    const job = await prisma.aiJob.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        targetEntityType: input.targetEntityType,
        targetEntityId: input.targetEntityId,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        payload: input.payload,
        maxAttempts: input.maxAttempts ?? 3,
        priority: input.priority ?? 0,
        runAfter: input.runAfter ?? new Date(),
      },
      update: {},
      select: { id: true, status: true, progress: true, attempts: true },
    });

    await this.recordEvent(job.id, 'ENQUEUED', 'Job queued for durable execution.', job.progress, {
      idempotencyKey: input.idempotencyKey,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
    });

    return job;
  }

  start(): void {
    if (this.timer || !this.stopped) return;
    this.stopped = false;
    this.schedule(500);
    logger.info({ type: 'ai_job_runner_started', workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    logger.info({ type: 'ai_job_runner_stopped', workerId: WORKER_ID });
  }

  private schedule(delayMs = POLL_INTERVAL_MS): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.schedule();
      return;
    }

    this.running = true;
    try {
      await this.requeueStaleLocks();
      const job = await this.claimNextJob();
      if (job) {
        await this.execute(job);
        this.schedule(250);
      } else {
        this.schedule();
      }
    } catch (error) {
      logger.error({
        type: 'ai_job_runner_tick_failed',
        workerId: WORKER_ID,
        error: error instanceof Error ? error.message : String(error),
      });
      this.schedule();
    } finally {
      this.running = false;
    }
  }

  private async claimNextJob(): Promise<ClaimedJob | null> {
    const rows = await prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "AiJob"
      SET
        "status" = 'RUNNING',
        "lockedAt" = NOW(),
        "lockedBy" = ${WORKER_ID},
        "startedAt" = COALESCE("startedAt", NOW()),
        "attempts" = "attempts" + 1,
        "updatedAt" = NOW()
      WHERE "id" = (
        SELECT "id"
        FROM "AiJob"
        WHERE "status" IN ('QUEUED', 'RETRYING')
          AND "runAfter" <= NOW()
        ORDER BY "priority" DESC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "id", "type", "status", "targetEntityType", "targetEntityId",
                "userId", "organizationId", "payload", "attempts", "maxAttempts"
    `;

    return rows[0] ?? null;
  }

  private async execute(job: ClaimedJob): Promise<void> {
    await this.recordEvent(job.id, 'STARTED', `Attempt ${job.attempts} started.`, undefined, {
      workerId: WORKER_ID,
      type: job.type,
    });

    try {
      if (job.type === 'GENERATED_POLICY_PIPELINE') {
        await runEnterprisePolicyJob(job, (progress, message, metadata) =>
          this.updateProgress(job.id, progress, message, metadata),
        );
      } else if (job.type === 'POLICY_GENERATION') {
        await runPolicyGenerationJob(job, (progress, message, metadata) =>
          this.updateProgress(job.id, progress, message, metadata),
        );
      } else if (job.type === 'GAP_ANALYSIS_PIPELINE') {
        const { executeGapAnalysisPipeline } = await import('@/modules/compliance/compliance.module');
        await executeGapAnalysisPipeline(job.payload as never);
      } else {
        throw new Error(`No handler registered for AI job type: ${job.type}`);
      }

      await prisma.aiJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          progress: 100,
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      await this.recordEvent(job.id, 'COMPLETED', 'Job completed successfully.', 100);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = job.attempts >= job.maxAttempts;
      const retryDelayMs = Math.min(60 * 60 * 1000, 30_000 * Math.pow(2, Math.max(job.attempts - 1, 0)));

      await prisma.aiJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? 'DEAD_LETTERED' : 'RETRYING',
          runAfter: exhausted ? new Date() : new Date(Date.now() + retryDelayMs),
          lockedAt: null,
          lockedBy: null,
          failedAt: new Date(),
          deadLetteredAt: exhausted ? new Date() : null,
          lastError: message,
        },
      });

      if (job.targetEntityType === 'GeneratedPolicy') {
        await prisma.generatedPolicy.update({
          where: { id: job.targetEntityId },
          data: {
            status: exhausted ? 'FAILED' : 'INITIALIZING',
            progress: exhausted ? 0 : undefined,
            errorMessage: exhausted ? message : `Retry scheduled: ${message}`,
          },
        }).catch((recoveryError: unknown) => {
          logger.error({
            type: 'generated_policy_failure_recovery_failed',
            policyId: job.targetEntityId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
        });
      } else if (job.targetEntityType === 'Policy') {
        await prisma.policy.update({
          where: { id: job.targetEntityId },
          data: {
            status: exhausted ? 'FAILED' : 'GENERATING',
            generationMetadata: {
              jobId: job.id,
              error: message,
              retrying: !exhausted,
              failedAt: new Date().toISOString(),
            },
          },
        }).catch((recoveryError: unknown) => {
          logger.error({
            type: 'policy_failure_recovery_failed',
            policyId: job.targetEntityId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
        });
      } else if (job.targetEntityType === 'GapAnalysis') {
        await prisma.gapAnalysis.update({
          where: { id: job.targetEntityId },
          data: {
            status: exhausted ? 'FAILED' : 'QUEUED',
            errorMessage: exhausted ? message : `Retry scheduled: ${message}`,
          },
        }).catch((recoveryError: unknown) => {
          logger.error({
            type: 'gap_analysis_failure_recovery_failed',
            analysisId: job.targetEntityId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
        });
      }

      await this.recordEvent(
        job.id,
        exhausted ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED',
        message,
        undefined,
        exhausted ? { attempts: job.attempts } : { attempts: job.attempts, retryDelayMs },
      );

      logger.error({
        type: 'ai_job_failed',
        jobId: job.id,
        jobType: job.type,
        attempts: job.attempts,
        exhausted,
        error: message,
      });
    }
  }

  private async updateProgress(
    jobId: string,
    progress: number,
    message: string,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    await prisma.aiJob.update({
      where: { id: jobId },
      data: { progress },
    });
    await this.recordEvent(jobId, 'PROGRESS', message, progress, metadata);
  }

  private async recordEvent(
    jobId: string,
    type: string,
    message?: string,
    progress?: number,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    await prisma.aiJobEvent.create({
      data: {
        jobId,
        type,
        message,
        progress,
        metadata,
      },
    });
  }

  private async requeueStaleLocks(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
    const result = await prisma.aiJob.updateMany({
      where: {
        status: 'RUNNING',
        lockedAt: { lt: staleBefore },
        completedAt: null,
      },
      data: {
        status: 'RETRYING',
        lockedAt: null,
        lockedBy: null,
        runAfter: new Date(),
        lastError: 'Worker lock expired before completion.',
      },
    });

    if (result.count > 0) {
      logger.warn({ type: 'ai_job_stale_locks_requeued', count: result.count, staleLockMs: STALE_LOCK_MS });
    }
  }
}

export const aiJobRunner = new AiJobRunner();
