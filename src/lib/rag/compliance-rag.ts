/**
 * Enhanced Compliance RAG Pipeline
 *
 * Wraps the existing RAG search + AI compliance query into a single function
 * that grounds Claude's answers in actual retrieved regulatory documents.
 *
 * Key features added on top of the base compliance query:
 *   - Semantic search over the Pinecone regulatory corpus before calling Claude
 *   - Auto-detection of metadata filters (category, jurisdiction) from the query
 *   - Source-attributed context chunks so Claude can cite specific documents
 *   - A `sources` array in the result: { documentTitle, section, relevanceScore }
 *   - Instructions to Claude to flag when info falls outside the retrieved corpus
 *
 * Usage:
 *   import { enhancedComplianceQuery } from '@/lib/rag/compliance-rag';
 *
 *   const result = await enhancedComplianceQuery({
 *     question: 'What personal data obligations apply to mobile lenders in Kenya?',
 *   });
 *   // result.sources -> [{ documentTitle, section, relevanceScore }, ...]
 *
 * Integration note:
 *   The compliance module's existing `aiService.answerComplianceQuery()` is
 *   called unchanged  -  the RAG context is injected via the `context` parameter
 *   that is already part of `ComplianceQueryParams`. No existing files are
 *   modified by this module.
 */

import { ragService, type SearchOptions, type SearchResult } from './rag.service';
import { aiService, type ComplianceQueryResult } from '@/lib/ai/ai.service';
import { type ComplianceQueryParams } from '@/lib/ai/prompts/compliance-query';
import { logger } from '@/utils/logger';

// ============================================================================
// Public types
// ============================================================================

export interface ComplianceSource {
  documentTitle: string;
  section?: string;
  relevanceScore: number;
  authorityStatus?: string;
  isBinding?: boolean;
  source?: string;
  version?: string;
  /** Whether this source was confirmed from the RAG regulatory corpus. */
  verified: boolean;
  /** Verification status: "verified" = confirmed in corpus, "unverified" = not found, "not_checked" = verification not attempted. */
  verificationStatus: 'verified' | 'unverified' | 'not_checked';
}

export interface EnhancedComplianceQueryOptions {
  /** Maximum number of RAG chunks to retrieve (default: 8) */
  topK?: number;
  /** Minimum relevance score (0-1) to include a chunk (default: 0.65) */
  minScore?: number;
  /**
   * Override category filter (e.g. 'DATA_PROTECTION').
   * If omitted and autoDetectFilters is true, inferred from query keywords.
   */
  filterCategory?: string;
  /**
   * Override jurisdiction filter (e.g. 'Kenya', 'EU', 'International').
   * If omitted and autoDetectFilters is true, inferred from query keywords.
   */
  filterJurisdiction?: string;
  /** Automatically infer Pinecone metadata filters from query (default: true) */
  autoDetectFilters?: boolean;
  /** Organisation type forwarded to the AI compliance prompt */
  organizationType?: string;
  /** Industry/sector forwarded to the AI compliance prompt */
  industry?: string;
  /** Urgency level forwarded to the AI compliance prompt */
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface EnhancedComplianceQueryResult extends ComplianceQueryResult {
  /** Document sources that were retrieved and used as context */
  sources: ComplianceSource[];
  /** Summary of the RAG search that produced the context */
  ragContext: {
    documentsFound: string[];
    chunksRetrieved: number;
    avgRelevanceScore: number;
    filtersApplied: Record<string, string>;
  };
}

// ============================================================================
// Metadata filter auto-detection
// ============================================================================

/**
 * Build Pinecone metadata filters from query text.
 * Returns undefined when no strong signals are detected (search runs without
 * filters, returning results from the full corpus).
 */
function detectFilters(
  query: string,
  override: { filterCategory?: string; filterJurisdiction?: string }
): Record<string, any> | undefined {
  const filters: Record<string, string> = {};

  // Explicit overrides take priority
  if (override.filterCategory) filters['category'] = override.filterCategory;
  if (override.filterJurisdiction) filters['jurisdiction'] = override.filterJurisdiction;

  // Skip auto-detection when both are already set
  if (filters['category'] && filters['jurisdiction']) {
    return buildPineconeFilter(filters);
  }

  const lower = query.toLowerCase();

  // -- Jurisdiction detection ----------------------------------------------
  if (!filters['jurisdiction']) {
    if (
      lower.includes('gdpr') ||
      lower.includes('european union') ||
      /\beu\b/.test(lower)
    ) {
      filters['jurisdiction'] = 'EU';
    } else if (
      lower.includes('kenya') ||
      lower.includes('kenyan') ||
      lower.includes(' cbk ') ||
      lower.includes('central bank of kenya') ||
      lower.includes('odpc') ||
      lower.includes('mpesa') ||
      lower.includes('m-pesa') ||
      lower.includes('nairobi') ||
      lower.includes('ksh') ||
      lower.includes('shilling')
    ) {
      filters['jurisdiction'] = 'Kenya';
    }
  }

  // -- Category detection -------------------------------------------------
  if (!filters['category']) {
    if (
      lower.includes('data protection') ||
      lower.includes('personal data') ||
      lower.includes('privacy') ||
      lower.includes('gdpr') ||
      lower.includes('data subject') ||
      lower.includes('data controller') ||
      lower.includes('data processor')
    ) {
      filters['category'] = 'DATA_PROTECTION';
    } else if (
      lower.includes('aml') ||
      lower.includes('anti-money laundering') ||
      lower.includes('counter-terrorism financing') ||
      lower.includes('cft') ||
      lower.includes('suspicious transaction') ||
      lower.includes('financial reporting centre') ||
      lower.includes('frc') ||
      lower.includes('kyc') ||
      lower.includes('know your customer')
    ) {
      filters['category'] = 'AML_CFT';
    } else if (
      lower.includes('payment') ||
      lower.includes('mobile money') ||
      lower.includes('mpesa') ||
      lower.includes('m-pesa') ||
      lower.includes('payment system') ||
      lower.includes('nps act')
    ) {
      filters['category'] = 'PAYMENT_SYSTEMS';
    } else if (
      lower.includes('cybersecurity') ||
      lower.includes('cyber security') ||
      lower.includes('cybercrime') ||
      lower.includes('data breach') ||
      lower.includes('information security') ||
      lower.includes('computer misuse')
    ) {
      filters['category'] = 'CYBERSECURITY';
    } else if (
      lower.includes('digital lending') ||
      lower.includes('digital credit') ||
      lower.includes('sandbox') ||
      lower.includes('fintech') ||
      lower.includes('insurtech') ||
      lower.includes('cma ') ||
      lower.includes('ira guideline') ||
      lower.includes('cbk guideline')
    ) {
      filters['category'] = 'FINTECH_REGULATION';
    } else if (
      lower.includes('nist') ||
      lower.includes('iso 27001') ||
      lower.includes('pci dss') ||
      lower.includes('iso27001') ||
      lower.includes('international standard')
    ) {
      filters['category'] = 'INTERNATIONAL_STANDARD';
    }
  }

  return Object.keys(filters).length > 0 ? buildPineconeFilter(filters) : undefined;
}

/**
 * Convert a plain key->value map into Pinecone filter syntax.
 * Single key: { "field": { "$eq": "value" } }
 * Multiple keys: { "$and": [{ "field1": { "$eq": "v1" } }, ...] }
 */
function buildPineconeFilter(
  fields: Record<string, string>
): Record<string, any> {
  const conditions = Object.entries(fields).map(([key, value]) => ({
    [key]: { $eq: value },
  }));

  if (conditions.length === 1) {
    return conditions[0];
  }

  return { $and: conditions };
}

// ============================================================================
// Context formatting
// ============================================================================

/**
 * Format retrieved search results into a rich context string for Claude.
 * Each chunk is prefixed with document title + section for easy attribution.
 * Appends instructions telling Claude how to use the provided context.
 */
function formatRagContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const chunks = results.map((r, i) => {
    const authorityStatus = r.authorityStatus ?? 'IN_FORCE';
    const isNonBinding = r.isBinding === false;
    const lines: string[] = [];
    lines.push(`SOURCE ${i + 1}: ${r.documentTitle}`);
    if (r.section) lines.push(`Section: ${r.section}`);
    if (r.citation) lines.push(`Citations: ${r.citation}`);
    if (r.source) lines.push(`Source: ${r.source}`);
    if (r.version) lines.push(`Version: ${r.version}`);
    lines.push(`Authority Status: ${authorityStatus}`);
    lines.push(`Binding Law: ${isNonBinding ? 'No' : 'Yes'}`);
    if (isNonBinding) {
      lines.push('Important: This is non-binding draft/consultation/superseded material. Any citation to it must be labelled accordingly.');
    }
    lines.push(`Relevance: ${(r.score * 100).toFixed(0)}%`);
    lines.push('');
    lines.push(r.chunkText);
    return lines.join('\n');
  });

  return `**RETRIEVED REGULATORY CONTEXT:**
The following excerpts from Kenya's regulatory corpus and international standards are relevant to this query. Use them as your primary reference where applicable.

${chunks.join('\n\n---\n\n')}

---
**INSTRUCTIONS FOR USING THE ABOVE CONTEXT:**
- Cite each source you reference as: "According to [Document Title], [Section]..."
- If your answer draws from multiple sources, note each one explicitly
- If a source has Authority Status DRAFT, CONSULTATION, or SUPERSEDED, clearly label the citation as non-binding and do not describe it as current binding law
- If the retrieved context does not fully address the query, state this clearly and supplement with your broader knowledge of Kenyan law
- If the query is entirely outside the scope of the retrieved documents, say so`;
}

// ============================================================================
// Enhanced compliance query
// ============================================================================

/**
 * Run a compliance query grounded in the regulatory document corpus.
 *
 * @param question   The compliance question to answer
 * @param options    Optional search and prompt configuration
 */
export async function enhancedComplianceQuery(
  question: string,
  options: EnhancedComplianceQueryOptions = {}
): Promise<EnhancedComplianceQueryResult> {
  const {
    topK = 8,
    minScore = 0.65,
    filterCategory,
    filterJurisdiction,
    autoDetectFilters = true,
    organizationType,
    industry,
    urgency,
  } = options;

  const startTime = Date.now();

  logger.info({
    type: 'enhanced_compliance_query_started',
    question: question.substring(0, 100),
    topK,
    minScore,
    filterCategory,
    filterJurisdiction,
    autoDetectFilters,
  });

  // -- Step 1: Determine Pinecone metadata filters ----------------------------
  let pineconeFilter: Record<string, any> | undefined;
  const filtersApplied: Record<string, string> = {};

  if (autoDetectFilters || filterCategory || filterJurisdiction) {
    pineconeFilter = detectFilters(question, { filterCategory, filterJurisdiction });

    if (pineconeFilter) {
      // Extract readable filter description for logging / result
      const flattenFilter = (f: Record<string, any>): Record<string, string> => {
        const out: Record<string, string> = {};
        if (f.$and) {
          for (const cond of f.$and as Record<string, any>[]) {
            Object.assign(out, flattenFilter(cond));
          }
        } else {
          for (const [key, expr] of Object.entries(f)) {
            if (typeof expr === 'object' && '$eq' in expr) {
              out[key] = String(expr['$eq']);
            }
          }
        }
        return out;
      };
      Object.assign(filtersApplied, flattenFilter(pineconeFilter));
    }
  }

  logger.info({
    type: 'enhanced_compliance_rag_search',
    filtersApplied,
    topK,
    minScore,
  });

  // -- Step 2: Semantic search ------------------------------------------------
  const searchOptions: SearchOptions = {
    topK,
    minScore,
    filter: pineconeFilter,
  };

  const searchResults = await ragService.searchWithReranking(question, searchOptions);

  logger.info({
    type: 'enhanced_compliance_rag_results',
    chunksRetrieved: searchResults.length,
    documentsFound: [...new Set(searchResults.map(r => r.documentTitle))].length,
  });

  // -- Step 3: Format context -------------------------------------------------
  const ragContextString = formatRagContext(searchResults);

  const avgRelevanceScore =
    searchResults.length > 0
      ? searchResults.reduce((sum, r) => sum + r.score, 0) / searchResults.length
      : 0;

  // -- Step 4: Call AI compliance query with RAG context ---------------------
  const complianceParams: ComplianceQueryParams = {
    question,
    organizationType,
    industry,
    urgency,
    context: ragContextString || undefined,
  };

  const aiResult = await aiService.answerComplianceQuery(complianceParams);

  // -- Step 5: Build sources array -------------------------------------------
  const sources: ComplianceSource[] = searchResults.map(r => ({
    documentTitle: r.documentTitle,
    section: r.section,
    relevanceScore: parseFloat(r.score.toFixed(4)),
    authorityStatus: r.authorityStatus,
    isBinding: r.isBinding,
    source: r.source,
    version: r.version,
    verified: true,
    verificationStatus: 'verified' as const,
  }));

  const documentsFound = [...new Set(searchResults.map(r => r.documentTitle))];

  const duration = Date.now() - startTime;

  logger.info({
    type: 'enhanced_compliance_query_complete',
    question: question.substring(0, 100),
    chunksRetrieved: searchResults.length,
    documentsFound: documentsFound.length,
    filtersApplied,
    durationMs: duration,
    cost: aiResult.cost,
  });

  return {
    ...aiResult,
    sources,
    ragContext: {
      documentsFound,
      chunksRetrieved: searchResults.length,
      avgRelevanceScore: parseFloat(avgRelevanceScore.toFixed(4)),
      filtersApplied,
    },
  };
}

/**
 * Run a quick compliance check grounded in the regulatory corpus.
 * Uses a smaller topK and higher minScore for speed.
 */
export async function enhancedQuickComplianceCheck(
  scenario: string,
  options: Pick<EnhancedComplianceQueryOptions, 'filterCategory' | 'filterJurisdiction'> = {}
): Promise<{ answer: string; sources: ComplianceSource[] }> {
  const result = await enhancedComplianceQuery(scenario, {
    topK: 4,
    minScore: 0.70,
    ...options,
    urgency: 'HIGH',
  });

  return {
    answer: result.content,
    sources: result.sources,
  };
}
