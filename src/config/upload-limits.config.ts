// ============================================================================
// Avatar upload limits  -  flat across all tiers (no tier differentiation).
// ============================================================================

export const AVATAR_UPLOAD_LIMITS = {
  maxFileSizeMB: 5,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
} as const;

// ============================================================================
// Derived constants
// ============================================================================

/** Largest single-file size any tier can upload to the vault (ENTERPRISE: 50 MB).
 * Used as the Zod schema ceiling in vault.schema.ts. */
export const VAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export {
  GAP_ANALYSIS_MAX_BASE64_CHARS,
  GAP_ANALYSIS_MAX_FILE_BYTES,
} from './gap-analysis.config';
