/**
 * Document Module
 * Manages the full lifecycle of documents: upload, processing, versioning,
 * sharing, and knowledge base content (blog posts / KB articles).
 *
 * Integrations:
 * - Cloudflare R2 (storageService) — file storage
 * - Pinecone (ragService)          — vector embeddings & semantic search
 * - Prisma                         — metadata persistence
 * - Redis                          — caching & processing status
 */

import { prisma } from '@/lib/prisma/client';
import { logPilotEvent } from '@/modules/pilot';
import { redis } from '@/lib/redis/client';
import { ragService } from '@/lib/rag/rag.service';
import { storageService } from '@/lib/storage/storage.service';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';
import {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
} from '@/utils/error';
import {
  generateSlug,
  generateShareToken,
  extractText,
  toDocumentSummary,
  toBlogPost,
  toKBArticle,
  toShareLink,
  docCacheKey,
  searchCacheKey,
} from './document.utils';
import {
  DOCUMENT_CONSTANTS,
  type UploadDocumentParams,
  type DocumentMetadata,
  type DocumentFilters,
  type SearchFilters,
  type PaginatedDocuments,
  type DocumentSearchResult,
  type ProcessingResult,
  type DocumentVersion,
  type ShareParams,
  type ShareLink,
  type BulkUploadParams,
  type BulkUploadResult,
  type BulkDeleteResult,
  type DocumentExportFormat,
  type ExportResult,
  type BlogPostParams,
  type BlogPost,
  type BlogFilters,
  type PaginatedBlogPosts,
  type KBArticleParams,
  type KBArticle,
  type KBFilters,
  type PaginatedKBArticles,
  type KBSearchResult,
  type DocumentSummary,
} from './document.types';

const { REDIS_KEYS, CACHE_TTL, LIMITS } = DOCUMENT_CONSTANTS;

class DocumentModule {
  private readonly appUrl: string;

  constructor() {
    this.appUrl = appConfig.appUrl || 'http://localhost:3000';
  }

  // ==========================================================================
  // UPLOAD & PROCESSING
  // ==========================================================================

  /**
   * Upload a document to R2 and create metadata record in DB.
   * Optionally triggers async processing (text extraction + Pinecone indexing).
   */
  async uploadDocument(params: UploadDocumentParams): Promise<DocumentSummary> {
    logger.info({
      type: 'document_upload_started',
      userId: params.userId,
      filename: params.filename,
      size: params.file.length,
    });

    // Validate file type
    if (!DOCUMENT_CONSTANTS.ALLOWED_MIME_TYPES.includes(params.mimeType as never)) {
      throw new BadRequestError(
        `Unsupported file type: ${params.mimeType}. Allowed: PDF, DOCX, TXT, MD, HTML`
      );
    }

    // Validate file size
    const maxBytes = LIMITS.MAX_FILE_SIZE_MB * 1024 * 1024;
    if (params.file.length > maxBytes) {
      throw new BadRequestError(
        `File exceeds maximum size of ${LIMITS.MAX_FILE_SIZE_MB}MB`
      );
    }

    try {
      // Upload to R2
      const uploaded = await storageService.uploadDocument(
        params.file,
        params.filename,
        params.userId,
        { organizationId: params.organizationId ?? '' }
      );

      // Create DB record
      const doc = await prisma.legalDocument.create({
        data: {
          actName: params.metadata?.actName ?? params.filename,
          documentType: params.metadata?.documentType ?? 'DOCUMENT',
          originalFilename: params.filename,
          fileUrl: uploaded.url,
          fileSize: uploaded.size,
          mimeType: params.mimeType,
          status: 'UPLOADING',
          contentType: 'REGULATORY_DOCUMENT',
          contentStatus: 'DRAFT',
          title: params.metadata?.title ?? null,
          tags: params.metadata?.tags ?? [],
          keywords: params.metadata?.keywords ?? [],
          category: params.metadata?.category ?? null,
          subcategory: params.metadata?.subcategory ?? null,
          regulatoryBody: params.metadata?.regulatoryBody ?? null,
          enactmentDate: params.metadata?.enactmentDate ?? null,
          effectiveDate: params.metadata?.effectiveDate ?? null,
          userId: params.userId,
          organizationId: params.organizationId ?? null,
          authorId: params.userId,
        },
      });

      // Queue processing status in Redis
      await redis.set(
        `${REDIS_KEYS.PROCESSING}${doc.id}`,
        JSON.stringify({ status: 'queued', documentId: doc.id }),
        { ex: 300 }
      );

      // Auto-process if requested (fire-and-forget with error capture)
      if (params.autoProcess !== false) {
        this.processDocument(doc.id).catch((err: Error) => {
          logger.error({
            type: 'document_auto_process_error',
            documentId: doc.id,
            error: err.message,
          });
        });
      }

      // Invalidate org document cache
      if (params.organizationId) {
        await this.invalidateOrgCache(params.organizationId);
      }

      logger.info({
        type: 'document_upload_complete',
        documentId: doc.id,
        userId: params.userId,
      });

      // Pilot event -- fire-and-forget, never throws.
      logPilotEvent({
        userId:   params.userId,
        action:   'DOCUMENT_UPLOADED',
        feature:  'vault',
        metadata: { documentId: doc.id, filename: params.filename },
      }).catch((err) => logger.error({ type: 'PILOT_EVENT_LOG_FAILED', err }));

      return toDocumentSummary(doc as unknown as Record<string, unknown>);
    } catch (error: unknown) {
      const err = error as Error;
      logger.error({
        type: 'document_upload_error',
        userId: params.userId,
        filename: params.filename,
        error: err.message,
      });
      throw error;
    }
  }

  /**
   * Process a document: extract text, chunk it, embed in Pinecone.
   */
  async processDocument(documentId: string): Promise<ProcessingResult> {
    const startTime = Date.now();

    logger.info({ type: 'document_processing_started', documentId });

    // Mark as processing
    await prisma.legalDocument.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    });

    await redis.set(
      `${REDIS_KEYS.PROCESSING}${documentId}`,
      JSON.stringify({ status: 'processing', documentId }),
      { ex: 600 }
    );

    try {
      const doc = await prisma.legalDocument.findUnique({
        where: { id: documentId },
      });

      if (!doc) throw new NotFoundError('Document');

      // Download file from R2
      // Extract the storage key from the URL
      const storageKey = this.extractStorageKey(doc.fileUrl);
      const fileBuffer = await storageService.downloadFile(storageKey);

      // Extract text
      const fullText = await extractText(fileBuffer, doc.mimeType, doc.originalFilename);

      if (!fullText || fullText.trim().length === 0) {
        // Still mark as indexed but with no full text (binary files)
        await prisma.legalDocument.update({
          where: { id: documentId },
          data: {
            status: 'INDEXED',
            processedAt: new Date(),
            totalChunks: 0,
          },
        });

        return {
          documentId,
          status: 'completed',
          chunksIndexed: 0,
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Index into Pinecone via RAG service
      const chunkCount = await ragService.indexDocument(
        {
          id: documentId,
          title: doc.title ?? doc.actName,
          content: fullText,
          documentType: doc.documentType,
          actName: doc.actName,
          regulatoryArea: doc.regulatoryBody ?? undefined,
          metadata: {
            organizationId: doc.organizationId,
            contentType: doc.contentType,
            category: doc.category,
          },
        },
        {
          maxChunkSize: LIMITS.CHUNK_SIZE,
          chunkOverlap: LIMITS.CHUNK_OVERLAP,
        }
      );

      // Update DB with results
      await prisma.legalDocument.update({
        where: { id: documentId },
        data: {
          status: 'INDEXED',
          fullText,
          totalChunks: chunkCount,
          processedAt: new Date(),
        },
      });

      // Clear processing status
      await redis.del(`${REDIS_KEYS.PROCESSING}${documentId}`);
      // Invalidate document cache
      await redis.del(docCacheKey(documentId));

      const result: ProcessingResult = {
        documentId,
        status: 'completed',
        chunksIndexed: chunkCount,
        processingTimeMs: Date.now() - startTime,
      };

      logger.info({
        type: 'document_processing_complete',
        documentId,
        chunks: chunkCount,
        duration: result.processingTimeMs,
      });

      return result;
    } catch (error: unknown) {
      const err = error as Error;

      await prisma.legalDocument.update({
        where: { id: documentId },
        data: { status: 'FAILED' },
      });

      await redis.del(`${REDIS_KEYS.PROCESSING}${documentId}`);

      logger.error({
        type: 'document_processing_error',
        documentId,
        error: err.message,
      });

      return {
        documentId,
        status: 'failed',
        chunksIndexed: 0,
        processingTimeMs: Date.now() - startTime,
        error: err.message,
      };
    }
  }

  /**
   * Re-process an already-indexed document (e.g., after metadata updates).
   */
  async reprocessDocument(documentId: string): Promise<ProcessingResult> {
    // Delete existing Pinecone vectors first
    try {
      await ragService.deleteDocument(documentId);
    } catch {
      // Non-fatal — might not have been indexed yet
    }

    // Clear chunk records in DB
    await prisma.documentChunk.deleteMany({ where: { documentId } });

    return this.processDocument(documentId);
  }

  // ==========================================================================
  // RETRIEVAL
  // ==========================================================================

  async getDocument(documentId: string, userId: string): Promise<DocumentSummary> {
    const cacheKey = docCacheKey(documentId);
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      await this.incrementViewCount(documentId);
      return JSON.parse(cached) as DocumentSummary;
    }

    const doc = await prisma.legalDocument.findUnique({
      where: { id: documentId, deletedAt: null },
    });

    if (!doc) throw new NotFoundError('Document');

    // Verify access — org members or the author can view
    if (
      doc.organizationId &&
      doc.userId !== userId
    ) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true, role: true } });
      if (
        user?.role !== 'ADMIN' &&
        user?.organizationId !== doc.organizationId
      ) {
        throw new ForbiddenError('You do not have access to this document');
      }
    }

    const summary = toDocumentSummary(doc as unknown as Record<string, unknown>);
    await redis.set(cacheKey, JSON.stringify(summary), { ex: CACHE_TTL.DOCUMENT });
    await this.incrementViewCount(documentId);

    return summary;
  }

  async getDocumentsByOrganization(
    orgId: string,
    filters: DocumentFilters
  ): Promise<PaginatedDocuments> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      organizationId: orgId,
      deletedAt: null,
      contentType: filters.contentType ?? undefined,
      contentStatus: filters.contentStatus ?? undefined,
      category: filters.category ?? undefined,
    };

    if (filters.tags && filters.tags.length > 0) {
      where.tags = { hasSome: filters.tags };
    }

    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom && { gte: filters.dateFrom }),
        ...(filters.dateTo && { lte: filters.dateTo }),
      };
    }

    const [items, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where: where as any,
        orderBy: { [filters.sortBy ?? 'createdAt']: filters.sortOrder ?? 'desc' },
        skip,
        take: limit,
      }),
      prisma.legalDocument.count({
        where: where as any,
      }),
    ]);

    return {
      items: items.map((d) => toDocumentSummary(d as unknown as Record<string, unknown>)),
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  async getDocumentsByUser(
    userId: string,
    filters: DocumentFilters
  ): Promise<PaginatedDocuments> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where: {
          userId,
          deletedAt: null,
          ...(filters.contentType && { contentType: filters.contentType as never }),
          ...(filters.contentStatus && { contentStatus: filters.contentStatus as never }),
          ...(filters.category && { category: filters.category }),
        },
        orderBy: { [filters.sortBy ?? 'createdAt']: filters.sortOrder ?? 'desc' },
        skip,
        take: limit,
      }),
      prisma.legalDocument.count({
        where: {
          userId,
          deletedAt: null,
        },
      }),
    ]);

    return {
      items: items.map((d) => toDocumentSummary(d as unknown as Record<string, unknown>)),
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  /**
   * Semantic search across documents via Pinecone.
   */
  async searchDocuments(
    query: string,
    orgId: string,
    filters: SearchFilters = {}
  ): Promise<DocumentSearchResult[]> {
    const cacheKey = searchCacheKey(query, orgId);
    const cached = await redis.get<string>(cacheKey);
    if (cached) return JSON.parse(cached) as DocumentSearchResult[];

    const searchResults = await ragService.search(query, {
      topK: filters.topK ?? LIMITS.MAX_SEARCH_RESULTS,
      minScore: filters.minScore ?? 0.65,
      filter: {
        ...(orgId && { organizationId: orgId }),
        ...(filters.contentType && { contentType: filters.contentType }),
        ...(filters.category && { category: filters.category }),
      },
    });

    const results: DocumentSearchResult[] = searchResults.map((r) => ({
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      chunkText: r.chunkText,
      section: r.section,
      citation: r.citation,
      score: r.score,
      rank: r.rank,
    }));

    await redis.set(cacheKey, JSON.stringify(results), { ex: CACHE_TTL.SEARCH });
    return results;
  }

  // ==========================================================================
  // MANAGEMENT
  // ==========================================================================

  async updateDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata
  ): Promise<DocumentSummary> {
    const doc = await prisma.legalDocument.findUnique({
      where: { id: documentId, deletedAt: null },
    });
    if (!doc) throw new NotFoundError('Document');

    const updated = await prisma.legalDocument.update({
      where: { id: documentId },
      data: {
        ...(metadata.actName !== undefined && { actName: metadata.actName }),
        ...(metadata.documentType !== undefined && { documentType: metadata.documentType }),
        ...(metadata.regulatoryBody !== undefined && { regulatoryBody: metadata.regulatoryBody }),
        ...(metadata.tags !== undefined && { tags: metadata.tags }),
        ...(metadata.category !== undefined && { category: metadata.category }),
        ...(metadata.subcategory !== undefined && { subcategory: metadata.subcategory }),
        ...(metadata.keywords !== undefined && { keywords: metadata.keywords }),
        ...(metadata.title !== undefined && { title: metadata.title }),
        ...(metadata.summary !== undefined && { summary: metadata.summary }),
        ...(metadata.enactmentDate !== undefined && { enactmentDate: metadata.enactmentDate }),
        ...(metadata.effectiveDate !== undefined && { effectiveDate: metadata.effectiveDate }),
      },
    });

    // Invalidate cache
    await redis.del(docCacheKey(documentId));
    if (doc.organizationId) await this.invalidateOrgCache(doc.organizationId);

    logger.info({ type: 'document_metadata_updated', documentId });

    return toDocumentSummary(updated as unknown as Record<string, unknown>);
  }

  async deleteDocument(documentId: string, userId: string): Promise<void> {
    const doc = await prisma.legalDocument.findUnique({
      where: { id: documentId, deletedAt: null },
    });
    if (!doc) throw new NotFoundError('Document');

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (doc.userId !== userId && user?.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to delete this document');
    }

    // Soft delete first
    await this.archiveDocument(documentId);

    // Hard delete from R2 + Pinecone (fire-and-forget cleanup)
    setTimeout(async () => {
      try {
        const storageKey = this.extractStorageKey(doc.fileUrl);
        await storageService.deleteFile(storageKey);
        await ragService.deleteDocument(documentId);
        await prisma.legalDocument.delete({ where: { id: documentId } });

        logger.info({ type: 'document_hard_deleted', documentId });
      } catch (err: unknown) {
        logger.error({
          type: 'document_hard_delete_error',
          documentId,
          error: (err as Error).message,
        });
      }
    }, 30 * 24 * 60 * 60 * 1000); // 30 days

    await redis.del(docCacheKey(documentId));
    if (doc.organizationId) await this.invalidateOrgCache(doc.organizationId);

    logger.info({ type: 'document_deleted', documentId, userId });
  }

  async archiveDocument(documentId: string): Promise<DocumentSummary> {
    const doc = await prisma.legalDocument.update({
      where: { id: documentId },
      data: { contentStatus: 'ARCHIVED', deletedAt: new Date() },
    });

    await redis.del(docCacheKey(documentId));
    logger.info({ type: 'document_archived', documentId });

    return toDocumentSummary(doc as unknown as Record<string, unknown>);
  }

  async restoreDocument(documentId: string): Promise<DocumentSummary> {
    const doc = await prisma.legalDocument.update({
      where: { id: documentId },
      data: { contentStatus: 'DRAFT', deletedAt: null },
    });

    await redis.del(docCacheKey(documentId));
    logger.info({ type: 'document_restored', documentId });

    return toDocumentSummary(doc as unknown as Record<string, unknown>);
  }

  // ==========================================================================
  // VERSIONING
  // ==========================================================================

  async createDocumentVersion(
    documentId: string,
    file: Buffer
  ): Promise<DocumentVersion> {
    const parent = await prisma.legalDocument.findUnique({
      where: { id: documentId, deletedAt: null },
    });
    if (!parent) throw new NotFoundError('Document');

    // Upload new file version
    const uploaded = await storageService.uploadDocument(
      file,
      `v${parent.version + 1}_${parent.originalFilename}`,
      parent.userId ?? 'system'
    );

    // Mark parent as not latest
    await prisma.legalDocument.update({
      where: { id: documentId },
      data: { isLatestVersion: false },
    });

    // Create new version record
    const newVersion = await prisma.legalDocument.create({
      data: {
        actName: parent.actName,
        documentType: parent.documentType,
        originalFilename: parent.originalFilename,
        fileUrl: uploaded.url,
        fileSize: uploaded.size,
        mimeType: parent.mimeType,
        status: 'UPLOADING',
        contentType: parent.contentType,
        contentStatus: parent.contentStatus,
        title: parent.title,
        tags: parent.tags,
        keywords: parent.keywords,
        category: parent.category,
        subcategory: parent.subcategory,
        regulatoryBody: parent.regulatoryBody,
        userId: parent.userId,
        organizationId: parent.organizationId,
        authorId: parent.authorId,
        parentId: documentId,
        version: parent.version + 1,
        isLatestVersion: true,
      },
    });

    await redis.del(docCacheKey(documentId));

    return {
      id: newVersion.id,
      parentId: documentId,
      version: newVersion.version,
      fileUrl: newVersion.fileUrl,
      fileSize: newVersion.fileSize,
      createdAt: newVersion.createdAt,
      isLatestVersion: true,
    };
  }

  async getDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
    const versions = await prisma.legalDocument.findMany({
      where: {
        OR: [{ id: documentId }, { parentId: documentId }],
      },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        parentId: true,
        version: true,
        fileUrl: true,
        fileSize: true,
        createdAt: true,
        isLatestVersion: true,
      },
    });

    return versions.map((v) => ({
      id: v.id,
      parentId: v.parentId ?? documentId,
      version: v.version,
      fileUrl: v.fileUrl,
      fileSize: v.fileSize,
      createdAt: v.createdAt,
      isLatestVersion: v.isLatestVersion,
    }));
  }

  async restoreDocumentVersion(
    documentId: string,
    versionId: string
  ): Promise<DocumentSummary> {
    const version = await prisma.legalDocument.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundError('Document version');

    // Mark all versions as not latest
    await prisma.legalDocument.updateMany({
      where: { OR: [{ id: documentId }, { parentId: documentId }] },
      data: { isLatestVersion: false },
    });

    // Restore target version as latest
    const restored = await prisma.legalDocument.update({
      where: { id: versionId },
      data: { isLatestVersion: true },
    });

    await redis.del(docCacheKey(documentId));
    await redis.del(docCacheKey(versionId));

    logger.info({ type: 'document_version_restored', documentId, versionId });

    return toDocumentSummary(restored as unknown as Record<string, unknown>);
  }

  // ==========================================================================
  // SHARING & ACCESS
  // ==========================================================================

  async shareDocument(documentId: string, shareParams: ShareParams): Promise<ShareLink> {
    const doc = await prisma.legalDocument.findUnique({
      where: { id: documentId, deletedAt: null },
    });
    if (!doc) throw new NotFoundError('Document');

    const token = generateShareToken();
    const expiresAt = shareParams.expiresAt
      ? new Date(shareParams.expiresAt)
      : new Date(Date.now() + LIMITS.SHARE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Store share in Redis (lightweight — can persist in DB if needed)
    const shareData = {
      id: token,
      documentId,
      token,
      sharedBy: shareParams.sharedBy,
      expiresAt: expiresAt.toISOString(),
      maxDownloads: shareParams.maxDownloads ?? null,
      downloads: 0,
      createdAt: new Date().toISOString(),
    };

    const ttl = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    await redis.set(
      `${REDIS_KEYS.SHARE}${token}`,
      JSON.stringify(shareData),
      { ex: ttl }
    );

    logger.info({ type: 'document_shared', documentId, sharedBy: shareParams.sharedBy });

    return toShareLink(shareData as unknown as Record<string, unknown>, this.appUrl);
  }

  async revokeDocumentShare(
    _documentId: string,
    shareId: string
  ): Promise<void> {
    await redis.del(`${REDIS_KEYS.SHARE}${shareId}`);
    logger.info({ type: 'document_share_revoked', shareId });
  }

  async getSharedDocument(shareToken: string): Promise<DocumentSummary> {
    const shareData = await redis.get<string>(`${REDIS_KEYS.SHARE}${shareToken}`);
    if (!shareData) throw new NotFoundError('Share link (may have expired)');

    const share = JSON.parse(shareData) as {
      documentId: string;
      expiresAt: string;
      maxDownloads: number | null;
      downloads: number;
    };

    if (new Date(share.expiresAt) < new Date()) {
      await redis.del(`${REDIS_KEYS.SHARE}${shareToken}`);
      throw new BadRequestError('Share link has expired');
    }

    if (share.maxDownloads !== null && share.downloads >= share.maxDownloads) {
      throw new BadRequestError('Share link download limit reached');
    }

    const doc = await prisma.legalDocument.findUnique({
      where: { id: share.documentId, deletedAt: null },
    });
    if (!doc) throw new NotFoundError('Document');

    // Increment download count
    const updated = { ...share, downloads: share.downloads + 1 };
    const remaining = Math.floor(
      (new Date(share.expiresAt).getTime() - Date.now()) / 1000
    );
    await redis.set(`${REDIS_KEYS.SHARE}${shareToken}`, JSON.stringify(updated), { ex: remaining });

    return toDocumentSummary(doc as unknown as Record<string, unknown>);
  }

  // ==========================================================================
  // BULK OPERATIONS
  // ==========================================================================

  async bulkUpload(
    files: BulkUploadParams[],
    userId: string,
    organizationId?: string
  ): Promise<BulkUploadResult> {
    if (files.length > LIMITS.MAX_BULK_UPLOAD) {
      throw new BadRequestError(
        `Cannot upload more than ${LIMITS.MAX_BULK_UPLOAD} files at once`
      );
    }

    const succeeded: BulkUploadResult['succeeded'] = [];
    const failed: BulkUploadResult['failed'] = [];

    for (const f of files) {
      try {
        const doc = await this.uploadDocument({
          file: f.file,
          filename: f.filename,
          mimeType: f.mimeType,
          userId,
          organizationId,
          metadata: f.metadata,
          autoProcess: true,
        });
        succeeded.push({ filename: f.filename, documentId: doc.id });
      } catch (err: unknown) {
        failed.push({ filename: f.filename, error: (err as Error).message });
      }
    }

    logger.info({
      type: 'bulk_upload_complete',
      total: files.length,
      succeeded: succeeded.length,
      failed: failed.length,
    });

    return {
      succeeded,
      failed,
      total: files.length,
      successCount: succeeded.length,
      failureCount: failed.length,
    };
  }

  async bulkDelete(documentIds: string[], userId: string): Promise<BulkDeleteResult> {
    const deleted: string[] = [];
    const failed: BulkDeleteResult['failed'] = [];

    for (const id of documentIds) {
      try {
        await this.deleteDocument(id, userId);
        deleted.push(id);
      } catch (err: unknown) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    return {
      deleted,
      failed,
      total: documentIds.length,
      successCount: deleted.length,
      failureCount: failed.length,
    };
  }

  async exportDocuments(
    documentIds: string[],
    format: DocumentExportFormat
  ): Promise<ExportResult> {
    if (documentIds.length === 0) {
      throw new BadRequestError('At least one document ID is required');
    }

    // Generate export job ID
    const exportId = `export_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // For now, create a simple JSON manifest and store as temp file
    const docs = await prisma.legalDocument.findMany({
      where: { id: { in: documentIds }, deletedAt: null },
      select: {
        id: true,
        actName: true,
        title: true,
        documentType: true,
        fileUrl: true,
        category: true,
        tags: true,
        createdAt: true,
      },
    });

    const manifest = JSON.stringify({ exportId, documents: docs, format, exportedAt: new Date() });
    const buffer = Buffer.from(manifest, 'utf-8');

    const uploaded = await storageService.uploadTempFile(buffer, `${exportId}.json`, 86400);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    logger.info({
      type: 'documents_exported',
      exportId,
      count: docs.length,
      format,
    });

    return {
      exportId,
      downloadUrl: uploaded.url,
      format,
      fileSize: buffer.length,
      expiresAt,
    };
  }

  // ==========================================================================
  // BLOG POSTS
  // ==========================================================================

  async createBlogPost(params: BlogPostParams): Promise<BlogPost> {
    const slug = params.slug ?? (await this.generateUniqueSlug(params.title));

    const post = await prisma.legalDocument.create({
      data: {
        actName: params.title,
        documentType: 'BLOG_POST',
        originalFilename: `${slug}.md`,
        fileUrl: '',
        fileSize: Buffer.byteLength(params.content, 'utf-8'),
        mimeType: 'text/markdown',
        status: 'INDEXED',
        contentType: 'BLOG_POST',
        contentStatus: 'DRAFT',
        title: params.title,
        slug,
        content: params.content,
        htmlContent: params.htmlContent ?? null,
        excerpt: params.excerpt ?? null,
        tags: params.tags ?? [],
        category: params.category ?? null,
        seoTitle: params.seoTitle ?? null,
        seoDescription: params.seoDescription ?? null,
        seoKeywords: params.seoKeywords ?? [],
        authorId: params.authorId,
        userId: params.authorId,
      },
    });

    // Index in Pinecone for unified semantic search
    await ragService.indexDocument({
      id: post.id,
      title: params.title,
      content: params.content,
      documentType: 'BLOG_POST',
      metadata: { slug, category: params.category, tags: params.tags },
    }).catch((err: Error) => {
      logger.warn({ type: 'blog_post_index_failed', postId: post.id, error: err.message });
    });

    logger.info({ type: 'blog_post_created', postId: post.id, slug });

    return toBlogPost(post as unknown as Record<string, unknown>);
  }

  async updateBlogPost(postId: string, params: Partial<BlogPostParams>): Promise<BlogPost> {
    const post = await prisma.legalDocument.findUnique({
      where: { id: postId, contentType: 'BLOG_POST', deletedAt: null },
    });
    if (!post) throw new NotFoundError('Blog post');

    const updated = await prisma.legalDocument.update({
      where: { id: postId },
      data: {
        ...(params.title && { actName: params.title, title: params.title }),
        ...(params.content && { content: params.content }),
        ...(params.htmlContent !== undefined && { htmlContent: params.htmlContent }),
        ...(params.excerpt !== undefined && { excerpt: params.excerpt }),
        ...(params.tags && { tags: params.tags }),
        ...(params.category !== undefined && { category: params.category }),
        ...(params.seoTitle !== undefined && { seoTitle: params.seoTitle }),
        ...(params.seoDescription !== undefined && { seoDescription: params.seoDescription }),
        ...(params.seoKeywords !== undefined && { seoKeywords: params.seoKeywords }),
      },
    });

    // Re-index in Pinecone
    if (params.content ?? params.title) {
      await ragService.deleteDocument(postId).catch(() => undefined);
      await ragService.indexDocument({
        id: postId,
        title: updated.title ?? updated.actName,
        content: updated.content ?? '',
        documentType: 'BLOG_POST',
      }).catch((err: Error) => {
        logger.warn({ type: 'blog_post_reindex_failed', postId, error: err.message });
      });
    }

    await redis.del(docCacheKey(postId));
    return toBlogPost(updated as unknown as Record<string, unknown>);
  }

  async publishBlogPost(postId: string): Promise<BlogPost> {
    const post = await prisma.legalDocument.update({
      where: { id: postId, contentType: 'BLOG_POST' },
      data: { contentStatus: 'PUBLISHED', publishedAt: new Date() },
    });

    await redis.del(docCacheKey(postId));
    logger.info({ type: 'blog_post_published', postId });

    return toBlogPost(post as unknown as Record<string, unknown>);
  }

  async getBlogPosts(filters: BlogFilters): Promise<PaginatedBlogPosts> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where: {
          contentType: 'BLOG_POST',
          deletedAt: null,
          ...(filters.status && { contentStatus: filters.status as never }),
          ...(filters.category && { category: filters.category }),
          ...(filters.authorId && { authorId: filters.authorId }),
          ...(filters.tags && filters.tags.length > 0 && { tags: { hasSome: filters.tags } }),
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.legalDocument.count({
        where: { contentType: 'BLOG_POST', deletedAt: null },
      }),
    ]);

    return {
      items: items.map((p) => toBlogPost(p as unknown as Record<string, unknown>)),
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  // ==========================================================================
  // KNOWLEDGE BASE
  // ==========================================================================

  async createKnowledgeBaseArticle(params: KBArticleParams): Promise<KBArticle> {
    const slug = params.slug ?? (await this.generateUniqueSlug(params.title));

    const article = await prisma.legalDocument.create({
      data: {
        actName: params.title,
        documentType: 'KB_ARTICLE',
        originalFilename: `${slug}.md`,
        fileUrl: '',
        fileSize: Buffer.byteLength(params.content, 'utf-8'),
        mimeType: 'text/markdown',
        status: 'INDEXED',
        contentType: 'KNOWLEDGE_BASE_ARTICLE',
        contentStatus: 'DRAFT',
        title: params.title,
        slug,
        content: params.content,
        htmlContent: params.htmlContent ?? null,
        excerpt: params.excerpt ?? null,
        tags: params.tags ?? [],
        category: params.category ?? null,
        subcategory: params.subcategory ?? null,
        authorId: params.authorId,
        userId: params.authorId,
      },
    });

    await ragService.indexDocument({
      id: article.id,
      title: params.title,
      content: params.content,
      documentType: 'KNOWLEDGE_BASE_ARTICLE',
      metadata: { slug, category: params.category, subcategory: params.subcategory },
    }).catch((err: Error) => {
      logger.warn({ type: 'kb_article_index_failed', articleId: article.id, error: err.message });
    });

    logger.info({ type: 'kb_article_created', articleId: article.id, slug });

    return toKBArticle(article as unknown as Record<string, unknown>);
  }

  async updateKnowledgeBaseArticle(
    articleId: string,
    params: Partial<KBArticleParams>
  ): Promise<KBArticle> {
    const article = await prisma.legalDocument.findUnique({
      where: { id: articleId, contentType: 'KNOWLEDGE_BASE_ARTICLE', deletedAt: null },
    });
    if (!article) throw new NotFoundError('KB article');

    const updated = await prisma.legalDocument.update({
      where: { id: articleId },
      data: {
        ...(params.title && { actName: params.title, title: params.title }),
        ...(params.content && { content: params.content }),
        ...(params.htmlContent !== undefined && { htmlContent: params.htmlContent }),
        ...(params.excerpt !== undefined && { excerpt: params.excerpt }),
        ...(params.tags && { tags: params.tags }),
        ...(params.category !== undefined && { category: params.category }),
        ...(params.subcategory !== undefined && { subcategory: params.subcategory }),
      },
    });

    if (params.content ?? params.title) {
      await ragService.deleteDocument(articleId).catch(() => undefined);
      await ragService.indexDocument({
        id: articleId,
        title: updated.title ?? updated.actName,
        content: updated.content ?? '',
        documentType: 'KNOWLEDGE_BASE_ARTICLE',
      }).catch(() => undefined);
    }

    await redis.del(docCacheKey(articleId));
    return toKBArticle(updated as unknown as Record<string, unknown>);
  }

  async getKnowledgeBaseArticles(filters: KBFilters): Promise<PaginatedKBArticles> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where: {
          contentType: 'KNOWLEDGE_BASE_ARTICLE',
          deletedAt: null,
          ...(filters.status && { contentStatus: filters.status as never }),
          ...(filters.category && { category: filters.category }),
          ...(filters.subcategory && { subcategory: filters.subcategory }),
          ...(filters.tags && filters.tags.length > 0 && { tags: { hasSome: filters.tags } }),
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.legalDocument.count({
        where: { contentType: 'KNOWLEDGE_BASE_ARTICLE', deletedAt: null },
      }),
    ]);

    return {
      items: items.map((a) => toKBArticle(a as unknown as Record<string, unknown>)),
      nextCursor: items.length === limit ? String(page + 1) : null,
      total,
      page,
      limit,
    };
  }

  async searchKnowledgeBase(query: string): Promise<KBSearchResult[]> {
    const results = await ragService.search(query, {
      topK: 10,
      minScore: 0.6,
      filter: { documentType: 'KNOWLEDGE_BASE_ARTICLE' },
    });

    return results.map((r) => ({
      articleId: r.documentId,
      title: r.documentTitle,
      slug: '',
      excerpt: r.chunkText.substring(0, 200),
      score: r.score,
      rank: r.rank,
      chunkText: r.chunkText,
    }));
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private extractStorageKey(fileUrl: string): string {
    try {
      const url = new URL(fileUrl);
      return url.pathname.replace(/^\//, '');
    } catch {
      return fileUrl;
    }
  }

  private async generateUniqueSlug(title: string): Promise<string> {
    const base = generateSlug(title);
    let slug = base;
    let counter = 1;

    while (true) {
      const existing = await prisma.legalDocument.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!existing) break;
      slug = `${base}-${counter}`;
      counter++;
    }

    return slug;
  }

  private async incrementViewCount(documentId: string): Promise<void> {
    // Fire-and-forget increment
    prisma.legalDocument
      .update({ where: { id: documentId }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);
  }

  private async invalidateOrgCache(orgId: string): Promise<void> {
    try {
      const keys = await redis.keys(`${REDIS_KEYS.ORG_DOCS}${orgId}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      // Non-fatal
    }
  }
}

export const documentModule = new DocumentModule();
export { DocumentModule };
