import type { EffectivePlan } from '@/types/plan.types';

// ============================================================================
// Avatar upload limits  -  flat across all tiers (no tier differentiation).
// ============================================================================

export const AVATAR_UPLOAD_LIMITS = {
  maxFileSizeMB: 5,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
} as const;

// ============================================================================
// Gap analysis file upload limits  -  per-tier maximum single-file size.
// Count limits are enforced separately via checkUsageLimit middleware.
// ============================================================================

export interface GapAnalysisTierLimits {
  /** Maximum size of the uploaded file in megabytes. 0 = blocked. */
  maxFileSizeMB: number;
}

export const GAP_ANALYSIS_UPLOAD_LIMITS: Record<EffectivePlan, GapAnalysisTierLimits> = {
  REGULATOR: { maxFileSizeMB: 0 },
  FREE_TRIAL: { maxFileSizeMB: 10 },
  STARTUP:    { maxFileSizeMB: 0 },
  BUSINESS:   { maxFileSizeMB: 20 },
  ENTERPRISE: { maxFileSizeMB: 20 },
};

// ============================================================================
// Derived constants
// ============================================================================

/** Largest single-file size any tier can upload to the vault (ENTERPRISE: 50 MB).
 * Used as the Zod schema ceiling in vault.schema.ts. */
export const VAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Largest gap-analysis file any tier can upload (BUSINESS/ENTERPRISE: 20 MB).
 * A 20 MB binary file is ~27.3 MB when base64-encoded.
 * Used as the Zod schema ceiling in compliance.router.ts. */
export const GAP_ANALYSIS_MAX_BASE64_CHARS = 28_000_000;
