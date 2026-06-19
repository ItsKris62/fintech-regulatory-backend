import { Pinecone } from '@pinecone-database/pinecone';
import { logger } from '@/utils/logger';
import { appConfig } from '@/config/app.config';

/**
 * Vector metadata structure
 */
export interface VectorMetadata {
  documentId: string;
  documentTitle: string;
  documentType: string;
  chunkIndex: number;
  chunk_text?: string;
  section?: string;
  subsection?: string;
  actName?: string;
  year?: number;
  regulatoryArea?: string;
  citation?: string;
  /** ISO jurisdiction label used by RAG filter auto-detection (e.g. "Kenya", "International", "EU") */
  jurisdiction?: string;
  /** Prisma RegulatoryDocumentCategory value used by RAG filter auto-detection */
  category?: string;
  /** Legal authority status for the source instrument (DRAFT, IN_FORCE, SUPERSEDED, CONSULTATION) */
  authorityStatus?: string;
  /** Whether the source instrument is currently binding law */
  isBinding?: boolean;
  /** Publisher/source label, e.g. Central Bank of Kenya */
  source?: string;
  /** Human version label from the corpus registry */
  version?: string;
  /** Corpus lifecycle status, e.g. ACTIVE or SUPERSEDED */
  corpusStatus?: string;
  /** Human framework label captured during indexing. */
  framework?: string;
  /** Regulatory framework slug attached by ingestion or gap-analysis retrieval filters. */
  frameworkSlug?: string;
  /** Original LegalDocument ID when this vector came from the legal corpus. */
  legalDocumentId?: string;
  indexVersion?: string;
  officialUrl?: string;
  sourceDocumentVersionId?: string;
  pageStart?: number;
  pageEnd?: number;
  sectionNumber?: string;
  clauseNumber?: string;
  scheduleNumber?: string;
  headingPath?: string[] | string;
  provisionId?: string;
  contentHash?: string;
  documentChecksum?: string;
  effectiveDate?: string;
  effectiveEndDate?: string;
}

/**
 * Record used for integrated embedding upsert.
 * Flat structure  -  all fields at top level (Pinecone SDK v7 upsertRecords requirement).
 */
export interface IntegratedVectorRecord extends VectorMetadata {
  id: string;
  chunk_text: string; // MUST match Pinecone field map
}

/**
 * Query result
 */
export interface QueryResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

/**
 * Initialize Pinecone client
 */
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY || '',
});

/**
 * Get Pinecone index name
 */
function getIndexName(): string {
  return process.env.PINECONE_INDEX_NAME || 'sheriabot-legal-docs';
}

export function getPineconeDiagnostics(namespace?: string): {
  indexName: string;
  namespace: string;
  environment: string | null;
} {
  return {
    indexName: getIndexName(),
    namespace: namespace || '__default__',
    environment: process.env.PINECONE_ENVIRONMENT || null,
  };
}

/**
 * Get Pinecone index
 */
export async function getIndex() {
  const indexName = getIndexName();

  try {
    const indexList = await pinecone.listIndexes();
    const exists = indexList.indexes?.some(i => i.name === indexName);

    if (!exists) {
      throw new Error(`Pinecone index "${indexName}" not found.`);
    }

    return pinecone.index(indexName);
  } catch (error: any) {
    logger.error({
      type: 'pinecone_index_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Upsert using integrated embeddings (Pinecone SDK v7).
 * Records are flat objects; Pinecone generates embeddings from `chunk_text`.
 */
export async function upsertVectors(
  records: IntegratedVectorRecord[],
  namespace?: string
): Promise<void> {
  try {
    const index = await getIndex();

    logger.info({
      type: 'pinecone_upserting_integrated',
      count: records.length,
      namespace,
    });

    await index.upsertRecords({
      records: records as any[],
      namespace: namespace || '__default__',
    });

    logger.info({
      type: 'pinecone_upsert_complete',
      count: records.length,
    });
  } catch (error: any) {
    logger.error({
      type: 'pinecone_upsert_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Query using integrated embeddings (Pinecone SDK v7).
 * Pinecone embeds query text internally via searchRecords.
 */
export async function queryVectors(
  queryText: string,
  topK: number = 10,
  namespace?: string,
  filter?: Record<string, any>
): Promise<QueryResult[]> {
  try {
    const index = await getIndex();

    logger.debug({
      type: 'pinecone_integrated_query',
      indexName: getIndexName(),
      environment: process.env.PINECONE_ENVIRONMENT || null,
      topK,
      namespace: namespace || '__default__',
      hasFilter: !!filter,
    });

    const response = await index.searchRecords({
      query: {
        inputs: { text: queryText },
        topK,
        filter,
      },
      namespace: namespace || '__default__',
    });

    return (response.result.hits || []).map(hit => ({
      id: hit._id,
      score: hit._score || 0,
      metadata: hit.fields as unknown as VectorMetadata,
    }));
  } catch (error: any) {
    logger.error({
      type: 'pinecone_query_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Delete vectors by IDs
 */
export async function deleteVectors(
  ids: string[],
  namespace?: string
): Promise<void> {
  const index = await getIndex();
  await index.namespace(namespace || '__default__').deleteMany(ids);
}

/**
 * Delete by metadata filter
 */
export async function deleteByFilter(
  filter: Record<string, any>,
  namespace?: string
): Promise<void> {
  const index = await getIndex();
  await index.namespace(namespace || '__default__').deleteMany({ filter });
}

/**
 * Clear entire namespace (dev only)
 */
export async function deleteAllInNamespace(namespace: string): Promise<void> {
  if (appConfig.isProduction) {
    throw new Error('Cannot delete namespace in production');
  }

  const index = await getIndex();
  await index.namespace(namespace).deleteAll();
}

/**
 * Get index stats
 */
export async function getIndexStats() {
  const index = await getIndex();
  return index.describeIndexStats();
}

/**
 * Health check
 */
export async function checkPineconeHealth(): Promise<boolean> {
  try {
    await getIndexStats();
    return true;
  } catch {
    return false;
  }
}

export { pinecone };
