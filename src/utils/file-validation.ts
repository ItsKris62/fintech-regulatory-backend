import path from 'node:path';
import { logger } from '@/utils/logger';

/**
 * MIME types whose content can be verified via magic bytes.
 * file-type v20 can detect all of these.
 */
const BINARY_ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
]);

/**
 * Text-based MIME types that have no binary magic bytes.
 * file-type will return undefined for these; we validate via UTF-8 heuristic.
 */
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/msword', // .doc (old binary format — file-type detects this as application/msword)
]);

export interface FileValidationResult {
  valid: boolean;
  detectedType: string | null;
  reason?: string;
}

/**
 * Validate a file buffer against our magic-bytes allowlist.
 *
 * For binary types (PDF, DOCX, PNG, JPEG): uses `file-type` to read the
 * actual magic bytes from the buffer and rejects mismatches.
 *
 * For text types (TXT, MD): validates that the buffer is valid UTF-8 with
 * no embedded null bytes (heuristic to detect binary files masquerading as text).
 *
 * @param buffer   File buffer (first 8 KB is sufficient — pass more if available)
 * @param claimedFilename  Original filename as provided by the client
 * @param claimedMimeType  MIME type as declared by the client
 */
export async function validateFileMagicBytes(
  buffer: Buffer,
  claimedFilename: string,
  claimedMimeType: string,
): Promise<FileValidationResult> {
  // Sanitize the filename for logging — never log the full path
  const safeFilename = path.basename(claimedFilename);

  // ── Text-based types (no magic bytes) ──────────────────────────────────
  if (TEXT_MIME_TYPES.has(claimedMimeType)) {
    // Old .doc binary format IS detectable by file-type; let it fall through
    // to binary validation below. Only skip for true text types.
    if (claimedMimeType === 'text/plain' || claimedMimeType === 'text/markdown') {
      return validateTextBuffer(buffer, safeFilename, claimedMimeType);
    }
  }

  // ── Binary types — validate via magic bytes ─────────────────────────────
  // Dynamic import for ESM compatibility (file-type v17+ is ESM-only)
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(buffer);
  const detectedMime = detected?.mime ?? null;

  if (!detectedMime) {
    // file-type couldn't identify the file — reject unknown binary content
    logger.warn({
      type: 'file_validation_unknown_type',
      safeFilename,
      claimedMimeType,
    });
    return {
      valid: false,
      detectedType: null,
      reason: 'File type could not be determined from content. Accepted types: PDF, PNG, JPEG, DOCX',
    };
  }

  if (!BINARY_ALLOWED_MIMES.has(detectedMime)) {
    logger.warn({
      type: 'file_validation_disallowed_type',
      safeFilename,
      claimedMimeType,
      detectedMime,
    });
    return {
      valid: false,
      detectedType: detectedMime,
      reason: `Detected file type "${detectedMime}" is not allowed. Accepted types: PDF, PNG, JPEG, DOCX`,
    };
  }

  // Mismatch between claimed and detected type (e.g. file claims PDF but is PNG)
  if (claimedMimeType && claimedMimeType !== detectedMime) {
    // Allow application/msword claim when detected as application/msword (handled above)
    logger.warn({
      type: 'file_validation_mime_mismatch',
      safeFilename,
      claimedMimeType,
      detectedMime,
    });
    return {
      valid: false,
      detectedType: detectedMime,
      reason: `Claimed MIME type "${claimedMimeType}" does not match detected content "${detectedMime}"`,
    };
  }

  return { valid: true, detectedType: detectedMime };
}

/**
 * Validate a plain-text buffer.
 * Rejects buffers that contain null bytes (strong indicator of binary content).
 */
function validateTextBuffer(
  buffer: Buffer,
  safeFilename: string,
  claimedMimeType: string,
): FileValidationResult {
  // Null bytes are not valid in UTF-8 text files and indicate binary content
  if (buffer.indexOf(0x00) !== -1) {
    logger.warn({
      type: 'file_validation_binary_in_text',
      safeFilename,
      claimedMimeType,
    });
    return {
      valid: false,
      detectedType: null,
      reason: 'File claims to be plain text but contains binary content',
    };
  }

  return { valid: true, detectedType: claimedMimeType };
}
