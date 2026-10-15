// Ensure @xmldom/xmldom defaults mimeType to application/xml and suppresses deprecated errorHandler warning to prevent DOMParser crashes in mammoth
try {
  // pnpm keeps transitive dependencies under the package that owns them. Resolve
  // xmldom from mammoth's module graph so this patch also runs in compiled CJS.
  const { createRequire } = require('node:module') as typeof import('node:module');
  const mammothRequire = createRequire(require.resolve('mammoth'));
  const xmldom = mammothRequire('@xmldom/xmldom');
  if (xmldom?.DOMParser) {
    const OrigDOMParser = xmldom.DOMParser;
    xmldom.DOMParser = function (options: any) {
      if (options && options.errorHandler) {
        const origHandler = options.errorHandler;
        options = {
          ...options,
          onError: function (level: string, message: string, context: any) {
            if (message && message.includes('deprecated')) return;
            origHandler(level, message, context);
          },
        };
        delete options.errorHandler;
      }
      return new OrigDOMParser(options);
    };
    xmldom.DOMParser.prototype = OrigDOMParser.prototype;
    if (OrigDOMParser.prototype?.parseFromString) {
      const origParse = OrigDOMParser.prototype.parseFromString;
      OrigDOMParser.prototype.parseFromString = function (source: string, mimeType?: string) {
        return origParse.call(this, source, mimeType || 'application/xml');
      };
    }
  }
} catch {
  // ignore if not present
}
const mammoth = require('mammoth') as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
import { extractPdfTextWithMetadata } from '@/lib/pdf/extract-text';
import { logger } from '@/utils/logger';
import { GAP_ANALYSIS_MAX_FILE_BYTES } from '@/config/gap-analysis.config';

export const GAP_ANALYSIS_ZIP_MAX_ENTRIES = 500;
export const GAP_ANALYSIS_ZIP_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
export const GAP_ANALYSIS_ZIP_MAX_COMPRESSION_RATIO = 100;
export const GAP_ANALYSIS_ZIP_MAX_SINGLE_PART_BYTES = 20 * 1024 * 1024; // 20 MB
export const GAP_ANALYSIS_MIN_EXTRACTED_TEXT_LENGTH = 50;

export const SCANNED_PDF_REJECTION_MESSAGE =
  'This PDF appears to contain little or no extractable text. OCR is not currently available for Gap Analysis. Please upload a text-searchable PDF or DOCX.';

export const ENCRYPTED_PDF_REJECTION_MESSAGE =
  'This PDF is password-protected or encrypted. Please upload an unencrypted document.';

export interface GapAnalysisValidationSuccess {
  valid: true;
  detectedType: 'pdf' | 'docx' | 'txt';
  mimeType: string;
  fileSize: number;
  extractedTextLength: number;
}

export interface GapAnalysisValidationFailure {
  valid: false;
  code:
    | 'INVALID_SIGNATURE'
    | 'MALFORMED'
    | 'ENCRYPTED_PDF'
    | 'OCR_REQUIRED'
    | 'ZIP_SAFETY_VIOLATION'
    | 'BINARY_IN_TEXT'
    | 'TYPE_MISMATCH'
    | 'SIZE_EXCEEDED'
    | 'INSUFFICIENT_TEXT';
  reason: string;
}

export type GapAnalysisFileValidationResult =
  | GapAnalysisValidationSuccess
  | GapAnalysisValidationFailure;

export class GapAnalysisFileValidationError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'GapAnalysisFileValidationError';
  }
}

export interface ValidateGapAnalysisFileOptions {
  buffer: Buffer;
  fileName: string;
  fileType: string;
  claimedMimeType?: string;
}

export interface ZipArchiveInspection {
  isValidZip: boolean;
  entryCount: number;
  totalUncompressedSize: number;
  entryNames: Set<string>;
  maxSingleEntrySize: number;
}

/**
 * Low-level safe parser for ZIP container headers.
 * Extracts entry names and uncompressed sizes without uncompressing file data.
 */
export function inspectZipArchive(buffer: Buffer): ZipArchiveInspection {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    return {
      isValidZip: false,
      entryCount: 0,
      totalUncompressedSize: 0,
      entryNames: new Set(),
      maxSingleEntrySize: 0,
    };
  }

  const entryNames = new Set<string>();
  let totalUncompressedSize = 0;
  let maxSingleEntrySize = 0;
  let offset = 0;
  let entryCount = 0;

  // Walk local file headers
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      break;
    }

    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    if (offset + 30 + nameLen > buffer.length) break;

    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
    entryNames.add(name);
    entryCount++;
    totalUncompressedSize += uncompressedSize;
    if (uncompressedSize > maxSingleEntrySize) {
      maxSingleEntrySize = uncompressedSize;
    }

    // Guard against overflow or zero-length loops
    const advance = 30 + nameLen + extraLen + compressedSize;
    if (advance <= 30) break;
    offset += advance;
  }

  // Scan central directory headers (signature 0x02014b50)
  let cdOffset = 0;
  while (cdOffset < buffer.length - 46) {
    if (buffer.readUInt32LE(cdOffset) === 0x02014b50) {
      const cdUncompressedSize = buffer.readUInt32LE(cdOffset + 24);
      const cdNameLen = buffer.readUInt16LE(cdOffset + 28);
      const cdExtraLen = buffer.readUInt16LE(cdOffset + 30);
      const cdCommentLen = buffer.readUInt16LE(cdOffset + 32);

      if (cdOffset + 46 + cdNameLen <= buffer.length) {
        const cdName = buffer.toString('utf8', cdOffset + 46, cdOffset + 46 + cdNameLen);
        if (!entryNames.has(cdName)) {
          entryNames.add(cdName);
          entryCount++;
          totalUncompressedSize += cdUncompressedSize;
          if (cdUncompressedSize > maxSingleEntrySize) {
            maxSingleEntrySize = cdUncompressedSize;
          }
        }
      }
      cdOffset += 46 + cdNameLen + cdExtraLen + cdCommentLen;
    } else {
      cdOffset++;
    }
  }

  return {
    isValidZip: true,
    entryCount,
    totalUncompressedSize,
    entryNames,
    maxSingleEntrySize,
  };
}

/**
 * Validates a PDF document for magic bytes, encryption, malformed structure, and extractability.
 */
async function validatePdfDocument(buffer: Buffer): Promise<GapAnalysisFileValidationResult> {
  // 1. Magic bytes check: must start with %PDF-
  if (buffer.length < 5 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
    return {
      valid: false,
      code: 'INVALID_SIGNATURE',
      reason: 'Invalid PDF format: file does not begin with standard PDF signature (%PDF-).',
    };
  }

  // 2. Encryption check: inspect trailer/catalog for /Encrypt
  // PDF standard dictionary token /Encrypt
  const headerPreview = buffer.toString('latin1', 0, Math.min(buffer.length, 1024 * 1024));
  const trailerPreview = buffer.toString('latin1', Math.max(0, buffer.length - 8192));
  if (/\/Encrypt\s+/.test(headerPreview) || /\/Encrypt\s+/.test(trailerPreview)) {
    return {
      valid: false,
      code: 'ENCRYPTED_PDF',
      reason: ENCRYPTED_PDF_REJECTION_MESSAGE,
    };
  }

  // 3. Extract text and check extractability & parser integrity
  try {
    const extraction = await extractPdfTextWithMetadata(buffer);
    const meaningfulLength = extraction.meaningfulText.trim().length;

    if (meaningfulLength < GAP_ANALYSIS_MIN_EXTRACTED_TEXT_LENGTH) {
      return {
        valid: false,
        code: 'OCR_REQUIRED',
        reason: SCANNED_PDF_REJECTION_MESSAGE,
      };
    }

    return {
      valid: true,
      detectedType: 'pdf',
      mimeType: 'application/pdf',
      fileSize: buffer.length,
      extractedTextLength: meaningfulLength,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      return {
        valid: false,
        code: 'ENCRYPTED_PDF',
        reason: ENCRYPTED_PDF_REJECTION_MESSAGE,
      };
    }
    if (/meaningful|no readable text|scanned|image-based/i.test(message)) {
      return {
        valid: false,
        code: 'OCR_REQUIRED',
        reason: SCANNED_PDF_REJECTION_MESSAGE,
      };
    }
    return {
      valid: false,
      code: 'MALFORMED',
      reason: `PDF document is malformed or corrupted: ${message}`,
    };
  }
}

/**
 * Validates a DOCX document for ZIP signature, OOXML archive structure, zip bomb bounds, and extractability.
 */
async function validateDocxDocument(buffer: Buffer): Promise<GapAnalysisFileValidationResult> {
  // 1. Magic bytes check: must start with PK\x03\x04
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    return {
      valid: false,
      code: 'INVALID_SIGNATURE',
      reason: 'Invalid DOCX format: file does not begin with standard ZIP signature.',
    };
  }

  // 2. Archive safety and entry inspection
  const zipInfo = inspectZipArchive(buffer);
  if (!zipInfo.isValidZip) {
    return {
      valid: false,
      code: 'MALFORMED',
      reason: 'DOCX archive header is malformed or corrupted.',
    };
  }

  if (zipInfo.entryCount > GAP_ANALYSIS_ZIP_MAX_ENTRIES) {
    return {
      valid: false,
      code: 'ZIP_SAFETY_VIOLATION',
      reason: `DOCX archive exceeds maximum entry limit of ${GAP_ANALYSIS_ZIP_MAX_ENTRIES} (potential decompression attack).`,
    };
  }

  if (zipInfo.totalUncompressedSize > GAP_ANALYSIS_ZIP_MAX_UNCOMPRESSED_BYTES) {
    return {
      valid: false,
      code: 'ZIP_SAFETY_VIOLATION',
      reason: `DOCX uncompressed size exceeds ${GAP_ANALYSIS_ZIP_MAX_UNCOMPRESSED_BYTES / 1024 / 1024}MB limit (potential zip bomb).`,
    };
  }

  if (buffer.length > 0 && zipInfo.totalUncompressedSize / buffer.length > GAP_ANALYSIS_ZIP_MAX_COMPRESSION_RATIO) {
    return {
      valid: false,
      code: 'ZIP_SAFETY_VIOLATION',
      reason: `DOCX compression ratio exceeds ${GAP_ANALYSIS_ZIP_MAX_COMPRESSION_RATIO}x safety threshold (potential zip bomb).`,
    };
  }

  if (zipInfo.maxSingleEntrySize > GAP_ANALYSIS_ZIP_MAX_SINGLE_PART_BYTES) {
    return {
      valid: false,
      code: 'ZIP_SAFETY_VIOLATION',
      reason: `DOCX part exceeds maximum uncompressed size of ${GAP_ANALYSIS_ZIP_MAX_SINGLE_PART_BYTES / 1024 / 1024}MB.`,
    };
  }

  // 3. Confirm expected Word OOXML entries exist: [Content_Types].xml and word/document.xml
  const hasContentTypes = zipInfo.entryNames.has('[Content_Types].xml');
  const hasDocumentXml = zipInfo.entryNames.has('word/document.xml');

  if (!hasContentTypes || !hasDocumentXml) {
    return {
      valid: false,
      code: 'TYPE_MISMATCH',
      reason: 'Invalid DOCX document: archive does not contain standard Word processing parts ([Content_Types].xml, word/document.xml).',
    };
  }

  // 4. Extract text using mammoth to verify readable content
  try {
    const parsed = await mammoth.extractRawText({ buffer });
    const textLength = parsed.value.trim().length;

    if (textLength < GAP_ANALYSIS_MIN_EXTRACTED_TEXT_LENGTH) {
      return {
        valid: false,
        code: 'INSUFFICIENT_TEXT',
        reason: 'DOCX document contains insufficient readable text for Gap Analysis (minimum 50 characters required).',
      };
    }

    return {
      valid: true,
      detectedType: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSize: buffer.length,
      extractedTextLength: textLength,
    };
  } catch (error: unknown) {
    return {
      valid: false,
      code: 'MALFORMED',
      reason: `DOCX extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Validates a TXT document for binary magic bytes, null bytes, UTF-8 validity, and extractability.
 */
function validateTxtDocument(buffer: Buffer): GapAnalysisFileValidationResult {
  // 1. Prohibit binary magic bytes
  if (buffer.length >= 4) {
    const sig4 = buffer.toString('ascii', 0, 4);
    if (sig4 === '%PDF' || buffer.readUInt32LE(0) === 0x04034b50) {
      return {
        valid: false,
        code: 'BINARY_IN_TEXT',
        reason: 'File claims to be plain text but contains a binary signature (%PDF or ZIP).',
      };
    }
    // ELF or PE / Windows EXE signatures
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
      return {
        valid: false,
        code: 'BINARY_IN_TEXT',
        reason: 'File claims to be plain text but contains an ELF binary header.',
      };
    }
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
      return {
        valid: false,
        code: 'BINARY_IN_TEXT',
        reason: 'File claims to be plain text but contains an executable binary header.',
      };
    }
  }

  // 2. Prohibit null bytes
  if (buffer.indexOf(0x00) !== -1) {
    return {
      valid: false,
      code: 'BINARY_IN_TEXT',
      reason: 'File claims to be plain text but contains binary content (null bytes detected).',
    };
  }

  // 3. Control character ratio check (prohibit high binary byte density)
  let controlCount = 0;
  const sampleLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];
    // Control characters other than tab (9), newline (10), carriage return (13)
    if ((byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f)) && byte !== 0x20) {
      controlCount++;
    }
  }
  if (sampleLength > 0 && controlCount / sampleLength > 0.01) {
    return {
      valid: false,
      code: 'BINARY_IN_TEXT',
      reason: 'File claims to be plain text but contains excessive non-printable binary control characters.',
    };
  }

  // 4. Safe UTF-8 decoding & BOM stripping
  let textBuffer = buffer;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    textBuffer = buffer.subarray(3);
  }

  let text: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    text = decoder.decode(textBuffer);
  } catch {
    return {
      valid: false,
      code: 'MALFORMED',
      reason: 'Text document contains invalid UTF-8 byte sequences.',
    };
  }

  const trimmedLength = text.trim().length;
  if (trimmedLength < GAP_ANALYSIS_MIN_EXTRACTED_TEXT_LENGTH) {
    return {
      valid: false,
      code: 'INSUFFICIENT_TEXT',
      reason: 'Text document contains insufficient content for Gap Analysis (minimum 50 characters required).',
    };
  }

  return {
    valid: true,
    detectedType: 'txt',
    mimeType: 'text/plain',
    fileSize: buffer.length,
    extractedTextLength: trimmedLength,
  };
}

/**
 * Authoritative Gap Analysis server-side file validator.
 * Validates claimed extension, declared MIME, size limits, binary magic bytes,
 * archive integrity, PDF safety, and extractability. Fails closed on any inconsistency.
 */
export async function validateGapAnalysisFile(
  bufferOrOptions: Buffer | ValidateGapAnalysisFileOptions,
  fileNameArg?: string,
  fileTypeArg?: string,
  claimedMimeTypeArg?: string,
): Promise<GapAnalysisValidationSuccess> {
  let buffer: Buffer;
  let fileName: string;
  let fileType: string;
  let claimedMimeType: string | undefined;

  if (Buffer.isBuffer(bufferOrOptions)) {
    buffer = bufferOrOptions;
    fileName = fileNameArg!;
    fileType = fileTypeArg!;
    claimedMimeType = claimedMimeTypeArg;
  } else {
    buffer = bufferOrOptions.buffer;
    fileName = bufferOrOptions.fileName;
    fileType = bufferOrOptions.fileType;
    claimedMimeType = bufferOrOptions.claimedMimeType;
  }

  // 1. Size bounds
  if (!buffer || buffer.length === 0) {
    throw new GapAnalysisFileValidationError('Uploaded file is empty.', 'INSUFFICIENT_TEXT');
  }

  if (buffer.length > GAP_ANALYSIS_MAX_FILE_BYTES) {
    throw new GapAnalysisFileValidationError(
      `File size ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds the 10 MB Gap Analysis limit.`,
      'SIZE_EXCEEDED',
    );
  }

  // 2. Extension validation
  const ext = fileName.split('.').pop()?.toLowerCase();
  const normalizedType = fileType.toLowerCase().replace('.', '');

  if (ext !== normalizedType) {
    throw new GapAnalysisFileValidationError(
      'The document filename extension and declared file type do not match.',
      'TYPE_MISMATCH',
    );
  }

  if (ext !== 'pdf' && ext !== 'docx' && ext !== 'txt') {
    throw new GapAnalysisFileValidationError(
      `Unsupported file type .${ext}. Only PDF, DOCX, and TXT files are supported for Gap Analysis.`,
      'TYPE_MISMATCH',
    );
  }

  // 3. Claimed MIME sanity check if provided
  if (claimedMimeType) {
    const normMime = claimedMimeType.toLowerCase().trim();
    if (ext === 'pdf' && normMime !== 'application/pdf') {
      throw new GapAnalysisFileValidationError(
        `MIME type "${claimedMimeType}" is incompatible with PDF extension.`,
        'TYPE_MISMATCH',
      );
    }
    if (
      ext === 'docx' &&
      normMime !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
      normMime !== 'application/zip'
    ) {
      throw new GapAnalysisFileValidationError(
        `MIME type "${claimedMimeType}" is incompatible with DOCX extension.`,
        'TYPE_MISMATCH',
      );
    }
    if (ext === 'txt' && normMime !== 'text/plain') {
      throw new GapAnalysisFileValidationError(
        `MIME type "${claimedMimeType}" is incompatible with TXT extension.`,
        'TYPE_MISMATCH',
      );
    }
  }

  // 4. Genuine format & content inspection
  let result: GapAnalysisFileValidationResult;
  if (ext === 'pdf') {
    result = await validatePdfDocument(buffer);
  } else if (ext === 'docx') {
    result = await validateDocxDocument(buffer);
  } else {
    result = validateTxtDocument(buffer);
  }

  if (result.valid) {
    logger.info({
      type: 'gap_analysis_upload_validated',
      safeExtension: ext,
      fileSize: buffer.length,
      extractedTextLength: result.extractedTextLength,
    });
    return result;
  } else {
    logger.warn({
      type: 'gap_analysis_file_rejected',
      safeExtension: ext,
      failureClass: result.code,
    });
    throw new GapAnalysisFileValidationError(result.reason, result.code);
  }
}
