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
function resolvePDFParse(): new (opts: { data: Buffer }) => { getText: () => Promise<{ text: string }> } {
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

/**
 * Extract plain text from a PDF buffer.
 *
 * @param buffer - Raw PDF file contents
 * @returns The extracted text content
 * @throws Error if the buffer is not a valid PDF or pdf-parse is misconfigured
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('extractPdfText: buffer must be a non-empty Buffer');
  }
  const parser = new PDFParseClass({ data: buffer });
  const result = await parser.getText();
  return result?.text ?? '';
}
