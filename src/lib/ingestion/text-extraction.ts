import { extractPdfTextWithMetadata } from '@/lib/pdf/extract-text';
import { getOcrConfig, type OcrConfig } from '@/lib/ocr/config';
import { runOcrMyPdf, type OcrEngineResult } from '@/lib/ocr/engine';
import {
  isNativeTextUsable,
  validateOcrTextQuality,
  type ExtractionMethod,
  type OcrQualityStatus,
  type TextUsabilityMetrics,
} from '@/lib/ocr/quality';
import { logger } from '@/utils/logger';
import { DocumentParsingError } from '@/utils/error';

export interface ExtractionMetadata {
  extractionMethod: ExtractionMethod;
  ocrEngine?: string;
  ocrVersion?: string | null;
  ocrPageCount?: number | null;
  nativeCharacterCount?: number;
  extractedCharacterCount: number;
  pageCount?: number | null;
  durationMs: number;
  nativeExtractionDurationMs?: number;
  ocrDurationMs?: number;
  ocrQualityStatus?: OcrQualityStatus;
  qualityMetrics?: TextUsabilityMetrics;
  qualityReasons?: string[];
}

export interface ExtractDocumentTextDeps {
  config?: OcrConfig;
  ocrProvider?: (buffer: Buffer, config: OcrConfig) => Promise<OcrEngineResult>;
}

export interface ExtractedDocumentText {
  text: string;
  metadata: ExtractionMetadata;
}

function normaliseText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\0/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

export function normalizeExtractedText(raw: string): string {
  return normaliseText(raw);
}

async function extractNativePdfText(buffer: Buffer): Promise<{
  text: string;
  pageCount: number | null;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const native = await extractPdfTextWithMetadata(buffer);
  return {
    text: normaliseText(native.text),
    pageCount: native.pageCount,
    durationMs: Date.now() - startedAt,
  };
}

export async function extractPdfTextWithOcrFallback(
  buffer: Buffer,
  context: {
    documentId?: string;
    title: string;
    jurisdiction: string;
  },
  deps: ExtractDocumentTextDeps = {},
): Promise<ExtractedDocumentText> {
  const config = deps.config ?? getOcrConfig();
  const startedAt = Date.now();
  let nativeText = '';
  let pageCount: number | null = null;
  let nativeDurationMs = 0;
  let nativeFailure: Error | null = null;

  try {
    const native = await extractNativePdfText(buffer);
    nativeText = native.text;
    pageCount = native.pageCount;
    nativeDurationMs = native.durationMs;
  } catch (error) {
    nativeFailure = error as Error;
  }

  const nativeQuality = isNativeTextUsable(nativeText, pageCount, config);
  if (!nativeFailure && nativeQuality.usable) {
    return {
      text: nativeText,
      metadata: {
        extractionMethod: 'NATIVE',
        extractedCharacterCount: nativeText.length,
        pageCount,
        durationMs: Date.now() - startedAt,
        nativeExtractionDurationMs: nativeDurationMs,
        qualityMetrics: nativeQuality.metrics,
      },
    };
  }

  logger.info({
    type: 'ocr_candidate_detected',
    documentId: context.documentId,
    title: context.title,
    jurisdiction: context.jurisdiction,
    pageCount,
    nativeCharacterCount: nativeText.length,
    reasons: nativeFailure ? ['NATIVE_EXTRACTION_FAILED'] : nativeQuality.reasons,
  });

  if (!config.enabled) {
    throw new DocumentParsingError(
      `Document requires OCR but OCR is disabled. Native extraction chars=${nativeText.length}.`,
      {
        classification: 'OCR_REQUIRED',
        nativeFailure: nativeFailure?.message,
        nativeCharacterCount: nativeText.length,
        pageCount,
      },
    );
  }

  const ocrProvider = deps.ocrProvider ?? runOcrMyPdf;
  logger.info({
    type: 'ocr_started',
    documentId: context.documentId,
    title: context.title,
    jurisdiction: context.jurisdiction,
    pageCount,
  });

  let ocr: OcrEngineResult;
  try {
    ocr = await ocrProvider(buffer, config);
  } catch (error) {
    const err = error as Error;
    logger.error({
      type: 'ocr_failed',
      documentId: context.documentId,
      title: context.title,
      jurisdiction: context.jurisdiction,
      pageCount,
      durationMs: Date.now() - startedAt,
      error: err.message,
    });
    throw new DocumentParsingError(`OCR failed closed: ${err.message}`, {
      classification: 'OCR_FAILED',
      nativeCharacterCount: nativeText.length,
      pageCount,
    });
  }

  const normalizedOcrText = normaliseText(ocr.text);
  const ocrQuality = validateOcrTextQuality(normalizedOcrText, pageCount, config);
  if (!ocrQuality.usable) {
    logger.warn({
      type: 'ocr_quality_failed',
      documentId: context.documentId,
      title: context.title,
      jurisdiction: context.jurisdiction,
      pageCount,
      durationMs: ocr.durationMs,
      characterCount: normalizedOcrText.length,
      reasons: ocrQuality.reasons,
      metrics: ocrQuality.metrics,
    });
    throw new DocumentParsingError('OCR_LOW_QUALITY: OCR output failed legal-corpus quality gates.', {
      classification: 'OCR_LOW_QUALITY',
      reasons: ocrQuality.reasons,
      metrics: ocrQuality.metrics,
      nativeCharacterCount: nativeText.length,
      pageCount,
    });
  }

  logger.info({
    type: 'ocr_completed',
    documentId: context.documentId,
    title: context.title,
    jurisdiction: context.jurisdiction,
    pageCount,
    durationMs: ocr.durationMs,
    characterCount: normalizedOcrText.length,
  });

  return {
    text: normalizedOcrText,
    metadata: {
      extractionMethod: 'OCR',
      ocrEngine: ocr.engine,
      ocrVersion: ocr.engineVersion,
      ocrPageCount: pageCount,
      nativeCharacterCount: nativeText.length,
      extractedCharacterCount: normalizedOcrText.length,
      pageCount,
      durationMs: Date.now() - startedAt,
      nativeExtractionDurationMs: nativeDurationMs,
      ocrDurationMs: ocr.durationMs,
      ocrQualityStatus: 'PASS',
      qualityMetrics: ocrQuality.metrics,
      qualityReasons: ocrQuality.reasons,
    },
  };
}
