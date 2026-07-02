import type { Prisma } from '@prisma/client';

export const SALES_AGENT_TYPE = 'sales-growth' as const;

export const SALES_DRAFT_STATUSES = ['DRAFT', 'REVIEWED', 'DISMISSED'] as const;
export type SalesDraftStatus = (typeof SALES_DRAFT_STATUSES)[number];

export const SALES_DRAFT_PRIORITIES = ['high', 'medium', 'low'] as const;
export type SalesDraftPriority = (typeof SALES_DRAFT_PRIORITIES)[number];

export interface SalesProspectRow {
  signalId: string;
  sourceUrl: string;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: string;
  title: string;
  summary: string;
  severity: string;
  effectiveDate: Date | null;
  complianceWindowDays: number | null;
  organizationId: string;
  reason: string;
  cohort: string | null;
  organizationName: string;
  organizationType: string;
  industry: string | null;
  cbkLicenseNumber: string | null;
  plan: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  pilotStatus: string | null;
  pilotStartsAt: Date | null;
  pilotExpiresAt: Date | null;
}

export interface GroundedSalesProspect {
  signalId: string;
  organizationId: string;
  sourceUrl: string;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: string;
  title: string;
  summary: string;
  severity: string;
  effectiveDate: string | null;
  complianceWindowDays: number | null;
  reason: string;
  cohort: string | null;
  organizationName: string;
  organizationType: string;
  industry: string | null;
  cbkLicenseNumber: string | null;
  plan: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  pilotStatus: string | null;
  pilotStartsAt: string | null;
  pilotExpiresAt: string | null;
}

export type EngagementContext =
  | {
      available: true;
      lastSeenAt: string | null;
      eventCount7d: number;
    }
  | {
      available: false;
      reason: string;
    };

export interface OutreachDraftContent {
  subject: string;
  body: string;
  priority: SalesDraftPriority;
  metadata: Prisma.InputJsonValue;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    provider: string;
    model: string;
  };
}

export interface PersistedSalesOutreachDraft {
  id: string;
  sourceSignalId: string;
  organizationId: string;
  triggerReason: string;
  engagementContext: Prisma.JsonValue | null;
  subject: string;
  body: string;
  priority: string;
  status: string;
  agentRunId: string;
  generatedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  editedBody: string | null;
  sourceFingerprint: string;
  metadata: Prisma.JsonValue | null;
}

export interface SalesRunResult {
  runId: string | null;
  status: 'SKIPPED_DISABLED' | 'DUPLICATE' | 'COMPLETED' | 'HALTED_BUDGET' | 'FAILED';
  reportId?: string;
  draftsCreated: number;
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function sourceFingerprintFor(signalId: string, organizationId: string): string {
  return `${signalId}|${organizationId}`;
}
