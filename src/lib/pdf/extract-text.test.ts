/**
 * Regression test for PDF text extraction.
 *
 * Verifies that extractPdfText correctly uses the pdf-parse v2.x PDFParse class
 * and returns text from a minimal valid PDF buffer.
 *
 * Background: Production gap analysis failed with "pdfParse is not a function"
 * because the old code assumed `require('pdf-parse')` returned a callable
 * function, but v2.x exports an object with a `PDFParse` class.
 */
import { describe, it, expect } from 'vitest';
import { extractPdfText } from '@/lib/pdf/extract-text';

// ---------- Minimal valid PDF (single page with text "Hello") ---------------
// This is a hand-crafted PDF 1.4 with one page containing "Hello" in Helvetica.
// It's kept inline to avoid external fixture files.
function makeMinimalPdf(): Buffer {
  const lines = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]',
    '   /Contents 4 0 R',
    '   /Resources << /Font << /F1 5 0 R >> >> >>',
    'endobj',
    '4 0 obj',
    '<< /Length 44 >>',
    'stream',
    'BT /F1 12 Tf 100 700 Td (Hello World) Tj ET',
    'endstream',
    'endobj',
    '5 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
  ];

  // Build a proper xref + trailer so pdf-parse can load it
  const bodyStr = lines.join('\n') + '\n';
  const bodyBuf = Buffer.from(bodyStr, 'ascii');

  // Cross-reference table
  const objOffsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    if (/^\d+ 0 obj$/.test(line)) {
      objOffsets.push(pos);
    }
    pos += Buffer.byteLength(line + '\n', 'ascii');
  }

  const xrefStart = bodyBuf.length;
  const xrefLines = [
    'xref',
    `0 ${objOffsets.length + 1}`,
    '0000000000 65535 f ',
  ];
  for (const off of objOffsets) {
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n `);
  }
  xrefLines.push(
    'trailer',
    `<< /Size ${objOffsets.length + 1} /Root 1 0 R >>`,
    'startxref',
    `${xrefStart}`,
    '%%EOF',
  );

  const xrefBuf = Buffer.from(xrefLines.join('\n') + '\n', 'ascii');
  return Buffer.concat([bodyBuf, xrefBuf]);
}

// ---------- Valid PDF with no text (e.g. Scanned / Image-based) -----------
function makeEmptyTextPdf(): Buffer {
  const lines = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    'endobj',
    '4 0 obj',
    '<< /Length 0 >>',
    'stream',
    'endstream',
    'endobj',
  ];

  const bodyStr = lines.join('\n') + '\n';
  const bodyBuf = Buffer.from(bodyStr, 'ascii');

  const objOffsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    if (/^\d+ 0 obj$/.test(line)) objOffsets.push(pos);
    pos += Buffer.byteLength(line + '\n', 'ascii');
  }

  const xrefStart = bodyBuf.length;
  const xrefLines = ['xref', `0 ${objOffsets.length + 1}`, '0000000000 65535 f '];
  for (const off of objOffsets) xrefLines.push(`${String(off).padStart(10, '0')} 00000 n `);
  xrefLines.push('trailer', `<< /Size ${objOffsets.length + 1} /Root 1 0 R >>`, 'startxref', `${xrefStart}`, '%%EOF');

  const xrefBuf = Buffer.from(xrefLines.join('\n') + '\n', 'ascii');
  return Buffer.concat([bodyBuf, xrefBuf]);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('extractPdfText (pdf-parse v2.x interop)', () => {
  it('extracts text from a minimal valid PDF buffer', async () => {
    const pdf = makeMinimalPdf();
    const text = await extractPdfText(pdf);

    // The PDF contains "Hello World"
    expect(text).toBeDefined();
    expect(typeof text).toBe('string');
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });

  it('returns a callable — not "pdfParse is not a function"', () => {
    // The resolved helper must be a function; this is the exact failure mode
    // that occurred in production.
    expect(typeof extractPdfText).toBe('function');
  });

  it('throws on empty buffer', async () => {
    await expect(extractPdfText(Buffer.alloc(0))).rejects.toThrow();
  });

  it('throws on non-PDF garbage data', async () => {
    const garbage = Buffer.from('this is not a PDF file at all');
    await expect(extractPdfText(garbage)).rejects.toThrow();
  });

  it('throws on valid PDF with no readable text (e.g., scanned document)', async () => {
    const emptyTextPdf = makeEmptyTextPdf();
    await expect(extractPdfText(emptyTextPdf)).rejects.toThrow(
      'Extraction failed: Document contains no readable text'
    );
  });
});
