import mammoth from 'mammoth';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { extractPdfText } from '@/lib/pdf/extract-text';
import { createStorageService } from '@/lib/storage/client';
import { upsertVectors, type IntegratedVectorRecord } from '@/lib/rag/client';
import { isPriorityRegulatoryDocument } from '@/lib/source-grounding/approved-sources';
import { buildPageAwareText, chunkPageAwareLegalText } from '@/lib/source-grounding/v2-chunking';
import {
  deriveSourceLifecycleStatus,
  omitNullishMetadata,
  type SourceVersionRef,
} from '@/lib/source-grounding/source-metadata';

type Options = {
  dryRun: boolean;
  limit?: number;
  documentIds: string[];
  upsertVectors: boolean;
};

type ReindexSummary = {
  dryRun: boolean;
  scanned: number;
  processed: number;
  skipped: number;
  chunksCreated: number;
  chunksSkipped: number;
  vectorsPrepared: number;
  vectorsUpserted: number;
  warnings: string[];
};

const storage = createStorageService();

function parseOptions(argv: string[]): Options {
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const idsArg = argv.find((arg) => arg.startsWith('--document-ids='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
  return {
    dryRun: !argv.includes('--write'),
    limit: Number.isFinite(limit) && limit && limit > 0 ? limit : undefined,
    documentIds: idsArg ? idsArg.split('=')[1].split(',').map((id) => id.trim()).filter(Boolean) : [],
    upsertVectors: argv.includes('--upsert-vectors'),
  };
}

async function extractTextForV2(fileType: string, buffer: Buffer): Promise<{ text: string; pageBreaksReliable: boolean; sourceType: 'pdf' | 'docx' | 'txt' | 'unknown' }> {
  const normalizedType = fileType.toLowerCase().replace(/^\./, '');
  if (normalizedType.includes('pdf')) {
    const text = await extractPdfText(buffer);
    return { text, pageBreaksReliable: text.includes('\f'), sourceType: 'pdf' };
  }
  if (normalizedType.includes('doc')) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, pageBreaksReliable: false, sourceType: 'docx' };
  }
  if (normalizedType.includes('txt') || normalizedType.includes('text')) {
    return { text: buffer.toString('utf-8'), pageBreaksReliable: false, sourceType: 'txt' };
  }
  return { text: buffer.toString('utf-8'), pageBreaksReliable: false, sourceType: 'unknown' };
}

export async function reindexPriorityDocumentsV2(options: Options): Promise<ReindexSummary> {
  const summary: ReindexSummary = {
    dryRun: options.dryRun,
    scanned: 0,
    processed: 0,
    skipped: 0,
    chunksCreated: 0,
    chunksSkipped: 0,
    vectorsPrepared: 0,
    vectorsUpserted: 0,
    warnings: [],
  };

  const documents = await (prisma as any).regulatoryDocument.findMany({
    take: options.limit,
    where: options.documentIds.length > 0 ? { id: { in: options.documentIds } } : undefined,
    orderBy: { updatedAt: 'desc' },
    include: { sourceDocumentVersion: true },
  });

  summary.scanned = documents.length;

  for (const doc of documents) {
    if (options.documentIds.length === 0 && !isPriorityRegulatoryDocument(doc)) {
      summary.skipped++;
      continue;
    }

    const sourceVersion: SourceVersionRef = {
      sourceDocumentVersionId: doc.sourceDocumentVersionId ?? null,
      officialUrl: doc.sourceDocumentVersion?.officialUrl ?? doc.officialUrl ?? null,
      publicationDate: doc.sourceDocumentVersion?.publicationDate ?? doc.publicationDate ?? null,
      retrievedAt: doc.sourceDocumentVersion?.retrievedAt ?? doc.retrievedAt ?? null,
      effectiveDate: doc.sourceDocumentVersion?.effectiveDate ?? doc.effectiveDate ?? null,
      effectiveEndDate: doc.sourceDocumentVersion?.effectiveEndDate ?? doc.effectiveEndDate ?? null,
      versionLabel: doc.sourceDocumentVersion?.versionLabel ?? doc.version ?? null,
      checksumSha256: doc.sourceDocumentVersion?.checksumSha256 ?? doc.checksum ?? null,
    };
    const lifecycle = deriveSourceLifecycleStatus({
      documentStatus: doc.status,
      versionStatus: doc.sourceDocumentVersion?.status,
      authorityStatus: doc.authorityStatus,
      effectiveEndDate: sourceVersion.effectiveEndDate,
      supersededByDocumentId: doc.supersededByDocumentId,
      isBinding: doc.isBinding,
    });

    let extracted;
    try {
      const buffer = await storage.downloadFile(doc.storageKey);
      extracted = await extractTextForV2(doc.fileType || doc.fileName || '', buffer);
    } catch (error: any) {
      summary.skipped++;
      summary.warnings.push(`${doc.id}: unable to read/parse original (${error?.message ?? 'unknown error'})`);
      continue;
    }

    const pageAwareText = buildPageAwareText(extracted.text, {
      sourceType: extracted.sourceType,
      pageBreaksReliable: extracted.pageBreaksReliable,
    });
    if (!pageAwareText.pageMetadataReliable) {
      summary.warnings.push(`${doc.id}: page metadata unavailable for v2 chunks`);
    }

    const chunks = chunkPageAwareLegalText({
      documentId: doc.id,
      pageAwareText,
      documentChecksum: doc.checksum ?? null,
      sourceVersion,
      authorityStatus: doc.authorityStatus ?? 'IN_FORCE',
      corpusStatus: lifecycle.corpusStatus,
      isBinding: lifecycle.isBinding,
    });

    const existingChunks = await (prisma as any).regulatoryDocumentChunk.findMany({
      where: {
        documentId: doc.id,
        indexVersion: 'v2',
        contentHash: { in: chunks.map((chunk) => chunk.metadata.contentHash) },
      },
      select: { contentHash: true },
    });
    const existingHashes = new Set(existingChunks.map((chunk: { contentHash?: string | null }) => chunk.contentHash).filter(Boolean));
    const seenHashes = new Set<string>();
    const uniqueChunks = chunks.filter((chunk) => {
      const hash = chunk.metadata.contentHash;
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    });

    const newChunks = uniqueChunks.filter((chunk) => !existingHashes.has(chunk.metadata.contentHash));
    summary.chunksSkipped += chunks.length - newChunks.length;

    const records: IntegratedVectorRecord[] = uniqueChunks.map((chunk) => omitNullishMetadata({
      id: `${doc.id}-v2-${chunk.metadata.contentHash.slice(0, 20)}`,
      chunk_text: chunk.text.length > 35000 ? chunk.text.substring(0, 35000) : chunk.text,
      documentId: doc.id,
      documentTitle: doc.title,
      documentType: doc.documentType,
      chunkIndex: chunk.index,
      section: chunk.section ?? undefined,
      jurisdiction: doc.jurisdiction,
      category: doc.category,
      year: doc.effectiveDate ? new Date(doc.effectiveDate).getFullYear() : undefined,
      regulatoryArea: doc.category,
      authorityStatus: doc.authorityStatus ?? 'IN_FORCE',
      isBinding: lifecycle.isBinding,
      source: doc.source,
      version: doc.version ?? undefined,
      corpusStatus: lifecycle.corpusStatus,
      indexVersion: 'v2',
      officialUrl: sourceVersion.officialUrl ?? undefined,
      sourceDocumentVersionId: sourceVersion.sourceDocumentVersionId ?? undefined,
      pageStart: chunk.metadata.pageStart ?? undefined,
      pageEnd: chunk.metadata.pageEnd ?? undefined,
      sectionNumber: chunk.metadata.sectionNumber ?? undefined,
      clauseNumber: chunk.metadata.clauseNumber ?? undefined,
      scheduleNumber: chunk.metadata.scheduleNumber ?? undefined,
      headingPath: chunk.metadata.headingPath ?? undefined,
      provisionId: chunk.metadata.provisionId,
      contentHash: chunk.metadata.contentHash,
      documentChecksum: doc.checksum ?? undefined,
      effectiveDate: sourceVersion.effectiveDate ? new Date(sourceVersion.effectiveDate).toISOString() : undefined,
      effectiveEndDate: sourceVersion.effectiveEndDate ? new Date(sourceVersion.effectiveEndDate).toISOString() : undefined,
    }) as IntegratedVectorRecord);

    summary.vectorsPrepared += records.length;

    if (!options.dryRun) {
      for (const chunk of newChunks) {
        await (prisma as any).regulatoryDocumentChunk.create({
          data: {
            documentId: doc.id,
            chunkIndex: chunk.index,
            content: chunk.text,
            section: chunk.section ?? null,
            tokenCount: Math.ceil(chunk.text.length / 4),
            pineconeId: `${doc.id}-v2-${chunk.metadata.contentHash.slice(0, 20)}`,
            pageStart: chunk.metadata.pageStart ?? null,
            pageEnd: chunk.metadata.pageEnd ?? null,
            sectionNumber: chunk.metadata.sectionNumber ?? null,
            clauseNumber: chunk.metadata.clauseNumber ?? null,
            scheduleNumber: chunk.metadata.scheduleNumber ?? null,
            headingPath: chunk.metadata.headingPath ?? undefined,
            provisionId: chunk.metadata.provisionId,
            charStart: chunk.metadata.charStart ?? null,
            charEnd: chunk.metadata.charEnd ?? null,
            contentHash: chunk.metadata.contentHash,
            sourceDocumentVersionId: sourceVersion.sourceDocumentVersionId ?? null,
            indexVersion: 'v2',
            metadata: {
              parser: chunk.metadata.parser,
              pageMetadataReliable: chunk.metadata.pageMetadataReliable,
              fallbackReason: chunk.metadata.fallbackReason ?? null,
            },
          },
        });
        summary.chunksCreated++;
      }

      if (options.upsertVectors && records.length > 0) {
        for (let i = 0; i < records.length; i += 90) {
          const batch = records.slice(i, i + 90);
          await upsertVectors(batch);
        }
        summary.vectorsUpserted += records.length;
      }
    } else {
      summary.chunksCreated += newChunks.length;
    }

    summary.processed++;
  }

  logger.info({ type: 'priority_documents_v2_reindex_complete', ...summary });
  return summary;
}

if (require.main === module) {
  reindexPriorityDocumentsV2(parseOptions(process.argv.slice(2)))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
