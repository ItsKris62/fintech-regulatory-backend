import fs from 'fs';
import path from 'path';

import { documentIngestionService, type DocumentIngestionInput } from '@/lib/ingestion/document-processor';
import { extractPdfTextWithOcrFallback } from '@/lib/ingestion/text-extraction';
import { getOcrConfig } from '@/lib/ocr/config';
import { isNativeTextUsable, validateOcrTextQuality } from '@/lib/ocr/quality';
import { extractPdfTextWithMetadata } from '@/lib/pdf/extract-text';
import { prisma } from '@/lib/prisma/client';
import { buildRegistry, resolveDocumentPath, type RegistryEntry } from '../ingest-documents';
import type { Country } from './manifest.schema';

type FailureClassification =
  | 'TEXT_OK'
  | 'TEXT_TOO_SHORT'
  | 'SCANNED_PDF'
  | 'EXTRACTION_ERROR'
  | 'CORRUPT_PDF'
  | 'PASSWORD_PROTECTED'
  | 'FILE_MISSING'
  | 'OCR_REQUIRED'
  | 'OCR_FAILED'
  | 'OCR_LOW_QUALITY';

interface Args {
  countries: Country[];
  documentId?: string;
  runOcr: boolean;
  write: boolean;
  all: boolean;
}

interface ScanRow {
  jurisdiction: string;
  manifestId: string;
  title: string;
  filePath: string;
  fileSize: number | null;
  nativeChars: number;
  pageCount: number | null;
  classification: FailureClassification;
  ocrChars?: number;
  quality?: 'PASS' | 'FAIL' | 'NOT_RUN';
  ingestResult?: string;
  error?: string;
}

const COUNTRY_ARG_MAP: Record<string, Country> = {
  kenya: 'Kenya',
  ke: 'Kenya',
  malawi: 'Malawi',
  mw: 'Malawi',
  nigeria: 'Nigeria',
  ng: 'Nigeria',
  rwanda: 'Rwanda',
  rw: 'Rwanda',
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const countries: Country[] = [];
  let documentId: string | undefined;
  let runOcr = false;
  let write = false;
  let all = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--all') {
      all = true;
      countries.push('Kenya', 'Rwanda', 'Malawi', 'Nigeria');
    } else if (arg === '--run-ocr') {
      runOcr = true;
    } else if (arg === '--write') {
      write = true;
      runOcr = true;
    } else if (arg === '--dry-run') {
      write = false;
    } else if (arg.startsWith('--country=')) {
      const mapped = COUNTRY_ARG_MAP[arg.replace('--country=', '').trim().toLowerCase()];
      if (!mapped) throw new Error(`Unknown country: ${arg}`);
      countries.push(mapped);
    } else if (arg === '--country') {
      const value = args[++index];
      const mapped = COUNTRY_ARG_MAP[value?.trim().toLowerCase() ?? ''];
      if (!mapped) throw new Error(`Unknown country: ${value ?? ''}`);
      countries.push(mapped);
    } else if (arg.startsWith('--jurisdiction=')) {
      const mapped = COUNTRY_ARG_MAP[arg.replace('--jurisdiction=', '').trim().toLowerCase()];
      if (!mapped) throw new Error(`Unknown jurisdiction: ${arg}`);
      countries.push(mapped);
    } else if (arg === '--jurisdiction') {
      const value = args[++index];
      const mapped = COUNTRY_ARG_MAP[value?.trim().toLowerCase() ?? ''];
      if (!mapped) throw new Error(`Unknown jurisdiction: ${value ?? ''}`);
      countries.push(mapped);
    } else if (arg.startsWith('--document=')) {
      documentId = arg.replace('--document=', '').trim();
    } else if (arg === '--document') {
      documentId = args[++index]?.trim();
    }
  }

  const uniqueCountries = Array.from(new Set(countries));
  if (uniqueCountries.length === 0 && !documentId) {
    throw new Error('Usage: npm run corpus:ocr:scan -- --all | --jurisdiction MW [--run-ocr] [--document <id>]');
  }
  if (write && !all && uniqueCountries.length === 0 && !documentId) {
    throw new Error('--write requires --all, --jurisdiction, or --document.');
  }

  return { countries: uniqueCountries, documentId, runOcr, write, all };
}

function registryEntriesForArgs(args: Args): RegistryEntry[] {
  const entries = args.countries.flatMap((country) => buildRegistry(country));
  const unique = new Map(entries.map((entry) => [`${entry.jurisdiction}:${entry.fileName}:${entry.title}`, entry]));
  const filtered = Array.from(unique.values()).filter((entry) => {
    if (!args.documentId) return true;
    return entry.title.toLowerCase().includes(args.documentId.toLowerCase()) ||
      entry.fileName.toLowerCase().includes(args.documentId.toLowerCase());
  });
  return filtered.filter((entry) => path.extname(entry.fileName).toLowerCase() === '.pdf');
}

function classifyExtractionError(error: unknown): FailureClassification {
  const message = (error as Error).message ?? '';
  if (/password|encrypted/i.test(message)) return 'PASSWORD_PROTECTED';
  if (/invalid pdf|bad xref|xref|corrupt|not a pdf|format/i.test(message)) return 'CORRUPT_PDF';
  return 'EXTRACTION_ERROR';
}

async function scanEntry(entry: RegistryEntry, args: Args): Promise<ScanRow> {
  const filePath = resolveDocumentPath(entry.fileName);
  const base: ScanRow = {
    jurisdiction: entry.jurisdiction,
    manifestId: entry.manifestId ?? entry.fileName,
    title: entry.title,
    filePath,
    fileSize: null,
    nativeChars: 0,
    pageCount: null,
    classification: 'TEXT_OK',
    quality: args.runOcr ? 'NOT_RUN' : undefined,
  };

  if (!fs.existsSync(filePath)) {
    return { ...base, classification: 'FILE_MISSING' };
  }

  base.fileSize = fs.statSync(filePath).size;
  const buffer = fs.readFileSync(filePath);
  const config = getOcrConfig();

  try {
    const native = await extractPdfTextWithMetadata(buffer);
    const nativeText = native.meaningfulText;
    const nativeQuality = isNativeTextUsable(nativeText, native.pageCount, config);
    base.nativeChars = nativeText.length;
    base.pageCount = native.pageCount;
    base.classification = nativeQuality.usable
      ? 'TEXT_OK'
      : nativeText.length === 0
        ? 'SCANNED_PDF'
        : 'OCR_REQUIRED';
  } catch (error) {
    base.classification = classifyExtractionError(error);
    base.error = (error as Error).message;
  }

  const needsOcr =
    base.classification === 'SCANNED_PDF' ||
    base.classification === 'OCR_REQUIRED' ||
    base.classification === 'TEXT_TOO_SHORT' ||
    base.classification === 'EXTRACTION_ERROR';

  if (!args.runOcr || !needsOcr) return base;

  try {
    const extraction = await extractPdfTextWithOcrFallback(buffer, {
      title: entry.title,
      jurisdiction: entry.jurisdiction,
    });
    const quality = validateOcrTextQuality(extraction.text, extraction.metadata.pageCount ?? base.pageCount, config);
    base.ocrChars = extraction.text.length;
    base.quality = quality.usable ? 'PASS' : 'FAIL';
    base.classification = quality.usable ? 'OCR_REQUIRED' : 'OCR_LOW_QUALITY';

    if (args.write && quality.usable) {
      const input: DocumentIngestionInput = {
        filePath,
        fileName: path.basename(entry.fileName),
        title: entry.title,
        source: entry.source,
        category: entry.category,
        jurisdiction: entry.jurisdiction,
        documentType: entry.documentType,
        effectiveDate: entry.effectiveDate,
        publicationDate: entry.publicationDate,
        retrievedAt: entry.retrievedAt,
        officialUrl: entry.officialUrl,
        version: entry.version,
        authorityStatus: entry.authorityStatus ?? 'IN_FORCE',
        isBinding: entry.isBinding,
        supersedesDocumentId: entry.supersedesDocumentId,
        forceReprocessExisting: true,
      };
      const result = await documentIngestionService.ingestDocument(input);
      base.ingestResult = result.skipped
        ? `SKIPPED ${result.reason ?? ''}`.trim()
        : `INGESTED chunks=${result.chunkCount}`;
    }
  } catch (error) {
    const message = (error as Error).message;
    base.error = message;
    base.classification = /OCR_LOW_QUALITY/.test(message) ? 'OCR_LOW_QUALITY' : 'OCR_FAILED';
    base.quality = 'FAIL';
  }

  return base;
}

function printRows(rows: ScanRow[]): void {
  const failed = rows.filter((row) => row.classification !== 'TEXT_OK');
  console.log(JSON.stringify({
    total: rows.length,
    textOk: rows.filter((row) => row.classification === 'TEXT_OK').length,
    failed: failed.length,
    byClassification: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.classification] = (acc[row.classification] ?? 0) + 1;
      return acc;
    }, {}),
  }, null, 2));

  console.table(failed.map((row) => ({
    jurisdiction: row.jurisdiction,
    manifestId: row.manifestId,
    title: row.title,
    fileSize: row.fileSize,
    nativeChars: row.nativeChars,
    pageCount: row.pageCount,
    classification: row.classification,
    ocrChars: row.ocrChars ?? '',
    quality: row.quality ?? '',
    ingestResult: row.ingestResult ?? '',
    error: row.error ? row.error.slice(0, 140) : '',
  })));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const entries = registryEntriesForArgs(args);
  const rows: ScanRow[] = [];

  console.log(`OCR remediation mode: ${args.write ? 'WRITE' : args.runOcr ? 'OCR DRY RUN' : 'DIAGNOSTIC'}`);
  console.log(`PDF entries: ${entries.length}`);

  for (const entry of entries) {
    rows.push(await scanEntry(entry, args));
  }

  printRows(rows);
}

main()
  .catch((error: unknown) => {
    console.error('OCR remediation failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await (prisma as any).$disconnect();
    process.exit(process.exitCode ?? 0);
  });
