import { z } from 'zod';
import { storageConfig } from '@/config/storage.config';

// ─── Enum literals (kept in sync with Prisma schema) ──────────────────────────

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

// ─── Step 1: Request presigned upload URL ─────────────────────────────────────

export const vaultGetUploadUrlSchema = z.object({
  filename: z.string().min(1).max(255),
  fileType: z.string().min(1),
  fileSize: z
    .number()
    .min(storageConfig.limits.minFileSize, 'File must be at least 1 KB')
    .max(storageConfig.limits.maxFileSize.vault, 'File exceeds the 25 MB vault limit'),
});

export type VaultGetUploadUrlInput = z.infer<typeof vaultGetUploadUrlSchema>;

// ─── Step 2: Confirm upload and create DB record ──────────────────────────────

export const vaultConfirmUploadSchema = z.object({
  documentId: z.string().min(1),
  storageKey: z.string().min(1),
  name: z.string().min(1, 'Document name is required').max(255),
  description: z.string().max(1000).optional(),
  fileName: z.string().min(1).max(255),
  fileType: z.string().min(1),
  fileExtension: z.string().min(1).max(15),
  fileSize: z.number().min(1),
  category: documentCategorySchema,
  expiryDate: z.string().datetime({ offset: true }).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

export type VaultConfirmUploadInput = z.infer<typeof vaultConfirmUploadSchema>;

// ─── List / filter query ──────────────────────────────────────────────────────

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

// ─── Single document by ID ────────────────────────────────────────────────────

export const vaultDocumentIdSchema = z.object({
  id: z.string().min(1),
});

export type VaultDocumentIdInput = z.infer<typeof vaultDocumentIdSchema>;

// ─── Update document metadata ─────────────────────────────────────────────────

export const vaultUpdateDocumentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  category: documentCategorySchema.optional(),
  expiryDate: z.string().datetime({ offset: true }).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type VaultUpdateDocumentInput = z.infer<typeof vaultUpdateDocumentSchema>;

// ─── Update verification status ───────────────────────────────────────────────

export const vaultUpdateStatusSchema = z.object({
  id: z.string().min(1),
  status: vaultDocumentStatusSchema,
});

export type VaultUpdateStatusInput = z.infer<typeof vaultUpdateStatusSchema>;

// ─── Replace document file (new version) ─────────────────────────────────────

export const vaultReplaceDocumentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1).max(255),
  fileType: z.string().min(1),
  fileSize: z
    .number()
    .min(storageConfig.limits.minFileSize)
    .max(storageConfig.limits.maxFileSize.vault),
});

export type VaultReplaceDocumentInput = z.infer<typeof vaultReplaceDocumentSchema>;
