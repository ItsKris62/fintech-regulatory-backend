import type { Redis } from '@upstash/redis';
import { prisma as defaultPrisma } from '@/lib/prisma/client';
import { redis as defaultRedis } from '@/lib/redis/client';
import { errorTracker as defaultErrorTracker, type ErrorTracker } from '@/lib/error-tracker';
import type { AgentWorkforceCost, GroundedOpsSnapshot, SanitizedErrorEntry, SanitizedErrorSummary, ServiceHealthCheck } from './types';

type SnapshotPrisma = Pick<typeof defaultPrisma, 'agentRun'> & {
  $queryRaw<T>(query: TemplateStringsArray | unknown, ...values: unknown[]): Promise<T>;
};
type SnapshotRedis = Pick<Redis, 'ping'>;

export interface OpsHealthSnapshotDependencies {
  prisma?: SnapshotPrisma;
  redis?: SnapshotRedis;
  errorTracker?: ErrorTracker;
  now?: () => Date;
}

export interface ComputeOpsSnapshotInput {
  windowDays: number;
}

const ERROR_MESSAGE_MAX_CHARS = 100;
const EMAIL_PATTERN = /[\w.-]+@[\w.-]+\.\w+/g;
const PHONE_PATTERN = /\+?\d[\d\s\-()]{7,}\d/g;

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Second, defensive sanitization pass on top of errorTracker's own message
 * sanitization (which already strips stack traces / connection strings / SQL
 * fragments and caps at 200 chars) - same PII-minimization discipline applied
 * to LLM prompt payloads in the product-bi batch, applied here to operational
 * error text instead of customer data.
 */
function sanitizeErrorMessageForSynthesis(message: string): string {
  const redacted = message.replace(EMAIL_PATTERN, '[redacted]').replace(PHONE_PATTERN, '[redacted]');
  return redacted.slice(0, ERROR_MESSAGE_MAX_CHARS);
}

export class OpsHealthSnapshotService {
  private readonly prisma: SnapshotPrisma;
  private readonly redis: SnapshotRedis;
  private readonly errorTracker: ErrorTracker;
  private readonly now: () => Date;

  constructor(dependencies: OpsHealthSnapshotDependencies = {}) {
    this.prisma = dependencies.prisma ?? (defaultPrisma as unknown as SnapshotPrisma);
    this.redis = dependencies.redis ?? defaultRedis;
    this.errorTracker = dependencies.errorTracker ?? defaultErrorTracker;
    this.now = dependencies.now ?? (() => new Date());
  }

  async computeSnapshot(input: ComputeOpsSnapshotInput): Promise<GroundedOpsSnapshot> {
    const windowEnd = this.now();
    const windowStart = daysAgo(windowEnd, input.windowDays);

    const [workforceCosts, serviceHealth, errorSummary] = await Promise.all([
      this.computeWorkforceCosts(windowStart, windowEnd),
      this.computeServiceHealth(),
      this.computeErrorSummary(),
    ]);

    return {
      version: 1,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      workforceCosts,
      serviceHealth,
      errorSummary,
    };
  }

  // Mirrors product-bi's computeWorkforceCosts (B6) - not imported from that
  // module (consume, never modify/depend-on another batch's internals),
  // re-implemented against the same AgentRun table.
  private async computeWorkforceCosts(windowStart: Date, windowEnd: Date): Promise<AgentWorkforceCost[]> {
    const where = { startedAt: { gte: windowStart, lte: windowEnd } };
    const [totals, byStatus] = await Promise.all([
      this.prisma.agentRun.groupBy({
        by: ['agentType'],
        where,
        _sum: { costUsd: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      this.prisma.agentRun.groupBy({
        by: ['agentType', 'status'],
        where,
        _count: { _all: true },
      }),
    ]);

    const statusCounts = new Map<string, { completed: number; failed: number; haltedBudget: number; haltedIterations: number }>();
    for (const row of byStatus) {
      const existing = statusCounts.get(row.agentType) ?? { completed: 0, failed: 0, haltedBudget: 0, haltedIterations: 0 };
      if (row.status === 'COMPLETED') existing.completed += row._count._all;
      else if (row.status === 'FAILED') existing.failed += row._count._all;
      else if (row.status === 'HALTED_BUDGET') existing.haltedBudget += row._count._all;
      else if (row.status === 'HALTED_ITERATIONS') existing.haltedIterations += row._count._all;
      statusCounts.set(row.agentType, existing);
    }

    return totals.map((row) => {
      const counts = statusCounts.get(row.agentType) ?? { completed: 0, failed: 0, haltedBudget: 0, haltedIterations: 0 };
      return {
        agentType: row.agentType,
        totalCostUsd: Number(row._sum.costUsd ?? 0),
        totalInputTokens: row._sum.inputTokens ?? 0,
        totalOutputTokens: row._sum.outputTokens ?? 0,
        runCount: row._count._all,
        completedCount: counts.completed,
        failedCount: counts.failed,
        haltedBudgetCount: counts.haltedBudget,
        haltedIterationsCount: counts.haltedIterations,
      };
    });
  }

  // Mirrors the exact DB/Redis checks in GET /health/detailed (src/app.ts) -
  // called in-process here rather than over HTTP, since this agent runs in the
  // same backend. src/app.ts is not modified.
  private async computeServiceHealth(): Promise<ServiceHealthCheck[]> {
    const checks: ServiceHealthCheck[] = [];

    try {
      const start = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      checks.push({ service: 'database', status: 'healthy', latencyMs: Date.now() - start });
    } catch {
      checks.push({ service: 'database', status: 'down' });
    }

    try {
      const start = Date.now();
      await this.redis.ping();
      checks.push({ service: 'redis', status: 'healthy', latencyMs: Date.now() - start });
    } catch {
      checks.push({ service: 'redis', status: 'down' });
    }

    return checks;
  }

  private async computeErrorSummary(): Promise<SanitizedErrorSummary> {
    const summary = this.errorTracker.getSummary();
    const topErrors: SanitizedErrorEntry[] = summary.topErrors.map((entry) => ({
      code: entry.code,
      count: entry.count,
      message: sanitizeErrorMessageForSynthesis(entry.message),
    }));

    return { totalUniqueErrors: summary.totalUniqueErrors, topErrors };
  }
}

export const opsHealthSnapshotService = new OpsHealthSnapshotService();
