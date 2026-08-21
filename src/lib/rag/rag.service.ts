import { upsertVectors, queryVectors, deleteByFilter, IntegratedVectorRecord } from './client';
import { chunkDocument, chunkLegalAct, DocumentChunk, ChunkConfig } from './chunking';
import { logger } from '@/utils/logger';
import { hashString } from '@/utils/helpers';
import { redis } from '@/lib/redis/client';
import { buildPreferredActiveSourceFilter } from '@/lib/source-grounding/source-metadata';
import {
  jurisdictionCodeFromLabel,
  jurisdictionLabel,
  type JurisdictionCode,
  type JurisdictionContext,
} from '@/types/jurisdiction';
import { getCorpusVersionSnapshot, type CorpusVersionSnapshot } from '@/lib/rag/corpus-version';

const RAG_CTX_CACHE_TTL = 1800; // 30 minutes — caches Pinecone lookup, not AI answer

/**
 * Document to index
 */
export const REGULATORY_EVIDENCE_RETRIEVAL_VERSION = 'regulatory-evidence-v1';

export interface DocumentToIndex {
  id: string;
  title: string;
  content: string;
  documentType: string;
  actName?: string;
  year?: number;
  regulatoryArea?: string;
  jurisdictionCode?: JurisdictionCode;
  jurisdiction?: string;
  country?: string;
  authorityStatus?: string;
  isBinding?: boolean;
  source?: string;
  version?: string;
  effectiveDate?: Date;
  metadata?: Record<string, any>;
  framework?: string;
  officialUrl?: string;
  sourceDocumentVersionId?: string;
  indexVersion?: string;
  effectiveEndDate?: string;
  documentChecksum?: string;
}

/**
 * Search result with context
 */
export interface SearchResult {
  vectorId: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkText: string;
  jurisdictionCode?: JurisdictionCode;
  jurisdiction?: string;
  country?: string;
  section?: string;
  citation?: string;
  score: number;
  rank: number;
  authorityStatus?: string;
  isBinding?: boolean;
  source?: string;
  version?: string;
  corpusStatus?: string;
  framework?: string;
  frameworkSlug?: string;
  legalDocumentId?: string;
  officialUrl?: string;
  sourceDocumentVersionId?: string;
  indexVersion?: string;
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
  sourceLimited?: boolean;
  matchingStrategy?: 'vectorId' | 'chunkId' | 'document_section_rank' | 'document_section';
}

/**
 * Search options
 */
export interface SearchOptions {
  topK?: number;
  minScore?: number;
  filter?: Record<string, any>;
  namespace?: string;
  includeMetadata?: boolean;
  fallbackIfTooFew?: {
    minResults: number;
    relaxedFilter?: Record<string, any>;
  };
  preferActiveSources?: boolean;
  sourceIndexMode?: 'v1' | 'v2' | 'prefer-v2';
  preferV2FallbackConfig?: {
    minV2Results?: number;
    minV2TopScore?: number;
    minV2DocumentDiversity?: number;
  };
}

export interface RegulatoryEvidenceSearchOptions {
  query: string;
  jurisdictionContext: JurisdictionContext;
  topK?: number;
  minScore?: number;
  namespace?: string;
  preferActiveSources?: boolean;
  sourceIndexMode?: SearchOptions['sourceIndexMode'];
}

function andFilters(...filters: Array<Record<string, any> | undefined | null>): Record<string, any> | undefined {
  const present = filters.filter((filter): filter is Record<string, any> => !!filter && Object.keys(filter).length > 0);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { $and: present };
}

function indexVersionFilter(mode: SearchOptions['sourceIndexMode'] = 'v1', fallbackToV1 = false): Record<string, any> | undefined {
  const effectiveMode = fallbackToV1 && mode === 'prefer-v2' ? 'v1' : mode;
  if (effectiveMode === 'v2' || effectiveMode === 'prefer-v2') {
    return { indexVersion: { $eq: 'v2' } };
  }
  if (effectiveMode === 'v1') {
    return {
      $or: [
        { indexVersion: { $eq: 'v1' } },
        { indexVersion: { $exists: false } },
      ],
    };
  }
  return undefined;
}

export function buildRegulatoryEvidenceFilter(
  context: JurisdictionContext,
  sourceIndexMode?: SearchOptions['sourceIndexMode'],
): Record<string, unknown> {
  const code = context.primaryJurisdiction;
  const legacyLabel = jurisdictionLabel(code);
  const jurisdictionFilter = {
    $or: [
      { jurisdictionCode: { $eq: code } },
      { jurisdiction: { $eq: legacyLabel } },
    ],
  };
  return andFilters(jurisdictionFilter, indexVersionFilter(sourceIndexMode)) ?? jurisdictionFilter;
}

function resolveResultJurisdictionCode(metadata: {
  jurisdictionCode?: string;
  jurisdiction?: string;
  country?: string;
}): JurisdictionCode | undefined {
  if (metadata.jurisdictionCode) {
    const code = jurisdictionCodeFromLabel(metadata.jurisdictionCode);
    if (code) return code;
  }
  return jurisdictionCodeFromLabel(metadata.jurisdiction) ?? jurisdictionCodeFromLabel(metadata.country) ?? undefined;
}

/**
 * RAG Service
 * Handles document indexing and semantic search
 */
export class RAGService {
  /**
   * Index a document into the vector database
   * @param document Document to index
   * @param chunkConfig Optional chunk configuration
   */
  async indexDocument(
    document: DocumentToIndex,
    chunkConfig?: Partial<ChunkConfig>
  ): Promise<number> {
    const startTime = Date.now();

    logger.info({
      type: 'document_indexing_started',
      documentId: document.id,
      title: document.title,
      contentLength: document.content.length,
    });

    try {
      // Chunk the document
      let chunks: DocumentChunk[];
      
      if (document.actName && document.year && document.regulatoryArea) {
        // Special handling for legal acts
        chunks = chunkLegalAct(
          document.content,
          document.actName,
          document.year,
          document.regulatoryArea
        );
      } else {
        chunks = chunkDocument(document.content, chunkConfig, document.metadata);
      }

      // Create integrated vector records  -  embeddings generated by Pinecone
      const vectors: IntegratedVectorRecord[] = chunks.map((chunk) => ({
        id: `${document.id}:${chunk.index}`,
        chunk_text: chunk.text,
        documentId: document.id,
        documentTitle: document.title,
        documentType: document.documentType,
        chunkIndex: chunk.index,
        section: chunk.section,
        subsection: chunk.subsection,
        citation: chunk.citation,
        actName: document.actName,
        year: document.year,
        regulatoryArea: document.regulatoryArea,
        jurisdictionCode: document.jurisdictionCode ?? document.metadata?.jurisdictionCode,
        jurisdiction: document.jurisdiction ?? document.metadata?.jurisdiction,
        country: document.country ?? document.metadata?.country ?? document.jurisdiction,
        authorityStatus: document.authorityStatus ?? document.metadata?.authorityStatus,
        isBinding: document.isBinding ?? document.metadata?.isBinding,
        source: document.source ?? document.metadata?.source,
        version: document.version ?? document.metadata?.version,
        framework: document.framework ?? document.metadata?.framework,
        frameworkSlug: document.metadata?.frameworkSlug,
        legalDocumentId: document.metadata?.legalDocumentId ?? document.id,
        indexVersion: document.metadata?.indexVersion ?? 'v1',
        officialUrl: document.metadata?.officialUrl,
        sourceDocumentVersionId: document.metadata?.sourceDocumentVersionId,
        pageStart: chunk.metadata?.pageStart ?? document.metadata?.pageStart,
        pageEnd: chunk.metadata?.pageEnd ?? document.metadata?.pageEnd,
        sectionNumber: chunk.metadata?.sectionNumber ?? document.metadata?.sectionNumber,
        clauseNumber: chunk.metadata?.clauseNumber ?? document.metadata?.clauseNumber,
        scheduleNumber: chunk.metadata?.scheduleNumber ?? document.metadata?.scheduleNumber,
        headingPath: chunk.metadata?.headingPath ?? document.metadata?.headingPath,
        provisionId: chunk.metadata?.provisionId ?? document.metadata?.provisionId,
        contentHash: chunk.metadata?.contentHash ?? document.metadata?.contentHash,
        documentChecksum: document.metadata?.documentChecksum,
        effectiveDate: document.effectiveDate?.toISOString?.() ?? document.metadata?.effectiveDate,
        effectiveEndDate: document.metadata?.effectiveEndDate,
      }));

      // Upsert to Pinecone
      await upsertVectors(vectors);

      const duration = Date.now() - startTime;

      logger.info({
        type: 'document_indexing_complete',
        documentId: document.id,
        chunks: chunks.length,
        duration,
      });

      return chunks.length;
    } catch (error: any) {
      logger.error({
        type: 'document_indexing_error',
        documentId: document.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Index multiple documents in batch
   * @param documents Documents to index
   */
  async indexDocuments(documents: DocumentToIndex[]): Promise<void> {
    logger.info({
      type: 'batch_indexing_started',
      documentCount: documents.length,
    });

    let indexed = 0;
    let failed = 0;

    for (const document of documents) {
      try {
        await this.indexDocument(document);
        indexed++;
      } catch (error: any) {
        failed++;
        logger.error({
          type: 'batch_indexing_document_failed',
          documentId: document.id,
          error: error.message,
        });
      }
    }

    logger.info({
      type: 'batch_indexing_complete',
      indexed,
      failed,
      total: documents.length,
    });
  }

  /**
   * Search for relevant documents
   * @param query Search query
   * @param options Search options
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      topK = 10,
      minScore = 0.7,
      filter,
      namespace,
      includeMetadata: _includeMetadata = true,
      fallbackIfTooFew,
      preferActiveSources = false,
      sourceIndexMode,
    } = options;
    const baseFilter = andFilters(filter, indexVersionFilter(sourceIndexMode));
    const effectiveFilter = preferActiveSources
      ? buildPreferredActiveSourceFilter({ baseFilter })
      : baseFilter;

    const startTime = Date.now();

    logger.info({
      type: 'rag_search_started',
      query: query.substring(0, 100),
        topK,
        minScore,
        preferActiveSources,
        sourceIndexMode,
      });

    try {
      // Search Pinecone (integrated embeddings  -  query string passed directly)
      let results = await queryVectors(
        query,
        topK,
        namespace,
        effectiveFilter
      );

      if (sourceIndexMode === 'prefer-v2') {
        const fallbackConfig = {
          minV2Results: options.preferV2FallbackConfig?.minV2Results ?? 3,
          minV2TopScore: options.preferV2FallbackConfig?.minV2TopScore ?? 0.78,
          minV2DocumentDiversity: options.preferV2FallbackConfig?.minV2DocumentDiversity ?? 2,
        };
        const validResults = results.filter((result) => result.score >= minScore);
        const topScore = validResults.length > 0 ? Math.max(...validResults.map((r) => r.score)) : 0;
        const uniqueDocs = new Set(validResults.map((r) => r.metadata.documentId)).size;

        const shouldFallback = 
          validResults.length < fallbackConfig.minV2Results ||
          topScore < fallbackConfig.minV2TopScore ||
          uniqueDocs < fallbackConfig.minV2DocumentDiversity;

        if (shouldFallback) {
          const v1BaseFilter = andFilters(filter, indexVersionFilter(sourceIndexMode, true));
          const v1Filter = preferActiveSources
            ? buildPreferredActiveSourceFilter({ baseFilter: v1BaseFilter })
            : v1BaseFilter;
          logger.info({
            type: 'rag_search_v2_fallback_to_v1',
            topK,
            minScore,
            reason: {
              validResultsCount: validResults.length,
              topScore,
              uniqueDocs,
              config: fallbackConfig,
            }
          });
          results = await queryVectors(query, topK, namespace, v1Filter);
        }
      }

      const hasStrictFilter = !!effectiveFilter && Object.keys(effectiveFilter).length > 0;
      if (
        fallbackIfTooFew &&
        hasStrictFilter &&
        results.filter((result) => result.score >= minScore).length < fallbackIfTooFew.minResults
      ) {
        logger.info({
          type: 'rag_search_relaxed_filter',
          strictResultsCount: results.length,
          minResults: fallbackIfTooFew.minResults,
          hasRelaxedFilter: !!fallbackIfTooFew.relaxedFilter,
        });
        const relaxedBaseFilter = andFilters(
          fallbackIfTooFew.relaxedFilter,
          indexVersionFilter(sourceIndexMode),
        );
        const relaxedFilter = preferActiveSources
          ? buildPreferredActiveSourceFilter({ baseFilter: relaxedBaseFilter })
          : relaxedBaseFilter;
        results = await queryVectors(
          query,
          topK,
          namespace,
          relaxedFilter,
        );
      }

      // Filter by minimum score and format results
      const searchResults: SearchResult[] = results
        .filter(result => result.score >= minScore)
        .map((result, index) => ({
          vectorId: result.id,
          chunkId: result.metadata.chunkId ?? result.id,
          documentId: result.metadata.documentId,
          documentTitle: result.metadata.documentTitle,
          chunkText: result.metadata.chunk_text ?? '',
          jurisdictionCode: resolveResultJurisdictionCode(result.metadata),
          jurisdiction: result.metadata.jurisdiction,
          country: result.metadata.country,
          section: result.metadata.section,
          citation: result.metadata.citation,
          score: result.score,
          rank: index + 1,
          authorityStatus: result.metadata.authorityStatus,
          isBinding: result.metadata.isBinding,
          source: result.metadata.source,
          version: result.metadata.version,
          corpusStatus: result.metadata.corpusStatus,
          framework: result.metadata.framework,
          frameworkSlug: result.metadata.frameworkSlug,
          legalDocumentId: result.metadata.legalDocumentId,
          officialUrl: result.metadata.officialUrl,
          sourceDocumentVersionId: result.metadata.sourceDocumentVersionId,
          indexVersion: result.metadata.indexVersion,
          pageStart: result.metadata.pageStart,
          pageEnd: result.metadata.pageEnd,
          sectionNumber: result.metadata.sectionNumber,
          clauseNumber: result.metadata.clauseNumber,
          scheduleNumber: result.metadata.scheduleNumber,
          headingPath: result.metadata.headingPath,
          provisionId: result.metadata.provisionId,
          contentHash: result.metadata.contentHash,
          documentChecksum: result.metadata.documentChecksum,
          effectiveDate: result.metadata.effectiveDate,
          effectiveEndDate: result.metadata.effectiveEndDate,
        }));

      const duration = Date.now() - startTime;

      logger.info({
        type: 'rag_search_complete',
        resultsCount: searchResults.length,
        duration,
      });

      return searchResults;
    } catch (error: any) {
      logger.error({
        type: 'rag_search_error',
        query: query.substring(0, 100),
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Search with reranking for better relevance
   * @param query Search query
   * @param options Search options
   */
  async searchWithReranking(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    // Get more results initially
    const extendedOptions = {
      ...options,
      topK: (options.topK || 10) * 2,
    };

    const results = await this.search(query, extendedOptions);

    // Rerank based on multiple factors
    const reranked = results.map(result => {
      let rerankScore = result.score;

      // Boost if query terms appear in chunk text
      const queryTerms = query.toLowerCase().split(/\s+/);
      const chunkText = result.chunkText.toLowerCase();
      const termMatches = queryTerms.filter(term => chunkText.includes(term)).length;
      rerankScore += (termMatches / queryTerms.length) * 0.1;

      // Boost if chunk has citations (indicates more authoritative)
      if (result.citation) {
        rerankScore += 0.05;
      }

      // Boost if section name is relevant
      if (result.section) {
        const sectionRelevant = queryTerms.some(term =>
          result.section!.toLowerCase().includes(term)
        );
        if (sectionRelevant) {
          rerankScore += 0.05;
        }
      }

      return { ...result, score: rerankScore };
    });

    // Sort by reranked score and limit to topK
    reranked.sort((a, b) => b.score - a.score);
    const topK = options.topK || 10;
    
    return reranked.slice(0, topK).map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  async searchRegulatoryEvidence(
    options: RegulatoryEvidenceSearchOptions,
  ): Promise<SearchResult[]> {
    const {
      query,
      jurisdictionContext,
      topK = 10,
      minScore = 0.7,
      namespace,
      preferActiveSources = true,
      sourceIndexMode,
    } = options;
    const filter = buildRegulatoryEvidenceFilter(jurisdictionContext, sourceIndexMode);

    const results = await this.searchWithReranking(query, {
      topK,
      minScore,
      namespace,
      filter,
      preferActiveSources,
      sourceIndexMode,
    });

    const scopedResults = results.filter(
      (result) => result.jurisdictionCode === jurisdictionContext.primaryJurisdiction,
    );

    if (scopedResults.length !== results.length) {
      logger.warn({
        type: 'rag_regulatory_evidence_jurisdiction_mismatch_filtered',
        requestedJurisdiction: jurisdictionContext.primaryJurisdiction,
        removedCount: results.length - scopedResults.length,
        resultCount: results.length,
      });
    }

    return scopedResults.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  /**
   * Find similar chunks to a given document chunk
   * @param documentId Document ID
   * @param chunkIndex Chunk index
   * @param topK Number of similar chunks to return
   */
  async findSimilarChunks(
    documentId: string,
    chunkIndex: number,
    _topK: number = 5
  ): Promise<SearchResult[]> {
    logger.info({
      type: 'similar_chunks_search',
      documentId,
      chunkIndex,
    });

    // This would require fetching the chunk's embedding first
    // For now, we'll use a simplified approach
    // In production, you might cache chunk embeddings or fetch from Pinecone

    throw new Error('findSimilarChunks not yet implemented');
  }

  /**
   * Delete document from index
   * @param documentId Document ID
   */
  async deleteDocument(documentId: string): Promise<void> {
    logger.info({
      type: 'document_deletion_started',
      documentId,
    });

    try {
      await deleteByFilter({ documentId });

      logger.info({
        type: 'document_deletion_complete',
        documentId,
      });
    } catch (error: any) {
      logger.error({
        type: 'document_deletion_error',
        documentId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get context for AI prompt from search results
   * @param results Search results
   * @param maxChunks Maximum chunks to include
   * @param maxChars Maximum characters total
   */
  getContextForPrompt(
    results: SearchResult[],
    maxChunks: number = 5,
    maxChars: number = 4000
  ): string {
    const selectedResults = results.slice(0, maxChunks);
    let context = '';
    let totalChars = 0;

    for (const result of selectedResults) {
      const statusLabel = result.authorityStatus ?? 'IN_FORCE';
      const bindingLabel = result.isBinding === false ? 'No' : 'Yes';
      const chunkContext = `
[Document: ${result.documentTitle}]
${result.section ? `[Section: ${result.section}]` : ''}
${result.citation ? `[Citations: ${result.citation}]` : ''}
${result.source ? `[Source: ${result.source}]` : ''}
${result.version ? `[Version: ${result.version}]` : ''}
[Authority Status: ${statusLabel}]
[Binding Law: ${bindingLabel}]
${result.isBinding === false ? '[Important: This source is non-binding draft/consultation/superseded material. Label any citation to it accordingly.]' : ''}

${result.chunkText}

---
`;

      if (totalChars + chunkContext.length > maxChars) {
        break;
      }

      context += chunkContext;
      totalChars += chunkContext.length;
    }

    return context.trim();
  }

  /**
   * Extract relevant citations from search results
   * @param results Search results
   */
  extractCitations(results: SearchResult[]): string[] {
    const citations = new Set<string>();

    for (const result of results) {
      if (result.citation) {
        const citationList = result.citation.split(';').map(c => c.trim());
        citationList.forEach(c => citations.add(c));
      }
    }

    return Array.from(citations);
  }

  /**
   * Generate search summary
   * @param query Original query
   * @param results Search results
   */
  generateSearchSummary(query: string, results: SearchResult[]): {
    query: string;
    totalResults: number;
    documentsFound: string[];
    topSections: string[];
    citations: string[];
    avgScore: number;
  } {
    const documentsFound = [...new Set(results.map(r => r.documentTitle))];
    const topSections = [...new Set(
      results
        .filter(r => r.section)
        .slice(0, 5)
        .map(r => r.section!)
    )];
    const citations = this.extractCitations(results);
    const avgScore = results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0;

    return {
      query,
      totalResults: results.length,
      documentsFound,
      topSections,
      citations,
      avgScore,
    };
  }
}

/**
 * Export singleton RAG service instance
 */
export const ragService = new RAGService();

/**
 * Helper: Search and get context for AI
 *
 * Retrieval results are cached in Redis for RAG_CTX_CACHE_TTL seconds to
 * avoid hitting Pinecone on every grounded query for the same question.
 * Only the Pinecone result is cached — the AI answer is never cached when
 * ragContext is present, keeping answers fresh as the corpus evolves.
 */
export async function searchAndGetContext(
  query: string,
  options: SearchOptions = {}
): Promise<{
  context: string;
  results: SearchResult[];
  citations: string[];
}> {
  const { topK = 10, minScore = 0.7 } = options;
  const cacheKey = `sheriabot:rag:ctx:v3:${hashString(JSON.stringify({
    query,
    topK,
    minScore,
    filter: options.filter ?? null,
    namespace: options.namespace ?? null,
    preferActiveSources: options.preferActiveSources ?? false,
    sourceIndexMode: options.sourceIndexMode ?? null,
  }))}`;

  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { context: string; results: SearchResult[]; citations: string[] };
      logger.debug({ type: 'rag_ctx_cache_hit', cacheKey });
      return parsed;
    }
  } catch {
    // Cache read failure is non-fatal — proceed to Pinecone
  }

  const results = await ragService.searchWithReranking(query, options);
  const context = ragService.getContextForPrompt(results);
  const citations = ragService.extractCitations(results);
  const payload = { context, results, citations };

  try {
    await redis.set(cacheKey, JSON.stringify(payload), { ex: RAG_CTX_CACHE_TTL });
    logger.debug({ type: 'rag_ctx_cache_set', cacheKey, ttl: RAG_CTX_CACHE_TTL });
  } catch {
    // Cache write failure is non-fatal
  }

  return payload;
}

export async function searchAndGetRegulatoryEvidenceContext(
  options: RegulatoryEvidenceSearchOptions,
): Promise<{
  context: string;
  results: SearchResult[];
  citations: string[];
  corpusVersions: CorpusVersionSnapshot;
  retrievalVersion: string;
}> {
  const {
    query,
    jurisdictionContext,
    topK = 10,
    minScore = 0.7,
    namespace,
    preferActiveSources = true,
    sourceIndexMode,
  } = options;
  const normalizedQuestion = query.trim().replace(/\s+/g, ' ');
  const corpusVersions = await getCorpusVersionSnapshot(jurisdictionContext);
  const cacheKey = `sheriabot:rag:ctx:v4:${hashString(JSON.stringify({
    normalizedQuestion,
    mode: jurisdictionContext.mode,
    jurisdictions: [...jurisdictionContext.jurisdictions],
    primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
    corpusVersions,
    retrievalVersion: REGULATORY_EVIDENCE_RETRIEVAL_VERSION,
    topK,
    minScore,
    namespace: namespace ?? null,
    preferActiveSources,
    sourceIndexMode: sourceIndexMode ?? null,
    jurisdictionFilterMode: 'jurisdictionCode-or-legacy-label',
  }))}`;

  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as {
        context: string;
        results: SearchResult[];
        citations: string[];
        corpusVersions: CorpusVersionSnapshot;
        retrievalVersion: string;
      };
      logger.debug({
        type: 'rag_regulatory_evidence_cache_hit',
        cacheKey,
        jurisdiction: jurisdictionContext.primaryJurisdiction,
      });
      return parsed;
    }
  } catch {
    // Cache read failure is non-fatal.
  }

  const results = await ragService.searchRegulatoryEvidence({
    query,
    jurisdictionContext,
    topK,
    minScore,
    namespace,
    preferActiveSources,
    sourceIndexMode,
  });
  const context = ragService.getContextForPrompt(results);
  const citations = ragService.extractCitations(results);
  const payload = {
    context,
    results,
    citations,
    corpusVersions,
    retrievalVersion: REGULATORY_EVIDENCE_RETRIEVAL_VERSION,
  };

  try {
    await redis.set(cacheKey, JSON.stringify(payload), { ex: RAG_CTX_CACHE_TTL });
    logger.debug({
      type: 'rag_regulatory_evidence_cache_set',
      cacheKey,
      ttl: RAG_CTX_CACHE_TTL,
      jurisdiction: jurisdictionContext.primaryJurisdiction,
    });
  } catch {
    // Cache write failure is non-fatal.
  }

  return payload;
}

/**
 * Helper: Index Kenyan legal act
 */
export async function indexKenyanLegalAct(
  actName: string,
  year: number,
  content: string,
  regulatoryArea: string
): Promise<number> {
  const documentId = hashString(`${actName}-${year}`);

  return await ragService.indexDocument({
    id: documentId,
    title: `${actName} ${year}`,
    content,
    documentType: 'LEGAL_ACT',
    actName,
    year,
    regulatoryArea,
    framework: actName,
  });
}
