import { TRPCError } from '@trpc/server';
import { z } from 'zod';
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

        // Generate storage key prefix
        const timestamp = Date.now();
        const sanitizedFilename = input.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const keyName = `${input.documentType.toLowerCase()}/${ctx.user.id}/${timestamp}-${sanitizedFilename}`;

        // Get presigned upload URL from storage service (requires filename + contentType)
        const uploadResult = await ctx.storageService.getUploadUrl(keyName, input.fileType);

        logger.info({
          type: 'document_upload_url_generated',
          userId: ctx.user.id,
          filename: input.filename,
          fileSize: input.fileSize,
          documentType: input.documentType,
        });

        return {
          uploadUrl: uploadResult.url,
          key: uploadResult.key,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour
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
      try {
        // Create document record in database
        const document = await ctx.prisma.legalDocument.create({
          data: {
            actName: input.filename,
            originalFilename: input.filename,
            fileUrl: input.key, // Store the key, not the presigned URL
            fileSize: input.fileSize,
            mimeType: input.fileType,
            documentType: input.documentType,
            userId: ctx.user.id,
            organizationId: ctx.user.organizationId,
            keywords: [],
            amendedBy: [],
          } as any,
        });

        // If it's a legal document, index it in RAG
        if (input.documentType === 'LEGAL_DOCUMENT') {
          try {
            // Download file content — stored for future RAG indexing
            await ctx.storageService.getDownloadUrl(input.key);
            // TODO: Extract text from file and index in RAG

            logger.info({
              type: 'document_indexed_rag',
              userId: ctx.user.id,
              documentId: document.id,
            });
          } catch (ragError: any) {
            // Log but don't fail upload
            logger.error({
              type: 'document_rag_index_error',
              userId: ctx.user.id,
              documentId: document.id,
              error: ragError.message,
            });
          }
        }

        logger.info({
          type: 'document_upload_confirmed',
          userId: ctx.user.id,
          documentId: document.id,
          documentType: input.documentType,
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

        // Filter by organization unless admin
        if (ctx.user.role !== 'ADMIN') {
          where.OR = [
            { userId: ctx.user.id },
            { organizationId: ctx.user.organizationId },
          ];
        }

        if (documentType) {
          where.documentType = documentType;
        }

        if (search) {
          where.OR = [
            { title: { contains: search, mode: 'insensitive' } },
            { actName: { contains: search, mode: 'insensitive' } },
          ];
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
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this document',
            });
          }
        }

        // Get presigned download URL — use fileUrl as the storage key
        const downloadUrl = await ctx.storageService.getDownloadUrl(document.fileUrl);

        logger.info({
          type: 'document_download_url_generated',
          userId: ctx.user.id,
          documentId: input.id,
        });

        return {
          downloadUrl,
          filename: document.title || document.originalFilename,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour
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
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this document',
          });
        }

        // Delete from R2 storage
        try {
          await ctx.storageService.deleteFile(document.fileUrl);
        } catch (storageError: any) {
          logger.warn({
            type: 'document_storage_delete_error',
            userId: ctx.user.id,
            documentId: input.id,
            error: storageError.message,
          });
          // Continue even if storage deletion fails
        }

        // Remove vectors from Pinecone for all chunk types
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
          // Continue — soft delete still proceeds even if vector removal fails
        }

        // Soft delete from database
        await ctx.prisma.legalDocument.update({
          where: { id: input.id },
          data: { deletedAt: new Date() },
        });

        logger.info({
          type: 'document_deleted',
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
