import { z } from 'zod';
import {
  RegulatoryAuthorityType,
  RegulatorySourceType,
  RegulatoryInformationType,
  RegulatoryStage,
  RegulatoryVerificationState,
  RegulatoryMateriality,
  RegulatoryEvidenceRole,
} from '@prisma/client';
import { AUDITED_JURISDICTIONS } from '@/config/jurisdictions.config';

export {
  RegulatoryAuthorityType,
  RegulatorySourceType,
  RegulatoryInformationType,
  RegulatoryStage,
  RegulatoryVerificationState,
  RegulatoryMateriality,
  RegulatoryEvidenceRole,
};

export const JURISDICTION_CODES = AUDITED_JURISDICTIONS;

// ---------------------------------------------------------------------------
// Source Registry Schemas
// ---------------------------------------------------------------------------

export const createRegulatorySourceSchema = z.object({
  sourceKey: z.string().min(3).max(100).regex(/^[a-z0-9-]+$/, 'sourceKey must be lowercase kebab-case (a-z, 0-9, -)'),
  name: z.string().min(2).max(255),
  jurisdictionCode: z.enum(JURISDICTION_CODES).default('KE'),
  regulatoryBody: z.string().min(2).max(100),
  authorityType: z.nativeEnum(RegulatoryAuthorityType).default(RegulatoryAuthorityType.PRIMARY_OFFICIAL),
  sourceType: z.nativeEnum(RegulatorySourceType).default(RegulatorySourceType.WEBSITE),
  baseUrl: z.string().url().max(2000),
  fetchUrl: z.string().url().max(2000).optional(),
  isActive: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateRegulatorySourceSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  jurisdictionCode: z.enum(JURISDICTION_CODES).optional(),
  regulatoryBody: z.string().min(2).max(100).optional(),
  authorityType: z.nativeEnum(RegulatoryAuthorityType).optional(),
  sourceType: z.nativeEnum(RegulatorySourceType).optional(),
  baseUrl: z.string().url().max(2000).optional(),
  fetchUrl: z.string().url().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const listRegulatorySourcesSchema = z.object({
  jurisdictionCode: z.enum(JURISDICTION_CODES).optional(),
  regulatoryBody: z.string().optional(),
  authorityType: z.nativeEnum(RegulatoryAuthorityType).optional(),
  isActive: z.boolean().optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------------------------
// Snapshot Ingestion Schemas
// ---------------------------------------------------------------------------

export const ingestRegulatorySnapshotSchema = z.object({
  sourceId: z.string().min(1),
  sourceUrl: z.string().url().max(2000),
  rawPayload: z.string().optional(),
  rawText: z.string().optional(),
  rawStorageKey: z.string().max(500).optional(),
  title: z.string().max(500).optional(),
  httpStatus: z.number().int().optional(),
  contentType: z.string().max(100).optional(),
  etag: z.string().max(200).optional(),
  lastModified: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface SnapshotIngestResult {
  status: 'CREATED' | 'DUPLICATE';
  snapshotId: string;
  sourceId: string;
  canonicalUrl: string;
  contentHash: string;
  isNew: boolean;
}

// ---------------------------------------------------------------------------
// Source Item Schemas
// ---------------------------------------------------------------------------

export const createRegulatorySourceItemSchema = z.object({
  dedupeKey: z.string().min(5).max(255),
  sourceId: z.string().min(1),
  primarySnapshotId: z.string().min(1).optional(),
  jurisdictionCode: z.enum(JURISDICTION_CODES).default('KE'),
  regulator: z.string().min(2).max(100),
  title: z.string().min(5).max(500),
  officialTitle: z.string().max(500).optional(),
  summary: z.string().min(10).max(5000),
  informationType: z.nativeEnum(RegulatoryInformationType).default(RegulatoryInformationType.NOTICE),
  regulatoryStage: z.nativeEnum(RegulatoryStage).default(RegulatoryStage.ISSUED),
  verificationState: z.nativeEnum(RegulatoryVerificationState).default(RegulatoryVerificationState.UNVERIFIED),
  materiality: z.nativeEnum(RegulatoryMateriality).default(RegulatoryMateriality.MEDIUM),
  relevanceScore: z.number().min(0).max(1).optional(),
  publicationDate: z.string().datetime().optional(),
  effectiveDate: z.string().datetime().optional(),
  consultationDeadline: z.string().datetime().optional(),
  complianceDeadline: z.string().datetime().optional(),
  affectedSectors: z.array(z.string()).default([]),
  affectedEntityTypes: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateRegulatorySourceItemSchema = z.object({
  title: z.string().min(5).max(500).optional(),
  officialTitle: z.string().max(500).optional(),
  summary: z.string().min(10).max(5000).optional(),
  informationType: z.nativeEnum(RegulatoryInformationType).optional(),
  regulatoryStage: z.nativeEnum(RegulatoryStage).optional(),
  verificationState: z.nativeEnum(RegulatoryVerificationState).optional(),
  materiality: z.nativeEnum(RegulatoryMateriality).optional(),
  relevanceScore: z.number().min(0).max(1).optional(),
  publicationDate: z.string().datetime().nullable().optional(),
  effectiveDate: z.string().datetime().nullable().optional(),
  consultationDeadline: z.string().datetime().nullable().optional(),
  complianceDeadline: z.string().datetime().nullable().optional(),
  affectedSectors: z.array(z.string()).optional(),
  affectedEntityTypes: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  supersededById: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const linkEvidenceSchema = z.object({
  sourceItemId: z.string().min(1),
  snapshotId: z.string().min(1),
  role: z.nativeEnum(RegulatoryEvidenceRole).default(RegulatoryEvidenceRole.SUPPORTING),
  isPrimary: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

export const listRegulatorySourceItemsSchema = z.object({
  sourceId: z.string().optional(),
  jurisdictionCode: z.enum(JURISDICTION_CODES).optional(),
  regulator: z.string().optional(),
  informationType: z.nativeEnum(RegulatoryInformationType).optional(),
  regulatoryStage: z.nativeEnum(RegulatoryStage).optional(),
  verificationState: z.nativeEnum(RegulatoryVerificationState).optional(),
  materiality: z.nativeEnum(RegulatoryMateriality).optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------------------------
// Draft Alert Creation Schema
// ---------------------------------------------------------------------------

export const createRegulatoryAlertDraftSchema = z.object({
  sourceItemId: z.string().min(1),
  automationDraftKey: z.string().min(8).max(200),
  title: z.string().min(5).max(200).optional(),
  summary: z.string().min(10).max(500).optional(),
  body: z.string().min(20).optional(),
  category: z.string().min(2).max(100).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  effectiveDate: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  sourceUrl: z.string().url().optional(),
});

// ---------------------------------------------------------------------------
// Backend Regulatory Fetch Schemas
// ---------------------------------------------------------------------------

export const fetchRegulatorySourceSchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    sourceKey: z.string().min(1).optional(),
    executionMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.sourceId || v.sourceKey), {
    message: 'Either sourceId or sourceKey must be provided',
  });

export type CreateRegulatorySourceInput = z.input<typeof createRegulatorySourceSchema>;
export type UpdateRegulatorySourceInput = z.input<typeof updateRegulatorySourceSchema>;
export type ListRegulatorySourcesInput = z.input<typeof listRegulatorySourcesSchema>;
export type IngestRegulatorySnapshotInput = z.input<typeof ingestRegulatorySnapshotSchema>;
export type CreateRegulatorySourceItemInput = z.input<typeof createRegulatorySourceItemSchema>;
export type UpdateRegulatorySourceItemInput = z.input<typeof updateRegulatorySourceItemSchema>;
export type LinkEvidenceInput = z.input<typeof linkEvidenceSchema>;
export type ListRegulatorySourceItemsInput = z.input<typeof listRegulatorySourceItemsSchema>;
export type CreateRegulatoryAlertDraftInput = z.input<typeof createRegulatoryAlertDraftSchema>;
export type FetchRegulatorySourceInput = z.input<typeof fetchRegulatorySourceSchema>;

export type RegulatoryFetchResultStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';
export type RegulatoryChangeType = 'NEW' | 'CHANGED' | 'UNCHANGED';

export interface RegulatoryFetchResult {
  status: RegulatoryFetchResultStatus;
  changeType?: RegulatoryChangeType;
  sourceId: string;
  sourceKey: string;
  snapshotId?: string | null;
  contentHash?: string;
  canonicalUrl?: string;
  httpStatus?: number;
  error?: string;
  isNew?: boolean;
}

export const zodRegulatoryEnrichmentOutputSchema = z.object({
  title: z.string().min(5).max(500).describe('Concise human-readable regulatory title'),
  officialTitle: z.string().max(500).nullable().optional().describe('Full official circular or regulation title if present'),
  officialReferenceNumber: z.string().max(100).nullable().optional().describe('Official circular / gazette / reference number if explicitly stated in text'),
  summary: z.string().min(10).max(5000).describe('Objective factual summary of the regulatory development'),
  whatChanged: z.string().max(2000).nullable().optional().describe('Specific delta or new obligation introduced'),
  complianceImplications: z.string().max(2000).nullable().optional().describe('Impact on fintech/financial services operations'),
  recommendedActions: z.array(z.string().max(500)).default([]).describe('Concrete actionable steps for compliance teams'),
  informationType: z.nativeEnum(RegulatoryInformationType).default(RegulatoryInformationType.NOTICE),
  regulatoryStage: z.nativeEnum(RegulatoryStage).default(RegulatoryStage.ISSUED),
  materiality: z.nativeEnum(RegulatoryMateriality).default(RegulatoryMateriality.MEDIUM),
  publicationDate: z.string().datetime().nullable().optional().describe('Publication date if explicitly in text; null if absent'),
  effectiveDate: z.string().datetime().nullable().optional().describe('Legal effective date if explicitly in text; null if absent'),
  consultationDeadline: z.string().datetime().nullable().optional().describe('Consultation comments deadline if explicitly in text; null if absent'),
  complianceDeadline: z.string().datetime().nullable().optional().describe('Mandatory compliance deadline if explicitly in text; null if absent'),
  affectedSectors: z.array(z.string()).default([]).describe('Sectors affected e.g. Payments, Banking, Lending, Digital Asset, Insurance'),
  affectedEntityTypes: z.array(z.string()).default([]).describe('Entities affected e.g. Commercial Banks, PSPs, Microfinance, Asset Managers'),
  topics: z.array(z.string()).default([]).describe('Compliance topics e.g. Capital Adequacy, AML/CFT, Data Protection, Consumer Protection'),
  alertCategory: z.enum(['PRUDENTIAL', 'DATA_PROTECTION', 'AML_CFT', 'LICENSING', 'CAPITAL_MARKETS', 'GENERAL']).default('GENERAL'),
  alertSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  confidence: z.number().min(0).max(1).default(0.8).describe('Extraction confidence from 0 to 1'),
  uncertainties: z.array(z.string()).default([]).describe('Explicit ambiguities or uncertainties identified in the evidence'),
});

export type RegulatoryEnrichmentOutput = z.infer<typeof zodRegulatoryEnrichmentOutputSchema>;

// ---------------------------------------------------------------------------
// Machine Procedure Input Schemas (Phase 3)
// ---------------------------------------------------------------------------

export const getRegulatorySnapshotMachineSchema = z.object({
  snapshotId: z.string().min(1),
});

export const processRegulatorySnapshotMachineSchema = z.object({
  snapshotId: z.string().min(1),
  correlationId: z.string().optional(),
});

export const listPendingRegulatorySnapshotsMachineSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
});

export type GetRegulatorySnapshotMachineInput = z.input<typeof getRegulatorySnapshotMachineSchema>;
export type ProcessRegulatorySnapshotMachineInput = z.input<typeof processRegulatorySnapshotMachineSchema>;
export type ListPendingRegulatorySnapshotsMachineInput = z.input<typeof listPendingRegulatorySnapshotsMachineSchema>;

export interface ProcessRegulatorySnapshotResult {
  status: 'COMPLETED' | 'SKIPPED' | 'BUDGET_BLOCKED' | 'FAILED_REVIEW' | 'FAILED_FATAL';
  snapshotId: string;
  sourceItemId?: string | null;
  alertDraftId?: string | null;
  draftCreated: boolean;
  duplicate: boolean;
  materiality?: RegulatoryMateriality;
  verificationState?: RegulatoryVerificationState;
  costUsd?: number;
  tokensUsed?: { inputTokens: number; outputTokens: number };
  error?: string;
  whatChanged?: string | null;
}

// ---------------------------------------------------------------------------
// Item Deduplication Key Hierarchy
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic deduplication key following the identity hierarchy:
 * 1. Official document/reference number: ref:JURISDICTION:REGULATOR:REF_NUM
 * 2. Stable canonical document URL: url:JURISDICTION:REGULATOR:CANONICAL_URL
 * 3. Source-provided GUID: guid:SOURCE_ID:GUID
 * 4. Deterministic fallback fingerprint: fp:v1:SOURCE_ID:HASH(title + date)
 */
export function computeRegulatoryItemDedupeKey(params: {
  jurisdictionCode: string;
  regulator: string;
  sourceId: string;
  title: string;
  officialReference?: string | null;
  canonicalUrl?: string | null;
  guid?: string | null;
  publicationDate?: string | null;
}): string {
  // 1. Official reference number
  if (params.officialReference && params.officialReference.trim()) {
    const cleanRef = params.officialReference.trim().toUpperCase().replace(/\s+/g, '-');
    return `ref:${params.jurisdictionCode}:${params.regulator.toUpperCase()}:${cleanRef}`;
  }
  // 2. Stable canonical document URL
  if (params.canonicalUrl && params.canonicalUrl.trim()) {
    return `url:${params.jurisdictionCode}:${params.regulator.toUpperCase()}:${params.canonicalUrl.trim()}`;
  }
  // 3. Source-provided GUID
  if (params.guid && params.guid.trim()) {
    return `guid:${params.sourceId}:${params.guid.trim()}`;
  }
  // 4. Deterministic fallback fingerprint
  const dateStr = params.publicationDate ? params.publicationDate.slice(0, 10) : '';
  const payload = `${params.sourceId}|${params.title.trim().toLowerCase()}|${dateStr}`;
  // Simple deterministic hash
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash << 5) - hash + payload.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `fp:v1:${params.sourceId}:${hex}`;
}

