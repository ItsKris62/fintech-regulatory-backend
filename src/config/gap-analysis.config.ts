import { PLAN_ENTITLEMENTS, type PlanEntitlementConfig } from './entitlements.config';
import type { EffectivePlan } from '@/types/plan.types';
import { FREE_TRIAL_LIMITS } from '@/types/plan.types';
import { GAP_ANALYSIS_DEPTH_PRODUCT_COPY } from './gap-analysis-depth-profiles';

export const GAP_ANALYSIS_DEPTHS = ['quick', 'standard', 'deep'] as const;
export type GapAnalysisDepth = (typeof GAP_ANALYSIS_DEPTHS)[number];

export type GapAnalysisDepthAvailability = Readonly<Record<GapAnalysisDepth, boolean>>;

const PILOT_FRAMEWORK_DEPTH_AVAILABILITY: Readonly<Record<string, GapAnalysisDepthAvailability>> = {
  'KE/dpa-2019': { quick: true, standard: true, deep: false },
  'RW/rw-dpa-2021': { quick: true, standard: true, deep: false },
  'MW/mw-cybersecurity-2016': { quick: true, standard: true, deep: false },
  'NG/ndpa-2023': { quick: true, standard: true, deep: false },
};

export const GAP_ANALYSIS_DEFAULT_DEPTH_AVAILABILITY: GapAnalysisDepthAvailability = {
  quick: true,
  standard: true,
  deep: false,
};

export function getFrameworkDepthAvailability(
  jurisdiction: string,
  frameworkSlug: string,
): GapAnalysisDepthAvailability {
  return PILOT_FRAMEWORK_DEPTH_AVAILABILITY[
    `${jurisdiction.toUpperCase()}/${frameworkSlug.toLowerCase().replace(/_/g, '-')}`
  ] ?? GAP_ANALYSIS_DEFAULT_DEPTH_AVAILABILITY;
}

export function isFrameworkDepthAvailable(
  jurisdiction: string,
  frameworkSlug: string,
  depth: GapAnalysisDepth,
): boolean {
  return getFrameworkDepthAvailability(jurisdiction, frameworkSlug)[depth];
}

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
    pilotAvailability: getGapAnalysisPilotAvailability(),
    depthAvailability: {
      default: GAP_ANALYSIS_DEFAULT_DEPTH_AVAILABILITY,
      frameworks: PILOT_FRAMEWORK_DEPTH_AVAILABILITY,
    },
  } as const;
}

export type PilotCorpusReadiness =
  | 'UNAVAILABLE'
  | 'INDEXED_PARTIAL'
  | 'VALIDATED_FOR_GAP_ANALYSIS'
  | 'STALE_OR_UNKNOWN';

export interface PilotCountryConfig {
  pilotEnabled: boolean;
  readiness: PilotCorpusReadiness;
  validatedFrameworks: readonly string[];
  indexedPartialFrameworks: readonly string[];
  unavailableFrameworks: readonly string[];
  message?: string;
}

export const GAP_ANALYSIS_PILOT_CONFIG: Readonly<{
  jurisdictions: Record<string, PilotCountryConfig>;
}> = {
  jurisdictions: {
    KE: {
      pilotEnabled: true,
      readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
      validatedFrameworks: ['dpa-2019'],
      indexedPartialFrameworks: ['odpc-regs-2021', 'cbk-cyber', 'cbk-kyc', 'cbk-prudential', 'pocamla', 'nps-2011'],
      unavailableFrameworks: [],
      message: 'Kenya corpus validated for pilot testing under Data Protection Act 2019.',
    },
    RW: {
      pilotEnabled: true,
      readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
      validatedFrameworks: ['rw-dpa-2021'],
      indexedPartialFrameworks: ['bnr-cybersecurity-2021', 'bnr-psp-2018'],
      unavailableFrameworks: [],
      message: 'Rwanda corpus validated for pilot testing under Law N° 058/2021 relating to Personal Data and Privacy.',
    },
    MW: {
      pilotEnabled: true,
      readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
      validatedFrameworks: ['mw-cybersecurity-2016'],
      indexedPartialFrameworks: ['mw-dpa-2024', 'rbm-payment-systems-2016'],
      unavailableFrameworks: [],
      message: 'Malawi corpus validated for pilot testing under Electronic Transactions and Cyber Security Act 2016.',
    },
    NG: {
      pilotEnabled: true,
      readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
      validatedFrameworks: ['ndpa-2023'],
      indexedPartialFrameworks: ['cbn-cybersecurity-2024', 'bofia-2020'],
      unavailableFrameworks: [],
      message: 'Nigeria corpus validated for pilot testing under Nigeria Data Protection Act 2023.',
    },
  },
};

export interface PilotJurisdictionAvailability {
  jurisdiction: string;
  pilotEnabled: boolean;
  readiness: PilotCorpusReadiness;
  message?: string;
}

export interface PilotFrameworkAvailability {
  slug: string;
  pilotEnabled: boolean;
  readiness: PilotCorpusReadiness;
}

export interface GapAnalysisPilotAvailability {
  jurisdictions: Record<string, PilotJurisdictionAvailability>;
}

export function getPilotJurisdictionAvailability(code: string): PilotJurisdictionAvailability {
  const upper = code.toUpperCase();
  const enabledEnv = process.env.GAP_ANALYSIS_PILOT_ENABLED_JURISDICTIONS;
  const validatedEnv = process.env.GAP_ANALYSIS_PILOT_VALIDATED_JURISDICTIONS;

  const enabledList = (enabledEnv ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const validatedList = (validatedEnv ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const isExplicitlyValidated = validatedList.includes(upper);
  const isExplicitlyEnabled = enabledList.includes(upper) || isExplicitlyValidated;

  if (isExplicitlyValidated) {
    return {
      jurisdiction: upper,
      pilotEnabled: true,
      readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
    };
  }

  if (isExplicitlyEnabled) {
    return {
      jurisdiction: upper,
      pilotEnabled: true,
      readiness: 'INDEXED_PARTIAL',
      message: `Corpus validation in progress for ${upper}. Enabled for controlled pilot testing with partial coverage.`,
    };
  }

  // Strict gate mode (e.g. baseline test simulation): fail-closed
  if (process.env.GAP_ANALYSIS_PILOT_STRICT_GATE === 'true') {
    if (upper === 'KE') {
      return {
        jurisdiction: 'KE',
        pilotEnabled: false,
        readiness: 'INDEXED_PARTIAL',
        message: 'Corpus validation in progress. Regulatory sources for Kenya are undergoing release validation. Gap Analysis pilot testing is pending formal release validation.',
      };
    }
    return {
      jurisdiction: upper,
      pilotEnabled: false,
      readiness: 'UNAVAILABLE',
      message: `Gap Analysis corpus for jurisdiction ${upper} is not yet available or enabled for pilot testing.`,
    };
  }

  // Release configuration from GAP_ANALYSIS_PILOT_CONFIG
  const configured = GAP_ANALYSIS_PILOT_CONFIG.jurisdictions[upper];
  if (configured) {
    return {
      jurisdiction: upper,
      pilotEnabled: configured.pilotEnabled,
      readiness: configured.readiness,
      message: configured.message,
    };
  }

  return {
    jurisdiction: upper,
    pilotEnabled: false,
    readiness: 'UNAVAILABLE',
    message: `Gap Analysis corpus for jurisdiction ${upper} is not yet available or enabled for pilot testing.`,
  };
}

export function getPilotFrameworkAvailability(
  slug: string,
  _jurisdiction?: string,
): PilotFrameworkAvailability {
  const enabledEnv = process.env.GAP_ANALYSIS_PILOT_ENABLED_FRAMEWORKS;
  const validatedEnv = process.env.GAP_ANALYSIS_PILOT_VALIDATED_FRAMEWORKS;

  const enabledSlugs = (enabledEnv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const validatedSlugs = (validatedEnv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const lowerSlug = slug.toLowerCase().replace(/_/g, '-');
  const isValidated = validatedSlugs.includes(lowerSlug) || validatedSlugs.includes('*');
  const isEnabled = enabledSlugs.includes(lowerSlug) || enabledSlugs.includes('*') || isValidated;

  if (isValidated) {
    return {
      slug,
      pilotEnabled: true,
      readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
    };
  }

  if (isEnabled) {
    return {
      slug,
      pilotEnabled: true,
      readiness: 'INDEXED_PARTIAL',
    };
  }

  // Strict gate mode (e.g. baseline test simulation): fail-closed
  if (process.env.GAP_ANALYSIS_PILOT_STRICT_GATE === 'true') {
    return {
      slug,
      pilotEnabled: false,
      readiness: 'UNAVAILABLE',
    };
  }

  // Release configuration from GAP_ANALYSIS_PILOT_CONFIG
  for (const config of Object.values(GAP_ANALYSIS_PILOT_CONFIG.jurisdictions)) {
    if (config.validatedFrameworks.map((f) => f.toLowerCase()).includes(lowerSlug)) {
      return {
        slug,
        pilotEnabled: true,
        readiness: 'VALIDATED_FOR_GAP_ANALYSIS',
      };
    }
    if (config.indexedPartialFrameworks.map((f) => f.toLowerCase()).includes(lowerSlug)) {
      return {
        slug,
        pilotEnabled: false,
        readiness: 'INDEXED_PARTIAL',
      };
    }
  }

  return {
    slug,
    pilotEnabled: false,
    readiness: 'UNAVAILABLE',
  };
}

export function getGapAnalysisPilotAvailability(): GapAnalysisPilotAvailability {
  return {
    jurisdictions: {
      KE: getPilotJurisdictionAvailability('KE'),
      RW: getPilotJurisdictionAvailability('RW'),
      MW: getPilotJurisdictionAvailability('MW'),
      NG: getPilotJurisdictionAvailability('NG'),
    },
  };
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
