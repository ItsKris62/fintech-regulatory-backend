import { TRPCError } from '@trpc/server';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { storageService } from '@/lib/storage/storage.service';
import { vaultS3Client, vaultStorageConfig } from '@/lib/storage/client';
import { computeObjectContentHash } from '@/lib/storage/content-hash';
import {
  assertVaultUploadScanningConfigured,
  scanVaultObjectForMalware,
} from '@/lib/security/malware-scanner';
import {
  ALLOWED_VAULT_MIME_TYPES,
  MIME_TO_EXTENSION,
  VAULT_MIME_TYPES,
  type VaultMimeType,
} from '@/lib/storage/mime';
import {
  PLAN_ENTITLEMENTS,
} from '@/config/entitlements.config';
import { logger } from '@/utils/logger';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { notificationModule } from '@/modules/notification';
import type { EffectivePlan } from '@/types/plan.types';
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

// --- Constants ----------------------------------------------------------------

/** Roles permitted to change document verification status */
const STATUS_CHANGE_ROLES: readonly string[] = ['ADMIN', 'REGULATOR'];

/** Days before expiry considered "expiring soon" */
const EXPIRING_SOON_DAYS = 30;

const VAULT_UPLOAD_PREFIX = 'vault';
const PENDING_UPLOAD_TTL_SECONDS = 600;
const VAULT_TAG_SCHEMA = z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/);
const CONTROL_CHARACTERS_REGEX = /[\x00-\x1F\x7F]/g;
const DISALLOWED_DESCRIPTION_CHARACTERS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const SAFE_FILENAME_SCHEMA = z.string()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/]/.test(value), 'Filename must not include path separators.')
  .refine((value) => !/[\0-\x1F\x7F]/.test(value), 'Filename must not include control characters.');

const VAULT_DOCUMENT_NAME_SCHEMA = z.string()
  .transform((value) => value.replace(CONTROL_CHARACTERS_REGEX, '').trim())
  .refine((value) => value.length > 0)
  .refine((value) => value.length <= 255);

const VAULT_DESCRIPTION_SCHEMA = z.string()
  .max(1000)
  .refine((value) => !DISALLOWED_DESCRIPTION_CHARACTERS_REGEX.test(value));

const ISO_DATE_TIME_SCHEMA = z.string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)));

const FUTURE_ISO_DATE_TIME_SCHEMA = ISO_DATE_TIME_SCHEMA
  .refine((value) => new Date(value).getTime() > Date.now());

const vaultPresignInputSchema = z.object({
  organizationId: z.string().min(1),
  uploaderId: z.string().min(1),
  documentId: z.string().min(1),
  name: VAULT_DOCUMENT_NAME_SCHEMA,
  description: VAULT_DESCRIPTION_SCHEMA.optional(),
  expiryDate: FUTURE_ISO_DATE_TIME_SCHEMA.optional(),
  declaredFilename: SAFE_FILENAME_SCHEMA,
  declaredMimeType: z.enum(VAULT_MIME_TYPES),
  declaredSize: z.number().int().positive(),
  category: z.enum(['CORPORATE', 'COMPLIANCE', 'FINANCIAL', 'LICENSE', 'OPERATIONS', 'TAX', 'OTHER']),
  tags: z.array(VAULT_TAG_SCHEMA).max(20),
  tier: z.enum(['REGULATOR', 'STARTUP', 'BUSINESS', 'ENTERPRISE', 'FREE_TRIAL']),
});

const vaultReplacePresignInputSchema = vaultPresignInputSchema.omit({
  name: true,
  description: true,
  expiryDate: true,
});

const pendingVaultUploadSchema = z.object({
  organizationId: z.string().min(1),
  uploaderId: z.string().min(1),
  documentId: z.string().min(1),
  storageKey: z.string().min(1),
  bucket: z.string().min(1),
  name: VAULT_DOCUMENT_NAME_SCHEMA,
  description: VAULT_DESCRIPTION_SCHEMA.optional(),
  expiryDate: ISO_DATE_TIME_SCHEMA.optional(),
  declaredMimeType: z.enum(VAULT_MIME_TYPES),
  declaredSize: z.number().int().positive(),
  category: z.enum(['CORPORATE', 'COMPLIANCE', 'FINANCIAL', 'LICENSE', 'OPERATIONS', 'TAX', 'OTHER']),
  tags: z.array(VAULT_TAG_SCHEMA).max(20),
  declaredFilename: SAFE_FILENAME_SCHEMA,
});

type PendingVaultUpload = z.infer<typeof pendingVaultUploadSchema>;

// --- Select shape shared by list and get queries ------------------------------

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

// --- Helper: assert organisation is present -----------------------------------

function requireOrganization(organizationId: string | undefined | null): string {
  if (!organizationId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Your account must belong to an organization to use the Document Vault.',
    });
  }
  return organizationId;
}

function getVaultPlanLimits(plan: EffectivePlan) {
  const entitlements = PLAN_ENTITLEMENTS[plan];
  const maxFileSizeMB = entitlements.vaultDocumentMaxBytes === -1
    ? -1
    : Math.floor(entitlements.vaultDocumentMaxBytes / (1024 * 1024));
  const maxTotalStorageMB = entitlements.vaultTotalQuotaBytes === -1
    ? -1
    : Math.floor(entitlements.vaultTotalQuotaBytes / (1024 * 1024));

  return {
    maxFileSizeMB,
    maxTotalStorageMB,
    allowedMimeTypes: entitlements.vaultAllowedMimeTypes,
  };
}

function sanitizeDeclaredFilename(filename: string): string {
  const basename = path.basename(filename).replace(/[\0-\x1F\x7F]/g, '_').slice(0, 255);
  return basename || 'document';
}

function encodeMetadataFilename(filename: string): string {
  const safeFilename = sanitizeDeclaredFilename(filename);
  return /^[\x20-\x7E]*$/.test(safeFilename)
    ? safeFilename
    : encodeURIComponent(safeFilename);
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value ?? '']),
  );
}

function generateVaultDocumentId(): string {
  return `c${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function getSafeExtension(mimeType: string): string {
  if (!ALLOWED_VAULT_MIME_TYPES.has(mimeType)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported vault file type.' });
  }

  return MIME_TO_EXTENSION[mimeType as VaultMimeType];
}

function buildVaultStorageKey(orgId: string, documentId: string, declaredMimeType: string): string {
  const safeExt = getSafeExtension(declaredMimeType);
  const objectId = randomUUID();
  return `${VAULT_UPLOAD_PREFIX}/organizationId/${orgId}/documentId/${documentId}/${objectId}.${safeExt}`;
}

function assertVaultStorageKey(params: {
  organizationId: string;
  documentId: string;
  storageKey: string;
}): void {
  const expectedPrefix = `${VAULT_UPLOAD_PREFIX}/organizationId/${params.organizationId}/documentId/${params.documentId}/`;
  if (!params.storageKey.startsWith(expectedPrefix) || params.storageKey.includes('..')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Upload key does not match the server-issued vault location.',
    });
  }
}

function buildVaultObjectMetadata(args: {
  uploaderId: string;
  organizationId: string;
  documentId: string;
  category: DocumentCategory;
  originalFilename: string;
  declaredMimeType: string;
  declaredSize: number;
}): Record<string, string> {
  return {
    'uploader-id': args.uploaderId,
    'org-id': args.organizationId,
    'document-id': args.documentId,
    category: args.category,
    'original-filename': encodeMetadataFilename(args.originalFilename),
    'declared-mime': args.declaredMimeType,
    'declared-size': String(args.declaredSize),
  };
}

function pendingUploadKey(documentId: string): string {
  return `sheriabot:vault:pending:${documentId}`;
}

async function assertActiveOrganizationMembership(userId: string, organizationId: string): Promise<void> {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { status: true },
  });

  if (membership?.status === 'ACTIVE') return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { organizationId: true },
  });

  if (user?.organizationId === organizationId) return;

  throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this organization.' });
}

async function storePendingUpload(pendingUpload: PendingVaultUpload): Promise<void> {
  // Pending upload schema v2 stores mutable form fields captured at presign.
  await redis.set(
    pendingUploadKey(pendingUpload.documentId),
    JSON.stringify(pendingUpload),
    { ex: PENDING_UPLOAD_TTL_SECONDS },
  );
}

async function loadPendingUpload(documentId: string): Promise<PendingVaultUpload> {
  const raw = await redis.get<string>(pendingUploadKey(documentId));
  if (!raw) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Upload request expired or was not found.',
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Upload request state is invalid.',
    });
  }
  const parsed = pendingVaultUploadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Upload request state is invalid.',
    });
  }

  return parsed.data;
}

async function deletePendingUpload(documentId: string): Promise<void> {
  try {
    await redis.del(pendingUploadKey(documentId));
  } catch (error: unknown) {
    logger.warn({
      type: 'vault.pending.delete_failed',
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeVaultAuditLog(args: {
  userId: string;
  action: string;
  documentId: string;
  organizationId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId,
        action: args.action,
        entityType: 'VaultDocument',
        entityId: args.documentId,
        metadata: {
          organizationId: args.organizationId,
          ...(args.metadata ?? {}),
        },
      },
    });
  } catch (error: unknown) {
    logger.warn({
      type: 'vault.audit_log_failed',
      action: args.action,
      documentId: args.documentId,
      error: sanitizeErrorMessage(error),
    });
  }
}

async function deleteRejectedVaultObject(args: {
  key: string;
  bucket: string;
  documentId: string;
}): Promise<void> {
  try {
    await vaultS3Client.send(new DeleteObjectCommand({ Bucket: args.bucket, Key: args.key }));
    logger.warn({
      type: 'vault.rejected_object.deleted',
      documentId: args.documentId,
      key: args.key,
      bucket: args.bucket,
    });
  } catch (error: unknown) {
    logger.error({
      type: 'vault.rejected_object.delete_failed',
      documentId: args.documentId,
      key: args.key,
      error: sanitizeErrorMessage(error),
    });
  }
}

async function verifyVaultObjectBeforeConfirm(pendingUpload: PendingVaultUpload): Promise<{
  verifiedSize: number;
  verifiedMime: string;
}> {
  const metadata = await storageService.getVaultFileInfo(pendingUpload.storageKey, pendingUpload.bucket);
  if (!metadata) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Upload not received.',
    });
  }

  if (metadata.size !== pendingUpload.declaredSize) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Uploaded file size does not match the signed upload request.',
    });
  }

  if (metadata.contentType !== pendingUpload.declaredMimeType) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Uploaded file type does not match the signed upload request.',
    });
  }

  const objectMetadata = normalizeMetadata(metadata.metadata);
  const metadataComparisons: Array<{ key: string; expected: string }> = [
    { key: 'uploader-id', expected: pendingUpload.uploaderId },
    { key: 'org-id', expected: pendingUpload.organizationId },
    { key: 'document-id', expected: pendingUpload.documentId },
    { key: 'declared-size', expected: String(pendingUpload.declaredSize) },
    { key: 'declared-mime', expected: pendingUpload.declaredMimeType },
  ];
  const mismatchedMetadata = metadataComparisons.find(
    (comparison) => objectMetadata[comparison.key] !== comparison.expected,
  );

  if (mismatchedMetadata) {
    logger.warn({
      type: 'vault.confirm.metadata_mismatch',
      documentId: pendingUpload.documentId,
      key: mismatchedMetadata.key,
    });
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Uploaded file metadata does not match the signed upload request.',
    });
  }

  return {
    verifiedSize: metadata.size,
    verifiedMime: metadata.contentType,
  };
}

// --- Helper: enforce per-tier upload limits -----------------------------------

function assertTierUploadLimits(plan: EffectivePlan, fileType: string, fileSize: number): void {
  const limits = PLAN_ENTITLEMENTS[plan];

  if (limits.vaultDocumentMaxBytes === 0 || limits.vaultTotalQuotaBytes === 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Document vault is not available on your current plan.',
    });
  }

  if (!limits.vaultAllowedMimeTypes.includes(fileType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `File type "${fileType}" is not allowed on your current plan. Accepted: ${limits.vaultAllowedMimeTypes.join(', ')}.`,
    });
  }

  if (limits.vaultDocumentMaxBytes !== -1 && fileSize > limits.vaultDocumentMaxBytes) {
    const maxFileSizeMB = Math.floor(limits.vaultDocumentMaxBytes / (1024 * 1024));
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `File size ${(fileSize / 1024 / 1024).toFixed(1)} MB exceeds the ${maxFileSizeMB} MB limit for your plan. Upgrade for larger uploads.`,
    });
  }
}

// --- Helper: enforce per-org total storage quota ------------------------------

async function checkVaultStorageQuota(
  orgId: string,
  incomingFileSizeBytes: number,
  plan: EffectivePlan,
): Promise<void> {
  const limits = PLAN_ENTITLEMENTS[plan];

  // Unlimited storage  -  no check needed
  if (limits.vaultTotalQuotaBytes === -1) return;

  // Blocked tier  -  assertTierUploadLimits already handles this, but guard anyway
  if (limits.vaultTotalQuotaBytes === 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Document vault is not available on your current plan.',
    });
  }

  // Sum active (non-archived) vault documents for this org  -  this is the
  // authoritative source of total storage used (Redis counter is for billing
  // dashboards only and resets monthly).
  const agg = await prisma.vaultDocument.aggregate({
    where: { organizationId: orgId, isArchived: false, deletedAt: null },
    _sum: { fileSize: true },
  });
  const currentUsedBytes = agg._sum.fileSize ?? 0;

  if (currentUsedBytes + incomingFileSizeBytes > limits.vaultTotalQuotaBytes) {
    const usedMB = Math.round(currentUsedBytes / (1024 * 1024));
    const limitMB = Math.floor(limits.vaultTotalQuotaBytes / (1024 * 1024));
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Storage quota exceeded. Your plan allows ${limitMB} MB total. Currently using ${usedMB} MB. Upgrade your plan for more storage.`,
    });
  }
}

// --- Helper: assert org-scoped document access -------------------------------

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

// --- Helper: assert ownership or admin ---------------------------------------

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

// --- VaultModule class --------------------------------------------------------

class VaultModule {
  /**
   * Step 1 of the two-step upload flow.
   * Enforces tier-based file size, MIME type, and total storage quota checks
   * BEFORE generating the presigned PUT URL. If any check fails the client
   * never receives a URL and cannot upload.
   */
  async generateUploadPresignedUrl(
    params: GenerateUploadUrlParams,
  ): Promise<GenerateUploadUrlResult> {
    const orgId = requireOrganization(params.organizationId);
    const documentId = generateVaultDocumentId();
    const declaredFilename = sanitizeDeclaredFilename(params.declaredFilename);
    const parsed = vaultPresignInputSchema.safeParse({
      organizationId: orgId,
      uploaderId: params.userId,
      documentId,
      name: params.name,
      description: params.description,
      expiryDate: params.expiryDate,
      declaredFilename,
      declaredMimeType: params.declaredMimeType,
      declaredSize: params.declaredSize,
      category: params.category,
      tags: params.tags ?? [],
      tier: params.plan,
    });

    if (!parsed.success) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid vault upload request.',
      });
    }
    const uploadRequest = parsed.data;
    assertVaultUploadScanningConfigured();

    // Enforce per-tier single-file limits first (cheap, synchronous)
    assertTierUploadLimits(params.plan, params.declaredMimeType, params.declaredSize);

    // Enforce total storage quota (async DB aggregate)
    await checkVaultStorageQuota(orgId, params.declaredSize, params.plan);

    const storageKey = buildVaultStorageKey(orgId, documentId, uploadRequest.declaredMimeType);
    const bucket = vaultStorageConfig.bucket;
    const metadata = buildVaultObjectMetadata({
      uploaderId: params.userId,
      organizationId: orgId,
      documentId,
      category: uploadRequest.category,
      originalFilename: declaredFilename,
      declaredMimeType: uploadRequest.declaredMimeType,
      declaredSize: uploadRequest.declaredSize,
    });
    const uploadExpirySeconds = 300;

    // Pass fileSize so the presigned URL is bound to a specific Content-Length,
    // preventing the client from uploading a larger file than declared.
    const { url, requiredHeaders } = await storageService.getVaultUploadUrl({
      key: storageKey,
      contentType: uploadRequest.declaredMimeType,
      contentLength: uploadRequest.declaredSize,
      metadata,
      expiresIn: uploadExpirySeconds,
    });

    await storePendingUpload({
      organizationId: orgId,
      uploaderId: params.userId,
      documentId,
      storageKey,
      bucket,
      name: uploadRequest.name,
      description: uploadRequest.description,
      expiryDate: uploadRequest.expiryDate,
      declaredMimeType: uploadRequest.declaredMimeType,
      declaredSize: uploadRequest.declaredSize,
      category: uploadRequest.category,
      tags: uploadRequest.tags,
      declaredFilename,
    });

    logger.info({
      type: 'vault.presign.issued',
      organizationId: orgId,
      uploaderId: params.userId,
      documentId,
      bucket,
      key: storageKey,
      declaredSize: uploadRequest.declaredSize,
      declaredMimeType: uploadRequest.declaredMimeType,
    });
    await writeVaultAuditLog({
      userId: params.userId,
      action: 'vault_upload_url_issued',
      documentId,
      organizationId: orgId,
      metadata: {
        storageKey,
        bucket,
        declaredSize: uploadRequest.declaredSize,
        declaredMimeType: uploadRequest.declaredMimeType,
        expiresInSeconds: uploadExpirySeconds,
      },
    });

    return {
      uploadUrl: url,
      documentId,
      requiredHeaders,
      expiresAt: new Date(
        Date.now() + uploadExpirySeconds * 1000,
      ).toISOString(),
    };
  }

  /**
   * Step 2 of the two-step upload flow.
   * Creates the VaultDocument DB record after the client confirms R2 upload.
   */
  async createDocument(params: CreateDocumentParams): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);
    const pendingUpload = await loadPendingUpload(params.documentId);

    if (params.userId !== pendingUpload.uploaderId || orgId !== pendingUpload.organizationId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this upload.' });
    }

    await assertActiveOrganizationMembership(params.userId, pendingUpload.organizationId);
    assertVaultStorageKey({
      organizationId: pendingUpload.organizationId,
      documentId: pendingUpload.documentId,
      storageKey: pendingUpload.storageKey,
    });

    const verified = await verifyVaultObjectBeforeConfirm(pendingUpload);
    const safeExtension = getSafeExtension(pendingUpload.declaredMimeType);
    let contentHash: string;
    let hashBytesRead: number;

    try {
      const hashResult = await computeObjectContentHash({
        s3Client: vaultS3Client,
        bucket: pendingUpload.bucket,
        key: pendingUpload.storageKey,
        expectedSize: pendingUpload.declaredSize,
        context: {
          organizationId: pendingUpload.organizationId,
          documentId: pendingUpload.documentId,
        },
      });
      contentHash = hashResult.hash;
      hashBytesRead = hashResult.bytesRead;
    } catch (error: unknown) {
      logger.error({
        type: 'vault.confirm.hash_failed',
        organizationId: pendingUpload.organizationId,
        documentId: pendingUpload.documentId,
        error: sanitizeErrorMessage(error),
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Upload verification failed. Please try again.',
      });
    }

    const scanResult = await scanVaultObjectForMalware({
      key: pendingUpload.storageKey,
      bucket: pendingUpload.bucket,
      organizationId: pendingUpload.organizationId,
      documentId: pendingUpload.documentId,
    });

    if (scanResult.status === 'infected') {
      await deletePendingUpload(pendingUpload.documentId);
      await deleteRejectedVaultObject({
        key: pendingUpload.storageKey,
        bucket: pendingUpload.bucket,
        documentId: pendingUpload.documentId,
      });
      await writeVaultAuditLog({
        userId: pendingUpload.uploaderId,
        action: 'vault_upload_quarantined_malware',
        documentId: pendingUpload.documentId,
        organizationId: pendingUpload.organizationId,
        metadata: {
          storageKey: pendingUpload.storageKey,
          signature: scanResult.signature ?? null,
        },
      });
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Upload rejected by malware scanning.',
      });
    }

    const doc = await prisma.vaultDocument.create({
      data: {
        id: pendingUpload.documentId,
        name: pendingUpload.name,
        description: pendingUpload.description ?? null,
        fileName: pendingUpload.declaredFilename,
        fileType: pendingUpload.declaredMimeType,
        fileExtension: `.${safeExtension}`,
        fileSize: verified.verifiedSize,
        storageKey: pendingUpload.storageKey,
        category: pendingUpload.category,
        expiryDate: pendingUpload.expiryDate ? new Date(pendingUpload.expiryDate) : null,
        tags: pendingUpload.tags,
        uploadedById: pendingUpload.uploaderId,
        organizationId: pendingUpload.organizationId,
        status: 'PENDING',
        r2Bucket: pendingUpload.bucket,
        contentHash,
        uploadStatus: 'VERIFIED',
      },
      select: VAULT_DOCUMENT_SELECT,
    });

    await deletePendingUpload(pendingUpload.documentId);
    await writeVaultAuditLog({
      userId: pendingUpload.uploaderId,
      action: 'vault_upload_confirmed',
      documentId: doc.id,
      organizationId: pendingUpload.organizationId,
      metadata: {
        storageKey: pendingUpload.storageKey,
        bucket: pendingUpload.bucket,
        contentHash,
        scanStatus: scanResult.status,
        scanEngine: scanResult.engine,
        fileSize: verified.verifiedSize,
        fileType: verified.verifiedMime,
      },
    });

    logger.info({
      type: 'vault.upload.confirmed',
      organizationId: pendingUpload.organizationId,
      uploaderId: pendingUpload.uploaderId,
      documentId: doc.id,
      bucket: pendingUpload.bucket,
      key: pendingUpload.storageKey,
      verifiedSize: verified.verifiedSize,
      verifiedMime: verified.verifiedMime,
      uploadStatus: 'VERIFIED',
      hashBytesRead,
    });

    notificationModule.createCategorizedNotification({
      userId: pendingUpload.uploaderId,
      type: 'DOCUMENT_UPLOADED',
      category: 'DOCUMENTS',
      title: 'Document Uploaded',
      message: `"${pendingUpload.name}" has been added to your document vault.`,
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
      deletedAt: null,
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
      prisma.vaultDocument.findMany({
        where,
        skip,
        take: params.limit,
        orderBy,
        select: VAULT_DOCUMENT_SELECT,
      }),
      prisma.vaultDocument.count({ where }),
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

    const doc = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
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

    const doc = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
      select: {
        storageKey: true,
        fileName: true,
        name: true,
        isArchived: true,
        r2Bucket: true,
        organizationId: true,
        uploadedById: true,
      },
    });

    if (!doc || doc.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    if (doc.organizationId !== orgId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this document.' });
    }
    await assertActiveOrganizationMembership(params.userId, doc.organizationId);

    const bucket = doc.r2Bucket ?? vaultStorageConfig.bucket;
    const downloadExpirySeconds = 300;

    const downloadUrl = await storageService.getVaultDownloadUrl(
      doc.storageKey,
      downloadExpirySeconds,
      doc.fileName,
      bucket,
    );

    logger.info({
      type: 'vault.download.issued',
      uploaderId: params.userId,
      organizationId: doc.organizationId,
      documentId: params.documentId,
      bucket,
      key: doc.storageKey,
    });
    await writeVaultAuditLog({
      userId: params.userId,
      action: 'vault_download_url_issued',
      documentId: params.documentId,
      organizationId: doc.organizationId,
      metadata: {
        storageKey: doc.storageKey,
        bucket,
        expiresInSeconds: downloadExpirySeconds,
      },
    });

    return {
      downloadUrl,
      filename: doc.name,
      expiresAt: new Date(
        Date.now() + downloadExpirySeconds * 1000,
      ).toISOString(),
    };
  }

  /**
   * Update document metadata. Restricted to the uploader or an admin.
   */
  async updateDocument(params: UpdateDocumentParams): Promise<VaultDocumentListItem> {
    const orgId = requireOrganization(params.organizationId);

    const existing = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
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

    const updated = await prisma.vaultDocument.update({
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

    const existing = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
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

    const updated = await prisma.vaultDocument.update({
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

    const existing = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
      select: { organizationId: true, uploadedById: true, isArchived: true, storageKey: true },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);

    await prisma.vaultDocument.update({
      where: { id: params.documentId },
      data: { isArchived: true, deletedAt: new Date(), uploadStatus: 'DELETED' },
    });
    await writeVaultAuditLog({
      userId: params.userId,
      action: 'vault_document_deleted',
      documentId: params.documentId,
      organizationId: orgId,
      metadata: { storageKey: existing.storageKey },
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

    const baseWhere = { organizationId: orgId, isArchived: false, deletedAt: null };

    const [totalCount, categoryGroups, statusGroups, expiringSoonCount] = await Promise.all([
      prisma.vaultDocument.count({ where: baseWhere }),
      prisma.vaultDocument.groupBy({
        by: ['category'],
        where: baseWhere,
        _count: { id: true },
      }),
      prisma.vaultDocument.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { id: true },
      }),
      prisma.vaultDocument.count({
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
        categoryGroups.find((g) => g.category === cat)?._count.id ?? 0,
      ]),
    ) as Record<DocumentCategory, number>;

    const byStatus = Object.fromEntries(
      allStatuses.map((st) => [
        st,
        statusGroups.find((g) => g.status === st)?._count.id ?? 0,
      ]),
    ) as Record<VaultDocumentStatus, number>;

    return {
      total: totalCount,
      byCategory,
      byStatus,
      expiringSoon: expiringSoonCount,
    };
  }

  /**
   * Scan for documents whose expiryDate has passed and flip their status to
   * EXPIRED. Designed to be called fire-and-forget; never throws to callers.
   */
  async checkExpiredDocuments(organizationId?: string): Promise<void> {
    const where: Record<string, unknown> = {
      isArchived: false,
      deletedAt: null,
      status: { not: 'EXPIRED' },
      expiryDate: { lt: new Date() },
    };
    if (organizationId) where.organizationId = organizationId;

    const { count } = await prisma.vaultDocument.updateMany({
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
   * Returns the total active (non-archived) storage used by an org in megabytes.
   * Used by the getUploadLimits tRPC query to show the storage usage indicator.
   */
  async getStorageUsedMB(organizationId: string): Promise<number> {
    if (!organizationId) return 0;
    const agg = await prisma.vaultDocument.aggregate({
      where: { organizationId, isArchived: false, deletedAt: null },
      _sum: { fileSize: true },
    });
    return Math.round((agg._sum.fileSize ?? 0) / (1024 * 1024));
  }

  async getUploadLimits(
    organizationId: string,
    plan: EffectivePlan,
  ): Promise<{
    maxFileSizeMB: number;
    maxTotalStorageMB: number;
    allowedMimeTypes: readonly string[];
    storageUsedMB: number;
  }> {
    const orgId = requireOrganization(organizationId);
    const limits = getVaultPlanLimits(plan);
    const storageUsedMB = await this.getStorageUsedMB(orgId);

    return {
      ...limits,
      storageUsedMB,
    };
  }

  /**
   * Generate a new presigned upload URL for replacing an existing document.
   * Increments the version counter once confirmUpload is called.
   * Returns the new storageKey and documentId (same as existing docId so the
   * caller passes it back to a dedicated confirmReplace flow).
   */
  async replaceDocument(
    params: ReplaceDocumentParams,
  ): Promise<GenerateUploadUrlResult & { currentVersion: number; storageKey: string }> {
    const orgId = requireOrganization(params.organizationId);

    // Enforce per-tier single-file limits and MIME type before doing any DB work
    assertTierUploadLimits(params.plan, params.fileType, params.fileSize);

    const existing = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
      select: {
        organizationId: true,
        uploadedById: true,
        isArchived: true,
        version: true,
        storageKey: true,
        fileSize: true,
        category: true,
        tags: true,
      },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);

    // For replacement: quota check uses (incoming - current file size) as the
    // net addition so replacing with a same-size file never exceeds quota.
    const sizeDeltaBytes = params.fileSize - (existing.fileSize ?? 0);
    if (sizeDeltaBytes > 0) {
      await checkVaultStorageQuota(orgId, sizeDeltaBytes, params.plan);
    }

    const declaredFilename = sanitizeDeclaredFilename(params.filename);
    const parsed = vaultReplacePresignInputSchema.safeParse({
      organizationId: orgId,
      uploaderId: params.userId,
      documentId: params.documentId,
      declaredFilename,
      declaredMimeType: params.fileType,
      declaredSize: params.fileSize,
      category: existing.category,
      tags: existing.tags,
      tier: params.plan,
    });

    if (!parsed.success) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid vault replacement request.',
      });
    }

    // Keep same documentId folder so it remains traceable
    const storageKey = buildVaultStorageKey(orgId, params.documentId, params.fileType);
    const uploadExpirySeconds = 300;
    const metadata = buildVaultObjectMetadata({
      uploaderId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
      category: existing.category,
      originalFilename: declaredFilename,
      declaredMimeType: params.fileType,
      declaredSize: params.fileSize,
    });

    const { url, requiredHeaders } = await storageService.getVaultUploadUrl({
      key: storageKey,
      contentType: params.fileType,
      contentLength: params.fileSize,
      metadata,
      expiresIn: uploadExpirySeconds,
    });

    logger.info({
      type: 'vault_replace_url_generated',
      userId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
    });
    await writeVaultAuditLog({
      userId: params.userId,
      action: 'vault_replacement_upload_url_issued',
      documentId: params.documentId,
      organizationId: orgId,
      metadata: {
        storageKey,
        previousStorageKey: existing.storageKey,
        declaredSize: params.fileSize,
        declaredMimeType: params.fileType,
        expiresInSeconds: uploadExpirySeconds,
      },
    });

    return {
      uploadUrl: url,
      storageKey,
      documentId: params.documentId,
      requiredHeaders,
      currentVersion: existing.version as number,
      expiresAt: new Date(
        Date.now() + uploadExpirySeconds * 1000,
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

    const existing = await prisma.vaultDocument.findFirst({
      where: { id: params.documentId, deletedAt: null },
      select: {
        organizationId: true,
        uploadedById: true,
        isArchived: true,
        version: true,
        category: true,
        tags: true,
      },
    });

    if (!existing || existing.isArchived) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found.' });
    }

    assertOwnerOrAdmin(existing, params.userId, orgId, params.userRole);
    assertVaultStorageKey({
      organizationId: orgId,
      documentId: params.documentId,
      storageKey: params.storageKey,
    });
    const replacementPending: PendingVaultUpload = {
      storageKey: params.storageKey,
      organizationId: orgId,
      uploaderId: params.userId,
      documentId: params.documentId,
      bucket: vaultStorageConfig.bucket,
      name: params.fileName,
      description: undefined,
      expiryDate: undefined,
      declaredMimeType: params.fileType as VaultMimeType,
      declaredSize: params.fileSize,
      category: existing.category,
      tags: existing.tags,
      declaredFilename: sanitizeDeclaredFilename(params.fileName),
    };
    const verified = await verifyVaultObjectBeforeConfirm(replacementPending);
    let contentHash: string;
    let hashBytesRead: number;

    try {
      const hashResult = await computeObjectContentHash({
        s3Client: vaultS3Client,
        bucket: replacementPending.bucket,
        key: replacementPending.storageKey,
        expectedSize: replacementPending.declaredSize,
        context: {
          organizationId: replacementPending.organizationId,
          documentId: replacementPending.documentId,
        },
      });
      contentHash = hashResult.hash;
      hashBytesRead = hashResult.bytesRead;
    } catch (error: unknown) {
      logger.error({
        type: 'vault.replace.hash_failed',
        organizationId: replacementPending.organizationId,
        documentId: replacementPending.documentId,
        error: sanitizeErrorMessage(error),
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Replacement verification failed. Please try again.',
      });
    }

    const scanResult = await scanVaultObjectForMalware({
      key: replacementPending.storageKey,
      bucket: replacementPending.bucket,
      organizationId: replacementPending.organizationId,
      documentId: replacementPending.documentId,
    });

    if (scanResult.status === 'infected') {
      await deleteRejectedVaultObject({
        key: replacementPending.storageKey,
        bucket: replacementPending.bucket,
        documentId: replacementPending.documentId,
      });
      await writeVaultAuditLog({
        userId: params.userId,
        action: 'vault_replacement_quarantined_malware',
        documentId: params.documentId,
        organizationId: orgId,
        metadata: {
          storageKey: replacementPending.storageKey,
          signature: scanResult.signature ?? null,
        },
      });
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Replacement rejected by malware scanning.',
      });
    }

    const updated = await prisma.vaultDocument.update({
      where: { id: params.documentId },
      data: {
        storageKey: params.storageKey,
        fileName: params.fileName,
        fileType: params.fileType,
        fileExtension: `.${getSafeExtension(params.fileType)}`,
        fileSize: verified.verifiedSize,
        version: { increment: 1 },
        status: 'PENDING',
        verifiedAt: null,
        verifiedBy: null,
        r2Bucket: replacementPending.bucket,
        contentHash,
        uploadStatus: 'VERIFIED',
      },
      select: VAULT_DOCUMENT_SELECT,
    });
    await writeVaultAuditLog({
      userId: params.userId,
      action: 'vault_document_replaced',
      documentId: params.documentId,
      organizationId: orgId,
      metadata: {
        storageKey: params.storageKey,
        contentHash,
        scanStatus: scanResult.status,
        scanEngine: scanResult.engine,
        fileSize: verified.verifiedSize,
      },
    });

    logger.info({
      type: 'vault_document_replaced',
      userId: params.userId,
      organizationId: orgId,
      documentId: params.documentId,
      newVersion: updated.version,
      uploadStatus: 'VERIFIED',
      hashBytesRead,
    });

    return updated as VaultDocumentListItem;
  }
}

export const vaultModule = new VaultModule();
export { VaultModule };
