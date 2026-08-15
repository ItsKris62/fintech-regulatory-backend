import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import { extractPdfText } from '@/lib/pdf/extract-text'

import { prisma } from '@/lib/prisma/client'
import { logger } from '@/utils/logger'

import {
  upsertVectors,
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
import {
  mapV1DocumentToV2Metadata,
  omitNullishMetadata,
  prepareV2ChunkMetadata,
} from '@/lib/source-grounding/source-metadata'

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
  authorityStatus?: 'DRAFT' | 'IN_FORCE' | 'SUPERSEDED' | 'CONSULTATION';
  isBinding?: boolean;
  supersedesDocumentId?: string;
  officialUrl?: string;
  publicationDate?: Date;
  retrievedAt?: Date;
  effectiveEndDate?: Date;
  sourceRegistryId?: string;
  sourceDocumentVersionId?: string;
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

// Pinecone metadata limit is 40,960 bytes per vector.
// Reserve ~8 KB for all other metadata fields; cap chunk_text at ~30 KB.
const MAX_CHUNK_TEXT_BYTES = 30_000
const MAX_SECTION_BYTES = 500

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

function defaultBindingForAuthority(
  authorityStatus: DocumentIngestionInput['authorityStatus'] = 'IN_FORCE'
): boolean {
  return authorityStatus === 'IN_FORCE'
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
    const text = await extractPdfText(buffer)
    return normaliseText(text)
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
  const documentMetadata = mapV1DocumentToV2Metadata(doc)

  for (let i = 0; i < chunks.length; i += VECTOR_BATCH_SIZE) {
    const batch = chunks.slice(i, i + VECTOR_BATCH_SIZE)

    const records: IntegratedVectorRecord[] = batch.map((chunk, idx) => {
      const chunkIndex = i + idx
      const id = `${doc.id}-chunk-${chunkIndex}`
      vectorIds.push(id)

      // Truncate fields to stay within Pinecone's 40,960-byte metadata limit
      const chunkTextBytes = Buffer.byteLength(chunk.text, 'utf8')
      const safeChunkText =
        chunkTextBytes > MAX_CHUNK_TEXT_BYTES
          ? chunk.text.slice(0, MAX_CHUNK_TEXT_BYTES) + '...'
          : chunk.text

      const rawSection = chunk.section ?? undefined
      const safeSection =
        rawSection && Buffer.byteLength(rawSection, 'utf8') > MAX_SECTION_BYTES
          ? rawSection.slice(0, MAX_SECTION_BYTES) + '...'
          : rawSection

      const v2Metadata = prepareV2ChunkMetadata({
        documentId: doc.id,
        chunkIndex,
        content: chunk.text,
        documentChecksum: doc.checksum ?? null,
        provisionAnchor: {
          sectionNumber: safeSection,
        },
        sourceVersion: {
          sourceDocumentVersionId: doc.sourceDocumentVersionId ?? null,
          officialUrl: doc.officialUrl ?? null,
          publicationDate: doc.publicationDate ?? null,
          retrievedAt: doc.retrievedAt ?? null,
          effectiveDate: doc.effectiveDate ?? null,
          effectiveEndDate: doc.effectiveEndDate ?? null,
          versionLabel: doc.version ?? null,
          checksumSha256: doc.checksum ?? null,
        },
        authorityStatus: doc.authorityStatus ?? 'IN_FORCE',
        corpusStatus: documentMetadata.corpusStatus,
        isBinding: doc.isBinding ?? true,
        indexVersion: doc.indexVersion ?? 'v1',
      })

      return omitNullishMetadata({
        id,
        chunk_text: safeChunkText,
        documentId: doc.id,
        documentTitle: doc.title,
        documentType: doc.documentType,
        chunkIndex,
        section: safeSection,
        // Metadata used by RAG filter auto-detection
        jurisdiction: doc.jurisdiction,
        category: doc.category,
        year: doc.effectiveDate
          ? new Date(doc.effectiveDate).getFullYear()
          : undefined,
        regulatoryArea: doc.category,
        authorityStatus: doc.authorityStatus ?? 'IN_FORCE',
        isBinding: doc.isBinding ?? true,
        source: doc.source,
        version: doc.version ?? undefined,
        corpusStatus: documentMetadata.corpusStatus,
        indexVersion: doc.indexVersion ?? 'v1',
        officialUrl: doc.officialUrl ?? undefined,
        sourceDocumentVersionId: doc.sourceDocumentVersionId ?? undefined,
        sectionNumber: v2Metadata.sectionNumber ?? undefined,
        provisionId: v2Metadata.provisionId,
        contentHash: v2Metadata.contentHash,
        documentChecksum: doc.checksum ?? undefined,
        effectiveDate: doc.effectiveDate ? new Date(doc.effectiveDate).toISOString() : undefined,
        effectiveEndDate: doc.effectiveEndDate ? new Date(doc.effectiveEndDate).toISOString() : undefined,
      }) as IntegratedVectorRecord
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
        sectionNumber: chunk.section ?? null,
        provisionId: prepareV2ChunkMetadata({
          documentId: doc.id,
          chunkIndex: i + idx,
          content: chunk.text,
          provisionAnchor: { sectionNumber: chunk.section ?? null },
          indexVersion: doc.indexVersion ?? 'v1',
        }).provisionId,
        contentHash: prepareV2ChunkMetadata({
          documentId: doc.id,
          chunkIndex: i + idx,
          content: chunk.text,
          indexVersion: doc.indexVersion ?? 'v1',
        }).contentHash,
        sourceDocumentVersionId: doc.sourceDocumentVersionId ?? null,
        indexVersion: doc.indexVersion ?? 'v1',
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

    // MEMORY SAFE READ (stream -> buffer)
    const bufChunks: Buffer[] = []
    const stream = fs.createReadStream(input.filePath)

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => bufChunks.push(chunk as Buffer))
      stream.on('end', resolve)
      stream.on('error', reject)
    })

    const buffer = Buffer.concat(bufChunks)

    const checksum = computeChecksum(buffer)

    // Checksum deduplication  -  skip if already indexed
    const existing = await (prisma as any).regulatoryDocument.findFirst({
      where: { checksum, status: { not: 'FAILED' } },
    })

    if (existing) {
      if (existing.status === 'PROCESSING' || existing.status === 'PENDING') {
        await (prisma as any).regulatoryDocument.update({
          where: { id: existing.id },
          data: {
            status: 'FAILED',
            errorMessage: 'Marked failed so ingestion can resume after an interrupted run.',
          },
        })
      } else {
      const nextAuthorityStatus = input.authorityStatus ?? 'IN_FORCE'
      const nextIsBinding = input.isBinding ?? defaultBindingForAuthority(nextAuthorityStatus)

      if (
        existing.authorityStatus !== nextAuthorityStatus ||
        existing.isBinding !== nextIsBinding ||
        (input.version !== undefined && existing.version !== input.version)
      ) {
        await this.updateDocumentAuthority(existing.id, {
          authorityStatus: nextAuthorityStatus,
          isBinding: nextIsBinding,
          version: input.version,
          effectiveDate: input.effectiveDate,
        })
      }

      return {
        documentId: existing.id,
        chunkCount: existing.chunkCount ?? 0,
        totalCharacters: existing.totalCharacters ?? 0,
        storageKey: existing.storageKey,
        skipped: true,
        reason: `Duplicate  -  already indexed as "${existing.title}"`,
      }
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
        effectiveEndDate: input.effectiveEndDate,
        officialUrl: input.officialUrl,
        publicationDate: input.publicationDate,
        retrievedAt: input.retrievedAt,
        sourceRegistryId: input.sourceRegistryId,
        sourceDocumentVersionId: input.sourceDocumentVersionId,
        version: input.version,
        authorityStatus: input.authorityStatus ?? 'IN_FORCE',
        isBinding: input.isBinding ?? defaultBindingForAuthority(input.authorityStatus),
        fileName,
        fileType: fileExt,
        storageKey,
        status: 'PROCESSING',
        checksum,
        indexVersion: 'v1',
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

      if (input.supersedesDocumentId) {
        try {
          await this.updateDocumentAuthority(input.supersedesDocumentId, {
            authorityStatus: 'SUPERSEDED',
            isBinding: false,
          })
        } catch (err: any) {
          logger.warn({
            type: 'regulatory_document_supersede_warning',
            newDocumentId: doc.id,
            supersedesDocumentId: input.supersedesDocumentId,
            error: err?.message,
          })
        }
      }

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

  async updateDocumentAuthority(
    documentId: string,
    input: {
      authorityStatus: 'DRAFT' | 'IN_FORCE' | 'SUPERSEDED' | 'CONSULTATION';
      isBinding?: boolean;
      version?: string;
      effectiveDate?: Date;
    }
  ): Promise<void> {
    const doc = await (prisma as any).regulatoryDocument.update({
      where: { id: documentId },
      data: {
        authorityStatus: input.authorityStatus,
        isBinding: input.isBinding ?? input.authorityStatus === 'IN_FORCE',
        version: input.version,
        effectiveDate: input.effectiveDate,
        status: input.authorityStatus === 'SUPERSEDED' ? 'SUPERSEDED' : undefined,
      },
      include: { chunks: true },
    })

    if (!doc.chunks?.length) return

    const records: IntegratedVectorRecord[] = doc.chunks.map((chunk: any) => ({
      id: chunk.pineconeId,
      chunk_text: chunk.content,
      documentId: doc.id,
      documentTitle: doc.title,
      documentType: doc.documentType,
      chunkIndex: chunk.chunkIndex,
      section: chunk.section ?? undefined,
      jurisdiction: doc.jurisdiction,
      category: doc.category,
      year: doc.effectiveDate ? new Date(doc.effectiveDate).getFullYear() : undefined,
      regulatoryArea: doc.category,
      authorityStatus: doc.authorityStatus,
      isBinding: doc.isBinding,
      source: doc.source,
      version: doc.version ?? undefined,
      corpusStatus: doc.status,
    }))

    for (let i = 0; i < records.length; i += VECTOR_BATCH_SIZE) {
      const batch = records.slice(i, i + VECTOR_BATCH_SIZE)
      await withRetry(() => upsertVectors(batch), 'pinecone_authority_metadata_upsert')
    }
  }
}

export const documentIngestionService =
  new DocumentIngestionService()
