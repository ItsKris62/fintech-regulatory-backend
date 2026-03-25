import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc/trpc';
import { withPlanContext, requirePlanFeature } from '../trpc/middleware';
import { vaultModule } from '@/modules/vault';
import { usageTrackingService } from '@/services/usage-tracking.service';
import {
  vaultGetUploadUrlSchema,
  vaultConfirmUploadSchema,
  vaultListQuerySchema,
  vaultDocumentIdSchema,
  vaultUpdateDocumentSchema,
  vaultUpdateStatusSchema,
  vaultReplaceDocumentSchema,
} from '../schemas/vault.schema';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import { incrementTrialUsage } from '@/modules/trial';

/**
 * Vault Router
 *
 * Thin tRPC layer for the organisation-scoped Document Vault.
 * All business logic lives in VaultModule.
 */
export const vaultRouter = router({
  /**
   * Step 1: Get presigned PUT URL for direct client-to-R2 upload.
   * Returns uploadUrl, storageKey, and documentId for use in confirmUpload.
   */
  getUploadUrl: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('documentRepository'))
    .input(vaultGetUploadUrlSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.generateUploadPresignedUrl({
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          filename: input.filename,
          fileType: input.fileType,
          fileSize: input.fileSize,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_get_upload_url_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate upload URL.' });
      }
    }),

  /**
   * Step 2: Create DB record after the client successfully PUT the file to R2.
   */
  confirmUpload: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('documentRepository'))
    .input(vaultConfirmUploadSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user.organizationId ?? '';
        const result = await vaultModule.createDocument({
          documentId:     input.documentId,
          storageKey:     input.storageKey,
          name:           input.name,
          description:    input.description,
          fileName:       input.fileName,
          fileType:       input.fileType,
          fileExtension:  input.fileExtension,
          fileSize:       input.fileSize,
          category:       input.category,
          expiryDate:     input.expiryDate ?? null,
          tags:           input.tags,
          userId:         ctx.user.id,
          organizationId: orgId,
        });

        // Non-blocking: increment document storage usage counter.
        // fileSize is in bytes; service converts to MB internally.
        // Failure is logged inside the service and never blocks the upload response.
        if (orgId) {
          void usageTrackingService.incrementDocumentStorage(orgId, input.fileSize);
        }

        // Track vault upload count for free trial users (fire-and-forget, non-fatal).
        if (ctx.plan === 'FREE_TRIAL') {
          incrementTrialUsage(ctx.user.id, 'vaultUploads').catch(() => {});
        }

        return result;
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_confirm_upload_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to save document record.' });
      }
    }),

  /**
   * Paginated, filtered, searchable document list scoped to the caller's org.
   */
  list: protectedProcedure
    .input(vaultListQuerySchema)
    .query(async ({ input, ctx }) => {
      try {
        return await vaultModule.listDocuments({
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
          page: input.page,
          limit: input.limit,
          category: input.category,
          status: input.status,
          search: input.search,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_list_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list documents.' });
      }
    }),

  /**
   * Single document detail with org-scoped access check.
   */
  getById: protectedProcedure
    .input(vaultDocumentIdSchema)
    .query(async ({ input, ctx }) => {
      try {
        return await vaultModule.getDocumentById({
          documentId: input.id,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_get_by_id_error', userId: ctx.user.id, documentId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch document.' });
      }
    }),

  /**
   * Generate a presigned GET URL for downloading or viewing a document.
   */
  getDownloadUrl: protectedProcedure
    .input(z.object({ id: z.string().min(1), inline: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.generateDownloadPresignedUrl({
          documentId: input.id,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
          inline: input.inline,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_get_download_url_error', userId: ctx.user.id, documentId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate download URL.' });
      }
    }),

  /**
   * Update document metadata (name, description, category, expiry, tags, notes).
   * Owner or Admin only.
   */
  update: protectedProcedure
    .input(vaultUpdateDocumentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.updateDocument({
          documentId: input.id,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
          name: input.name,
          description: input.description,
          category: input.category,
          expiryDate: input.expiryDate,
          tags: input.tags,
          notes: input.notes,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_update_error', userId: ctx.user.id, documentId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update document.' });
      }
    }),

  /**
   * Change verification status (PENDING → VERIFIED / EXPIRED).
   * Admin and Regulator roles only.
   */
  updateStatus: protectedProcedure
    .input(vaultUpdateStatusSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.updateDocumentStatus({
          documentId: input.id,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
          status: input.status,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_update_status_error', userId: ctx.user.id, documentId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update document status.' });
      }
    }),

  /**
   * Soft-delete a document (sets isArchived = true). Owner or Admin only.
   */
  delete: protectedProcedure
    .input(vaultDocumentIdSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.deleteDocument({
          documentId: input.id,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_delete_error', userId: ctx.user.id, documentId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to delete document.' });
      }
    }),

  /**
   * Category + status counts for the summary cards.
   */
  getStats: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        return await vaultModule.getDocumentStats({
          organizationId: ctx.user.organizationId ?? '',
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_get_stats_error', userId: ctx.user.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to load document stats.' });
      }
    }),

  /**
   * Step 1 of file replacement: get new presigned PUT URL for the existing doc.
   */
  getReplaceUrl: protectedProcedure
    .input(vaultReplaceDocumentSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.replaceDocument({
          documentId: input.id,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
          filename: input.filename,
          fileType: input.fileType,
          fileSize: input.fileSize,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_get_replace_url_error', userId: ctx.user.id, documentId: input.id, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to generate replace URL.' });
      }
    }),

  /**
   * Step 2 of file replacement: finalise the new file after R2 upload.
   */
  confirmReplace: protectedProcedure
    .input(
      z.object({
        documentId: z.string().min(1),
        storageKey: z.string().min(1),
        fileName: z.string().min(1).max(255),
        fileType: z.string().min(1),
        fileExtension: z.string().min(1).max(15),
        fileSize: z.number().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await vaultModule.confirmReplacement({
          documentId: input.documentId,
          storageKey: input.storageKey,
          fileName: input.fileName,
          fileType: input.fileType,
          fileExtension: input.fileExtension,
          fileSize: input.fileSize,
          userId: ctx.user.id,
          organizationId: ctx.user.organizationId ?? '',
          userRole: ctx.user.role,
        });
      } catch (error: unknown) {
        if (error instanceof TRPCError) throw error;
        logger.error({ type: 'vault_confirm_replace_error', userId: ctx.user.id, documentId: input.documentId, error: String(error) });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to confirm file replacement.' });
      }
    }),
});
