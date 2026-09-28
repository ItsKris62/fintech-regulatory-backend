import { logger } from '@/utils/logger';
import { aiConfig } from '@/config/ai.config';
import { executeWithBreaker } from '@/lib/circuit-breaker/circuit-breaker.service';
import type { SearchResult } from './rag.service';

export interface RerankerOptions {
  provider?: 'heuristic' | 'cohere' | 'local';
  topN?: number;
  timeoutMs?: number;
  apiKey?: string;
  model?: string;
}

export interface ScoreDistribution {
  min: number;
  max: number;
  avg: number;
}

export interface RerankOutcome {
  results: SearchResult[];
  provider: 'heuristic' | 'cohere' | 'local';
  latencyMs: number;
  scoreDistribution: ScoreDistribution;
  fallbackTriggered: boolean;
  fallbackReason?: string;
}

/**
 * Execute heuristic multi-factor reranking based on query term frequency,
 * citation presence, and section title matching.
 */
export function heuristicRerank(
  query: string,
  chunks: SearchResult[],
  topN: number = 8
): SearchResult[] {
  if (!chunks || chunks.length === 0) return [];

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const reranked = chunks.map((result) => {
    let rerankScore = result.score;

    if (queryTerms.length > 0) {
      const chunkText = result.chunkText.toLowerCase();
      const termMatches = queryTerms.filter((term) => chunkText.includes(term)).length;
      rerankScore += (termMatches / queryTerms.length) * 0.1;
    }

    if (result.citation) {
      rerankScore += 0.05;
    }

    if (result.section && queryTerms.length > 0) {
      const sectionLower = result.section.toLowerCase();
      const sectionRelevant = queryTerms.some((term) => sectionLower.includes(term));
      if (sectionRelevant) {
        rerankScore += 0.05;
      }
    }

    return { ...result, score: rerankScore };
  });

  reranked.sort((a, b) => b.score - a.score);

  return reranked.slice(0, topN).map((result, index) => ({
    ...result,
    rank: index + 1,
  }));
}

/**
 * Compute statistical score distribution for telemetry.
 */
function computeScoreDistribution(results: SearchResult[]): ScoreDistribution {
  if (!results || results.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }
  const scores = results.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const sum = scores.reduce((acc, val) => acc + val, 0);
  const avg = Number((sum / scores.length).toFixed(4));
  return { min, max, avg };
}

/**
 * Outbound Cohere Rerank API integration
 */
async function callCohereRerank(
  query: string,
  chunks: SearchResult[],
  topN: number,
  options: { apiKey: string; model: string; timeoutMs: number }
): Promise<SearchResult[]> {
  const documents = chunks.map((c) => c.chunkText);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
        'X-Client-Name': 'SheriaBot-RAG-Reranker',
      },
      body: JSON.stringify({
        model: options.model,
        query,
        documents,
        top_n: topN,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Cohere Rerank API returned HTTP ${res.status}: ${errorText.substring(0, 150)}`);
    }

    const data = await res.json();
    const rankedResults: SearchResult[] = [];

    if (Array.isArray(data.results)) {
      for (let i = 0; i < data.results.length; i++) {
        const item = data.results[i];
        const originalIndex = item.index;
        if (originalIndex !== undefined && chunks[originalIndex]) {
          const original = chunks[originalIndex];
          rankedResults.push({
            ...original,
            score: typeof item.relevance_score === 'number' ? item.relevance_score : original.score,
            rank: i + 1,
          });
        }
      }
    }

    return rankedResults.length > 0 ? rankedResults : chunks.slice(0, topN);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Rerank chunks using configured provider with circuit breaker, timeout, and heuristic fallback.
 */
export async function rerankChunks(
  query: string,
  chunks: SearchResult[],
  options: RerankerOptions = {}
): Promise<RerankOutcome> {
  const t0 = Date.now();
  const provider = options.provider || aiConfig.rag.reranker.provider;
  const topN = options.topN || aiConfig.rag.reranker.topN || 8;
  const timeoutMs = options.timeoutMs || aiConfig.rag.reranker.timeoutMs || 1500;
  const apiKey = options.apiKey || aiConfig.rag.reranker.apiKey;
  const model = options.model || aiConfig.rag.reranker.model;

  if (!chunks || chunks.length === 0) {
    return {
      results: [],
      provider: 'heuristic',
      latencyMs: 0,
      scoreDistribution: { min: 0, max: 0, avg: 0 },
      fallbackTriggered: false,
    };
  }

  // 1. Heuristic Provider (fast path)
  if (provider === 'heuristic' || !apiKey && provider === 'cohere') {
    const results = heuristicRerank(query, chunks, topN);
    const latencyMs = Date.now() - t0;
    return {
      results,
      provider: 'heuristic',
      latencyMs,
      scoreDistribution: computeScoreDistribution(results),
      fallbackTriggered: provider === 'cohere',
      fallbackReason: provider === 'cohere' ? 'cohere_api_key_missing' : undefined,
    };
  }

  // 2. Cohere Rerank Provider
  if (provider === 'cohere') {
    try {
      const results = await executeWithBreaker('cohere', () =>
        callCohereRerank(query, chunks, topN, { apiKey, model, timeoutMs })
      );
      const latencyMs = Date.now() - t0;
      return {
        results,
        provider: 'cohere',
        latencyMs,
        scoreDistribution: computeScoreDistribution(results),
        fallbackTriggered: false,
      };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError' || err?.message?.includes('timeout') || err?.message?.includes('aborted');
      const reason = isTimeout ? 'cohere_timeout' : (err?.message || 'cohere_error');
      
      logger.warn({
        type: 'rag_reranker_fallback_triggered',
        requestedProvider: 'cohere',
        fallbackProvider: 'heuristic',
        reason,
        queryPreview: query.substring(0, 60),
      });

      const fallbackResults = heuristicRerank(query, chunks, topN);
      const latencyMs = Date.now() - t0;
      return {
        results: fallbackResults,
        provider: 'heuristic',
        latencyMs,
        scoreDistribution: computeScoreDistribution(fallbackResults),
        fallbackTriggered: true,
        fallbackReason: reason,
      };
    }
  }

  // 3. Local cross-encoder or other provider fallback
  const results = heuristicRerank(query, chunks, topN);
  const latencyMs = Date.now() - t0;
  return {
    results,
    provider: 'local',
    latencyMs,
    scoreDistribution: computeScoreDistribution(results),
    fallbackTriggered: false,
  };
}
