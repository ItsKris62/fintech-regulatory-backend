import type { Prisma } from '@prisma/client';

export const PRODUCT_BI_AGENT_TYPE = 'product-bi' as const;

export interface OrganizationCountByPlan {
  plan: string;
  subscriptionStatus: string;
  count: number;
}

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

/**
 * organizationId + organizationName (company name) only - never a contact
 * email or personal name. metrics-computation.service.ts must never populate
 * these types with the organization's own contact fields or a user's personal
 * name/email fields.
 */
export interface UpgradeMomentCandidate {
  organizationId: string;
  organizationName: string;
  plan: string;
  metric: 'checklistGenerations' | 'complianceQueries';
  periodsAtOrOverLimit: number;
  latestPeriodStart: string;
  latestUsage: number;
  latestLimit: number;
}

export interface ChurnRiskOrg {
  organizationId: string;
  organizationName: string;
  subscriptionStatus: string;
  mpesaFailedRenewalAttempts: number;
  reason: string;
}

export interface PilotCohortSnapshot {
  cohort: string;
  activeCount: number;
  convertedCount: number;
  expiredCount: number;
}

export type EngagementAggregate =
  | { available: true; activeDistinctPersons7d: number }
  | { available: false; reason: string };

export interface GroundedMetricsSnapshot {
  version: 1;
  windowStart: string;
  windowEnd: string;
  organizationCountsByPlan: OrganizationCountByPlan[];
  workforceCosts: AgentWorkforceCost[];
  upgradeMomentCandidates: UpgradeMomentCandidate[];
  churnRiskOrgs: ChurnRiskOrg[];
  pilotCohorts: PilotCohortSnapshot[];
  engagement: EngagementAggregate;
}

export interface InsightNarrative {
  summary: string;
  opportunities: string[];
  risks: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    provider: string;
    model: string;
  };
}

export interface ProductBiRunResult {
  runId: string | null;
  status: 'SKIPPED_DISABLED' | 'DUPLICATE' | 'COMPLETED' | 'HALTED_BUDGET' | 'FAILED';
  reportId?: string;
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function isoWeekIdentifier(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
