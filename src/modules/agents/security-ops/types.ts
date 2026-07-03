import type { Prisma } from '@prisma/client';

export const SECURITY_OPS_AGENT_TYPE = 'security-ops' as const;

export interface AgentWorkforceCost {
  agentType: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  runCount: number;
  completedCount: number;
  failedCount: number;
  haltedBudgetCount: number;
  haltedIterationsCount: number;
}

export interface ServiceHealthCheck {
  service: 'database' | 'redis';
  status: 'healthy' | 'down';
  latencyMs?: number;
}

/**
 * Truncated, PII-scrubbed view of errorTracker's in-memory summary. message is
 * already sanitized once by errorTracker itself (stack traces, connection
 * strings, and SQL fragments stripped, 200-char cap); ops-health-snapshot.service.ts
 * applies a second, defensive truncation/redaction pass before this ever reaches
 * the synthesis prompt.
 */
export interface SanitizedErrorEntry {
  code: string;
  count: number;
  message: string;
}

export interface SanitizedErrorSummary {
  totalUniqueErrors: number;
  topErrors: SanitizedErrorEntry[];
}

export interface GroundedOpsSnapshot {
  version: 1;
  windowStart: string;
  windowEnd: string;
  workforceCosts: AgentWorkforceCost[];
  serviceHealth: ServiceHealthCheck[];
  errorSummary: SanitizedErrorSummary;
}

export interface OpsNarrative {
  summary: string;
  risks: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    provider: string;
    model: string;
  };
}

export interface SecurityOpsRunResult {
  runId: string | null;
  status: 'SKIPPED_DISABLED' | 'DUPLICATE' | 'COMPLETED' | 'HALTED_BUDGET' | 'FAILED';
  reportId?: string;
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function isoDateIdentifier(date: Date): string {
  return date.toISOString().slice(0, 10);
}
