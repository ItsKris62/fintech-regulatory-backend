import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { router, protectedProcedure, adminProcedure } from '../trpc/trpc';
import {
  getUploadUrlSchema,
  confirmUploadSchema,
  listDocumentsSchema,
  getDocumentSchema,
  getDownloadUrlSchema,
  deleteDocumentSchema,
} from '../schemas/document.schema';
import { deleteByFilter } from '@/lib/rag/client';
import { documentIngestionService } from '@/lib/ingestion/document-processor';
import { validateFileMagicBytes } from '@/utils/file-validation';
import { storageConfig } from '@/config/storage.config';
import { logger } from '@/utils/logger';

/**
 * Document Router
 *
 * Handles document upload, download, and management using R2 storage.
 */
export const documentRouter = router({
  /**
   * Get presigned upload URL
   *
   * @protected
   */
  getUploadUrl: protectedProcedure
    .input(getUploadUrlSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Validate file type
        const allowedTypes = [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
          'application/msword', // doc
          'text/plain',
          'text/markdown',
        ];

        if (!allowedTypes.includes(input.fileType)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'File type not allowed. Only PDF, DOCX, DOC, TXT, and MD files are supported.',
          });
        }

        // Validate file size (10MB max)
        if (input.fileSize > 10485760) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'File size exceeds maximum limit of 10MB',
          });
        }

        // Pre-generate a document ID so the R2 key can embed it.
        // confirmUpload will create the DB record with this same ID.
        const documentId = randomUUID();

        // UUID-named file — never expose the original filename in the R2 key.
        const ext = path.extname(input.filename).toLowerCase().slice(0, 10); // e.g. ".pdf"
        const uuidFilename = `${randomUUID()}${ext}`;

        // Per-org isolation: documents/{orgId}/{docId}/{uuid}.ext
        const orgId = ctx.user.organizationId ?? ctx.user.id;
        const storageKey = `documents/${orgId}/${documentId}/${uuidFilename}`;

        // Get presigned upload URL using the pre-constructed key
        const uploadResult = await ctx.storageService.getUploadUrl(
          input.filename,
          input.fileType,
          undefined,
          storageKey,
        );

        logger.info({
          type: 'document_upload_url_generated',
          userId: ctx.user.id,
          organizationId: orgId,
          documentId,
          fileSize: input.fileSize,
          documentType: input.documentType,
        });

        return {
          uploadUrl: uploadResult.url,
          key: uploadResult.key,
          documentId, // Return pre-generated ID so confirmUpload can use it
          expiresAt: new Date(
            Date.now() + storageConfig.presignedUrls.expiry.upload * 1000,
          ).toISOString(),
        };
      } catch (error: any) {
        logger.error({
          type: 'document_upload_url_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate upload URL',
          cause: error,
        });
      }
    }),

  /**
   * Confirm upload and create document record
   *
   * @protected
   */
  confirmUpload: protectedProcedure
    .input(confirmUploadSchema)
    .mutation(async ({ input, ctx }) => {
      // Strip any path components from the original filename before storing —
      // prevents path traversal in metadata (e.g. "../../etc/passwd.pdf" → "passwd.pdf").
      const safeOriginalFilename = path.basename(input.filename);

      try {
        // ── Magic-byte validation ─────────────────────────────────────────
        // Download the first 8 KB of the file (already in R2) and validate
        // the actual content type against our allowlist. If validation fails,
        // delete the file from R2 immediately and reject the request.
        let fileChunk: Buffer;
        try {
          fileChunk = await ctx.storageService.downloadFileChunk(input.key, 8192);
        } catch (downloadError: any) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not retrieve uploaded file for validation',
            cause: downloadError,
          });
        }

        const validation = await validateFileMagicBytes(
          fileChunk,
          safeOriginalFilename,
          input.fileType,
        );

        if (!validation.valid) {
          // Delete the invalid file from R2 before rejecting
          try {
            await ctx.storageService.deleteFile(input.key);
          } catch (cleanupError: any) {
            logger.error({
              type: 'file_validation_cleanup_error',
              userId: ctx.user.id,
              key: input.key,
              error: cleanupError.message,
            });
          }

          logger.warn({
            type: 'file_validation_rejected',
            userId: ctx.user.id,
            key: input.key,
            claimedType: input.fileType,
            detectedType: validation.detectedType,
            reason: validation.reason,
          });

          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `File type not allowed. ${validation.reason ?? 'Accepted types: PDF, DOCX, TXT, Markdown'}`,
          });
        }

        // ── Create document record ────────────────────────────────────────
        const createData: Record<string, unknown> = {
          actName: safeOriginalFilename,
          originalFilename: safeOriginalFilename,
          fileUrl: input.key, // Store the R2 key, not a presigned URL
          fileSize: input.fileSize,
          mimeType: input.fileType,
          documentType: input.documentType,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId,
          keywords: [],
          amendedBy: [],
        };

        // Use the pre-generated ID from getUploadUrl if provided, so the DB
        // record ID matches the document ID embedded in the R2 key path.
        if (input.documentId) {
          createData.id = input.documentId;
        }

        const document = await ctx.prisma.legalDocument.create({
          data: createData as any,
        });

        logger.info({
          type: 'document_upload_confirmed',
          userId: ctx.user.id,
          documentId: document.id,
          documentType: input.documentType,
          detectedMimeType: validation.detectedType,
        });

        return {
          documentId: document.id,
          success: true,
          message: 'Document uploaded successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'document_confirm_upload_error',
          userId: ctx.user.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to confirm upload',
          cause: error,
        });
      }
    }),

  /**
   * List documents with pagination
   *
   * @protected
   */
  list: protectedProcedure
    .input(listDocumentsSchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit, documentType, search } = input;
        const skip = (page - 1) * limit;

        const where: any = {
          deletedAt: null,
          // Only show regulatory documents in the document router
          contentType: 'REGULATORY_DOCUMENT',
        };

        // Build AND conditions so org filter and search can coexist without
        // overwriting each other's OR clauses (bug fix).
        const andConditions: object[] = [];

        // Filter by organization unless admin — always scoped to DB, never in JS
        if (ctx.user.role !== 'ADMIN') {
          andConditions.push({
            OR: [
              { userId: ctx.user.id },
              { organizationId: ctx.user.organizationId },
            ],
          });
        }

        if (search) {
          andConditions.push({
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { actName: { contains: search, mode: 'insensitive' } },
            ],
          });
        }

        if (andConditions.length > 0) {
          where.AND = andConditions;
        }

        if (documentType) {
          where.documentType = documentType;
        }

        const [documents, total] = await Promise.all([
          ctx.prisma.legalDocument.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              title: true,
              documentType: true,
              fileSize: true,
              createdAt: true,
              author: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          }),
          ctx.prisma.legalDocument.count({ where }),
        ]);

        return {
          documents,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'document_list_error',
          userId: ctx.user.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list documents',
          cause: error,
        });
      }
    }),

  /**
   * Get document metadata by ID
   *
   * @protected
   */
  get: protectedProcedure
    .input(getDocumentSchema)
    .query(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          include: {
            author: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
          },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found',
          });
        }

        // Check access
        if (ctx.user.role !== 'ADMIN') {
          const hasAccess =
            document.userId === ctx.user.id ||
            document.organizationId === ctx.user.organizationId;

          if (!hasAccess) {
            logger.warn({
              type: 'document_unauthorized_access',
              userId: ctx.user.id,
              userOrgId: ctx.user.organizationId,
              documentId: input.id,
              documentOrgId: document.organizationId,
            });
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this document',
            });
          }
        }

        return document;
      } catch (error: any) {
        logger.error({
          type: 'document_get_error',
          userId: ctx.user.id,
          documentId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get document',
          cause: error,
        });
      }
    }),

  /**
   * Get presigned download URL
   *
   * @protected
   */
  getDownloadUrl: protectedProcedure
    .input(getDownloadUrlSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found',
          });
        }

        // Check access
        if (ctx.user.role !== 'ADMIN') {
          const hasAccess =
            document.userId === ctx.user.id ||
            document.organizationId === ctx.user.organizationId;

          if (!hasAccess) {
            logger.warn({
              type: 'document_unauthorized_download',
              userId: ctx.user.id,
              userOrgId: ctx.user.organizationId,
              documentId: input.id,
              documentOrgId: document.organizationId,
            });
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this document',
            });
          }
        }

        // Get presigned download URL — pass original filename so the
        // Content-Disposition header shows the human-readable name, not the UUID.
        const downloadUrl = await ctx.storageService.getDownloadUrl(
          document.fileUrl,
          storageConfig.presignedUrls.expiry.download,
          false,
          document.originalFilename,
        );

        logger.info({
          type: 'document_download_url_generated',
          userId: ctx.user.id,
          documentId: input.id,
        });

        return {
          downloadUrl,
          filename: document.title ?? document.originalFilename,
          expiresAt: new Date(
            Date.now() + storageConfig.presignedUrls.expiry.download * 1000,
          ).toISOString(),
        };
      } catch (error: any) {
        logger.error({
          type: 'document_download_url_error',
          userId: ctx.user.id,
          documentId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate download URL',
          cause: error,
        });
      }
    }),

  /**
   * Delete document
   *
   * @protected
   */
  delete: protectedProcedure
    .input(deleteDocumentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found',
          });
        }

        // Check access
        if (ctx.user.role !== 'ADMIN' && document.userId !== ctx.user.id) {
          logger.warn({
            type: 'document_unauthorized_delete',
            userId: ctx.user.id,
            userOrgId: ctx.user.organizationId,
            documentId: input.id,
            documentOrgId: document.organizationId,
          });
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this document',
          });
        }

        // Remove vectors from Pinecone (derived data — safe to clear on soft delete)
        try {
          await deleteByFilter({ documentId: input.id });
          logger.info({
            type: 'document_rag_vectors_deleted',
            userId: ctx.user.id,
            documentId: input.id,
          });
        } catch (ragError: any) {
          logger.warn({
            type: 'document_rag_remove_error',
            userId: ctx.user.id,
            documentId: input.id,
            error: ragError.message,
          });
          // Continue — soft delete proceeds even if vector removal fails
        }

        // Soft delete: set deletedAt timestamp only. The R2 object is intentionally
        // retained for the retention period and permanently removed by the scheduled
        // cleanup script (src/scripts/cleanup-deleted-documents.ts).
        await ctx.prisma.legalDocument.update({
          where: { id: input.id },
          data: { deletedAt: new Date() },
        });

        logger.info({
          type: 'document_soft_deleted',
          userId: ctx.user.id,
          documentId: input.id,
        });

        return {
          success: true,
          message: 'Document deleted successfully',
        };
      } catch (error: any) {
        logger.error({
          type: 'document_delete_error',
          userId: ctx.user.id,
          documentId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete document',
          cause: error,
        });
      }
    }),

  /**
   * Restore a soft-deleted document
   *
   * Sets deletedAt back to null. Only the document owner or an admin can restore.
   * Note: Pinecone vectors are not restored automatically — if the document needs
   * to be searchable again, trigger a re-ingest via the `reingest` procedure.
   *
   * @protected
   */
  restore: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.id },
          select: { id: true, deletedAt: true, userId: true, organizationId: true },
        });

        if (!document) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
        }

        if (!document.deletedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Document is not deleted',
          });
        }

        if (ctx.user.role !== 'ADMIN' && document.userId !== ctx.user.id) {
          logger.warn({
            type: 'document_unauthorized_restore',
            userId: ctx.user.id,
            documentId: input.id,
          });
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the document owner or an admin can restore a deleted document',
          });
        }

        await ctx.prisma.legalDocument.update({
          where: { id: input.id },
          data: { deletedAt: null },
        });

        logger.info({
          type: 'document_restored',
          userId: ctx.user.id,
          documentId: input.id,
        });

        return { success: true, message: 'Document restored successfully' };
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to restore document',
          cause: error,
        });
      }
    }),

  /**
   * Get document processing status
   *
   * Returns the indexing status and chunk count for a document.
   * Useful for polling after upload to know when RAG indexing is complete.
   *
   * @protected
   */
  getProcessingStatus: protectedProcedure
    .input(z.object({ documentId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.documentId },
          select: {
            id: true,
            status: true,
            totalChunks: true,
            processedAt: true,
            deletedAt: true,
            userId: true,
            organizationId: true,
          },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found',
          });
        }

        // Access control
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess =
            document.userId === ctx.user!.id ||
            document.organizationId === ctx.user!.organizationId;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this document',
            });
          }
        }

        const chunkCount = await ctx.prisma.documentChunk.count({
          where: { documentId: input.documentId },
        });

        return {
          documentId: document.id,
          status: document.status,
          totalChunks: document.totalChunks ?? chunkCount,
          processedChunks: chunkCount,
          processedAt: document.processedAt,
          isComplete: document.status === 'INDEXED',
          isFailed: document.status === 'FAILED',
        };
      } catch (error: any) {
        logger.error({
          type: 'document_processing_status_error',
          userId: ctx.user!.id,
          documentId: input.documentId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get document processing status',
          cause: error,
        });
      }
    }),

  /**
   * Re-ingest a document into the RAG pipeline (admin only)
   *
   * Clears existing Pinecone vectors and DB chunks, then re-runs the full
   * ingestion pipeline. Useful after pipeline changes or failed indexing.
   *
   * @admin
   */
  reingest: adminProcedure
    .input(z.object({ documentId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        const document = await ctx.prisma.legalDocument.findUnique({
          where: { id: input.documentId },
          select: {
            id: true,
            fileUrl: true,
            deletedAt: true,
            status: true,
          },
        });

        if (!document || document.deletedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found',
          });
        }

        // Mark as processing immediately so callers can poll status
        await ctx.prisma.legalDocument.update({
          where: { id: input.documentId },
          data: { status: 'PROCESSING', processedAt: null, totalChunks: null },
        });

        logger.info({
          type: 'document_reingest_started',
          adminId: ctx.user!.id,
          documentId: input.documentId,
        });

        // Run re-ingestion in background — do not await so the response is fast
        void (documentIngestionService as any)
          .reingestDocument(input.documentId, document.fileUrl)
          .then(() => {
            logger.info({
              type: 'document_reingest_complete',
              documentId: input.documentId,
            });
          })
          .catch((err: any) => {
            logger.error({
              type: 'document_reingest_error',
              documentId: input.documentId,
              error: err.message,
            });
          });

        return {
          success: true,
          message: 'Document re-ingestion started. Poll getProcessingStatus for progress.',
          documentId: input.documentId,
        };
      } catch (error: any) {
        logger.error({
          type: 'document_reingest_initiation_error',
          adminId: ctx.user!.id,
          documentId: input.documentId,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to initiate document re-ingestion',
          cause: error,
        });
      }
    }),
});
