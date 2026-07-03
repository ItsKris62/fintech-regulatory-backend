import type { Prisma } from '@prisma/client';

export const CHIEF_OF_STAFF_AGENT_TYPE = 'chief-of-staff' as const;

// The five known source agent types this batch reads from - plain string
// literals, not imported from B3-B7's own _AGENT_TYPE constants (consume,
// never modify/depend-on another batch's internals).
export const SOURCE_AGENT_TYPES = [
  'regulatory-intelligence',
  'marketing',
  'sales-growth',
  'product-bi',
  'security-ops',
] as const;
export type SourceAgentType = (typeof SOURCE_AGENT_TYPES)[number];

/**
 * Safe, uniform extract of one source agent's latest AgentReport - summary
 * plus only the parts of risks/recommendedActions that are already plain
 * string arrays or array lengths, never the full heterogeneous nested JSON
 * (see Stage 1 audit Section 1). reportId is null when that source agent has
 * not produced a report yet (a fresh environment, or before its first run).
 */
export interface SourceReportExtract {
  agentType: SourceAgentType;
  reportId: string | null;
  createdAt: string | null;
  summary: string | null;
  riskNotes: string[];
  actionNotes: string[];
  itemCounts: Record<string, number>;
}

export interface RankedAction {
  action: string;
  sourceAgentType: SourceAgentType;
  sourceReportId: string;
}

export interface DecisionNeeded {
  decision: string;
  sourceAgentType: SourceAgentType;
  sourceReportId: string;
}

export interface WeeklyBrief {
  summary: string;
  wins: string[];
  rankedActions: RankedAction[];
  decisionsNeeded: DecisionNeeded[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    provider: string;
    model: string;
  };
}

export interface ChiefOfStaffRunResult {
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

/**
 * Generic runtime walk over a risks/recommendedActions JSON blob: any
 * top-level array of strings is collected as plain notes; any top-level array
 * of non-strings (structured objects) contributes only its length, keyed by
 * field name. Works uniformly across B3-B7's differently-shaped payloads
 * without a bespoke parser per batch, so it does not drift when any of them
 * change their own internal shape independently.
 */
export function extractStringsAndCounts(value: Prisma.JsonValue | null | undefined): { strings: string[]; counts: Record<string, number> } {
  const strings: string[] = [];
  const counts: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { strings, counts };

  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'version' || key === 'generatedAt') continue;
    if (!Array.isArray(fieldValue)) continue;
    if (fieldValue.every((item): item is string => typeof item === 'string')) {
      strings.push(...fieldValue);
    } else {
      counts[key] = fieldValue.length;
    }
  }

  return { strings, counts };
}
