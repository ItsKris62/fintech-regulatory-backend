import type { Prisma } from '@prisma/client';

export const MARKETING_AGENT_TYPE = 'marketing' as const;

export const MARKETING_CONTENT_TYPES = ['newsletter_item', 'linkedin_post'] as const;
export type MarketingContentType = (typeof MARKETING_CONTENT_TYPES)[number];

export const MARKETING_DRAFT_STATUSES = ['DRAFT', 'REVIEWED', 'DISMISSED'] as const;
export type MarketingDraftStatus = (typeof MARKETING_DRAFT_STATUSES)[number];

export interface MarketingSignalRow {
  id: string;
  sourceUrl: string;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: string;
  title: string;
  summary: string;
  severity: string;
  affectedSectors: Prisma.JsonValue;
  affectedObligations: Prisma.JsonValue;
  effectiveDate: Date | null;
  complianceWindowDays: number | null;
  status: string;
  createdAt: Date;
}

export interface GroundedMarketingSignal {
  id: string;
  sourceUrl: string;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: string;
  title: string;
  summary: string;
  severity: string;
  affectedSectors: string[];
  affectedObligations: string[];
  effectiveDate: string | null;
  complianceWindowDays: number | null;
  status: string;
}

export interface DraftContent {
  title: string;
  body: string;
  brief: string;
  metadata: Prisma.InputJsonValue;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    provider: string;
    model: string;
  };
}

export interface PersistedMarketingDraft {
  id: string;
  contentType: string;
  sourceSignalIds: Prisma.JsonValue;
  sourceFingerprint: string;
  title: string;
  body: string;
  brief: string | null;
  status: string;
  agentRunId: string;
  generatedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  editedBody: string | null;
  metadata: Prisma.JsonValue | null;
}

export interface MarketingRunResult {
  runId: string | null;
  status: 'SKIPPED_DISABLED' | 'DUPLICATE' | 'COMPLETED' | 'HALTED_BUDGET' | 'FAILED';
  reportId?: string;
  draftsCreated: number;
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}