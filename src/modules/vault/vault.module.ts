import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prisma } from '@/lib/prisma/client';
import { storageService } from '@/lib/storage/storage.service';
import { storageConfig } from '@/config/storage.config';
import { logger } from '@/utils/logger';
import { notificationModule } from '@/modules/notification';
import type {
  DocumentCategory,
  VaultDocumentStatus,
  VaultDocumentListItem,
  VaultDocumentListResult,
  VaultDocumentStats,
  GenerateUploadUrlParams,
  GenerateUploadUrlResult,
  CreateDocumentParams,
  ListDocumentsParams,
  GetDocumentByIdParams,
  GenerateDownloadUrlParams,
  UpdateDocumentParams,
  UpdateDocumentStatusParams,
  DeleteDocumentParams,
  GetDocumentStatsParams,
  ReplaceDocumentParams,
} from './vault.types';

// ─── Constants ────────────────────────────────────────────────────────────────

const VAULT_ALLOWED_MIME_TYPES: readonly string[] =
  storageConfig.allowedFileTypes.vault.mimeTypes;

const VAULT_MAX_FILE_SIZE = storageConfig.limits.maxFileSize.vault;

/** Roles permitted to change document verification status */
const STATUS_CHANGE_ROLES: readonly string[] = ['ADMIN', 'REGULATOR'];

/** Days before expiry considered "expiring soon" */
const EXPIRING_SOON_DAYS = 30;

// ─── Select shape shared by list and get queries ──────────────────────────────

const VAULT_DOCUMENT_SELECT = {
  id: true,
  name: true,
  description: true,
  fileName: true,
  fileType: true,
  fileExtension: true,
  fileSize: true,
  storageKey: true,
  category: true,
  status: true,
  expiryDate: true,
  verifiedAt: true,
  verifiedBy: true,
  uploadedById: true,
  organizationId: true,
  tags: true,
  version: true,
  isArchived: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: {
    select: {
      id: true,
      fullName: true,
      email: true,
    },
  },
} as const;

// ─── Helper: assert organisation is present ───────────────────────────────────

function requireOrganization(organizationId: string | undefined | null): string {
  if (!organizationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Your account must belong to an organization to use the Document Vault.',
    });
  }
  return organizationId;
}

// ─── Helper: assert MIME type is allowed for vault ────────────────────────────

function assertVaultMimeType(fileType: string): void {
  if (!VAULT_ALLOWED_MIME_TYPES.includes(fileType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `File type "${fileType}" is not allowed. Accepted types: PDF, DOCX, XLSX, CSV, PNG, JPG.`,
    });
  }
}

// ─── Helper: assert file size within vault limit ──────────────────────────────

function assertVaultFileSize(fileSize: number): void {
  if (fileSize > VAULT_MAX_FILE_SIZE) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `File size ${(fileSize / 1024 / 1024).toFixed(1)} MB exceeds the 25 MB vault limit.`,
    });
  }
}

// ─── Helper: assert org-scoped document access ───────────────────────────────

function assertDocumentAccess(
  doc: { organizationId: string; uploadedById: string },
  _userId: string,
  organizationId: string,
  userRole: string,
): void {
  if (userRole === 'ADMIN') return;
  if (doc.organizationId !== organizationId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this document.' });
  }
}

// ─── Helper: assert ownership or admin ───────────────────────────────────────

function assertOwnerOrAdmin(
  doc: { organizationId: string; uploadedById: string },
  userId: string,
  organizationId: string,
  userRole: string,
): void {
  if (userRole === 'ADMIN') return;
  if (doc.organizationId !== organizationId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this document.' });
  }
  if (doc.uploadedById !== userId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the document owner or an administrator can perform this action.',
    });
  }
}

// ─── VaultModule class ────────────────────────────────────────────────────────

class VaultModule {
  /**
   * Step 1 of the two-step upload flow.
   * Generates a presigned PUT URL and a pre-allocated document ID.
   * The caller uploads directly to R2 then calls createDocument with the
   * documentId and storageKey returned here.
   */
  async generateUploadPresignedUrl(
    params: GenerateUploadUrlParams,
  ): Promise<GenerateUploadUrlResult> {
    const orgId = requireOrganization(params.organizationId);
    assertVaultMimeType(params.fileType);
    assertVaultFileSize(params.fileSize);

    const documentId = randomUUID();
    const ext = path.extname(params.filename).toLowerCase().slice(0, 15);
    const uuidFilename = `${randomUUID()}${ext}`;
    const storageKey = `vault/org_${orgId}/${documentId}/${uuidFilename}`;

    const { url } = await storageService.getUploadUrl(
      params.filename,
      params.fileType,
      undefined,
      storageKey,
    );

    logger.info({
      type: 'vault_upload_url_generated',
      userId: params.userId,
      organizationId: orgId,
      documentId,
      fileSize: params.fileSize,
    });

    return {
      uploadUrl: url,
      storageKey,
      documentId,
      expiresAt: new Date(
        Date.now() + storageConfig.presignedUrls.expiry.upload * 1000,
      ).toISOString(),
    };
  }

  /**
   * Step 2 of the two-step upload flow.
   * Creates the VaultDocument DB record after the client confirms R2 upload.
   */
  async createDocument(params: CreateDocumentParams): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);

    const doc = await (prisma as any).vaultDocument.create({
      data: {
        id: params.documentId,
        name: params.name,
        description: params.description ?? null,
        fileName: params.fileName,
        fileType: params.fileType,
        fileExtension: params.fileExtension,
        fileSize: params.fileSize,
        storageKey: params.storageKey,
        category: params.category,
        expiryDate: params.expiryDate ? new Date(params.expiryDate) : null,
        tags: params.tags ?? [],
        uploadedById: params.userId,
        organizationId: orgId,
      },
      select: VAULT_DOCUMENT_SELECT,
    });

    logger.info({
      type: 'vault_document_created',
      userId: params.userId,
      organizationId: orgId,
      documentId: doc.id,
      category: doc.category,
    });

    notificationModule.createCategorizedNotification({
      userId: params.userId,
      type: 'DOCUMENT_UPLOADED',
      category: 'DOCUMENTS',
      title: 'Document Uploaded',
      message: `"${params.name}" has been added to your document vault.`,
      link: `/startup/vault`,
    }).catch(() => { /* non-blocking */ });

    return doc as VaultDocumentListItem;
  }

  /**
   * Paginated, filtered document list scoped to the caller's organization.
   * Also triggers an async expiry check (fire-and-forget).
   */
  async listDocuments(params: ListDocumentsParams): Promise<VaultDocumentListResult> {
    const orgId = requireOrganization(params.organizationId);

    // Fire-and-forget expiry check so stale PENDING/VERIFIED docs get auto-expired
    void this.checkExpiredDocuments(orgId).catch((err: Error) => {
      logger.warn({ type: 'vault_expiry_check_error', orgId, error: err.message });
    });

    const where: Record<string, unknown> = {
      organizationId: orgId,
      isArchived: false,
    };

    if (params.category) where.category = params.category;
    if (params.status) where.status = params.status;

    if (params.search) {
      const term = params.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { tags: { has: term } },
      ];
    }

    const orderBy: Record<string, string> = {
      [params.sortBy ?? 'createdAt']: params.sortOrder ?? 'desc',
    };

    const skip = (params.page - 1) * params.limit;

    const [documents, total] = await Promise.all([
      (prisma as any).vaultDocument.findMany({
        where,
        skip,
        take: params.limit,
        orderBy,
        select: VAULT_DOCUMENT_SELECT,
      }),
      (prisma as any).vaultDocument.count({ where }),
    ]);

    return {
      documents: documents as VaultDocumentListItem[],
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  /**
   * Fetch a single vault document, enforcing org-scoped access.
   */
  async getDocumentById(params: GetDocumentByIdParams): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);

    const doc = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: VAULT_DOCUMENT_SELECT,
    });

    if (!doc || doc.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertDocumentAccess(doc, params.userId, orgId, params.userRole);

    return doc as VaultDocumentListItem;
  }

  /**
   * Generate a presigned GET URL for downloading or viewing a document.
   */
  async generateDownloadPresignedUrl(
    params: GenerateDownloadUrlParams,
  ): Promise<{ downloadUrl: string; filename: string; expiresAt: string }> {
    const orgId = requireOrganization(params.organizationId);

    const doc = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: {
        storageKey: true,
        fileName: true,
        name: true,
        isArchived: true,
        organizationId: true,
        uploadedById: true,
      },
    });

    if (!doc || doc.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertDocumentAccess(doc, params.userId, orgId, params.userRole);

    const downloadUrl = await storageService.getDownloadUrl(
      doc.storageKey,
      storageConfig.presignedUrls.expiry.download,
      params.inline ?? false,
      doc.fileName,
    );

    logger.info({
      type: 'vault_download_url_generated',
      userId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
    });

    return {
      downloadUrl,
      filename: doc.name,
      expiresAt: new Date(
        Date.now() + storageConfig.presignedUrls.expiry.download * 1000,
      ).toISOString(),
    };
  }

  /**
   * Update document metadata. Restricted to the uploader or an admin.
   */
  async updateDocument(params: UpdateDocumentParams): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);

    const existing = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: { organizationId: true, uploadedById: true, isArchived: true },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);

    const data: Record<string, unknown> = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.description !== undefined) data.description = params.description;
    if (params.category !== undefined) data.category = params.category;
    if (params.expiryDate !== undefined) {
      data.expiryDate = params.expiryDate ? new Date(params.expiryDate) : null;
    }
    if (params.tags !== undefined) data.tags = params.tags;
    if (params.notes !== undefined) data.notes = params.notes;

    const updated = await (prisma as any).vaultDocument.update({
      where: { id: params.documentId },
      data,
      select: VAULT_DOCUMENT_SELECT,
    });

    logger.info({
      type: 'vault_document_updated',
      userId: params.userId,
      documentId: params.documentId,
      fields: Object.keys(data),
    });

    return updated as VaultDocumentListItem;
  }

  /**
   * Update verification status. Restricted to Admin and Regulator roles.
   */
  async updateDocumentStatus(params: UpdateDocumentStatusParams): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);

    if (!STATUS_CHANGE_ROLES.includes(params.userRole)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only administrators and regulators can change document verification status.',
      });
    }

    const existing = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: { organizationId: true, uploadedById: true, isArchived: true },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    // Admins can update any org; regulators only their own org
    if (params.userRole === 'REGULATOR' && existing.organizationId !== orgId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this document.' });
    }

    const data: Record<string, unknown> = { status: params.status };
    if (params.status === 'VERIFIED') {
      data.verifiedAt = new Date();
      data.verifiedBy = params.userId;
    }

    const updated = await (prisma as any).vaultDocument.update({
      where: { id: params.documentId },
      data,
      select: VAULT_DOCUMENT_SELECT,
    });

    logger.info({
      type: 'vault_document_status_updated',
      userId: params.userId,
      documentId: params.documentId,
      status: params.status,
    });

    return updated as VaultDocumentListItem;
  }

  /**
   * Soft-delete a document (sets isArchived = true). Owner or Admin only.
   */
  async deleteDocument(params: DeleteDocumentParams): Promise<{ success: boolean }> {
    const orgId = requireOrganization(params.organizationId);

    const existing = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: { organizationId: true, uploadedById: true, isArchived: true, storageKey: true },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);

    await (prisma as any).vaultDocument.update({
      where: { id: params.documentId },
      data: { isArchived: true },
    });

    logger.info({
      type: 'vault_document_deleted',
      userId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
    });

    notificationModule.createCategorizedNotification({
      userId: params.userId,
      type: 'DOCUMENT_DELETED',
      category: 'DOCUMENTS',
      title: 'Document Removed',
      message: 'A document has been removed from your document vault.',
      link: `/startup/vault`,
    }).catch(() => { /* non-blocking */ });

    return { success: true };
  }

  /**
   * Category + status counts for the summary cards, scoped to the org.
   */
  async getDocumentStats(params: GetDocumentStatsParams): Promise<VaultDocumentStats> {
    const orgId = requireOrganization(params.organizationId);

    const baseWhere = { organizationId: orgId, isArchived: false };

    const [totalCount, categoryGroups, statusGroups, expiringSoonCount] = await Promise.all([
      (prisma as any).vaultDocument.count({ where: baseWhere }),
      (prisma as any).vaultDocument.groupBy({
        by: ['category'],
        where: baseWhere,
        _count: { id: true },
      }),
      (prisma as any).vaultDocument.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { id: true },
      }),
      (prisma as any).vaultDocument.count({
        where: {
          ...baseWhere,
          status: { not: 'EXPIRED' },
          expiryDate: {
            gte: new Date(),
            lte: new Date(Date.now() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ]);

    const allCategories: DocumentCategory[] = [
      'CORPORATE',
      'COMPLIANCE',
      'FINANCIAL',
      'LICENSE',
      'OPERATIONS',
      'TAX',
      'OTHER',
    ];
    const allStatuses: VaultDocumentStatus[] = ['PENDING', 'VERIFIED', 'EXPIRED'];

    const byCategory = Object.fromEntries(
      allCategories.map((cat) => [
        cat,
        (categoryGroups as Array<{ category: DocumentCategory; _count: { id: number } }>).find(
          (g) => g.category === cat,
        )?._count.id ?? 0,
      ]),
    ) as Record<DocumentCategory, number>;

    const byStatus = Object.fromEntries(
      allStatuses.map((st) => [
        st,
        (statusGroups as Array<{ status: VaultDocumentStatus; _count: { id: number } }>).find(
          (g) => g.status === st,
        )?._count.id ?? 0,
      ]),
    ) as Record<VaultDocumentStatus, number>;

    return {
      total: totalCount as number,
      byCategory,
      byStatus,
      expiringSoon: expiringSoonCount as number,
    };
  }

  /**
   * Scan for documents whose expiryDate has passed and flip their status to
   * EXPIRED. Designed to be called fire-and-forget; never throws to callers.
   */
  async checkExpiredDocuments(organizationId?: string): Promise<void> {
    const where: Record<string, unknown> = {
      isArchived: false,
      status: { not: 'EXPIRED' },
      expiryDate: { lt: new Date() },
    };
    if (organizationId) where.organizationId = organizationId;

    const { count } = await (prisma as any).vaultDocument.updateMany({
      where,
      data: { status: 'EXPIRED' },
    });

    if (count > 0) {
      logger.info({
        type: 'vault_documents_auto_expired',
        count,
        organizationId: organizationId ?? 'all',
      });
    }
  }

  /**
   * Generate a new presigned upload URL for replacing an existing document.
   * Increments the version counter once confirmUpload is called.
   * Returns the new storageKey and documentId (same as existing docId so the
   * caller passes it back to a dedicated confirmReplace flow).
   */
  async replaceDocument(
    params: ReplaceDocumentParams,
  ): Promise<GenerateUploadUrlResult & { currentVersion: number }> {
    const orgId = requireOrganization(params.organizationId);
    assertVaultMimeType(params.fileType);
    assertVaultFileSize(params.fileSize);

    const existing = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: {
        organizationId: true,
        uploadedById: true,
        isArchived: true,
        version: true,
        storageKey: true,
      },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);

    const ext = path.extname(params.filename).toLowerCase().slice(0, 15);
    const uuidFilename = `${randomUUID()}${ext}`;
    // Keep same documentId folder so it remains traceable
    const storageKey = `vault/org_${orgId}/${params.documentId}/${uuidFilename}`;

    const { url } = await storageService.getUploadUrl(
      params.filename,
      params.fileType,
      undefined,
      storageKey,
    );

    logger.info({
      type: 'vault_replace_url_generated',
      userId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
    });

    return {
      uploadUrl: url,
      storageKey,
      documentId: params.documentId,
      currentVersion: existing.version as number,
      expiresAt: new Date(
        Date.now() + storageConfig.presignedUrls.expiry.upload * 1000,
      ).toISOString(),
    };
  }

  /**
   * Finalize a file replacement: update storageKey, fileName, fileType,
   * fileSize, fileExtension, version, and reset status to PENDING.
   */
  async confirmReplacement(params: {
    documentId: string;
    storageKey: string;
    fileName: string;
    fileType: string;
    fileExtension: string;
    fileSize: number;
    userId: string;
    organizationId: string;
    userRole: string;
  }): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);

    const existing = await (prisma as any).vaultDocument.findUnique({
      where: { id: params.documentId },
      select: { organizationId: true, uploadedById: true, isArchived: true, version: true },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);

    const updated = await (prisma as any).vaultDocument.update({
      where: { id: params.documentId },
      data: {
        storageKey: params.storageKey,
        fileName: params.fileName,
        fileType: params.fileType,
        fileExtension: params.fileExtension,
        fileSize: params.fileSize,
        version: { increment: 1 },
        status: 'PENDING',
        verifiedAt: null,
        verifiedBy: null,
      },
      select: VAULT_DOCUMENT_SELECT,
    });

    logger.info({
      type: 'vault_document_replaced',
      userId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
      newVersion: updated.version,
    });

    return updated as VaultDocumentListItem;
  }
}

export const vaultModule = new VaultModule();
export { VaultModule };
