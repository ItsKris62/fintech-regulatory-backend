import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

export interface AsyncTaskJob<T = unknown> {
  id: string;
  name: string;
  payload: T;
  execute: (payload: T) => Promise<void>;
  maxRetries?: number;
}

class DurableTaskRunner {
  private queue: AsyncTaskJob[] = [];
  private isProcessing = false;
  private pendingPromises = new Set<Promise<void>>();

  /**
   * Enqueue a compliance or telemetry background task.
   * Dispatches asynchronously without stalling the calling request thread,
   * while ensuring durability through automated retries and unhandled rejection protection.
   */
  public enqueue<T>(
    name: string,
    payload: T,
    execute: (payload: T) => Promise<void>,
    maxRetries = 3,
  ): void {
    const job: AsyncTaskJob<T> = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      payload,
      execute,
      maxRetries,
    };

    const promise = this.executeWithRetry(job, 0);
    this.pendingPromises.add(promise);
    promise.finally(() => {
      this.pendingPromises.delete(promise);
    });
  }

  private async executeWithRetry(job: AsyncTaskJob<any>, attempt: number): Promise<void> {
    try {
      await job.execute(job.payload);
    } catch (err: any) {
      const isLastAttempt = attempt >= (job.maxRetries ?? 3);
      logger.warn({
        type: 'durable_task_execution_attempt_failed',
        taskId: job.id,
        taskName: job.name,
        attempt: attempt + 1,
        maxRetries: job.maxRetries,
        error: err?.message ?? String(err),
      });

      if (!isLastAttempt) {
        const backoffMs = Math.min(100 * Math.pow(2, attempt), 2000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.executeWithRetry(job, attempt + 1);
      }

      logger.error({
        type: 'durable_task_permanently_failed',
        taskId: job.id,
        taskName: job.name,
        payload: job.payload,
        error: err?.message ?? String(err),
      });
    }
  }

  /**
   * Helper for non-blocking compliance audit logging
   */
  public enqueueAuditLog(data: {
    userId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown> | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): void {
    this.enqueue('write_audit_log', data, async (logData) => {
      await prisma.auditLog.create({
        data: {
          userId: logData.userId ?? undefined,
          action: logData.action,
          entityType: logData.entityType,
          entityId: logData.entityId,
          metadata: logData.metadata ?? undefined,
          ipAddress: logData.ipAddress ?? undefined,
          userAgent: logData.userAgent ? logData.userAgent.substring(0, 500) : undefined,
        },
      });
    });
  }

  /**
   * Helper for non-blocking user login telemetry update
   */
  public enqueueLastLoginUpdate(userId: string, ipAddress: string | null): void {
    this.enqueue('update_last_login', { userId, ipAddress }, async ({ userId, ipAddress }) => {
      await prisma.user.update({
        where: { id: userId },
        data: {
          lastLoginAt: new Date(),
          lastLoginIp: ipAddress,
        },
      });
    });
  }

  /**
   * Await all currently in-flight background tasks (useful during graceful server shutdown)
   */
  public async drain(): Promise<void> {
    if (this.pendingPromises.size > 0) {
      await Promise.allSettled(Array.from(this.pendingPromises));
    }
  }
}

export const durableTaskRunner = new DurableTaskRunner();
