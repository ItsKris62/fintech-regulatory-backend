import type { Prisma } from '@prisma/client';
import type { LLMProviderName } from '@/lib/ai/gateway/types';

export const REG_INTEL_AGENT_TYPE = 'regulatory-intelligence' as const;
export const RAW_CONTENT_MAX_CHARS = 12000;

export type RegulatoryDocumentType =
  | 'guideline'
  | 'notice'
  | 'amendment'
  | 'consultation'
  | 'enforcement'
  | 'gazette'
  | 'other';

export type RegulatorySeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type RegulatorySignalStatus = 'NEW' | 'REVIEWED' | 'DISMISSED';

export interface RawRegulatorySourceItem {
  id: string;
  monitorId: string;
  title: string;
  url: string;
  normalizedUrl: string;
  summary: string | null;
  jurisdiction: string;
  authorityType: string;
  sourceType: string;
  publicationDate: Date | null;
  discoveredAt: Date;
  contentHash: string;
  rawContentHash: string | null;
  monitorName: string;
}

export interface UnverifiedSourceGap {
  sourceId: string;
  name: string;
  jurisdiction: string;
  regulatoryBody: string;
  sourceUrl: string | null;
  reason: string;
}

export interface SourceMonitorResult {
  items: RawRegulatorySourceItem[];
  unverifiedSourceGaps: UnverifiedSourceGap[];
  monitorSummaries: Array<{
    monitorId: string;
    name: string;
    status: string;
    itemsFound: number;
    itemsCreated: number;
    duplicateCount: number;
    failureCount: number;
    errorMessage: string | null;
  }>;
}

export interface ScannedSignalCandidate {
  sourceItem: RawRegulatorySourceItem;
  isRegulatory: boolean;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: RegulatoryDocumentType;
  confidence: number;
  reason: string;
}

export interface ProviderUsage {
  provider: LLMProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ClassifiedSignalCore {
  sourceItem: RawRegulatorySourceItem;
  sourceUrl: string;
  normalizedUrl: string;
  contentHash: string;
  jurisdiction: string;
  regulatoryBody: string;
  documentType: RegulatoryDocumentType;
  title: string;
  summary: string;
  affectedSectors: string[];
  affectedObligations: string[];
  severityLevel: RegulatorySeverity;
  effectiveDate: string | null;
  complianceWindowDays: number | null;
  referencedFrameworks: string[];
  rawContent: string | null;
  providerTrace: {
    scanningProvider: 'gemini';
    analysisProvider: 'anthropic';
    scanningModel: string;
    analysisModel: string;
  };
}

export interface CorpusGapResult {
  corpusGapDetected: boolean;
  corpusGapDetails: {
    missingFrameworks: string[];
    checkedQueries: string[];
    matchedFrameworks: string[];
  };
}

export interface PilotFintechImpact {
  organizationId: string;
  organizationName: string;
  userId: string;
  userEmail: string;
  cohort: string | null;
  reason: string;
  matchedFields: string[];
}

export interface RegulatorySignalForReport extends ClassifiedSignalCore, CorpusGapResult {
  id?: string;
  status: RegulatorySignalStatus;
  pilotFintechsAffected: PilotFintechImpact[];
}

export interface RecommendedAction {
  category: 'marketing' | 'sales' | 'corpus';
  signalId?: string;
  actionType: string;
  priority: RegulatorySeverity;
  brief: string;
  organizationId?: string;
  sourceUrl?: string;
}

export interface RegIntelReportPayload {
  version: 1;
  generatedAt: string;
  agentRunId: string;
  signals: Prisma.InputJsonValue[];
}

export interface RegIntelRecommendedActionsPayload {
  version: 1;
  generatedAt: string;
  marketing: RecommendedAction[];
  sales: RecommendedAction[];
  corpus: RecommendedAction[];
}

export interface RegIntelRisksPayload {
  version: 1;
  generatedAt: string;
  critical: string[];
  high: string[];
  budgetOrCoverageNotes: string[];
  sourceFailures: string[];
}

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}