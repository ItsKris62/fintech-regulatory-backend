import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'

import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

import { prisma } from '@/lib/prisma/client'
import { logger } from '@/utils/logger'

import {
  upsertVectors,
  deleteVectors,
  type IntegratedVectorRecord,
} from '@/lib/rag/client'

import { chunkLegalAct, mergeSmallChunks } from '@/lib/rag/chunking'
import { createStorageService } from '@/lib/storage/client'
import { getMimeType } from '@/utils/helpers'

import {
  DocumentParsingError,
  DocumentIndexingError,
  DocumentUploadError,
} from '@/utils/error'

// ============================================================================
// Types
// ============================================================================

export interface DocumentIngestionInput {
  filePath: string;
  fileName?: string;
  title: string;
  source: string;
  category: string;
  jurisdiction: string;
  documentType: string;
  effectiveDate?: Date;
  version?: string;
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
  deleteVectors?: boolean;
  deleteStorage?: boolean;
}

export interface DocumentStats {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  byJurisdiction: Record<string, number>;
}

// ============================================================================
// Constants
// ============================================================================

const VECTOR_BATCH_SIZE = 50
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024
const MIN_EXTRACTABLE_TEXT = 100
const MIN_CHUNK_SIZE = 100

const VECTOR_UPSERT_MAX_RETRIES = 4
const VECTOR_UPSERT_BASE_DELAY_MS = 400

const ingestStorage = createStorageService()

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
    .trim()
}

function computeChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function safeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function getFileExt(fileName: string): string {
  return path.extname(fileName).replace('.', '').toLowerCase()
}

function assertFileReadable(filePath: string): { size: number } {
  if (!fs.existsSync(filePath)) {
    throw new DocumentParsingError(`File not found: ${filePath}`)
  }

  const stat = fs.statSync(filePath)

  if (!stat.isFile()) {
    throw new DocumentParsingError(`Path is not a file: ${filePath}`)
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new DocumentParsingError(`File too large (max 50MB)`)
  }

  return { size: stat.size }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(ms: number) {
  const delta = ms * 0.25
  return Math.max(0, Math.floor(ms + (Math.random() * 2 - 1) * delta))
}

async function withRetry<T>(
  fn: () => Promise<T>,
  name: string
): Promise<T> {
  let attempt = 0

  while (true) {
    try {
      return await fn()
    } catch (err: any) {
      if (attempt >= VECTOR_UPSERT_MAX_RETRIES) throw err

      const delay = jitter(
        VECTOR_UPSERT_BASE_DELAY_MS * Math.pow(2, attempt)
      )

      logger.warn({
        type: 'retrying_operation',
        operation: name,
        attempt: attempt + 1,
        delayMs: delay,
        message: err?.message,
      })

      await sleep(delay)
      attempt++
    }
  }
}

// ============================================================================
// Text Extraction
// ============================================================================

async function extractFromPdf(buffer: Buffer): Promise<string> {
  try {
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    return normaliseText(result?.text ?? '')
  } catch (err: any) {
    throw new DocumentParsingError(
      `PDF parsing failed: ${err?.message ?? 'Unknown error'}`
    )
  }
}

async function extractFromDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer })
    return normaliseText(result.value)
  } catch (err: any) {
    throw new DocumentParsingError(
      `DOCX parsing failed: ${err?.message ?? 'Unknown error'}`
    )
  }
}

function extractFromTxt(buffer: Buffer): string {
  try {
    return normaliseText(buffer.toString('utf-8'))
  } catch (err: any) {
    throw new DocumentParsingError(
      `TXT parsing failed: ${err?.message ?? 'Unknown error'}`
    )
  }
}

async function extractText(
  buffer: Buffer,
  fileExt: string
): Promise<string> {
  switch (fileExt) {
    case 'pdf':
      return extractFromPdf(buffer)
    case 'docx':
    case 'doc':
      return extractFromDocx(buffer)
    case 'txt':
      return extractFromTxt(buffer)
    default:
      throw new DocumentParsingError(`Unsupported file type: .${fileExt}`)
  }
}

// ============================================================================
// Processing
// ============================================================================

async function processDocument(
  doc: any,
  buffer: Buffer,
  fileExt: string
) {
  const extractedText = await extractText(buffer, fileExt)

  if (!extractedText || extractedText.length < MIN_EXTRACTABLE_TEXT) {
    throw new DocumentParsingError(
      'Document contains no extractable text'
    )
  }

  // Upload original file
  try {
    await ingestStorage.uploadBuffer(doc.storageKey, buffer, {
      contentType: getMimeType(fileExt),
    })
  } catch (err: any) {
    throw new DocumentUploadError(
      `Storage upload failed: ${err?.message ?? 'Unknown error'}`
    )
  }

  const rawChunks = chunkLegalAct(
    extractedText,
    doc.title,
    new Date().getFullYear(),
    doc.category as string
  )

  const chunks = mergeSmallChunks(rawChunks, MIN_CHUNK_SIZE)

  const vectorIds: string[] = []
  const chunkRows: any[] = []

  for (let i = 0; i < chunks.length; i += VECTOR_BATCH_SIZE) {
    const batch = chunks.slice(i, i + VECTOR_BATCH_SIZE)

    const records: IntegratedVectorRecord[] = batch.map((chunk, idx) => {
      const chunkIndex = i + idx
      const id = `${doc.id}-chunk-${chunkIndex}`
      vectorIds.push(id)

      return {
        id,
        chunk_text: chunk.text,
        documentId: doc.id,
        documentTitle: doc.title,
        documentType: doc.documentType,
        chunkIndex,
        section: chunk.section ?? undefined,
        // Metadata used by RAG filter auto-detection
        jurisdiction: doc.jurisdiction,
        category: doc.category,
        year: doc.effectiveDate
          ? new Date(doc.effectiveDate).getFullYear()
          : undefined,
        regulatoryArea: doc.category,
      }
    })

    try {
      await withRetry(() => upsertVectors(records), 'pinecone_upsert')
    } catch (err: any) {
      throw new DocumentIndexingError(
        `Vector indexing failed: ${err?.message ?? 'Unknown error'}`
      )
    }

    batch.forEach((chunk, idx) => {
      chunkRows.push({
        pineconeId: `${doc.id}-chunk-${i + idx}`,
        chunkIndex: i + idx,
        content: chunk.text,
        section: chunk.section ?? null,
        tokenCount: Math.ceil(chunk.text.length / 4),
      })
    })
  }

  return {
    chunkCount: chunks.length,
    totalCharacters: extractedText.length,
    vectorIds,
    chunkRows,
  }
}

// ============================================================================
// Service
// ============================================================================

export class DocumentIngestionService {
  async ingestDocument(input: DocumentIngestionInput): Promise<IngestionResult> {
    assertFileReadable(input.filePath)

    // MEMORY SAFE READ (stream → buffer)
    const bufChunks: Buffer[] = []
    const stream = fs.createReadStream(input.filePath)

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => bufChunks.push(chunk as Buffer))
      stream.on('end', resolve)
      stream.on('error', reject)
    })

    const buffer = Buffer.concat(bufChunks)

    const checksum = computeChecksum(buffer)

    // Checksum deduplication — skip if already indexed
    const existing = await (prisma as any).regulatoryDocument.findFirst({
      where: { checksum, status: { not: 'FAILED' } },
    })

    if (existing) {
      return {
        documentId: existing.id,
        chunkCount: existing.chunkCount ?? 0,
        totalCharacters: existing.totalCharacters ?? 0,
        storageKey: existing.storageKey,
        skipped: true,
        reason: `Duplicate — already indexed as "${existing.title}"`,
      }
    }

    const fileName = input.fileName ?? path.basename(input.filePath)
    const fileExt = getFileExt(fileName)

    const storageKey = `regulations/${safeSlug(
      input.jurisdiction
    )}/${fileName}`

    const doc = await (prisma as any).regulatoryDocument.create({
      data: {
        title: input.title,
        source: input.source,
        category: input.category,
        jurisdiction: input.jurisdiction,
        documentType: input.documentType,
        effectiveDate: input.effectiveDate,
        version: input.version,
        fileName,
        fileType: fileExt,
        storageKey,
        status: 'PROCESSING',
        checksum,
      },
    })

    try {
      const processing = await processDocument(doc, buffer, fileExt)

      await prisma.$transaction(async (tx) => {
        await (tx as any).regulatoryDocumentChunk.createMany({
          data: processing.chunkRows.map((r) => ({
            documentId: doc.id,
            pineconeId: r.pineconeId,
            chunkIndex: r.chunkIndex,
            content: r.content,
            section: r.section,
            tokenCount: r.tokenCount,
          })),
        })

        await (tx as any).regulatoryDocument.update({
          where: { id: doc.id },
          data: {
            status: 'ACTIVE',
            chunkCount: processing.chunkCount,
            totalCharacters: processing.totalCharacters,
            processedAt: new Date(),
          },
        })
      })

      return {
        documentId: doc.id,
        chunkCount: processing.chunkCount,
        totalCharacters: processing.totalCharacters,
        storageKey,
        skipped: false,
      }
    } catch (error: any) {
      await (prisma as any).regulatoryDocument.update({
        where: { id: doc.id },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        },
      })

      throw error
    }
  }
}

export const documentIngestionService =
  new DocumentIngestionService()