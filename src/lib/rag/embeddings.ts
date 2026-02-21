import { logger } from '@/utils/logger';
import { redis } from '@/lib/redis/client';

/**
 * Embedding provider type
 */
export type EmbeddingProvider = 'huggingface' | 'openai';

/**
 * Embedding configuration
 */
interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimension: number;
}

/**
 * Default embedding configurations
 */
const EMBEDDING_CONFIGS: Record<EmbeddingProvider, EmbeddingConfig> = {
  huggingface: {
    provider: 'huggingface',
    model: 'sentence-transformers/all-MiniLM-L6-v2',
    dimension: 384,
  },
  openai: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimension: 1536,
  },
};

/**
 * Get embedding provider from environment
 */
function getEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER?.toLowerCase();
  
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    return 'openai';
  }
  
  return 'huggingface'; // Default to free HuggingFace
}

/**
 * Get embedding configuration
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  const provider = getEmbeddingProvider();
  return EMBEDDING_CONFIGS[provider];
}

/**
 * Generate cache key for embedding
 */
function getEmbeddingCacheKey(text: string, provider: EmbeddingProvider): string {
  // Simple hash function
  let hash = 0;
  const content = `${provider}:${text}`;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `embedding:${Math.abs(hash).toString(36)}`;
}

/**
 * Get cached embedding
 */
async function getCachedEmbedding(text: string, provider: EmbeddingProvider): Promise<number[] | null> {
  try {
    const key = getEmbeddingCacheKey(text, provider);
    const cached = await redis.get(key);
    
    if (cached) {
      logger.debug({
        type: 'embedding_cache_hit',
        provider,
      });
      return JSON.parse(cached);
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Cache embedding
 */
async function cacheEmbedding(text: string, provider: EmbeddingProvider, embedding: number[]): Promise<void> {
  try {
    const key = getEmbeddingCacheKey(text, provider);
    // Cache for 30 days
    await redis.setex(key, 30 * 24 * 60 * 60, JSON.stringify(embedding));
  } catch (error: any) {
    logger.error({
      type: 'embedding_cache_error',
      error: error.message,
    });
  }
}

/**
 * Generate embedding using HuggingFace Inference API
 */
async function generateHuggingFaceEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  
  if (!apiKey) {
    throw new Error('HUGGINGFACE_API_KEY not configured');
  }

  const model = EMBEDDING_CONFIGS.huggingface.model;
  const apiUrl = `https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`;

  try {
    logger.debug({
      type: 'huggingface_embedding_request',
      textLength: text.length,
    });

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: text,
        options: { wait_for_model: true },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HuggingFace API error: ${error}`);
    }

    const embedding = await response.json() as number[] | number[][];

    // HuggingFace returns array of embeddings, we want the first one
    const vector = Array.isArray(embedding[0]) ? embedding[0] as number[] : embedding as number[];

    logger.debug({
      type: 'huggingface_embedding_success',
      dimension: vector.length,
    });

    return vector;
  } catch (error: any) {
    logger.error({
      type: 'huggingface_embedding_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Generate embedding using OpenAI
 */
async function generateOpenAIEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const model = EMBEDDING_CONFIGS.openai.model;

  try {
    logger.debug({
      type: 'openai_embedding_request',
      textLength: text.length,
    });

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    const embedding = data.data[0].embedding;

    logger.debug({
      type: 'openai_embedding_success',
      dimension: embedding.length,
    });

    return embedding;
  } catch (error: any) {
    logger.error({
      type: 'openai_embedding_error',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Generate embedding for text
 * @param text Text to embed
 * @param provider Optional provider (defaults to configured provider)
 * @param useCache Whether to use cache (default: true)
 */
export async function generateEmbedding(
  text: string,
  provider?: EmbeddingProvider,
  useCache: boolean = true
): Promise<number[]> {
  const activeProvider = provider || getEmbeddingProvider();

  // Check cache first
  if (useCache) {
    const cached = await getCachedEmbedding(text, activeProvider);
    if (cached) {
      return cached;
    }
  }

  // Generate new embedding
  let embedding: number[];

  if (activeProvider === 'openai') {
    embedding = await generateOpenAIEmbedding(text);
  } else {
    embedding = await generateHuggingFaceEmbedding(text);
  }

  // Cache the result
  if (useCache) {
    await cacheEmbedding(text, activeProvider, embedding);
  }

  return embedding;
}

/**
 * Generate embeddings for multiple texts in batch
 * @param texts Array of texts to embed
 * @param provider Optional provider
 * @param useCache Whether to use cache
 */
export async function generateBatchEmbeddings(
  texts: string[],
  provider?: EmbeddingProvider,
  useCache: boolean = true
): Promise<number[][]> {
  const activeProvider = provider || getEmbeddingProvider();

  logger.info({
    type: 'batch_embedding_started',
    count: texts.length,
    provider: activeProvider,
  });

  // Process in parallel with concurrency limit
  const BATCH_SIZE = 10;
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    
    const batchEmbeddings = await Promise.all(
      batch.map(text => generateEmbedding(text, activeProvider, useCache))
    );

    embeddings.push(...batchEmbeddings);

    logger.debug({
      type: 'batch_embedding_progress',
      processed: embeddings.length,
      total: texts.length,
    });
  }

  logger.info({
    type: 'batch_embedding_complete',
    count: embeddings.length,
  });

  return embeddings;
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Normalize vector to unit length
 */
export function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  
  if (norm === 0) {
    return vector;
  }

  return vector.map(val => val / norm);
}

/**
 * Get embedding statistics
 */
export async function getEmbeddingStats(): Promise<{
  provider: EmbeddingProvider;
  model: string;
  dimension: number;
  cacheSize: number;
}> {
  const config = getEmbeddingConfig();
  
  // Count cached embeddings
  const cacheKeys = await redis.keys('embedding:*');
  
  return {
    provider: config.provider,
    model: config.model,
    dimension: config.dimension,
    cacheSize: cacheKeys.length,
  };
}

/**
 * Clear embedding cache
 */
export async function clearEmbeddingCache(): Promise<number> {
  try {
    const keys = await redis.keys('embedding:*');
    
    if (keys.length === 0) {
      return 0;
    }

    await redis.del(...keys);
    
    logger.warn({
      type: 'embedding_cache_cleared',
      count: keys.length,
    });

    return keys.length;
  } catch (error: any) {
    logger.error({
      type: 'embedding_cache_clear_error',
      error: error.message,
    });
    return 0;
  }
}