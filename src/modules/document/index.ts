/**
 * Document Module — Public API
 */

export { documentModule, DocumentModule } from './document.module';

export type {
  UploadDocumentParams,
  DocumentMetadata,
  DocumentFilters,
  SearchFilters,
  DocumentSummary,
  PaginatedDocuments,
  DocumentSearchResult,
  ProcessingResult,
  ProcessingStatus,
  DocumentVersion,
  ShareParams,
  ShareLink,
  BulkUploadParams,
  BulkUploadResult,
  BulkDeleteResult,
  DocumentExportFormat,
  ExportResult,
  BlogPostParams,
  BlogPost,
  BlogFilters,
  PaginatedBlogPosts,
  KBArticleParams,
  KBArticle,
  KBFilters,
  PaginatedKBArticles,
  KBSearchResult,
  DocumentAction,
  DocumentErrorCode,
} from './document.types';

export { DOCUMENT_CONSTANTS, DocumentError } from './document.types';

export {
  uploadDocumentSchema,
  documentFiltersSchema,
  searchFiltersSchema,
  shareParamsSchema,
  blogPostSchema,
  kbArticleSchema,
  metadataUpdateSchema,
  generateSlug,
  generateShareToken,
  extractText,
} from './document.utils';
