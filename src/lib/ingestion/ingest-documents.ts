/**
 * Ingestion barrel — re-exports the document ingestion service and its types
 * for convenient imports from `@/lib/ingestion`.
 *
 * The actual pipeline implementation lives in `./document-processor`.
 * The executable CLI script lives in `src/scripts/ingest-documents.ts`.
 */

export {
  documentIngestionService,
  DocumentIngestionService,
  type DocumentIngestionInput,
  type IngestionResult,
  type DeleteDocumentOptions,
  type DocumentStats,
} from './document-processor';
