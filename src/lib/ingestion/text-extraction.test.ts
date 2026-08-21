import { describe, expect, it, vi } from 'vitest';

import { extractPdfTextWithOcrFallback } from './text-extraction';
import type { OcrConfig } from '@/lib/ocr/config';

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const testConfig: OcrConfig = {
  enabled: true,
  engine: 'ocrmypdf',
  command: 'ocrmypdf',
  commandArgs: [],
  pathPrefix: undefined,
  minNativeCharacters: 100,
  minNativeCharsPerPage: 10,
  minOcrCharacters: 100,
  minOcrCharsPerPage: 10,
  minAlphanumericRatio: 0.55,
  maxGarbageRatio: 0.08,
  maxRepeatedArtifactRatio: 0.2,
  versionTimeoutMs: 30_000,
  timeoutMs: 1_000,
};

function makePdf(text: string): Buffer {
  const stream = text ? `BT /F1 12 Tf 100 700 Td (${text}) Tj ET` : '';
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
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>`,
    'stream',
    stream,
    'endstream',
    'endobj',
    '5 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
  ];

  const bodyStr = `${lines.join('\n')}\n`;
  const bodyBuf = Buffer.from(bodyStr, 'ascii');
  const objOffsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    if (/^\d+ 0 obj$/.test(line)) objOffsets.push(pos);
    pos += Buffer.byteLength(`${line}\n`, 'ascii');
  }

  const xrefLines = ['xref', `0 ${objOffsets.length + 1}`, '0000000000 65535 f '];
  for (const off of objOffsets) xrefLines.push(`${String(off).padStart(10, '0')} 00000 n `);
  xrefLines.push(
    'trailer',
    `<< /Size ${objOffsets.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(bodyBuf.length),
    '%%EOF',
  );

  return Buffer.concat([bodyBuf, Buffer.from(`${xrefLines.join('\n')}\n`, 'ascii')]);
}

describe('extractPdfTextWithOcrFallback', () => {
  it('uses native extraction and does not invoke OCR when PDF text is sufficient', async () => {
    const ocrProvider = vi.fn();
    const pdf = makePdf('Native text is sufficient for ingestion. '.repeat(8));

    const result = await extractPdfTextWithOcrFallback(
      pdf,
      { title: 'Native PDF', jurisdiction: 'Malawi' },
      { config: testConfig, ocrProvider },
    );

    expect(result.text).toContain('Native text is sufficient');
    expect(result.metadata.extractionMethod).toBe('NATIVE');
    expect(ocrProvider).not.toHaveBeenCalled();
  });

  it('invokes OCR and returns OCR metadata when native text is insufficient', async () => {
    const ocrProvider = vi.fn().mockResolvedValue({
      engine: 'ocrmypdf',
      engineVersion: '16.0.0',
      durationMs: 42,
      text: 'OCR text is readable and legally useful. '.repeat(8),
    });
    const pdf = makePdf('');

    const result = await extractPdfTextWithOcrFallback(
      pdf,
      { title: 'Scanned PDF', jurisdiction: 'Malawi' },
      { config: testConfig, ocrProvider },
    );

    expect(ocrProvider).toHaveBeenCalledOnce();
    expect(result.metadata.extractionMethod).toBe('OCR');
    expect(result.metadata.ocrQualityStatus).toBe('PASS');
    expect(result.metadata.ocrEngine).toBe('ocrmypdf');
  });

  it('fails closed when the OCR provider fails', async () => {
    const ocrProvider = vi.fn().mockRejectedValue(new Error('OCR timed out after 1000ms'));

    await expect(extractPdfTextWithOcrFallback(
      makePdf(''),
      { title: 'Timeout PDF', jurisdiction: 'Malawi' },
      { config: testConfig, ocrProvider },
    )).rejects.toThrow('OCR failed closed');
  });

  it('rejects low-quality OCR output', async () => {
    const ocrProvider = vi.fn().mockResolvedValue({
      engine: 'ocrmypdf',
      engineVersion: '16.0.0',
      durationMs: 20,
      text: '||||||||||||||||||||||||||||||||||||||||||||',
    });

    await expect(extractPdfTextWithOcrFallback(
      makePdf(''),
      { title: 'Low Quality PDF', jurisdiction: 'Malawi' },
      { config: testConfig, ocrProvider },
    )).rejects.toThrow('OCR_LOW_QUALITY');
  });

  it('fails closed when OCR is disabled for an OCR-required document', async () => {
    await expect(extractPdfTextWithOcrFallback(
      makePdf(''),
      { title: 'Disabled OCR PDF', jurisdiction: 'Malawi' },
      { config: { ...testConfig, enabled: false }, ocrProvider: vi.fn() },
    )).rejects.toThrow('OCR is disabled');
  });
});
