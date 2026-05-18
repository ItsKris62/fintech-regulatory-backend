import { z } from 'zod';

/**
 * Document Schemas
 *
 * Zod validation schemas for document upload, download, and management.
 */

/**
 * Get presigned upload URL
 */
export const getUploadUrlSchema = z.object({
  filename: z.string().min(1).max(255),
  fileType: z.string(),
  fileSize: z.number().min(1).max(500 * 1024 * 1024),
  documentType: z.string().default('LEGAL_DOCUMENT'),
});

export type GetUploadUrlInput = z.infer<typeof getUploadUrlSchema>;

/**
 * Confirm upload and create document record
 */
export const confirmUploadSchema = z.object({
  key: z.string(),
  filename: z.string(),
  fileType: z.string(),
  fileSize: z.number(),
  documentType: z.string().default('LEGAL_DOCUMENT'),
  /**
   * Pre-generated document ID returned by getUploadUrl.
   * When provided, the created DB record uses this exact ID so the key path
   * (which embeds the ID) stays consistent with the database record.
   */
  documentId: z.string().optional(),
  description: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;

/**
 * List documents with pagination
 */
export const listDocumentsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
  documentType: z.string().optional(),
  search: z.string().max(200).optional(),
});

export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;

/**
 * Get document by ID
 */
export const getDocumentSchema = z.object({
  id: z.string(),
});

export type GetDocumentInput = z.infer<typeof getDocumentSchema>;

/**
 * Get presigned download URL
 */
export const getDownloadUrlSchema = z.object({
  id: z.string(),
});

export type GetDownloadUrlInput = z.infer<typeof getDownloadUrlSchema>;

/**
 * Delete document
 */
export const deleteDocumentSchema = z.object({
  id: z.string(),
});

export type DeleteDocumentInput = z.infer<typeof deleteDocumentSchema>;
