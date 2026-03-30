import type { EffectivePlan } from '@/types/plan.types';

// ============================================================================
// Vault upload limits — single source of truth for per-tier enforcement.
// These values are read by vault.module.ts (backend enforcement) and returned
// via the vault.getUploadLimits tRPC query (frontend display).
// ============================================================================

export interface VaultTierLimits {
  /** Maximum size of a single uploaded file in megabytes. 0 = blocked. */
  maxFileSizeMB: number;
  /** Maximum total vault storage per org in megabytes. -1 = unlimited. 0 = blocked. */
  maxTotalStorageMB: number;
  /** MIME types permitted for vault uploads on this tier. */
  allowedMimeTypes: readonly string[];
}

export const VAULT_UPLOAD_LIMITS: Record<EffectivePlan, VaultTierLimits> = {
  REGULATOR: {
    maxFileSizeMB: 0,
    maxTotalStorageMB: 0,
    allowedMimeTypes: [],
  },
  FREE_TRIAL: {
    maxFileSizeMB: 5,
    maxTotalStorageMB: 100,
    allowedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain',
    ],
  },
  STARTUP: {
    maxFileSizeMB: 10,
    maxTotalStorageMB: 1024, // 1 GB
    allowedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/plain',
    ],
  },
  BUSINESS: {
    maxFileSizeMB: 25,
    maxTotalStorageMB: 10240, // 10 GB
    allowedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'image/png',
      'image/jpeg',
      'text/plain',
    ],
  },
  ENTERPRISE: {
    maxFileSizeMB: 50,
    maxTotalStorageMB: -1, // unlimited
    allowedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'image/png',
      'image/jpeg',
      'image/webp',
      'text/plain',
      'text/markdown',
    ],
  },
};

// ============================================================================
// Avatar upload limits — flat across all tiers (no tier differentiation).
// ============================================================================

export const AVATAR_UPLOAD_LIMITS = {
  maxFileSizeMB: 5,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
} as const;

// ============================================================================
// Gap analysis file upload limits — per-tier maximum single-file size.
// Count limits are enforced separately via checkUsageLimit middleware.
// ============================================================================

export interface GapAnalysisTierLimits {
  /** Maximum size of the uploaded file in megabytes. 0 = blocked. */
  maxFileSizeMB: number;
}

export const GAP_ANALYSIS_UPLOAD_LIMITS: Record<EffectivePlan, GapAnalysisTierLimits> = {
  REGULATOR: { maxFileSizeMB: 0 },
  FREE_TRIAL: { maxFileSizeMB: 10 },
  STARTUP:    { maxFileSizeMB: 10 },
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
