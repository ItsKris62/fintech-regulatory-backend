/**
 * Document Ingestion Pipeline
 *
 * Handles the full lifecycle of ingesting regulatory and cybersecurity documents
 * into the RAG system (Vector DB + PostgreSQL). Supports PDF, DOCX, and TXT files.
 *
 * Pipeline:
 *   validate → checksum → deduplicate → create record (PROCESSING) → extract text →
 *   upload to storage → chunk → embed → upsert vectors → save chunks → mark ACTIVE
 *
 * IMPORTANT FIX (based on your Prisma error):
 *   - `RegulatoryDocument` does NOT have a `filePath` column.
 *   - We still accept `filePath` as an INPUT (for reading the local file),
 *     but we DO NOT write `filePath` to Prisma anymore.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import mammoth from 'mammoth';

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

import { generateBatchEmbeddings } from '@/lib/rag/embeddings';
import { upsertVectors, deleteVectors } from '@/lib/rag/client';
import type { VectorRecord } from '@/lib/rag/client';

import { chunkLegalAct, mergeSmallChunks } from '@/lib/rag/chunking';

import { createStorageService } from '@/lib/storage/client';
import { getMimeType } from '@/utils/helpers';

import {
  DocumentParsingError,
  DocumentIndexingError,
  DocumentUploadError,
} from '@/utils/error';

import type {
  RegulatoryDocumentCategory,
  RegulatoryDocumentStatus,
} from '@prisma/client';

// ============================================================================
// pdf-parse (v2.x) — Node entrypoint REQUIRED
// ============================================================================

interface PdfParseData {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
}

type PdfParseFunction = (
  buffer: Buffer,
  options?: Record<string, unknown>
) => Promise<PdfParseData>;

// pdf-parse v2+ exposes the Node parser at `pdf-parse/node`
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse/node') as PdfParseFunction;

// ============================================================================
// Constants
// ============================================================================

const VECTOR_BATCH_SIZE = 50; // upsert batch size
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MIN_EXTRACTABLE_TEXT = 100;
const MIN_CHUNK_SIZE = 100;

// Storage client for ingestion
const ingestStorage = createStorageService();

// ============================================================================
// Public types
// ============================================================================

export interface DocumentIngestionInput {
  /**
   * Local file path (used ONLY to read the file from disk).
   * This is NOT persisted to Prisma (your schema doesn't have filePath).
   */
  filePath: string;

  title: string;
  source: string;
  category: RegulatoryDocumentCategory;
  jurisdiction: string;
  documentType: string;

  effectiveDate?: Date;
  version?: string;

  /**
   * Optional override. If not provided, derived from filePath.
   */
  fileName?: string;
}

export interface IngestionResult {
  documentId: string;
  chunkCount: number;
  totalCharacters: number;
  storageKey: string;
  skipped: boolean;
  reason?: string;
}

export interface DeleteDocumentOptions {
  deleteFromStorage?: boolean;
}

export interface DocumentStats {
  totalByStatus: Partial<Record<RegulatoryDocumentStatus, number>>;
  totalChunks: number;
  byCategory: Record<string, number>;
  byJurisdiction: Record<string, number>;
}

interface DocRecord {
  id: string;
  title: string;
  source: string;
  category: RegulatoryDocumentCategory;
  jurisdiction: string;
  documentType: string;
  storageKey: string;
  effectiveDate: Date | null;
  version: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

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

function computeChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-') // keep filename-ish chars
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getFileExt(fileName: string): string {
  return path.extname(fileName).replace('.', '').toLowerCase();
}

function assertFileReadable(filePath: string): { size: number } {
  if (!fs.existsSync(filePath)) {
    throw new DocumentParsingError(`File not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new DocumentParsingError(`Path is not a file: ${filePath}`);
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new DocumentParsingError(
      `File too large: ${(stat.size / (1024 * 1024)).toFixed(2)}MB (max 50MB)`,
      { size: stat.size }
    );
  }
  return { size: stat.size };
}

// ============================================================================
// Text extraction
// ============================================================================

async function extractFromPdf(buffer: Buffer): Promise<string> {
  try {
    const result = await pdfParse(buffer);
    const text = normaliseText(result.text);

    if (text.length < MIN_EXTRACTABLE_TEXT) {
      logger.warn({
        type: 'pdf_minimal_text_extracted',
        textLength: text.length,
        pages: result.numpages,
        note: 'Document may be image-only/scanned. OCR preprocessing recommended.',
      });
    }

    return text;
  } catch (error: any) {
    throw new DocumentParsingError(`PDF extraction failed: ${error.message}`, {
      originalError: error.message,
    });
  }
}

async function extractFromDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return normaliseText(result.value);
  } catch (error: any) {
    throw new DocumentParsingError(`DOCX extraction failed: ${error.message}`, {
      originalError: error.message,
    });
  }
}

function extractFromTxt(buffer: Buffer): string {
  return normaliseText(buffer.toString('utf-8'));
}

async function extractText(buffer: Buffer, fileExt: string): Promise<string> {
  switch (fileExt) {
    case 'pdf':
      return extractFromPdf(buffer);
    case 'docx':
    case 'doc':
      return extractFromDocx(buffer);
    case 'txt':
      return extractFromTxt(buffer);
    default:
      throw new DocumentParsingError(`Unsupported file type: .${fileExt}`);
  }
}

// ============================================================================
// Core processing pipeline
// ============================================================================

interface ProcessingResult {
  chunkCount: number;
  totalCharacters: number;
  // Vector IDs we created (used for rollback)
  vectorIds: string[];
  // Chunk rows we intend to persist
  chunkRows: Array<{
    vectorId: string;
    chunkIndex: number;
    content: string;
    section: string | null;
  }>;
}

async function processDocumentBuffer(
  doc: DocRecord,
  buffer: Buffer,
  fileExt: string
): Promise<ProcessingResult> {
  const extractedText = await extractText(buffer, fileExt);

  if (!extractedText.trim()) {
    throw new DocumentParsingError('Document contains no extractable text');
  }

  // Upload original document to storage
  try {
    const mimeType = getMimeType(fileExt);

    await ingestStorage.uploadBuffer(doc.storageKey, buffer, {
      contentType: mimeType,
      category: 'exports',
      malwareScan: false,
      metadata: {
        title: doc.title,
        source: doc.source,
        jurisdiction: doc.jurisdiction,
        documentType: doc.documentType,
        ingestedAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    throw new DocumentUploadError(`Storage upload failed: ${error.message}`, {
      originalError: error.message,
      storageKey: doc.storageKey,
    });
  }

  // Chunk
  const effectiveYear =
    doc.effectiveDate?.getFullYear() ?? new Date().getFullYear();

  const rawChunks = chunkLegalAct(
    extractedText,
    doc.title,
    effectiveYear,
    doc.category as string
  );

  const chunks = mergeSmallChunks(rawChunks, MIN_CHUNK_SIZE);
  if (!chunks.length) {
    throw new DocumentParsingError(
      'Chunking produced no chunks; document may be empty or parsing failed.'
    );
  }

  // Embed + upsert vectors
  const vectorIds: string[] = [];
  const chunkRows: ProcessingResult['chunkRows'] = [];

  try {
    for (let i = 0; i < chunks.length; i += VECTOR_BATCH_SIZE) {
      const batch = chunks.slice(i, i + VECTOR_BATCH_SIZE);

      const embeddings = await generateBatchEmbeddings(batch.map((c) => c.text));

      const vectors: VectorRecord[] = batch.map((chunk, idx) => {
        const chunkIndex = i + idx;
        const id = `${doc.id}-chunk-${chunkIndex}`;
        vectorIds.push(id);

        // Keep minimal metadata to avoid oversized vector metadata
        return {
          id,
          values: embeddings[idx],
          metadata: {
            documentId: doc.id,
            documentTitle: doc.title,
            documentType: doc.documentType,
            jurisdiction: doc.jurisdiction,
            category: doc.category,
            chunkIndex,
            section: chunk.section ?? null,
          },
        };
      });

      await upsertVectors(vectors);

      // prepare DB chunk rows for this batch
      batch.forEach((chunk, idx) => {
        const chunkIndex = i + idx;
        const vectorId = `${doc.id}-chunk-${chunkIndex}`;
        chunkRows.push({
          vectorId,
          chunkIndex,
          content: chunk.text,
          section: chunk.section ?? null,
        });
      });
    }
  } catch (error: any) {
    // Roll back vectors if indexing fails
    try {
      if (vectorIds.length) await deleteVectors(vectorIds);
    } catch (rollbackErr: any) {
      logger.error({
        type: 'vector_rollback_failed',
        message: rollbackErr?.message,
      });
    }

    throw new DocumentIndexingError(`Vector indexing failed: ${error.message}`, {
      originalError: error.message,
      documentId: doc.id,
    });
  }

  return {
    chunkCount: chunks.length,
    totalCharacters: extractedText.length,
    vectorIds,
    chunkRows,
  };
}

// ============================================================================
// Service
// ============================================================================

export class DocumentIngestionService {
  /**
   * Ingest a document:
   * - reads local file
   * - dedupes by checksum for ACTIVE docs
   * - creates/updates the RegulatoryDocument record
   * - uploads to storage
   * - chunks, embeds, upserts vectors
   * - saves chunk rows in DB
   * - marks document ACTIVE
   */
  async ingestDocument(input: DocumentIngestionInput): Promise<IngestionResult> {
    const startedAt = new Date();

    // Validate file
    assertFileReadable(input.filePath);

    const resolvedFileName = input.fileName ?? path.basename(input.filePath);
    const fileExt = getFileExt(resolvedFileName);

    // Read file
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(input.filePath);
    } catch (error: any) {
      throw new DocumentParsingError(`Failed to read file: ${error.message}`, {
        filePath: input.filePath,
      });
    }

    const checksum = computeChecksum(buffer);
    const jurisdictionSlug = safeSlug(input.jurisdiction);
    const fileNameSafe = resolvedFileName; // keep original (Prisma has fileName already)
    const storageKey = `regulations/${jurisdictionSlug}/${fileNameSafe}`;

    // Deduplicate (skip if already ACTIVE with same checksum)
    const existingActive = await prisma.regulatoryDocument.findFirst({
      where: {
        checksum,
        status: 'ACTIVE',
      },
      select: { id: true, title: true, storageKey: true },
    });

    if (existingActive) {
      logger.info({
        type: 'document_deduped',
        checksum,
        existingId: existingActive.id,
        title: existingActive.title,
      });

      return {
        documentId: existingActive.id,
        chunkCount: 0,
        totalCharacters: 0,
        storageKey: existingActive.storageKey,
        skipped: true,
        reason: 'Duplicate checksum (already ACTIVE)',
      };
    }

    // If there is a prior PROCESSING/FAILED doc with this checksum, reuse it (retry scenario)
    const existingNonActive = await prisma.regulatoryDocument.findFirst({
      where: {
        checksum,
        status: { in: ['PROCESSING', 'FAILED'] },
      },
      select: { id: true },
    });

    // Create or reset document record (PROCESSING)
    const fileType = fileExt; // e.g., pdf/docx/txt

    const docRow = await prisma.regulatoryDocument.upsert({
      where: { id: existingNonActive?.id ?? '__nonexistent__' },
      create: {
        // NOTE: DO NOT WRITE filePath (schema doesn't have it)
        title: input.title,
        source: input.source,
        category: input.category,
        jurisdiction: input.jurisdiction,
        documentType: input.documentType,
        effectiveDate: input.effectiveDate,
        version: input.version,
        fileName: fileNameSafe,
        fileType,
        storageKey,
        status: 'PROCESSING',
        checksum,
      },
      update: {
        title: input.title,
        source: input.source,
        category: input.category,
        jurisdiction: input.jurisdiction,
        documentType: input.documentType,
        effectiveDate: input.effectiveDate ?? null,
        version: input.version ?? null,
        fileName: fileNameSafe,
        fileType,
        storageKey,
        status: 'PROCESSING',
        errorMessage: null,
        processedAt: null,
        chunkCount: null,
        totalCharacters: null,
      },
      select: {
        id: true,
        title: true,
        source: true,
        category: true,
        jurisdiction: true,
        documentType: true,
        storageKey: true,
        effectiveDate: true,
        version: true,
      },
    });

    const doc: DocRecord = {
      id: docRow.id,
      title: docRow.title,
      source: docRow.source,
      category: docRow.category,
      jurisdiction: docRow.jurisdiction,
      documentType: docRow.documentType,
      storageKey: docRow.storageKey,
      effectiveDate: docRow.effectiveDate,
      version: docRow.version,
    };

    // Process: upload, chunk, embed, upsert
    let processing: ProcessingResult | null = null;

    try {
      processing = await processDocumentBuffer(doc, buffer, fileExt);

      // Persist chunks + finalize document in a transaction
      await prisma.$transaction(async (tx) => {
        // If retrying, delete old chunks first (so we don't duplicate)
        // NOTE: adjust model/field names if your chunk model differs
        await tx.regulatoryDocumentChunk.deleteMany({
          where: { documentId: doc.id },
        });

        // Create chunk rows
        // NOTE: adjust field names if your Prisma model differs
        await tx.regulatoryDocumentChunk.createMany({
          data: processing!.chunkRows.map((r) => ({
            documentId: doc.id,
            vectorId: r.vectorId,
            chunkIndex: r.chunkIndex,
            content: r.content,
            section: r.section,
          })),
        });

        // Mark ACTIVE
        await tx.regulatoryDocument.update({
          where: { id: doc.id },
          data: {
            status: 'ACTIVE',
            chunkCount: processing!.chunkCount,
            totalCharacters: processing!.totalCharacters,
            processedAt: new Date(),
            errorMessage: null,
          },
        });
      });

      logger.info({
        type: 'document_ingested',
        documentId: doc.id,
        title: doc.title,
        chunkCount: processing.chunkCount,
        totalCharacters: processing.totalCharacters,
        durationMs: Date.now() - startedAt.getTime(),
      });

      return {
        documentId: doc.id,
        chunkCount: processing.chunkCount,
        totalCharacters: processing.totalCharacters,
        storageKey: doc.storageKey,
        skipped: false,
      };
    } catch (error: any) {
      // Mark FAILED and store error
      try {
        await prisma.regulatoryDocument.update({
          where: { id: doc.id },
          data: {
            status: 'FAILED',
            errorMessage: error?.message ?? 'Unknown ingestion error',
            processedAt: new Date(),
          },
        });
      } catch (dbErr: any) {
        logger.error({
          type: 'failed_to_mark_document_failed',
          documentId: doc.id,
          message: dbErr?.message,
        });
      }

      logger.error({
        type: 'script_ingestion_error',
        title: input.title,
        fileName: `${jurisdictionSlug}/${fileNameSafe}`,
        message: error?.message,
        stack: error?.stack,
      });

      throw error;
    }
  }

  /**
   * Delete a document:
   * - deletes DB chunks
   * - deletes vectors
   * - optionally deletes from storage
   * - deletes document row
   */
  async deleteDocument(
    documentId: string,
    opts: DeleteDocumentOptions = {}
  ): Promise<void> {
    const doc = await prisma.regulatoryDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        storageKey: true,
      },
    });

    if (!doc) return;

    // Pull vector IDs from chunks (so we can delete vectors)
    const chunks = await prisma.regulatoryDocumentChunk.findMany({
      where: { documentId },
      select: { vectorId: true },
    });

    const vectorIds = chunks.map((c) => c.vectorId).filter(Boolean);

    // Best-effort delete vectors
    try {
      if (vectorIds.length) await deleteVectors(vectorIds);
    } catch (error: any) {
      logger.warn({
        type: 'delete_vectors_failed',
        documentId,
        message: error?.message,
      });
    }

    // Best-effort delete from storage
    if (opts.deleteFromStorage) {
      try {
        await ingestStorage.deleteObject(doc.storageKey);
      } catch (error: any) {
        logger.warn({
          type: 'delete_storage_failed',
          documentId,
          storageKey: doc.storageKey,
          message: error?.message,
        });
      }
    }

    // Delete DB rows
    await prisma.$transaction(async (tx) => {
      await tx.regulatoryDocumentChunk.deleteMany({ where: { documentId } });
      await tx.regulatoryDocument.delete({ where: { id: documentId } });
    });
  }

  /**
   * Basic stats for admin dashboards.
   */
  async getStats(): Promise<DocumentStats> {
    const [byStatus, byCategory, byJurisdiction, totalChunks] =
      await Promise.all([
        prisma.regulatoryDocument.groupBy({
          by: ['status'],
          _count: { status: true },
        }),
        prisma.regulatoryDocument.groupBy({
          by: ['category'],
          _count: { category: true },
        }),
        prisma.regulatoryDocument.groupBy({
          by: ['jurisdiction'],
          _count: { jurisdiction: true },
        }),
        prisma.regulatoryDocumentChunk.count(),
      ]);

    const totalByStatus: Partial<Record<RegulatoryDocumentStatus, number>> = {};
    byStatus.forEach((r) => {
      totalByStatus[r.status] = r._count.status;
    });

    const cat: Record<string, number> = {};
    byCategory.forEach((r) => {
      cat[String(r.category)] = r._count.category;
    });

    const jur: Record<string, number> = {};
    byJurisdiction.forEach((r) => {
      jur[String(r.jurisdiction)] = r._count.jurisdiction;
    });

    return {
      totalByStatus,
      totalChunks,
      byCategory: cat,
      byJurisdiction: jur,
    };
  }
}

// Convenience singleton (optional)
export const documentIngestionService = new DocumentIngestionService();