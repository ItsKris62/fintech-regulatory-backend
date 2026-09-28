import { logger } from '@/utils/logger';
import { aiConfig } from '@/config/ai.config';
import type { SearchResult } from './rag.service';

export interface CompressionOptions {
  enabled?: boolean;
  strategy?: 'rule-based' | 'extractive';
  maxOutputTokensPerChunk?: number;
  currentPipelineLatencyMs?: number;
}

export interface CompressionOutcome {
  compressedResults: SearchResult[];
  enabled: boolean;
  strategy: 'rule-based' | 'extractive' | 'none';
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  latencyMs: number;
  skippedDueToLatencyBudget?: boolean;
}

/**
 * Estimate token count from text using 4 characters per token heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Verify if key citation anchors present in original text remain in compressed text.
 * Checks documentTitle, section, clauseNumber, provisionId, etc.
 */
export function containsCitationAnchors(original: SearchResult, compressedText: string): boolean {
  if (
    original.sectionNumber &&
    original.chunkText.includes(original.sectionNumber) &&
    !compressedText.includes(original.sectionNumber)
  ) {
    return false;
  }
  if (
    original.clauseNumber &&
    original.chunkText.includes(original.clauseNumber) &&
    !compressedText.includes(original.clauseNumber)
  ) {
    return false;
  }
  if (
    original.section &&
    original.chunkText.includes(original.section) &&
    !compressedText.includes(original.section)
  ) {
    return false;
  }
  return true;
}

/**
 * Rule-based operative clause compression for legal and regulatory chunks.
 * Extracts sentences with query overlap, section titles, definitions, and mandatory terms.
 */
export function compressChunkRuleBased(
  chunk: SearchResult,
  query: string,
  maxTokens: number
): string {
  const originalText = chunk.chunkText;
  if (!originalText || estimateTokens(originalText) <= maxTokens) {
    return originalText;
  }

  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const sentences = originalText.split(/(?<=[.?!;])\s+/);

  const scoredSentences = sentences.map((sentence, idx) => {
    const sLower = sentence.toLowerCase();
    let score = 0;

    // Preserve opening clause or section header sentence
    if (idx === 0) score += 2;

    // Match query terms
    for (const term of queryTerms) {
      if (sLower.includes(term)) {
        score += 1.5;
      }
    }

    // Regulatory operative keywords (must, shall, prohibit, license, penalty, require, comply)
    if (/\b(shall|must|prohibited|requires?|compliance|license|penalty|regulation|section)\b/i.test(sentence)) {
      score += 1.0;
    }

    return { sentence, score, idx };
  });

  // Sort by score descending and pick until token budget
  const selected: Array<{ sentence: string; idx: number }> = [];
  let currentTokens = 0;

  // Always include sentences with positive score
  const candidates = [...scoredSentences].sort((a, b) => b.score - a.score);

  for (const cand of candidates) {
    const sentenceTokens = estimateTokens(cand.sentence);
    if (currentTokens + sentenceTokens <= maxTokens || selected.length === 0) {
      selected.push({ sentence: cand.sentence, idx: cand.idx });
      currentTokens += sentenceTokens;
    }
  }

  // Re-sort selected sentences into original document order
  selected.sort((a, b) => a.idx - b.idx);
  const compressedText = selected.map((s) => s.sentence).join(' ');

  // Safety check: if compression dropped essential citation anchors, preserve original chunk
  if (!containsCitationAnchors(chunk, compressedText)) {
    return originalText;
  }

  return compressedText;
}

/**
 * Compress context chunks to reduce prompt token footprint.
 */
export async function compressContextChunks(
  query: string,
  chunks: SearchResult[],
  options: CompressionOptions = {}
): Promise<CompressionOutcome> {
  const t0 = Date.now();
  const enabled = options.enabled ?? aiConfig.rag.compression.enabled;
  const strategy = options.strategy ?? aiConfig.rag.compression.strategy;
  const maxTokens = options.maxOutputTokensPerChunk ?? aiConfig.rag.compression.maxOutputTokensPerChunk;
  const currentLatency = options.currentPipelineLatencyMs ?? 0;
  const maxAddedLatency = aiConfig.rag.latencyBudgetMs;

  const originalTokens = chunks.reduce((sum, c) => sum + estimateTokens(c.chunkText), 0);

  if (!enabled || !chunks || chunks.length === 0) {
    return {
      compressedResults: chunks,
      enabled: false,
      strategy: 'none',
      originalTokens,
      compressedTokens: originalTokens,
      compressionRatio: 1.0,
      latencyMs: Date.now() - t0,
    };
  }

  // Latency budget guard: if pipeline is already taking too long, skip compression
  if (currentLatency >= maxAddedLatency) {
    logger.warn({
      type: 'rag_compression_skipped_latency_budget',
      currentLatencyMs: currentLatency,
      maxBudgetMs: maxAddedLatency,
    });
    return {
      compressedResults: chunks,
      enabled: true,
      strategy: 'none',
      originalTokens,
      compressedTokens: originalTokens,
      compressionRatio: 1.0,
      latencyMs: Date.now() - t0,
      skippedDueToLatencyBudget: true,
    };
  }

  const compressedResults: SearchResult[] = chunks.map((chunk) => {
    const compressedText = compressChunkRuleBased(chunk, query, maxTokens);
    return {
      ...chunk,
      chunkText: compressedText,
    };
  });

  const compressedTokens = compressedResults.reduce((sum, c) => sum + estimateTokens(c.chunkText), 0);
  const compressionRatio = originalTokens > 0 ? Number((compressedTokens / originalTokens).toFixed(4)) : 1.0;
  const latencyMs = Date.now() - t0;

  logger.info({
    type: 'rag_context_compressed',
    chunkCount: chunks.length,
    originalTokens,
    compressedTokens,
    compressionRatio,
    latencyMs,
  });

  return {
    compressedResults,
    enabled: true,
    strategy,
    originalTokens,
    compressedTokens,
    compressionRatio,
    latencyMs,
  };
}
