import { PLAN_ENTITLEMENTS, type PlanEntitlementConfig } from './entitlements.config';
import type { EffectivePlan } from '@/types/plan.types';
import { FREE_TRIAL_LIMITS } from '@/types/plan.types';
import { GAP_ANALYSIS_DEPTH_PRODUCT_COPY } from './gap-analysis-depth-profiles';

export const GAP_ANALYSIS_DEPTHS = ['quick', 'standard', 'deep'] as const;
export type GapAnalysisDepth = (typeof GAP_ANALYSIS_DEPTHS)[number];

export const GAP_ANALYSIS_DEPTH_UNIT_COST: Readonly<Record<GapAnalysisDepth, number>> = {
  quick: 1,
  standard: 2,
  deep: 5,
};

const GAP_ANALYSIS_DEPTHS_BY_PLAN: Readonly<Record<EffectivePlan, readonly GapAnalysisDepth[]>> = {
  FREE: [],
  STARTER: ['quick'],
  GROWTH: ['quick', 'standard'],
  BUSINESS: GAP_ANALYSIS_DEPTHS,
  ENTERPRISE: GAP_ANALYSIS_DEPTHS,
  REGULATOR: [],
  STARTUP: ['quick'],
  // The current trial contract grants five lifetime Gap Analysis units and has
  // historically allowed every depth. Preserve that behavior in this batch.
  FREE_TRIAL: GAP_ANALYSIS_DEPTHS,
};

/**
 * Safe ceiling while Gap Analysis requests still carry the complete document
 * as base64 through the request. Durable AI jobs store only the private
 * object reference and content-free execution metadata.
 */
export const GAP_ANALYSIS_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const GAP_ANALYSIS_MAX_BASE64_CHARS = 4 * Math.ceil(GAP_ANALYSIS_MAX_FILE_BYTES / 3);

export const GAP_ANALYSIS_FILE_EXTENSIONS = ['pdf', 'docx', 'txt'] as const;

export const GAP_ANALYSIS_ALLOWED_FILE_TYPES = [
  {
    extension: 'pdf',
    label: 'PDF',
    mimeTypes: ['application/pdf'],
  },
  {
    extension: 'docx',
    label: 'DOCX',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  {
    extension: 'txt',
    label: 'TXT',
    mimeTypes: ['text/plain'],
  },
] as const;

export type GapAnalysisFileType = (typeof GAP_ANALYSIS_FILE_EXTENSIONS)[number];

const GAP_ANALYSIS_FILE_TYPE_SET = new Set<string>(
  GAP_ANALYSIS_ALLOWED_FILE_TYPES.map((type) => type.extension),
);

export function getAllowedGapAnalysisDepths(plan: EffectivePlan): readonly GapAnalysisDepth[] {
  return GAP_ANALYSIS_DEPTHS_BY_PLAN[plan];
}

export function isGapAnalysisDepthAllowed(plan: EffectivePlan, depth: GapAnalysisDepth): boolean {
  return getAllowedGapAnalysisDepths(plan).includes(depth);
}

export function isGapAnalysisFileType(value: string): value is GapAnalysisFileType {
  return GAP_ANALYSIS_FILE_TYPE_SET.has(value.toLowerCase());
}

export function getGapAnalysisFileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

export function getGapAnalysisContract(
  plan: EffectivePlan,
  effectiveEntitlements: PlanEntitlementConfig = PLAN_ENTITLEMENTS[plan],
) {
  const entitlements = effectiveEntitlements;
  const enabled = entitlements.gapAnalysis.limit !== 0;
  const usageLimit = plan === 'FREE_TRIAL'
    ? FREE_TRIAL_LIMITS.gapAnalyses
    : entitlements.gapAnalysis.limit;
  const usagePeriod = plan === 'FREE_TRIAL'
    ? 'lifetime' as const
    : entitlements.gapAnalysis.period;

  return {
    enabled,
    usageLimit,
    usagePeriod,
    benchmarkDocuments: entitlements.benchmarkDocuments,
    countryLimit: entitlements.maxEnabledCountries,
    allowedDepths: getAllowedGapAnalysisDepths(plan),
    depthOptions: GAP_ANALYSIS_DEPTHS.map((depth) => ({
      depth,
      units: GAP_ANALYSIS_DEPTH_UNIT_COST[depth],
      ...GAP_ANALYSIS_DEPTH_PRODUCT_COPY[depth],
    })),
    maxFileSizeBytes: enabled ? GAP_ANALYSIS_MAX_FILE_BYTES : 0,
    allowedFileTypes: GAP_ANALYSIS_ALLOWED_FILE_TYPES,
    processingAcknowledgement: {
      version: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      text: GAP_ANALYSIS_PROCESSING_ACK_TEXT,
    },
  } as const;
}

/**
 * Canonical cross-border data processing consent version.
 */
export const GAP_ANALYSIS_PROCESSING_ACK_VERSION = '2026-10-01';

/**
 * Exact wording represented by GAP_ANALYSIS_PROCESSING_ACK_VERSION.
 * Exposed through getGapAnalysisLimits so the UI and server audit contract
 * cannot silently drift apart.
 */
export const GAP_ANALYSIS_PROCESSING_ACK_TEXT =
  'I understand that my document may be processed using AI services hosted outside my home jurisdiction, in accordance with SheriaBot\'s Privacy Policy and applicable data-protection law.';

/**
 * Isolated tenant storage path prefix for customer-owned policy documents.
 */
export const GAP_ANALYSIS_STORAGE_PATH_PREFIX = 'gap-analysis/';

/**
 * Gap Analysis document retention lifecycle states.
 * Note: Retention duration requires an explicit product/legal policy decision.
 */
export type GapAnalysisLifecycleState = 'ACTIVE' | 'PENDING_DELETION' | 'DELETED';
