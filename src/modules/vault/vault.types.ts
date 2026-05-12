import type { DocumentCategory, VaultDocumentStatus } from '@prisma/client';

export type { DocumentCategory, VaultDocumentStatus };

// --- Prisma select shape returned by list queries -----------------------------

export interface VaultDocumentListItem {
  id: string;
  name: string;
  description: string | null;
  fileName: string;
  fileType: string;
  fileExtension: string;
  fileSize: number;
  storageKey: string;
  category: DocumentCategory;
  status: VaultDocumentStatus;
  expiryDate: Date | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  uploadedById: string;
  organizationId: string;
  tags: string[];
  version: number;
  isArchived: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  uploadedBy: {
    id: string;
    fullName: string;
    email: string;
  };
}

// --- List result with pagination ----------------------------------------------

export interface VaultDocumentListResult {
  documents: VaultDocumentListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// --- Stats --------------------------------------------------------------------

export interface VaultDocumentStats {
  total: number;
  byCategory: Record<DocumentCategory, number>;
  byStatus: Record<VaultDocumentStatus, number>;
  expiringSoon: number;
}

// --- Service input types ------------------------------------------------------

export interface GenerateUploadUrlParams {
  userId: string;
  organizationId: string;
  name: string;
  description?: string;
  expiryDate?: string;
  declaredFilename: string;
  declaredMimeType: string;
  declaredSize: number;
  category: DocumentCategory;
  tags?: string[];
  /** The caller's effective plan  -  used to enforce per-tier file size and MIME limits. */
  plan: import('@/types/plan.types').EffectivePlan;
}

export interface GenerateUploadUrlResult {
  uploadUrl: string;
  documentId: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface CreateDocumentParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
}

export interface ListDocumentsParams {
  userId: string;
  organizationId: string;
  userRole: string;
  page: number;
  limit: number;
  category?: DocumentCategory;
  status?: VaultDocumentStatus;
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'fileSize' | 'expiryDate';
  sortOrder?: 'asc' | 'desc';
}

export interface GetDocumentByIdParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
}

export interface GenerateDownloadUrlParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
}

export interface UpdateDocumentParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
  name?: string;
  description?: string | null;
  category?: DocumentCategory;
  expiryDate?: string | null;
  tags?: string[];
  notes?: string | null;
}

export interface UpdateDocumentStatusParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
  status: VaultDocumentStatus;
}

export interface DeleteDocumentParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
}

export interface GetDocumentStatsParams {
  organizationId: string;
}

export interface ReplaceDocumentParams {
  documentId: string;
  userId: string;
  organizationId: string;
  userRole: string;
  filename: string;
  fileType: string;
  fileSize: number;
  /** The caller's effective plan  -  used to enforce per-tier file size and MIME limits. */
  plan: import('@/types/plan.types').EffectivePlan;
}
