/**
 * ESM/CommonJS-safe PDF text extraction helper.
 *
 * pdf-parse v2.x exports a class `PDFParse` — not a bare callable function.
 * This module encapsulates the correct instantiation so every consumer uses
 * one tested code-path regardless of bundler or runtime module interop.
 *
 * Usage:
 *   import { extractPdfText } from '@/lib/pdf/extract-text';
 *   const text = await extractPdfText(buffer);
 */

const pdfParseModule = require('pdf-parse') as Record<string, unknown>;

/**
 * Resolve the `PDFParse` constructor from whatever shape `require('pdf-parse')`
 * returns (bare export, `.default` wrapper, or named export).
 */
type PDFParseInstance = {
  destroy?: () => Promise<void> | void;
  getInfo: () => Promise<{ total?: number }>;
  getText: () => Promise<{ text: string }>;
};

function resolvePDFParse(): new (opts: { data: Buffer }) => PDFParseInstance {
  // v2.x named export
  if (typeof pdfParseModule.PDFParse === 'function') {
    return pdfParseModule.PDFParse as any;
  }
  // ESM default interop
  if (
    pdfParseModule.default &&
    typeof (pdfParseModule.default as Record<string, unknown>).PDFParse === 'function'
  ) {
    return (pdfParseModule.default as Record<string, unknown>).PDFParse as any;
  }
  // Fallback: module itself is the constructor (unlikely but defensive)
  if (typeof pdfParseModule === 'function') {
    return pdfParseModule as any;
  }

  throw new Error(
    'pdf-parse configuration error: could not resolve PDFParse constructor. ' +
    `Module type: ${typeof pdfParseModule}, ` +
    `keys: [${Object.keys(pdfParseModule).join(', ')}]. ` +
    'Ensure pdf-parse >=2.x is installed.',
  );
}

/** Resolved once at module load; throws immediately if misconfigured. */
const PDFParseClass = resolvePDFParse();

function stripPdfParsePageMarkers(text: string): string {
  return text
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '')
    .trim();
}

/**
 * Extract plain text from a PDF buffer.
 *
 * @param buffer - Raw PDF file contents
 * @returns The extracted text content
 * @throws Error if the buffer is not a valid PDF or pdf-parse is misconfigured
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const result = await extractPdfTextWithMetadata(buffer);
  if (!result.meaningfulText) {
    throw new Error('Extraction failed: Document contains no readable text. It may be an image-based scanned document or an empty file.');
  }

  return result.text;
}

export interface PdfTextExtractionResult {
  text: string;
  meaningfulText: string;
  pageCount: number | null;
}

/**
 * Extract text and page metadata from a PDF buffer without rejecting empty text.
 * Ingestion uses this to decide whether local OCR fallback is eligible.
 */
export async function extractPdfTextWithMetadata(buffer: Buffer): Promise<PdfTextExtractionResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('extractPdfText: buffer must be a non-empty Buffer');
  }
  const parser = new PDFParseClass({ data: buffer });
  try {
    const info = await parser.getInfo().catch(() => ({ total: undefined }));
    const result = await parser.getText();
    const extractedText = result?.text ?? '';
    const meaningfulText = stripPdfParsePageMarkers(extractedText);

    return {
      text: extractedText,
      meaningfulText,
      pageCount: Number.isFinite(info.total) ? Number(info.total) : null,
    };
  } finally {
    await parser.destroy?.();
  }
}
