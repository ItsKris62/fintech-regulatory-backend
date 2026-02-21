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
  chunkText: string;
  section?: string;
  subsection?: string;
  actName?: string;
  year?: number;
  regulatoryArea?: string;
  citation?: string;
}

/**
 * Vector record
 */
export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
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
 * Get Pinecone index name from environment
 */
function getIndexName(): string {
  return process.env.PINECONE_INDEX_NAME || 'sheriabot-legal-docs';
}

/**
 * Get or create Pinecone index
 */
export async function getIndex() {
  const indexName = getIndexName();
  
  try {
    // Check if index exists
    const indexList = await pinecone.listIndexes();
    const indexExists = indexList.indexes?.some(idx => idx.name === indexName);

    if (!indexExists) {
      logger.warn({
        type: 'pinecone_index_not_found',
        indexName,
      });
      
      throw new Error(`Pinecone index "${indexName}" not found. Please create it first.`);
    }

    return pinecone.index(indexName);
  } catch (error: any) {
    logger.error({
      type: 'pinecone_index_error',
      indexName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Create Pinecone index (admin operation)
 * @param dimension Embedding dimension (384 for HuggingFace, 1536 for OpenAI)
 * @param metric Distance metric (cosine, euclidean, dotproduct)
 */
export async function createIndex(
  dimension: number = 384,
  metric: 'cosine' | 'euclidean' | 'dotproduct' = 'cosine'
): Promise<void> {
  const indexName = getIndexName();

  try {
    logger.info({
      type: 'pinecone_creating_index',
      indexName,
      dimension,
      metric,
    });

    await pinecone.createIndex({
      name: indexName,
      dimension,
      metric,
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1',
        },
      },
    });

    logger.info({
      type: 'pinecone_index_created',
      indexName,
    });
  } catch (error: any) {
    logger.error({
      type: 'pinecone_create_index_error',
      indexName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Delete Pinecone index (admin operation - use with caution!)
 */
export async function deleteIndex(): Promise<void> {
  const indexName = getIndexName();

  if (appConfig.isProduction) {
    throw new Error('Cannot delete index in production');
  }

  try {
    logger.warn({
      type: 'pinecone_deleting_index',
      indexName,
    });

    await pinecone.deleteIndex(indexName);

    logger.warn({
      type: 'pinecone_index_deleted',
      indexName,
    });
  } catch (error: any) {
    logger.error({
      type: 'pinecone_delete_index_error',
      indexName,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Upsert vectors to Pinecone
 * @param vectors Array of vector records
 * @param namespace Optional namespace for organization
 */
export async function upsertVectors(
  vectors: VectorRecord[],
  namespace?: string
): Promise<void> {
  try {
    const index = await getIndex();

    logger.info({
      type: 'pinecone_upserting_vectors',
      count: vectors.length,
      namespace,
    });

    // Batch upsert (Pinecone handles batching internally)
    await index.namespace(namespace || '').upsert(vectors as any);

    logger.info({
      type: 'pinecone_vectors_upserted',
      count: vectors.length,
      namespace,
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
 * Query vectors from Pinecone
 * @param vector Query vector
 * @param topK Number of results to return
 * @param namespace Optional namespace
 * @param filter Optional metadata filter
 */
export async function queryVectors(
  vector: number[],
  topK: number = 10,
  namespace?: string,
  filter?: Record<string, any>
): Promise<QueryResult[]> {
  try {
    const index = await getIndex();

    logger.debug({
      type: 'pinecone_querying',
      topK,
      namespace,
      hasFilter: !!filter,
    });

    const queryResponse = await index.namespace(namespace || '').query({
      vector,
      topK,
      includeMetadata: true,
      filter,
    });

    const results: QueryResult[] = queryResponse.matches.map(match => ({
      id: match.id,
      score: match.score || 0,
      metadata: match.metadata as unknown as VectorMetadata,
    }));

    logger.debug({
      type: 'pinecone_query_complete',
      resultsCount: results.length,
    });

    return results;
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
 * @param ids Vector IDs to delete
 * @param namespace Optional namespace
 */
export async function deleteVectors(
  ids: string[],
  namespace?: string
): Promise<void> {
  try {
    const index = await getIndex();

    logger.info({
      type: 'pinecone_deleting_vectors',
      count: ids.length,
      namespace,
    });

    await index.namespace(namespace || '').deleteMany(ids);

    logger.info({
      type: 'pinecone_vectors_deleted',
      count: ids.length,
    });
  } catch (error: any) {
    logger.error({
      type: 'pinecone_delete_vectors_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Delete all vectors by metadata filter
 * @param filter Metadata filter
 * @param namespace Optional namespace
 */
export async function deleteByFilter(
  filter: Record<string, any>,
  namespace?: string
): Promise<void> {
  try {
    const index = await getIndex();

    logger.warn({
      type: 'pinecone_deleting_by_filter',
      filter,
      namespace,
    });

    await index.namespace(namespace || '').deleteMany(filter);

    logger.warn({
      type: 'pinecone_deleted_by_filter',
      filter,
    });
  } catch (error: any) {
    logger.error({
      type: 'pinecone_delete_filter_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Delete all vectors in namespace (use with caution!)
 * @param namespace Namespace to clear
 */
export async function deleteAllInNamespace(namespace: string): Promise<void> {
  if (appConfig.isProduction) {
    throw new Error('Cannot delete all vectors in production');
  }

  try {
    const index = await getIndex();

    logger.warn({
      type: 'pinecone_deleting_namespace',
      namespace,
    });

    await index.namespace(namespace).deleteAll();

    logger.warn({
      type: 'pinecone_namespace_deleted',
      namespace,
    });
  } catch (error: any) {
    logger.error({
      type: 'pinecone_delete_namespace_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get index statistics
 */
export async function getIndexStats(): Promise<{
  dimension: number;
  indexFullness: number;
  totalVectorCount: number;
  namespaces: Record<string, { vectorCount: number }>;
}> {
  try {
    const index = await getIndex();
    const stats = await index.describeIndexStats();

    logger.debug({
      type: 'pinecone_stats_retrieved',
      totalVectors: stats.totalRecordCount,
    });

    return {
      dimension: stats.dimension || 0,
      indexFullness: stats.indexFullness || 0,
      totalVectorCount: stats.totalRecordCount || 0,
      namespaces: (stats.namespaces || {}) as unknown as Record<string, { vectorCount: number }>,
    };
  } catch (error: any) {
    logger.error({
      type: 'pinecone_stats_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Fetch vectors by IDs
 * @param ids Vector IDs
 * @param namespace Optional namespace
 */
export async function fetchVectors(
  ids: string[],
  namespace?: string
): Promise<Record<string, VectorRecord>> {
  try {
    const index = await getIndex();

    const fetchResponse = await index.namespace(namespace || '').fetch({ ids });

    const records: Record<string, VectorRecord> = {};

    if (fetchResponse.records) {
      Object.entries(fetchResponse.records).forEach(([id, record]) => {
        records[id] = {
          id,
          values: (record.values ?? []) as number[],
          metadata: record.metadata as unknown as VectorMetadata,
        };
      });
    }

    return records;
  } catch (error: any) {
    logger.error({
      type: 'pinecone_fetch_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Check if Pinecone is accessible
 */
export async function checkPineconeHealth(): Promise<boolean> {
  try {
    await getIndexStats();
    return true;
  } catch (error) {
    return false;
  }
}

// Export Pinecone client for advanced usage
export { pinecone };