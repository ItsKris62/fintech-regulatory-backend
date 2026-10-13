import { createHash } from 'crypto';
import {
  GAP_ANALYSIS_DEPTH_ENGINE_VERSION,
  GAP_ANALYSIS_EXECUTION_PROFILE_VERSION,
  getDepthProfileVersion,
} from '@/config/gap-analysis-depth-profiles';
import { SCORING_VERSION_V2 } from './scoring/gap-analysis-scoring';
import type { CorpusVersionSnapshot } from '@/lib/rag/corpus-version';

export const GAP_ANALYSIS_RESULT_SCHEMA_VERSION = 'gap-analysis-result-v2';
export const GAP_ANALYSIS_RETRIEVAL_VERSION = 'regulatory-intelligence-v1';

/**
 * A reservation is deliberately narrower than "any historical row". Failed,
 * cancelled, dead-lettered, and soft-deleted attempts remain auditable but do
 * not prevent a corrected request from starting a new execution.
 */
export const GAP_ANALYSIS_REUSABLE_EXECUTION_STATUSES = [
  'UPLOADING',
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'ANALYZING',
  'COMPLETING',
  'COMPLETED',
] as const;

export type GapAnalysisExecutionIdentityInput = {
  organizationId: string;
  documentChecksum: string;
  jurisdictionCode: string;
  frameworkSlugs: readonly string[];
  benchmarkVersionIds: readonly string[];
  focusAreas: readonly string[];
  analysisDepth: 'quick' | 'standard' | 'deep';
  corpusVersions: CorpusVersionSnapshot;
  pineconeIndex: string;
  pineconeNamespace: string;
};

/**
 * Stable, content-free semantic identity for a customer-visible execution.
 * Keep this versioned: changing semantics intentionally invalidates reuse.
 */
export function buildGapAnalysisExecutionIdentity(input: GapAnalysisExecutionIdentityInput) {
  const canonical = {
    identityVersion: 'gap-analysis-execution-v1',
    organizationId: input.organizationId,
    documentChecksum: input.documentChecksum,
    jurisdictionCode: input.jurisdictionCode.toUpperCase(),
    frameworkSlugs: [...new Set(input.frameworkSlugs.map((value) => value.trim().toLowerCase()))].sort(),
    benchmarkVersionIds: [...new Set(input.benchmarkVersionIds)].sort(),
    focusAreas: [...new Set(input.focusAreas.map((value) => value.trim().toLowerCase()))].sort(),
    analysisDepth: input.analysisDepth,
    depthEngineVersion: GAP_ANALYSIS_DEPTH_ENGINE_VERSION,
    depthProfileVersion: getDepthProfileVersion(input.analysisDepth),
    executionProfileVersion: GAP_ANALYSIS_EXECUTION_PROFILE_VERSION,
    resultSchemaVersion: GAP_ANALYSIS_RESULT_SCHEMA_VERSION,
    scoringVersion: SCORING_VERSION_V2,
    retrievalVersion: GAP_ANALYSIS_RETRIEVAL_VERSION,
    corpusVersions: Object.fromEntries(Object.entries(input.corpusVersions).sort(([a], [b]) => a.localeCompare(b))),
    pineconeIndex: input.pineconeIndex,
    pineconeNamespace: input.pineconeNamespace,
  };
  return {
    canonical,
    key: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}
