import { z } from 'zod';
import { storageConfig } from '@/config/storage.config';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { VAULT_MIME_TYPES } from '@/lib/storage/mime';

// --- Enum literals (kept in sync with Prisma schema) --------------------------

export const documentCategorySchema = z.enum([
  'CORPORATE',
  'COMPLIANCE',
  'FINANCIAL',
  'LICENSE',
  'OPERATIONS',
  'TAX',
  'OTHER',
]);

export const vaultDocumentStatusSchema = z.enum(['PENDING', 'VERIFIED', 'EXPIRED']);

export type DocumentCategoryValue = z.infer<typeof documentCategorySchema>;
export type VaultDocumentStatusValue = z.infer<typeof vaultDocumentStatusSchema>;

const vaultMaxFileSizeBytes = Math.max(
  ...Object.values(PLAN_ENTITLEMENTS).map((entitlement) => entitlement.vaultDocumentMaxBytes),
);

const safeFilenameSchema = z.string()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/]/.test(value), 'Filename must not include path separators.')
  .refine((value) => !/[\0-\x1F\x7F]/.test(value), 'Filename must not include control characters.');

const vaultTagSchema = z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/);
const controlCharactersRegex = /[\x00-\x1F\x7F]/g;
const disallowedDescriptionCharactersRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const vaultDocumentNameSchema = z.string()
  .transform((value) => value.replace(controlCharactersRegex, '').trim())
  .refine((value) => value.length > 0, 'Document name is required')
  .refine((value) => value.length <= 255, 'Document name must be 255 characters or fewer');

const vaultDescriptionSchema = z.string()
  .max(1000)
  .refine(
    (value) => !disallowedDescriptionCharactersRegex.test(value),
    'Description must not include control characters.',
  );

const isoDateTimeSchema = z.string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expiry date must be a valid ISO date.');

const futureIsoDateTimeSchema = isoDateTimeSchema
  .refine((value) => new Date(value).getTime() > Date.now(), 'Expiry date must be in the future.');

// --- Step 1: Request presigned upload URL -------------------------------------

export const vaultGetUploadUrlSchema = z.object({
  name: vaultDocumentNameSchema,
  description: vaultDescriptionSchema.optional(),
  expiryDate: futureIsoDateTimeSchema.optional(),
  declaredFilename: safeFilenameSchema,
  declaredMimeType: z.enum(VAULT_MIME_TYPES),
  declaredSize: z
    .number()
    .int()
    .min(storageConfig.limits.minFileSize, 'File must be at least 1 KB')
    .max(vaultMaxFileSizeBytes, 'File exceeds the maximum vault file size'),
  category: documentCategorySchema,
  tags: z.array(vaultTagSchema).max(20).optional(),
});

export type VaultGetUploadUrlInput = z.infer<typeof vaultGetUploadUrlSchema>;

// --- Step 2: Confirm upload and create DB record ------------------------------

export const vaultConfirmUploadSchema = z.object({
  documentId: z.string().regex(/^c[a-z0-9]{8,}$/i, 'Invalid document ID'),
});

export type VaultConfirmUploadInput = z.infer<typeof vaultConfirmUploadSchema>;

// --- List / filter query ------------------------------------------------------

export const vaultListQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  category: documentCategorySchema.optional(),
  status: vaultDocumentStatusSchema.optional(),
  search: z.string().max(200).optional(),
  sortBy: z
    .enum(['name', 'createdAt', 'fileSize', 'expiryDate'])
    .optional()
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export type VaultListQueryInput = z.infer<typeof vaultListQuerySchema>;

// --- Single document by ID ----------------------------------------------------

export const vaultDocumentIdSchema = z.object({
  id: z.string().min(1),
});

export type VaultDocumentIdInput = z.infer<typeof vaultDocumentIdSchema>;

// --- Update document metadata -------------------------------------------------

export const vaultUpdateDocumentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  category: documentCategorySchema.optional(),
  expiryDate: z.string().datetime({ offset: true }).nullable().optional(),
  tags: z.array(vaultTagSchema).max(20).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type VaultUpdateDocumentInput = z.infer<typeof vaultUpdateDocumentSchema>;

// --- Update verification status -----------------------------------------------

export const vaultUpdateStatusSchema = z.object({
  id: z.string().min(1),
  status: vaultDocumentStatusSchema,
});

export type VaultUpdateStatusInput = z.infer<typeof vaultUpdateStatusSchema>;

// --- Replace document file (new version) -------------------------------------

export const vaultReplaceDocumentSchema = z.object({
  id: z.string().min(1),
  filename: safeFilenameSchema,
  fileType: z.enum(VAULT_MIME_TYPES),
  fileSize: z
    .number()
    .int()
    .min(storageConfig.limits.minFileSize)
    .max(vaultMaxFileSizeBytes),
});

export type VaultReplaceDocumentInput = z.infer<typeof vaultReplaceDocumentSchema>;
