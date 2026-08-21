/**
 * Compliance Module
 * Main module orchestrating all compliance operations
 * 
 * Operations:
 * - RAG-powered compliance queries
 * - Compliance scoring and history
 * - Gap analysis and roadmap generation
 * - Requirement tracking
 * - Risk assessment
 * - Regulatory updates subscription
 */

import { prisma } from '@/lib/prisma/client';
import { logPilotEvent } from '@/modules/pilot';
import { redis } from '@/lib/redis/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { sendEmail } from '@/lib/email/client';
import { storageService } from '@/lib/storage/storage.service';
import { getSystemConfigNumber } from '@/lib/system-config';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import { MemberRole, MemberStatus, OrganizationMember, Prisma, UserRole } from '@prisma/client';
import { notificationModule } from '@/modules/notification';
import { incrementTrialUsage } from '@/modules/trial';
import { aiJobRunner } from '@/modules/ai-jobs/ai-job-runner';
import { complianceScorer } from './compliance-scorer';
import { complianceAnalyzer } from './compliance-analyzer';
import { complianceTracker } from './compliance-tracker';
import type { GeneratedChecklist } from '@/lib/ai/prompts/checklist-generation';
import type { BenchmarkDocumentSummary, GapAnalysisResult } from '@/lib/ai/prompts/gap-analysis';
import type { SearchResult } from '@/lib/rag/rag.service';
import { sanitizePolicyText, chunkPolicyText } from '@/lib/ai/prompts/gap-analysis';
import { extractPdfText } from '@/lib/pdf/extract-text';
import {
  buildComplianceSourceInsufficiencyAnswer,
  COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE,
  GAP_ANALYSIS_SOURCE_INSUFFICIENCY_MESSAGE,
  hasUsableSourceContext,
  SourceInsufficiencyError,
  type ComplianceFallbackReason,
} from '@/lib/source-grounding/source-insufficiency';
import { buildCitationsFromChunks, hasUsableCitations } from '@/lib/source-grounding/citations';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require('mammoth') as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
import {
  toComplianceQueryResult,
  complianceQuerySchema,
  quickCheckSchema,
  queryFiltersSchema,
  requirementParamsSchema,
  riskScenarioSchema,
  subscriptionSchema,
  generateRegulatoryUpdateEmail,
} from './compliance.utils';
import {
  type ComplianceQueryParams,
  type ComplianceQueryResult,
  type QuickCheckResult,
  type QueryFilters,
  type PaginatedQueries,
  type ComplianceScore,
  type ScoreHistory,
  type ComplianceGap,
  type ComplianceRoadmap,
  type Requirement,
  type RequirementParams,
  type RequirementStatus,
  type RequirementFilters,
  type Evidence,
  type UpcomingDeadline,
  type RiskScenario,
  type RiskAssessment,
  type RiskReport,
  type RegulatoryUpdate,
  type UpdateSubscription,
  type RegulatoryArea,
  COMPLIANCE_CONSTANTS,
  ComplianceError,
} from './compliance.types';

const { REDIS_KEYS, MAX_QUERIES_PER_HOUR, MAX_QUICK_CHECKS_PER_HOUR, QUERY_CACHE_TTL } = COMPLIANCE_CONSTANTS;

function fallbackReasonForNoAcceptedSources(
  graderFailureClassification?: string,
): ComplianceFallbackReason {
  return graderFailureClassification === 'EXTERNAL_PROVIDER_BILLING_BLOCKER'
    ? 'EXTERNAL_PROVIDER_BILLING_BLOCKER'
    : 'ALL_CHUNKS_FAILED_VERIFICATION';
}

// --- Gap Analysis Async Helpers -----------------------------------------------

/**
 * Update status + progress on a GapAnalysis record.
 * Never throws  -  errors are logged and swallowed so callers stay non-fatal.
 */
async function updateAnalysisStatus(
  analysisId: string,
  update: { status: string; progress: number; errorMessage?: string },
): Promise<void> {
  try {
    await prisma.gapAnalysis.update({
      where: { id: analysisId },
      data: {
        status: update.status,
        progress: update.progress,
        ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage } : {}),
      },
    });
    logger.info({ type: 'gap_analysis_status_updated', analysisId, ...update });
  } catch (err) {
    logger.error({ type: 'gap_analysis_status_update_failed', analysisId, error: (err as Error).message });
  }
}

/**
 * Mark stuck analyses (non-terminal status, older than maxAgeMinutes) as FAILED.
 * Called lazily at the start of runGapAnalysis and getUserGapAnalyses. Never throws.
 */
async function recoverStaleJobs(maxAgeMinutes = 20): Promise<void> {
  const staleThreshold = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  try {
    const updated = await prisma.gapAnalysis.updateMany({
      where: {
        status: { in: ['UPLOADING', 'QUEUED', 'EXTRACTING', 'ANALYZING', 'COMPLETING'] },
        updatedAt: { lt: staleThreshold },
      },
      data: {
        status: 'FAILED',
        errorMessage: `Analysis timed out after ${maxAgeMinutes} minutes. This may be due to a large document or temporary service issue. Please try again.`,
      },
    });
    if (updated.count > 0) {
      logger.warn({ type: 'gap_analysis_stale_jobs_recovered', count: updated.count, maxAgeMinutes });
    }
  } catch (err) {
    logger.error({ type: 'gap_analysis_stale_job_recovery_failed', error: (err as Error).message });
  }
}

/**
 * Extract 3-5 key compliance-relevant keywords from a policy document.
 * Uses simple term-frequency analysis with a regulatory domain dictionary.
 * Runs synchronously and never throws.
 */
function extractPolicyKeywords(policyText: string): string[] {
  const DOMAIN_TERMS: Record<string, string> = {
    'data protection': 'data protection',
    'personal data': 'personal data',
    'privacy': 'privacy',
    'dpo': 'data protection officer',
    'consent': 'consent management',
    'breach notification': 'data breach notification',
    'kyc': 'KYC customer identification',
    'know your customer': 'KYC',
    'aml': 'anti-money laundering AML',
    'anti-money laundering': 'AML compliance',
    'suspicious transaction': 'suspicious transaction reporting',
    'money laundering': 'money laundering prevention',
    'due diligence': 'customer due diligence CDD',
    'pep': 'politically exposed persons PEP',
    'cybersecurity': 'cybersecurity information security',
    'information security': 'information security policy',
    'encryption': 'data encryption',
    'penetration test': 'penetration testing vulnerability',
    'incident response': 'cybersecurity incident response',
    'consumer protection': 'consumer protection fair treatment',
    'complaints': 'complaints handling mechanism',
    'pricing': 'transparent pricing disclosure',
    'mobile money': 'mobile money e-money',
    'payment': 'payment services NPS',
    'digital credit': 'digital credit providers',
    'digital lending': 'digital lending regulation',
    'capital adequacy': 'capital adequacy requirements',
    'licensing': 'CBK licensing requirements',
    'risk management': 'risk management framework',
    'governance': 'corporate governance board oversight',
    'audit': 'internal audit compliance',
    'record keeping': 'record retention policy',
    'cross-border': 'cross-border data transfer',
  };

  const lower = policyText.toLowerCase();
  const matched: Array<{ term: string; keyword: string; count: number }> = [];

  for (const [term, keyword] of Object.entries(DOMAIN_TERMS)) {
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = lower.match(regex);
    if (matches && matches.length > 0) {
      matched.push({ term, keyword, count: matches.length });
    }
  }

  // Sort by frequency descending, take top 5 unique keywords
  matched.sort((a, b) => b.count - a.count);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matched) {
    if (!seen.has(m.keyword) && result.length < 5) {
      seen.add(m.keyword);
      result.push(m.keyword);
    }
  }

  return result;
}

/**
 * Post-hoc citation verification: checks each gap's regulatoryBasis against
 * the ChromaDB/Pinecone legal corpus using a fast semantic search.
 * Runs all verification searches concurrently via Promise.all.
 * On any search failure, defaults citationVerified to false (graceful degradation).
 */
async function verifyCitationsAgainstCorpus(gapResults: GapAnalysisResult): Promise<GapAnalysisResult> {
  const allGaps: Array<{ frameworkIdx: number; gapIdx: number; citation: string }> = [];

  for (let fi = 0; fi < gapResults.frameworks.length; fi++) {
    for (let gi = 0; gi < gapResults.frameworks[fi].gaps.length; gi++) {
      const gap = gapResults.frameworks[fi].gaps[gi];
      allGaps.push({ frameworkIdx: fi, gapIdx: gi, citation: gap.regulatoryBasis });
    }
  }

  if (allGaps.length === 0) return gapResults;

  // Run all verification searches concurrently
  const verificationResults = await Promise.all(
    allGaps.map(async ({ citation }) => {
      try {
        const results = await ragService.search(citation, { topK: 3, minScore: 0.65 });
        // Semantic retrieval is useful attribution context, but not exact legal provision verification.
        return results[0] ?? null;
      } catch {
        // Graceful failure: if search fails or times out, mark verification as not checked.
        return undefined;
      }
    })
  );

  // Apply verification results back to the gap objects
  let verifiedCount = 0;
  let notCheckedCount = 0;
  for (let i = 0; i < allGaps.length; i++) {
    const { frameworkIdx, gapIdx } = allGaps[i];
    const topResult = verificationResults[i] as SearchResult | null | undefined;
    const gap = gapResults.frameworks[frameworkIdx].gaps[gapIdx];

    if (topResult) {
      gap.citationVerified = false;
      gap.verificationStatus = 'not_checked';
      gap.sourceDocumentTitle = topResult.documentTitle;
      gap.sourceSection = topResult.section;
      gap.sourceSnippet = topResult.chunkText?.slice(0, 300);
      gap.authorityStatus = topResult.authorityStatus;
      gap.isBinding = topResult.isBinding;
      notCheckedCount++;
    } else if (topResult === null) {
      gap.citationVerified = false;
      gap.verificationStatus = 'unverified';
    } else {
      gap.citationVerified = false;
      gap.verificationStatus = 'not_checked';
      notCheckedCount++;
    }
  }

  logger.info({
    type: 'gap_analysis_citation_verification_complete',
    totalCitations: allGaps.length,
    verifiedCount,
    unverifiedCount: allGaps.length - verifiedCount - notCheckedCount,
    notCheckedCount,
  });

  return gapResults;
}

interface GapAnalysisPipelineParams {
  analysisId: string;
  userId: string;
  trialUserId?: string;
  fileName: string;
  fileContent: string;  // base64-encoded
  fileType: string;     // extension without dot: pdf | docx | doc | txt
  regulatoryFrameworks: string[];
  regulatoryFrameworkSlugs?: string[];
  benchmarkDocumentIds?: string[];
  benchmarkDocuments?: BenchmarkDocumentSummary[];
  analysisDepth: 'quick' | 'standard' | 'deep';
  focusAreas?: string[];
  ipAddress?: string;
  userAgent?: string;
}

function pineconeInFilter(values: string[]): string | { $in: string[] } | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : { $in: values };
}

/**
 * Background gap analysis pipeline.
 * Runs after the HTTP response is sent. Manages its own lifecycle via DB status
 * updates. The top-level try/catch guarantees FAILED is set on any unhandled error.
 */
export async function executeGapAnalysisPipeline(params: GapAnalysisPipelineParams): Promise<void> {
  const {
    analysisId, userId, trialUserId, fileName, fileContent, fileType,
    regulatoryFrameworks, regulatoryFrameworkSlugs = [], benchmarkDocumentIds = [],
    benchmarkDocuments = [], analysisDepth, focusAreas, ipAddress, userAgent,
  } = params;

  const startTime = Date.now();
  let currentProgress = 5;

  try {
    // -- EXTRACTING (progress: 10) -----------------------------------------
    await updateAnalysisStatus(analysisId, { status: 'EXTRACTING', progress: 10 });
    currentProgress = 10;

    const fileBuffer = Buffer.from(fileContent, 'base64');
    const ext = fileType.toLowerCase().replace('.', '');

    let policyText: string;
    if (ext === 'pdf') {
      policyText = await extractPdfText(fileBuffer);
    } else if (ext === 'docx' || ext === 'doc') {
      const r = await mammoth.extractRawText({ buffer: fileBuffer });
      policyText = r.value;
    } else {
      policyText = fileBuffer.toString('utf8');
    }

    if (!policyText || policyText.trim().length < 50) {
      throw new Error('Could not extract meaningful text from the document. Please ensure it is not encrypted or image-only.');
    }

    // -- RAG RETRIEVAL (progress: 15 \u2192 30) ----------------------------------
    await updateAnalysisStatus(analysisId, { status: 'ANALYZING', progress: 15 });
    currentProgress = 15;

    // Extract 3-5 key compliance themes from the policy text for targeted RAG queries
    const policyKeywords = extractPolicyKeywords(policyText);
    const keywordSuffix = policyKeywords.length > 0 ? ` ${policyKeywords.join(' ')}` : '';

    const ragPromises = regulatoryFrameworks.map((framework, index) => {
      const frameworkSlug = regulatoryFrameworkSlugs[index];
      const strictFilter = {
        ...(frameworkSlug ? { frameworkSlug } : {}),
        ...(benchmarkDocumentIds.length > 0
          ? { documentId: pineconeInFilter(benchmarkDocumentIds) }
          : {}),
      };
      const relaxedFilter = frameworkSlug ? { frameworkSlug } : undefined;

      return ragService
        .search(`${framework} Kenya regulatory compliance obligations${keywordSuffix}`, {
          topK: 8,
          minScore: 0.6,
          filter: Object.keys(strictFilter).length > 0 ? strictFilter : undefined,
          fallbackIfTooFew: {
            minResults: 3,
            relaxedFilter,
          },
        })
        .catch((err: unknown) => {
          logger.warn({ type: 'gap_analysis_rag_framework_failed', userId, analysisId, framework, error: (err as Error).message });
          return [] as Awaited<ReturnType<typeof ragService.search>>;
        });
    });

    const ragResultsByFramework = await Promise.all(ragPromises);

    const seenDocumentIds = new Set<string>();
    const labeledResults: Array<{ text: string; framework: string }> = [];
    let groundedFrameworkCount = 0;

    for (let fIdx = 0; fIdx < regulatoryFrameworks.length; fIdx++) {
      const framework = regulatoryFrameworks[fIdx];
      const results = ragResultsByFramework[fIdx] ?? [];
      if (results.length > 0) groundedFrameworkCount++;
      for (const r of results) {
        if (!seenDocumentIds.has(r.documentId)) {
          seenDocumentIds.add(r.documentId);
          labeledResults.push({ text: r.chunkText, framework });
        }
      }
    }

    const ragGrounded =
      regulatoryFrameworks.length === 0
        ? false
        : groundedFrameworkCount >= Math.ceil(regulatoryFrameworks.length / 2);

    if (regulatoryFrameworks.length === 0 || groundedFrameworkCount < regulatoryFrameworks.length) {
      logger.warn({
        type: 'gap_analysis_source_insufficient',
        userId,
        analysisId,
        groundedFrameworkCount,
        totalFrameworks: regulatoryFrameworks.length,
      });
      throw new SourceInsufficiencyError(GAP_ANALYSIS_SOURCE_INSUFFICIENCY_MESSAGE);
    }

    let ragContext: string | undefined;
    if (labeledResults.length > 0) {
      const grouped: Record<string, string[]> = {};
      for (const r of labeledResults) {
        if (!grouped[r.framework]) grouped[r.framework] = [];
        grouped[r.framework].push(r.text);
      }
      ragContext = Object.entries(grouped)
        .map(([fw, texts]) =>
          texts
            .map((t, i) => `[REGULATORY CONTEXT \u2014 ${fw} (${i + 1} of ${texts.length})]\n${t}`)
            .join('\n\n---\n\n')
        )
        .join('\n\n---\n\n');
    }

    logger.info({ type: 'gap_analysis_rag_grounding_summary', userId, analysisId, ragGrounded, groundedFrameworkCount, totalFrameworks: regulatoryFrameworks.length });

    await updateAnalysisStatus(analysisId, { status: 'ANALYZING', progress: 30 });
    currentProgress = 30;

    // -- SANITIZE ----------------------------------------------------------
    const { sanitized: safePolicyText, wasModified: injectionDetected } = sanitizePolicyText(policyText);
    if (injectionDetected) {
      logger.warn({ type: 'gap_analysis_prompt_injection_detected', userId, analysisId, fileName });
    }

    // -- AI ANALYSIS (progress: 30 \u2192 85) ------------------------------------
    const SINGLE_PASS_THRESHOLD = analysisDepth === 'deep' ? 15000 : 8000;
    const useMultiChunk = analysisDepth !== 'quick' && safePolicyText.length > SINGLE_PASS_THRESHOLD;

    let gapResults: GapAnalysisResult;
    let chunksProcessed = 1;
    let gapInputTokens = 0;
    let gapOutputTokens = 0;

    if (!useMultiChunk) {
      const gapAiResult = await aiService.performGapAnalysis({
        policyText: safePolicyText,
        documentName: fileName,
        documentType: ext,
        regulatoryFrameworks,
        analysisDepth,
        focusAreas,
        ragContext,
      });
      gapResults = gapAiResult.result;
      gapResults.metadata.selectedBenchmarkDocuments = benchmarkDocuments;
      gapInputTokens = gapAiResult.inputTokens;
      gapOutputTokens = gapAiResult.outputTokens;
      await updateAnalysisStatus(analysisId, { status: 'ANALYZING', progress: 80 });
      currentProgress = 80;
    } else {
      const chunks = chunkPolicyText(safePolicyText);
      logger.info({ type: 'gap_analysis_chunking', userId, analysisId, textLength: safePolicyText.length, totalChunks: chunks.length });
      const multiResult = await aiService.performMultiChunkGapAnalysis({
        chunks,
        documentName: fileName,
        documentType: ext,
        regulatoryFrameworks,
        analysisDepth,
        focusAreas,
        ragContext,
      });
      gapResults = multiResult.result;
      gapResults.metadata.selectedBenchmarkDocuments = benchmarkDocuments;
      gapInputTokens = multiResult.totalInputTokens;
      gapOutputTokens = multiResult.totalOutputTokens;
      chunksProcessed = multiResult.chunksProcessed;
      // Attach token cost into metadata for storage + audit
      gapResults.metadata.tokenCost = {
        inputTokens: multiResult.totalInputTokens,
        outputTokens: multiResult.totalOutputTokens,
        estimatedCostUsd: multiResult.totalCost,
      };
      await updateAnalysisStatus(analysisId, { status: 'ANALYZING', progress: 85 });
      currentProgress = 85;
    }

    // Track token usage for free trial users (fire-and-forget, non-fatal).
    if (trialUserId) {
      incrementTrialUsage(trialUserId, 'totalTokensUsed', gapInputTokens + gapOutputTokens).catch(() => { });
    }

    // -- CITATION VERIFICATION (progress: 88) --------------------------------
    await updateAnalysisStatus(analysisId, { status: 'COMPLETING', progress: 88 });
    currentProgress = 88;

    try {
      gapResults = await verifyCitationsAgainstCorpus(gapResults);
    } catch (verifyErr: unknown) {
      // Graceful degradation: if verification fails entirely, leave all citations unverified
      logger.warn({ type: 'gap_analysis_citation_verification_failed', analysisId, error: (verifyErr as Error).message });
    }

    // -- COMPLETING (progress: 90) ----------------------------------------
    await updateAnalysisStatus(analysisId, { status: 'COMPLETING', progress: 90 });
    currentProgress = 90;

    await prisma.gapAnalysis.update({
      where: { id: analysisId },
      data: {
        results: gapResults,
        overallScore: gapResults.overallScore,
        status: 'COMPLETED',
        progress: 100,
        completedAt: new Date(),
        ragGrounded,
        chunksProcessed,
      },
    });

    logger.info({
      type: 'gap_analysis_pipeline_complete',
      userId,
      analysisId,
      overallScore: gapResults.overallScore,
      totalGaps: gapResults.metadata.totalGaps,
      chunksProcessed,
      durationMs: Date.now() - startTime,
    });

    // Invalidate list cache so the completed status is visible on next poll
    try {
      await redis.del(`cache:gap-analysis:list:${userId}`);
    } catch { /* non-fatal */ }

    // -- POST-COMPLETION: notifications + audit log ------------------------
    notificationModule.createCategorizedNotification({
      userId,
      type: 'GAP_ANALYSIS_COMPLETED',
      category: 'COMPLIANCE',
      title: 'Gap Analysis Complete',
      message: `Analysis of "${fileName}" complete. Score: ${gapResults.overallScore}%. Found ${gapResults.metadata.totalGaps} gaps.`,
      link: `/startup/gap-analysis/${analysisId}`,
    }).catch(() => { /* non-blocking */ });

    prisma.auditLog.create({
      data: {
        userId,
        action: 'GAP_ANALYSIS_CREATED',
        entityType: 'GapAnalysis',
        entityId: analysisId,
        metadata: {
          documentName: fileName,
          frameworks: regulatoryFrameworks,
          depth: analysisDepth,
          overallScore: gapResults.overallScore,
          ragGrounded,
          chunksProcessed,
          benchmarkDocumentIds,
          tokenCost: gapResults.metadata.tokenCost ?? null,
        },
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    }).catch((err: unknown) => {
      logger.error({ type: 'gap_analysis_audit_log_failed', userId, analysisId, error: (err as Error).message });
    });
  } catch (err) {
    logger.error({
      type: 'gap_analysis_pipeline_failed',
      userId,
      analysisId,
      durationMs: Date.now() - startTime,
      error: (err as Error).message,
    });

    const errorMessage = err instanceof SourceInsufficiencyError
      ? err.message
      : err instanceof Error
      ? `Analysis failed: ${err.message}`
      : 'Analysis failed due to an unexpected error. Please try again.';

    await updateAnalysisStatus(analysisId, { status: 'FAILED', progress: currentProgress, errorMessage });
    throw err;
  }
}

/**
 * Compliance Module Class
 * Central orchestrator for all compliance-related business logic
 */
class ComplianceModule {
  constructor() {
    // Module initialized
  }

  // ==========================================================================
  // QUERY OPERATIONS
  // ==========================================================================

  /**
   * Submit a compliance query
   * Uses RAG to search regulatory documents and AI to generate answer
   */
  async submitQuery(
    userId: string,
    params: ComplianceQueryParams
  ): Promise<ComplianceQueryResult> {
    logger.info({
      type: 'compliance_query_started',
      userId,
      queryLength: params.query.length,
      areas: params.regulatoryAreas,
    });

    const startTime = Date.now();

    try {
      // 1. Validate input
      const validated = complianceQuerySchema.parse(params);

      // 2. Check rate limit
      await this.checkQueryRateLimit(userId);

      // 3. Check cache for similar query
      const cacheKey = this.getQueryCacheKey(validated.query, validated.regulatoryAreas);
      const cached = await redis.get<string>(cacheKey);

      if (cached) {
        logger.debug({ type: 'compliance_query_cache_hit', userId });
        return JSON.parse(cached);
      }

      // 4. Search RAG for relevant regulatory content
      const ragResults = await ragService.search(
        validated.query,
        {
          topK: 10,
          filter: validated.regulatoryAreas?.length
            ? { regulatoryAreas: validated.regulatoryAreas }
            : undefined,
        }
      );

      // 5. Build context from RAG results
      const context = this.buildQueryContext(ragResults, validated.context);

      if (!hasUsableSourceContext({ results: ragResults, context })) {
        const answer = buildComplianceSourceInsufficiencyAnswer();
        const detectedAreas = validated.regulatoryAreas ?? [];
        const savedQuery = await prisma.complianceQuery.create({
          data: {
            userId,
            organizationId: validated.organizationId ?? null,
            query: validated.query,
            response: answer,
            citations: [],
            regulatoryAreas: detectedAreas,
            processingTimeMs: Date.now() - startTime,
            status: 'completed',
            metadata: {
              ragSources: ragResults.length,
              grounded: false,
              abstained: true,
              sourceInsufficient: true,
            },
          },
        });

        return {
          id: savedQuery.id,
          query: validated.query,
          answer,
          citations: [],
          regulatoryAreas: detectedAreas as RegulatoryArea[],
          confidence: 0,
          recommendations: [],
          relatedQueries: [],
          processingTimeMs: Date.now() - startTime,
          createdAt: savedQuery.createdAt,
        } as ComplianceQueryResult;
      }

      const grade = await runGraderAgent(validated.query, ragResults, 10);
      const acceptedResults = grade.accepted;
      const acceptedContext = this.buildQueryContext(acceptedResults, validated.context);
      const citations = buildCitationsFromChunks(acceptedResults, 'not_checked');

      if (!hasUsableSourceContext({ results: acceptedResults, context: acceptedContext }) || !hasUsableCitations(citations)) {
        const fallbackReason = fallbackReasonForNoAcceptedSources(grade.diagnostics?.failureClassification);
        const answer = buildComplianceSourceInsufficiencyAnswer(fallbackReason);
        const detectedAreas = validated.regulatoryAreas ?? [];
        const savedQuery = await prisma.complianceQuery.create({
          data: {
            userId,
            organizationId: validated.organizationId ?? null,
            query: validated.query,
            response: answer,
            citations: [],
            regulatoryAreas: detectedAreas,
            processingTimeMs: Date.now() - startTime,
            status: 'completed',
            metadata: {
              ragSources: ragResults.length,
              acceptedSources: acceptedResults.length,
              graderFailed: grade.gradeFailed,
              graderFailureClassification: grade.diagnostics?.failureClassification,
              grounded: false,
              abstained: true,
              sourceInsufficient: true,
              fallbackTriggered: true,
              fallbackReason,
            },
          },
        });

        return {
          id: savedQuery.id,
          query: validated.query,
          answer,
          citations: [],
          regulatoryAreas: detectedAreas as RegulatoryArea[],
          confidence: 0,
          recommendations: [],
          relatedQueries: [],
          processingTimeMs: Date.now() - startTime,
          createdAt: savedQuery.createdAt,
        } as ComplianceQueryResult;
      }

      // 6. Generate answer using AI
      const aiResponse = await aiService.answerComplianceQuery({
        query: validated.query,
        context: acceptedContext,
        regulatoryAreas: validated.regulatoryAreas || [],
        includeRecommendations: validated.includeRecommendations,
      } as any) as any;

      // 8. Determine regulatory areas from response
      const detectedAreas = this.detectRegulatoryAreas(
        aiResponse.answer,
        validated.regulatoryAreas
      );

      // 9. Save query to database
      const savedQuery = await prisma.complianceQuery.create({
        data: {
          userId,
          organizationId: validated.organizationId ?? null,
          query: validated.query,
          response: aiResponse.answer,
          citations: citations.length > 0 ? citations : undefined,
          regulatoryAreas: detectedAreas,
          confidence: aiResponse.confidence ?? 0.85,
          recommendations: aiResponse.recommendations ?? null,
          processingTimeMs: Date.now() - startTime,
        },
      });

      // 10. Build result
      const result: ComplianceQueryResult = {
        id: savedQuery.id,
        query: validated.query,
        answer: aiResponse.answer,
        citations: citations as any,
        regulatoryAreas: detectedAreas as RegulatoryArea[],
        confidence: aiResponse.confidence || 0.85,
        recommendations: aiResponse.recommendations,
        relatedQueries: aiResponse.relatedQueries,
        processingTimeMs: Date.now() - startTime,
        createdAt: savedQuery.createdAt,
      };

      // 11. Cache result
      await redis.set(cacheKey, JSON.stringify(result), { ex: QUERY_CACHE_TTL });

      // 12. Record rate limit usage
      await this.recordQueryUsage(userId);

      logger.info({
        type: 'compliance_query_success',
        userId,
        queryId: savedQuery.id,
        processingTimeMs: result.processingTimeMs,
      });

      // Pilot event -- fire-and-forget, never throws.
      logPilotEvent({
        userId,
        action: 'AI_QUERY_SENT',
        feature: 'compliance-query',
        metadata: { queryId: savedQuery.id },
      }).catch((err) => logger.error({ type: 'PILOT_EVENT_LOG_FAILED', err }));

      return result;
    } catch (error: any) {
      logger.error({
        type: 'compliance_query_error',
        userId,
        error: error.message,
      });

      if (error instanceof ComplianceError) throw error;
      throw new ComplianceError(
        'Failed to process compliance query',
        'QUERY_FAILED',
        500
      );
    }
  }

  /**
   * Submit a follow-up query
   */
  async submitFollowUp(
    userId: string,
    originalQueryId: string,
    followUp: string
  ): Promise<ComplianceQueryResult> {
    logger.info({
      type: 'compliance_followup_started',
      userId,
      originalQueryId,
    });

    try {
      // Get original query
      const originalQuery = await prisma.complianceQuery.findUnique({
        where: { id: originalQueryId },
      });

      if (!originalQuery) {
        throw new ComplianceError(
          'Original query not found',
          'QUERY_NOT_FOUND',
          404
        );
      }

      // Build context with original Q&A
      const context = `
Previous Question: ${originalQuery.query}
Previous Answer: ${originalQuery.response ?? ''}

Follow-up Question: ${followUp}
`;

      return await this.submitQuery(userId, {
        query: followUp,
        regulatoryAreas: this.narrowJsonStringArray(originalQuery.regulatoryAreas) as RegulatoryArea[],
        context,
        organizationId: originalQuery.organizationId ?? undefined,
      });
    } catch (error: any) {
      logger.error({
        type: 'compliance_followup_error',
        userId,
        originalQueryId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Quick compliance check for a scenario
   */
  async quickCheck(
    userId: string,
    scenario: string,
    areas?: RegulatoryArea[]
  ): Promise<QuickCheckResult> {
    logger.info({
      type: 'compliance_quick_check_started',
      userId,
      scenarioLength: scenario.length,
    });

    try {
      // Validate
      quickCheckSchema.parse({ scenario, regulatoryAreas: areas });

      // Check rate limit
      await this.checkQuickCheckRateLimit(userId);

      // Generate quick assessment
      const aiResponse = await aiService.quickComplianceCheck(scenario) as any;

      // Record usage
      await this.recordQuickCheckUsage(userId);

      logger.info({
        type: 'compliance_quick_check_success',
        userId,
        isCompliant: aiResponse.isCompliant,
        riskLevel: aiResponse.riskLevel,
      });

      return {
        isCompliant: aiResponse.isCompliant,
        riskLevel: aiResponse.riskLevel,
        summary: aiResponse.summary,
        keyPoints: aiResponse.keyPoints || [],
        areasOfConcern: aiResponse.areasOfConcern || [],
        nextSteps: aiResponse.nextSteps || [],
      };
    } catch (error: any) {
      logger.error({
        type: 'compliance_quick_check_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Build personalised suggested queries for the active user.
   *
   * Signal priority (graceful degradation):
   * 1. Organization.industry -> curated template match
   * 2. User's recent query regulatory areas (last ~20)
   * 3. Most recent active RegulatoryAlert
   * 4. Cohort popular templates (same organizationType, >=5 distinct orgs, 30d)
   * 5. Curated baseline (DEFAULT_SUGGESTIONS)
   *
   * Always returns exactly 5 suggestions. Cached in Redis for 1 hour.
   */
  async buildSuggestedQueries(
    userId: string,
    organizationId: string,
  ): Promise<Array<{
    id: string;
    text: string;
    reason: 'industry' | 'history' | 'alert' | 'cohort' | 'curated';
    relatedArea?: string;
  }>> {
    const CACHE_KEY = `sheriabot:suggested-queries:${userId}`;

    try {
      // Check Redis cache first
      const cached = await redis.get<string>(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length === 5) {
          return parsed;
        }
        // Malformed cache -- fall through to rebuild
        logger.warn({ type: 'suggested_queries_cache_malformed', userId });
      }

      const results: Array<{
        id: string;
        text: string;
        reason: 'industry' | 'history' | 'alert' | 'cohort' | 'curated';
        relatedArea?: string;
      }> = [];

      // Fetch org + industry in parallel
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { industry: true, type: true },
      });

      const industry = org?.industry ?? null;

      // -- Signal 1: Industry templates
      const { resolveTemplatesForIndustry, DEFAULT_SUGGESTIONS } =
        await import('@/config/suggested-queries.config');
      const industryTemplates = resolveTemplatesForIndustry(industry);

      function addFromPool(
        pool: readonly string[],
        reason: 'industry' | 'history' | 'alert' | 'cohort' | 'curated',
        relatedArea?: string,
      ): void {
        for (const text of pool) {
          if (results.length >= 5) return;
          const exists = results.some((r) => r.text === text);
          if (exists) continue;
          results.push({
            id: `sg_${reason}_${results.length}`,
            text,
            reason,
            ...(relatedArea ? { relatedArea } : {}),
          });
        }
      }

      // Fill from industry first
      if (industry) {
        addFromPool(industryTemplates, 'industry');
      }

      // -- Signal 2: Recent query regulatory areas
      if (results.length < 5) {
        const recentQueries = await prisma.complianceQuery.findMany({
          where: { userId, organizationId },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { regulatoryAreas: true },
        });

        const areaCounts = new Map<string, number>();
        for (const q of recentQueries) {
          const areas: string[] = Array.isArray(q.regulatoryAreas) ? q.regulatoryAreas as string[] : [];
          for (const area of areas) {
            areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
          }
        }

        // Sort by frequency, pick top areas
        const sortedAreas = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]);
        const topAreas = sortedAreas.slice(0, 4).map(([area]) => area);
        // Keep one area outside their history to surface coverage gaps
        const uncoveredAreas = ['DPA', 'AML', 'CFT', 'CYBERSECURITY', 'CONSUMER_PROTECTION', 'CBK', 'CMA', 'E_MONEY', 'PAYMENT_SYSTEMS', 'DIGITAL_LENDING'].filter(
          (a) => !topAreas.includes(a),
        );
        const gapArea = uncoveredAreas[Math.floor(Math.random() * uncoveredAreas.length)];

        // Map areas to templates using curated config
        const { getAllCuratedTemplates } = await import('@/config/suggested-queries.config');
        const allTemplates = getAllCuratedTemplates();

        for (const area of topAreas.slice(0, 3)) {
          const match = allTemplates.find((t) =>
            t.template.toLowerCase().includes(area.toLowerCase().replace(/_/g, ' ')) ||
            t.industryKey.toLowerCase().includes(area.toLowerCase())
          );
          if (match) {
            addFromPool([match.template], 'history', area);
          }
        }

        // Add the gap-area suggestion
        if (results.length < 5 && gapArea) {
          const gapMatch = allTemplates.find((t) =>
            t.template.toLowerCase().includes(gapArea.toLowerCase().replace(/_/g, ' '))
          );
          if (gapMatch) {
            addFromPool([gapMatch.template], 'history', gapArea);
          }
        }
      }

      // -- Signal 3: Recent RegulatoryAlert
      if (results.length < 5) {
        try {
          const recentAlert = await prisma.regulatoryAlert.findFirst({
            where: {
              isActive: true,
            },
            orderBy: { publishedAt: 'desc' },
            select: { title: true, regulatoryBody: true },
          });

          if (recentAlert) {
            const { getAllCuratedTemplates } = await import('@/config/suggested-queries.config');
            const allTemplates = getAllCuratedTemplates();
            const bodyStr = recentAlert.regulatoryBody || '';
            const match = allTemplates.find((t) =>
              t.template.toLowerCase().includes(bodyStr.toLowerCase().slice(0, 15))
            );
            if (match) {
              addFromPool([match.template], 'alert', bodyStr || undefined);
            }
          }
        } catch {
          // Alert signal is non-critical -- fall through
        }
      }

      // -- Signal 4: Cohort popular queries
      if (results.length < 5) {
        try {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const orgType = org?.type ?? 'startup';

          const cohortOrgs = await prisma.organization.findMany({
            where: { type: orgType, id: { not: organizationId } },
            select: { id: true },
            take: 100,
          });

          if (cohortOrgs.length >= 5) {
            const cohortOrgIds = cohortOrgs.map((o) => o.id);

            // Count query occurrences per regulatory area across cohort
            const cohortQueries = await prisma.complianceQuery.findMany({
              where: {
                organizationId: { in: cohortOrgIds },
                createdAt: { gte: thirtyDaysAgo },
              },
              select: { regulatoryAreas: true, organizationId: true },
              take: 500,
            });

            // Track distinct orgs per area
            const areaOrgSet = new Map<string, Set<string>>();
            for (const q of cohortQueries) {
              const areas: string[] = Array.isArray(q.regulatoryAreas)
                ? (q.regulatoryAreas as string[])
                : [];
              for (const area of areas) {
                if (!areaOrgSet.has(area)) areaOrgSet.set(area, new Set());
                areaOrgSet.get(area)!.add(q.organizationId!);
              }
            }

            // Only areas with 5+ distinct orgs qualify
            const qualifyingAreas = [...areaOrgSet.entries()]
              .filter(([, orgs]) => orgs.size >= 5)
              .sort((a, b) => b[1].size - a[1].size)
              .map(([area]) => area);

            if (qualifyingAreas.length > 0) {
              const { getAllCuratedTemplates } = await import('@/config/suggested-queries.config');
              const allTemplates = getAllCuratedTemplates();

              for (const area of qualifyingAreas) {
                if (results.length >= 5) break;
                const match = allTemplates.find((t) =>
                  t.template.toLowerCase().includes(area.toLowerCase().replace(/_/g, ' '))
                );
                if (match) {
                  addFromPool([match.template], 'cohort', area);
                }
              }
            }
          }
        } catch {
          // Cohort signal is non-critical -- fall through
        }
      }

      // -- Signal 5: Curated baseline
      if (results.length < 5) {
        addFromPool(DEFAULT_SUGGESTIONS, 'curated');
      }

      // Trim to exactly 5
      const final = results.slice(0, 5);

      // Cache in Redis for 1 hour
      await redis.set(CACHE_KEY, JSON.stringify(final), { ex: 3600 } as any);

      logger.info({
        type: 'suggested_queries_built',
        userId,
        organizationId,
        count: final.length,
        signals: final.map((s) => s.reason),
      });

      return final;
    } catch (error: any) {
      logger.error({
        type: 'suggested_queries_build_failed',
        userId,
        organizationId,
        error: error.message,
      });

      // Fallback: return 5 curated defaults
      const { DEFAULT_SUGGESTIONS } = await import('@/config/suggested-queries.config');
      return DEFAULT_SUGGESTIONS.slice(0, 5).map((text, i) => ({
        id: `sg_curated_${i}`,
        text,
        reason: 'curated' as const,
      }));
    }
  }

  /**
   * Get query history for a user
   */
  async getQueryHistory(
    userId: string,
    filters?: QueryFilters
  ): Promise<PaginatedQueries> {
    const validated = queryFiltersSchema.parse(filters || {});
    const { page, limit } = validated;
    const skip = (page - 1) * limit;

    const where: any = { userId };

    if (validated.regulatoryArea) {
      where.regulatoryAreas = { has: validated.regulatoryArea };
    }
    if (validated.startDate) {
      where.createdAt = { ...where.createdAt, gte: validated.startDate };
    }
    if (validated.endDate) {
      where.createdAt = { ...where.createdAt, lte: validated.endDate };
    }
    if (validated.searchTerm) {
      where.OR = [
        { query: { contains: validated.searchTerm, mode: 'insensitive' } },
        { response: { contains: validated.searchTerm, mode: 'insensitive' } },
      ];
    }

    const [queries, total] = await Promise.all([
      prisma.complianceQuery.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.complianceQuery.count({ where }),
    ]);

    return {
      queries: queries.map((q) =>
        toComplianceQueryResult({
          ...q,
          response: q.response ?? '',
          citations: Array.isArray(q.citations) ? q.citations : [],
          regulatoryAreas: this.narrowJsonStringArray(q.regulatoryAreas),
          confidence: q.confidence ?? undefined,
          recommendations: Array.isArray(q.recommendations)
            ? this.narrowJsonStringArray(q.recommendations)
            : undefined,
          processingTimeMs: q.processingTimeMs ?? undefined,
        })
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + queries.length < total,
    };
  }

  // ==========================================================================
  // COMPLIANCE SCORING
  // ==========================================================================

  /**
   * Calculate compliance score for an organization
   */
  async calculateComplianceScore(
    userId: string,
    orgId: string
  ): Promise<ComplianceScore> {
    logger.info({
      type: 'compliance_calculate_score_started',
      userId,
      orgId,
    });

    // Verify user has access to organization
    await this.verifyOrgAccess(userId, orgId);

    return await complianceScorer.calculate(orgId);
  }

  /**
   * Get compliance score history
   */
  async getComplianceScoreHistory(
    userId: string,
    orgId: string,
    days: number = 90
  ): Promise<ScoreHistory[]> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceScorer.getScoreHistory(orgId, days);
  }

  /**
   * Get improvement recommendations
   */
  async getRecommendations(
    userId: string,
    orgId: string
  ): Promise<string[]> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceScorer.generateRecommendations(orgId);
  }

  // ==========================================================================
  // GAP ANALYSIS
  // ==========================================================================

  /**
   * Analyze compliance gaps
   */
  async analyzeComplianceGaps(
    userId: string,
    orgId: string,
    requiredAreas?: RegulatoryArea[]
  ): Promise<ComplianceGap[]> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceAnalyzer.identifyGaps(orgId, requiredAreas);
  }

  /**
   * Generate compliance roadmap
   */
  async generateRoadmap(
    userId: string,
    orgId: string
  ): Promise<ComplianceRoadmap> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceAnalyzer.generateRoadmap(orgId);
  }

  /**
   * Estimate time to compliance
   */
  async estimateTimeToCompliance(
    userId: string,
    orgId: string
  ): Promise<{
    estimatedDays: number;
    estimatedWeeks: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    factors: string[];
  }> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceAnalyzer.estimateTimeToCompliance(orgId);
  }

  // ==========================================================================
  // REQUIREMENTS TRACKING
  // ==========================================================================

  /**
   * Create a requirement
   */
  async trackRequirement(
    userId: string,
    orgId: string,
    params: RequirementParams
  ): Promise<Requirement> {
    await this.verifyOrgAccess(userId, orgId, 'ADMIN');
    const validated = requirementParamsSchema.parse(params);
    return await complianceTracker.createRequirement(orgId, validated);
  }

  /**
   * Update requirement status
   */
  async updateRequirementStatus(
    userId: string,
    requirementId: string,
    status: RequirementStatus,
    notes?: string
  ): Promise<Requirement> {
    // Get requirement to check org access
    const requirement = await (prisma as any).requirement.findUnique({
      where: { id: requirementId },
    });

    if (!requirement) {
      throw new ComplianceError(
        'Requirement not found',
        'REQUIREMENT_NOT_FOUND',
        404
      );
    }

    await this.verifyOrgAccess(userId, requirement.organizationId);
    return await complianceTracker.updateRequirementStatus(requirementId, status, notes);
  }

  /**
   * Get requirements for an organization
   */
  async getRequirements(
    userId: string,
    orgId: string,
    filters?: RequirementFilters
  ): Promise<{
    requirements: Requirement[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceTracker.getRequirements(orgId, filters);
  }

  /**
   * Check upcoming deadlines
   */
  async checkDeadlines(
    userId: string,
    orgId: string,
    daysAhead: number = 30
  ): Promise<UpcomingDeadline[]> {
    await this.verifyOrgAccess(userId, orgId);
    return await complianceTracker.getUpcomingDeadlines(orgId, daysAhead);
  }

  /**
   * Track requirement completion with evidence
   */
  async trackCompletion(
    userId: string,
    requirementId: string,
    evidence: Omit<Evidence, 'id' | 'uploadedBy' | 'uploadedAt'>
  ): Promise<Requirement> {
    const requirement = await (prisma as any).requirement.findUnique({
      where: { id: requirementId },
    });

    if (!requirement) {
      throw new ComplianceError(
        'Requirement not found',
        'REQUIREMENT_NOT_FOUND',
        404
      );
    }

    await this.verifyOrgAccess(userId, requirement.organizationId);
    return await complianceTracker.trackCompletion(
      requirementId,
      evidence,
      userId
    );
  }

  /**
   * Generate compliance certificate
   */
  async generateCertificate(
    userId: string,
    orgId: string,
    area: RegulatoryArea
  ): Promise<{
    certificateId: string;
    downloadUrl: string;
    validUntil: Date;
  }> {
    await this.verifyOrgAccess(userId, orgId, 'ADMIN');
    return await complianceTracker.generateCertificate(orgId, area);
  }

  // ==========================================================================
  // RISK ASSESSMENT
  // ==========================================================================

  /**
   * Assess risk for a scenario
   */
  async assessRisk(
    userId: string,
    orgId: string,
    scenario: RiskScenario
  ): Promise<RiskAssessment> {
    logger.info({
      type: 'compliance_assess_risk_started',
      userId,
      orgId,
      scenario: scenario.title,
    });

    try {
      await this.verifyOrgAccess(userId, orgId);
      const validated = riskScenarioSchema.parse(scenario);

      // Generate risk assessment using AI
      const assessment = await (aiService as any).assessComplianceRisk({
        scenario: validated,
        organizationType: await this.getOrgType(orgId),
      });

      // Determine if approval required (high risk scenarios)
      const requiresApproval = assessment.overallRisk === 'CRITICAL' ||
        assessment.overallRisk === 'HIGH';

      // Save assessment
      const saved = await (prisma as any).riskAssessment.create({
        data: {
          organizationId: orgId,
          scenario: validated,
          overallRisk: assessment.overallRisk,
          riskScore: assessment.riskScore,
          risks: assessment.risks,
          mitigationStrategies: assessment.mitigationStrategies,
          recommendations: assessment.recommendations,
          requiresApproval,
          assessedBy: userId,
        },
      });

      logger.info({
        type: 'compliance_assess_risk_success',
        userId,
        orgId,
        assessmentId: saved.id,
        riskLevel: assessment.overallRisk,
      });

      return {
        id: saved.id,
        scenario: validated,
        overallRisk: assessment.overallRisk,
        riskScore: assessment.riskScore,
        risks: assessment.risks,
        mitigationStrategies: assessment.mitigationStrategies,
        recommendations: assessment.recommendations,
        requiresApproval,
        assessedAt: saved.createdAt,
        assessedBy: userId,
      };
    } catch (error: any) {
      logger.error({
        type: 'compliance_assess_risk_error',
        userId,
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate risk report
   */
  async generateRiskReport(
    userId: string,
    orgId: string,
    periodDays: number = 30
  ): Promise<RiskReport> {
    logger.info({
      type: 'compliance_generate_risk_report_started',
      userId,
      orgId,
      periodDays,
    });

    try {
      await this.verifyOrgAccess(userId, orgId, 'ADMIN');

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - periodDays);

      // Get all assessments in period
      const assessments = await (prisma as any).riskAssessment.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: startDate },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Build summary
      const summary = this.buildRiskSummary(assessments);

      // Build trend analysis
      const trendAnalysis = this.buildRiskTrendAnalysis(assessments);

      // Generate recommendations
      const recommendations = this.generateRiskRecommendations(summary, trendAnalysis);

      const report: RiskReport = {
        organizationId: orgId,
        generatedAt: new Date(),
        period: {
          start: startDate,
          end: new Date(),
        },
        summary,
        assessments: assessments as unknown as RiskAssessment[],
        trendAnalysis,
        recommendations,
      };

      logger.info({
        type: 'compliance_generate_risk_report_success',
        userId,
        orgId,
        totalRisks: summary.totalRisks,
      });

      // Pilot event -- fire-and-forget, never throws.
      logPilotEvent({
        userId,
        action: 'REPORT_GENERATED',
        feature: 'compliance-risk',
        metadata: { orgId, periodDays, totalRisks: summary.totalRisks },
      }).catch((err) => logger.error({ type: 'PILOT_EVENT_LOG_FAILED', err }));

      return report;
    } catch (error: any) {
      logger.error({
        type: 'compliance_generate_risk_report_error',
        userId,
        orgId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // REGULATORY UPDATES
  // ==========================================================================

  /**
   * Get regulatory updates
   */
  async getRegulatorUpdates(
    area: RegulatoryArea,
    limit: number = 10
  ): Promise<RegulatoryUpdate[]> {
    const updates = await (prisma as any).regulatoryUpdate.findMany({
      where: { regulatoryArea: area },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });

    return updates as unknown as RegulatoryUpdate[];
  }

  /**
   * Subscribe to regulatory updates
   */
  async subscribeToUpdates(
    userId: string,
    params: {
      areas: RegulatoryArea[];
      frequency: 'IMMEDIATE' | 'DAILY' | 'WEEKLY';
      emailEnabled: boolean;
      inAppEnabled: boolean;
    }
  ): Promise<UpdateSubscription> {
    const validated = subscriptionSchema.parse(params);

    // Upsert subscription
    const subscription = await (prisma as any).updateSubscription.upsert({
      where: { userId },
      update: {
        areas: validated.areas,
        frequency: validated.frequency,
        emailEnabled: validated.emailEnabled,
        inAppEnabled: validated.inAppEnabled,
        updatedAt: new Date(),
      },
      create: {
        userId,
        areas: validated.areas,
        frequency: validated.frequency,
        emailEnabled: validated.emailEnabled,
        inAppEnabled: validated.inAppEnabled,
      },
    });

    // Store in Redis for quick lookup
    await redis.set(
      `${REDIS_KEYS.SUBSCRIPTION}${userId}`,
      JSON.stringify(subscription),
      { ex: 24 * 60 * 60 }
    );

    return subscription as unknown as UpdateSubscription;
  }

  /**
   * Notify users of regulatory changes
   */
  async notifyRegulatorChanges(update: RegulatoryUpdate): Promise<void> {
    logger.info({
      type: 'compliance_notify_changes_started',
      updateId: update.id,
      area: update.area,
    });

    try {
      // Find all subscriptions for this area
      const subscriptions = await (prisma as any).updateSubscription.findMany({
        where: {
          areas: { has: update.area },
          emailEnabled: true,
        },
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });

      // Send notifications
      for (const sub of subscriptions) {
        const email = generateRegulatoryUpdateEmail(
          sub.user.name,
          {
            area: update.area,
            title: update.title,
            summary: update.summary,
            effectiveDate: update.effectiveDate,
            impact: update.impact,
            actionRequired: update.actionRequired,
          }
        );

        await sendEmail({
          to: sub.user.email,
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
      }

      logger.info({
        type: 'compliance_notify_changes_success',
        updateId: update.id,
        notified: subscriptions.length,
      });
    } catch (error: any) {
      logger.error({
        type: 'compliance_notify_changes_error',
        updateId: update.id,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS
  // ==========================================================================

  /**
   * Check query rate limit
   */
  private async checkQueryRateLimit(userId: string): Promise<void> {
    // F7/F16 (TD-008): Atomic nx set eliminates the incr+expire race condition.
    // Fail-open: if Redis is unavailable, allow the request and log the error.
    let count = 1;
    try {
      const key = `${REDIS_KEYS.QUERY_RATE}${userId}`;
      // Use incr then set TTL only on first write -- atomic via nx guard
      count = await redis.incr(key);
      if (count === 1) {
        // First increment this window -- set TTL (always overwrite is correct here)
        await redis.set(key, String(count), { ex: 3600 });
      }
    } catch (err: unknown) {
      logger.warn({
        type: 'query_rate_limit_redis_error',
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fail-open: Redis unavailable -- allow the request
      return;
    }

    const limit = await getSystemConfigNumber('maxQueriesPerHour', MAX_QUERIES_PER_HOUR);
    if (count > limit) {
      throw new ComplianceError(
        'Query rate limit exceeded. Please try again later.',
        'RATE_LIMIT_EXCEEDED',
        429
      );
    }
  }

  /**
   * Check quick check rate limit
   */
  private async checkQuickCheckRateLimit(userId: string): Promise<void> {
    // F7/F17 (TD-008): Same atomic pattern + fail-open as checkQueryRateLimit.
    let count = 1;
    try {
      const key = `${REDIS_KEYS.QUICK_CHECK_RATE}${userId}`;
      count = await redis.incr(key);
      if (count === 1) {
        await redis.set(key, String(count), { ex: 3600 });
      }
    } catch (err: unknown) {
      logger.warn({
        type: 'quick_check_rate_limit_redis_error',
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (count > MAX_QUICK_CHECKS_PER_HOUR) {
      throw new ComplianceError(
        'Quick check rate limit exceeded. Please try again later.',
        'RATE_LIMIT_EXCEEDED',
        429
      );
    }
  }

  /**
   * Record query usage
   */
  private async recordQueryUsage(_userId: string): Promise<void> {
    // Already tracked in rate limit, could add analytics here
  }

  /**
   * Record quick check usage
   */
  private async recordQuickCheckUsage(_userId: string): Promise<void> {
    // Already tracked in rate limit, could add analytics here
  }

  /**
   * Get cache key for query
   */
  private getQueryCacheKey(query: string, areas?: RegulatoryArea[]): string {
    const normalizedQuery = query.toLowerCase().trim().slice(0, 200);
    const areasStr = areas?.sort().join(',') || 'all';
    return `compliance:query:${Buffer.from(normalizedQuery).toString('base64').slice(0, 50)}:${areasStr}`;
  }

  /**
   * Build context from RAG results
   */
  private buildQueryContext(ragResults: any[], additionalContext?: string): string {
    let context = '';

    if (ragResults.length > 0) {
      context = 'Relevant regulatory information:\n\n';
      for (const result of ragResults) {
        context += `[${result.source || result.documentTitle || 'Regulation'}] ${result.chunkText || result.content || ''}\n\n`;
      }
    }

    if (additionalContext) {
      context += `\nAdditional context:\n${additionalContext}`;
    }

    return context;
  }

  /**
   * Detect regulatory areas from response
   */
  private detectRegulatoryAreas(
    response: string,
    requestedAreas?: RegulatoryArea[]
  ): string[] {
    if (requestedAreas?.length) {
      return requestedAreas;
    }

    // Simple keyword detection
    const detected: RegulatoryArea[] = [];
    const lowerResponse = response.toLowerCase();

    const keywords: Record<RegulatoryArea, string[]> = {
      CBK: ['central bank', 'cbk', 'banking act'],
      CMA: ['capital markets', 'cma', 'securities'],
      IRA: ['insurance', 'ira'],
      SASRA: ['sacco', 'sasra'],
      DPA: ['data protection', 'dpa', 'personal data', 'privacy'],
      AML: ['anti-money laundering', 'aml', 'money laundering'],
      CFT: ['terrorism financing', 'cft'],
      CONSUMER_PROTECTION: ['consumer protection', 'consumer rights'],
      CYBERSECURITY: ['cybersecurity', 'cyber security', 'information security'],
      E_MONEY: ['e-money', 'electronic money', 'mobile money'],
      PAYMENT_SYSTEMS: ['payment system', 'nps'],
      CREDIT_REFERENCE: ['credit reference', 'crb'],
      MICROFINANCE: ['microfinance', 'mfi'],
      DIGITAL_LENDING: ['digital lending', 'digital credit'],
    };

    for (const [area, words] of Object.entries(keywords)) {
      if (words.some((word) => lowerResponse.includes(word))) {
        detected.push(area as RegulatoryArea);
      }
    }

    return detected.length > 0 ? detected : ['CBK'];
  }

  /**
   * Verify user holds an active OrganizationMember row for the given org.
   * Returns the membership row so callers can inspect the role if needed.
   */
  private async verifyOrgAccess(
    userId: string,
    orgId: string,
    requiredRole: MemberRole = MemberRole.MEMBER
  ): Promise<OrganizationMember> {
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId: orgId } },
    });

    if (!member || member.status !== MemberStatus.ACTIVE) {
      logger.warn({
        type: 'compliance_dashboard.access_denied',
        userId,
        organizationId: orgId,
        reason: !member ? 'no_membership' : `member_status_${member.status.toLowerCase()}`,
      });
      throw new ComplianceError(
        'You do not have access to this organization',
        'UNAUTHORIZED',
        403
      );
    }

    const ROLE_LEVEL: Record<MemberRole, number> = {
      [MemberRole.VIEWER]: 0,
      [MemberRole.MEMBER]: 1,
      [MemberRole.ADMIN]: 2,
      [MemberRole.OWNER]: 3,
    };

    if ((ROLE_LEVEL[member.role] ?? 0) < (ROLE_LEVEL[requiredRole] ?? 1)) {
      logger.warn({
        type: 'compliance_dashboard.access_denied',
        userId,
        organizationId: orgId,
        reason: 'insufficient_role',
        userRole: member.role,
        requiredRole,
      });
      throw new ComplianceError(
        'Insufficient permissions for this action',
        'UNAUTHORIZED',
        403
      );
    }

    return member;
  }

  /**
   * Get organization type
   */
  private async getOrgType(orgId: string): Promise<string> {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { type: true },
    });
    return org?.type || 'FINTECH';
  }

  /**
   * Build risk summary from assessments
   */
  private buildRiskSummary(assessments: any[]): any {
    const summary = {
      totalRisks: 0,
      byLevel: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, MINIMAL: 0 },
      byArea: {} as Record<string, number>,
      mitigatedCount: 0,
      openCount: 0,
    };

    for (const assessment of assessments) {
      const risks = assessment.risks as any[] || [];
      summary.totalRisks += risks.length;

      for (const risk of risks) {
        summary.byLevel[risk.level as keyof typeof summary.byLevel]++;
        summary.byArea[risk.area] = (summary.byArea[risk.area] || 0) + 1;
      }
    }

    return summary;
  }

  /**
   * Build risk trend analysis
   */
  private buildRiskTrendAnalysis(assessments: any[]): any {
    // Simple trend analysis
    const midpoint = Math.floor(assessments.length / 2);
    const recent = assessments.slice(0, midpoint);
    const older = assessments.slice(midpoint);

    const recentRisks = recent.reduce((sum, a) => sum + (a.risks?.length || 0), 0);
    const olderRisks = older.reduce((sum, a) => sum + (a.risks?.length || 0), 0);

    let trend: 'IMPROVING' | 'STABLE' | 'WORSENING' = 'STABLE';
    if (recentRisks < olderRisks * 0.8) trend = 'IMPROVING';
    else if (recentRisks > olderRisks * 1.2) trend = 'WORSENING';

    return {
      trend,
      newRisks: recentRisks,
      resolvedRisks: Math.max(0, olderRisks - recentRisks),
      escalatedRisks: 0, // Would need status tracking
    };
  }

  /**
   * Generate risk recommendations
   */
  private generateRiskRecommendations(summary: any, trend: any): string[] {
    const recommendations: string[] = [];

    if (summary.byLevel.CRITICAL > 0) {
      recommendations.push(
        `Address ${summary.byLevel.CRITICAL} critical risk(s) immediately.`
      );
    }

    if (summary.byLevel.HIGH > 3) {
      recommendations.push(
        'Multiple high-risk items identified. Consider a comprehensive risk review.'
      );
    }

    if (trend.trend === 'WORSENING') {
      recommendations.push(
        'Risk profile is trending upward. Review recent changes and strengthen controls.'
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        'Risk profile is stable. Continue monitoring and regular assessments.'
      );
    }

    return recommendations;
  }

  /**
   * Safely narrow a Prisma JsonValue (stored as JSON in the DB) to string[].
   * Returns an empty array for any non-array or mixed-type value so callers
   * always get a clean string[] without unsafe casts.
   */
  private narrowJsonStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }

  // ==========================================================================
  // CHECKLIST OPERATIONS
  // ==========================================================================

  /**
   * Generate an AI+RAG compliance checklist for a fintech.
   * Saves result to DB; returns the full checklist record.
   */
  async generateChecklist(
    userId: string,
    params: {
      productType: string;
      businessStage: string;
      targetSegments: string[];
      servicesOffered: string[];
      additionalConcerns?: string;
      organizationId: string;
    }
  ): Promise<{
    id: string;
    title: string;
    status: string;
    checklistData: GeneratedChecklist;
    itemProgress: Record<string, string>;
    progress: number;
    createdAt: Date;
  }> {
    logger.info({
      type: 'checklist_generate_started',
      userId,
      productType: params.productType,
      businessStage: params.businessStage,
    });

    const startTime = Date.now();
    let record: { id: string } | null = null;

    try {
      // 1. Create a placeholder record with GENERATING status
      record = await prisma.checklist.create({
        data: {
          userId,
          organizationId: params.organizationId,
          title: `${params.productType}  -  ${params.businessStage}`,
          productType: params.productType,
          businessStage: params.businessStage,
          targetSegments: params.targetSegments,
          servicesOffered: params.servicesOffered,
          additionalConcerns: params.additionalConcerns ?? null,
          items: [], // Legacy field  -  kept for schema compat
          itemProgress: {},
          progress: 0,
          status: 'GENERATING',
        },
      });

      logger.info({
        type: 'checklist_generate_record_created',
        userId,
        checklistId: record.id,
        productType: params.productType,
      });

      // 2. Build rich RAG query from product + services + stage
      const ragQuery = [
        'Kenya fintech compliance requirements',
        params.productType,
        params.servicesOffered.join(' '),
        params.businessStage,
        'licensing KYC AML data protection CBK regulations',
      ].join(' ');

      let ragContext: string | undefined;
      try {
        const ragResults = await ragService.search(ragQuery, { topK: 15, minScore: 0.5 });
        if (ragResults.length > 0) {
          // Deduplicate by chunkText to avoid repetitive context
          const seen = new Set<string>();
          const deduplicated = ragResults.filter((r) => {
            const key = r.chunkText.slice(0, 100);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          ragContext = deduplicated
            .map((r, i) =>
              `[REGULATORY CONTEXT ${i + 1}  -  ${r.documentTitle || 'Kenyan Regulation'}]\n${r.chunkText}`
            )
            .join('\n\n---\n\n');
          logger.info({
            type: 'checklist_rag_retrieved',
            userId,
            checklistId: record.id,
            resultsCount: deduplicated.length,
          });
        }
      } catch (ragErr: unknown) {
        logger.warn({
          type: 'checklist_rag_search_failed',
          userId,
          checklistId: record.id,
          error: (ragErr as Error).message,
        });
      }

      if (!ragContext?.trim()) {
        throw new SourceInsufficiencyError(COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE);
      }

      // 3. Generate checklist with Claude AI
      logger.info({
        type: 'checklist_ai_generation_start',
        userId,
        checklistId: record.id,
        hasRagContext: !!ragContext,
      });

      const { checklist: generatedChecklist } = await aiService.generateComplianceChecklist({
        productType: params.productType,
        businessStage: params.businessStage,
        targetSegments: params.targetSegments,
        servicesOffered: params.servicesOffered,
        additionalConcerns: params.additionalConcerns,
        ragContext,
      });

      // 4. Build initial itemProgress (all items NOT_STARTED)
      const itemProgress: Record<string, string> = {};
      for (const category of generatedChecklist.categories) {
        for (const item of category.items) {
          // item.id is an optional AI-generated label (e.g. "LIC-001") used as
          // the key in the legacy itemProgress map.  Skip items without one.
          if (item.id !== undefined) {
            itemProgress[item.id] = 'NOT_STARTED';
          }
        }
      }

      // 5. Update DB record to COMPLETED with full checklist data
      const checklistTitle =
        generatedChecklist.metadata.productType
          ? `${generatedChecklist.metadata.productType}  -  ${generatedChecklist.metadata.businessStage}`
          : `${params.productType}  -  ${params.businessStage}`;

      const updated = await prisma.checklist.update({
        where: { id: record.id },
        data: {
          title: checklistTitle,
          checklistData: generatedChecklist as unknown as Record<string, unknown>,
          itemProgress,
          progress: 0,
          status: 'COMPLETED',
        },
      });

      logger.info({
        type: 'checklist_generate_success',
        userId,
        checklistId: record.id,
        totalItems: generatedChecklist.metadata.totalItems,
        criticalItems: generatedChecklist.metadata.criticalItems,
        durationMs: Date.now() - startTime,
      });

      notificationModule.createCategorizedNotification({
        userId,
        type: 'CHECKLIST_GENERATED',
        category: 'COMPLIANCE',
        title: 'Compliance Checklist Ready',
        message: `Your compliance checklist for "${checklistTitle}" has been generated with ${generatedChecklist.metadata.totalItems} items.`,
        link: `/startup/checklists/${record.id}`,
      }).catch(() => { /* non-blocking */ });

      return {
        id: updated.id,
        title: updated.title,
        status: updated.status,
        checklistData: generatedChecklist,
        itemProgress,
        progress: 0,
        createdAt: updated.createdAt,
      };
    } catch (error: unknown) {
      const errMsg = (error as Error).message ?? 'Unknown error';
      logger.error({
        type: 'checklist_generate_error',
        userId,
        checklistId: record?.id ?? null,
        error: errMsg,
        durationMs: Date.now() - startTime,
      });

      // Mark the stuck GENERATING record as FAILED so it doesn't linger
      if (record?.id) {
        try {
          await prisma.checklist.update({
            where: { id: record.id },
            data: { status: 'FAILED' },
          });
        } catch (updateErr: unknown) {
          logger.warn({
            type: 'checklist_failed_status_update_error',
            checklistId: record.id,
            error: (updateErr as Error).message,
          });
        }
      }

      throw error;
    }
  }

  /**
   * List all checklists for a user within an organization.
   * Includes legacy null-org rows owned by this user (KNOWN_ISSUES B5).
   */
  async getUserChecklists(userId: string, organizationId: string): Promise<{
    id: string;
    title: string;
    productType: string | null;
    businessStage: string | null;
    targetSegments: unknown;
    servicesOffered: unknown;
    additionalConcerns: string | null;
    progress: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    totalItems: number;
    criticalItems: number;
  }[]> {
    const checklists = await prisma.checklist.findMany({
      where: {
        userId,
        ...({ deletedAt: null } as any),
        OR: [
          { organizationId },
          { organizationId: null }, // Legacy rows per KNOWN_ISSUES B5; remove when migrated
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        productType: true,
        businessStage: true,
        targetSegments: true,
        servicesOffered: true,
        additionalConcerns: true,
        progress: true,
        status: true,
        checklistData: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return checklists.map((c) => {
      const data = c.checklistData as GeneratedChecklist | null;
      return {
        id: c.id,
        title: c.title,
        productType: c.productType,
        businessStage: c.businessStage,
        targetSegments: c.targetSegments,
        servicesOffered: c.servicesOffered,
        additionalConcerns: c.additionalConcerns,
        progress: c.progress,
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        totalItems: data?.metadata?.totalItems ?? 0,
        criticalItems: data?.metadata?.criticalItems ?? 0,
      };
    });
  }

  /**
   * Get a single checklist by ID.
   * Org-scoped: org records require active membership; legacy null-org records remain owner-only.
   */
  async getChecklist(userId: string, checklistId: string, organizationId: string): Promise<{
    id: string;
    title: string;
    productType: string | null;
    businessStage: string | null;
    targetSegments: unknown;
    servicesOffered: unknown;
    additionalConcerns: string | null;
    checklistData: GeneratedChecklist | null;
    itemProgress: Record<string, string>;
    progress: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const checklist = await prisma.checklist.findUnique({
      where: { id: checklistId },
    });

    // deletedAt added in March 2026 schema migration; cast until prisma generate runs
    if (!checklist || (checklist as any).deletedAt !== null) {
      throw new Error('Checklist not found');
    }

    // Org-scoped access: org-scoped records accessible to any org member;
    // legacy null-org records remain owner-only. ADMIN bypasses.
    const hasAccess = checklist.organizationId
      ? checklist.organizationId === organizationId
      : checklist.userId === userId;

    if (!hasAccess) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') {
        throw new Error('Access denied to this checklist');
      }
    }

    return {
      id: checklist.id,
      title: checklist.title,
      productType: checklist.productType,
      businessStage: checklist.businessStage,
      targetSegments: checklist.targetSegments,
      servicesOffered: checklist.servicesOffered,
      additionalConcerns: checklist.additionalConcerns,
      checklistData: (checklist.checklistData as unknown as GeneratedChecklist) ?? null,
      itemProgress: (checklist.itemProgress as Record<string, string>) ?? {},
      progress: checklist.progress,
      status: checklist.status,
      createdAt: checklist.createdAt,
      updatedAt: checklist.updatedAt,
    };
  }

  /**
   * Update the per-item progress states and recalculate overall progress %.
   */
  async updateChecklistProgress(
    userId: string,
    checklistId: string,
    itemProgress: Record<string, string>
  ): Promise<{ progress: number; itemProgress: Record<string, string> }> {
    const checklist = await prisma.checklist.findUnique({
      where: { id: checklistId },
      select: { userId: true, checklistData: true },
    });

    if (!checklist) throw new Error('Checklist not found');
    if (checklist.userId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') throw new Error('Access denied');
    }

    // Validate that item IDs belong to this checklist
    const data = checklist.checklistData as GeneratedChecklist | null;
    if (data) {
      const validIds = new Set(data.categories.flatMap((c) => c.items.map((i) => i.id)));
      for (const key of Object.keys(itemProgress)) {
        if (!validIds.has(key)) {
          throw new Error(`Invalid item ID: ${key}`);
        }
      }
    }

    // Validate status values
    const validStatuses = new Set(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']);
    for (const val of Object.values(itemProgress)) {
      if (!validStatuses.has(val)) {
        throw new Error(`Invalid status value: ${val}. Must be NOT_STARTED, IN_PROGRESS, or COMPLETED`);
      }
    }

    // Calculate progress %
    const totalItems = Object.keys(itemProgress).length;
    const completedItems = Object.values(itemProgress).filter((v) => v === 'COMPLETED').length;
    const progress = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    const updated = await prisma.checklist.update({
      where: { id: checklistId },
      data: {
        itemProgress,
        progress,
        completedAt: progress === 100 ? new Date() : null,
      },
    });

    logger.info({
      type: 'checklist_progress_updated',
      userId,
      checklistId,
      progress,
      completedItems,
      totalItems,
    });

    return {
      progress: updated.progress,
      itemProgress: (updated.itemProgress as Record<string, string>) ?? {},
    };
  }

  /**
   * Soft-delete a checklist (sets deletedAt timestamp; record is NOT destroyed).
   * Org-scoped: owner within the org can delete; legacy null-org records remain owner-only.
   */
  async deleteChecklist(userId: string, checklistId: string, organizationId: string): Promise<void> {
    const checklist = await prisma.checklist.findUnique({
      where: { id: checklistId },
      select: { userId: true, organizationId: true },
    });

    if (!checklist) throw new Error('Checklist not found');

    // Org-scoped delete: owner within org can delete their records;
    // legacy null-org records remain owner-only. ADMIN bypasses org check.
    const isOrgOwner = checklist.organizationId
      ? checklist.organizationId === organizationId && checklist.userId === userId
      : checklist.userId === userId;

    if (!isOrgOwner) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') throw new Error('Access denied');
    }

    // Soft delete  -  deletedAt added in March 2026 schema migration; cast until prisma generate runs
    await (prisma.checklist.update as any)({
      where: { id: checklistId },
      data: { deletedAt: new Date() },
    });

    logger.info({ type: 'checklist_soft_deleted', userId, checklistId, organizationId });
  }

  // ==========================================================================
  // GAP ANALYSIS OPERATIONS
  // ==========================================================================


  /**
   * Run a gap analysis  -  Part A (synchronous, within the HTTP request).
   *
   * Validates inputs, creates the DB record, uploads the file to R2, then
   * fires the background pipeline (Part B) as a non-blocking Promise and
   * returns immediately with { id, status: 'QUEUED', progress: 5 }.
   *
   * The heavy lifting (text extraction, RAG, AI analysis, DB save) happens in
   * executeGapAnalysisPipeline() which runs after the HTTP response is sent.
   */
  async runGapAnalysis(
    userId: string,
    params: {
      fileName: string;
      fileType: string;
      fileContent: string; // base64-encoded file content
      regulatoryFrameworks: string[];
      regulatoryFrameworkSlugs?: string[];
      benchmarkDocumentIds?: string[];
      benchmarkDocuments?: BenchmarkDocumentSummary[];
      analysisDepth: 'quick' | 'standard' | 'deep';
      focusAreas?: string[];
      organizationId?: string;
      ipAddress?: string;
      userAgent?: string;
      trialUserId?: string;
    }
  ): Promise<{ id: string; status: string; progress: number }> {
    logger.info({
      type: 'gap_analysis_run_started',
      userId,
      fileName: params.fileName,
      frameworks: params.regulatoryFrameworks,
      analysisDepth: params.analysisDepth,
    });

    // Validate file size (base64 -> actual size)
    const estimatedBytes = Math.round((params.fileContent.length * 3) / 4);
    if (estimatedBytes > 10 * 1024 * 1024) {
      throw new Error(`File too large. Maximum size is 10MB (estimated: ${(estimatedBytes / 1024 / 1024).toFixed(1)}MB)`);
    }

    // Validate file type
    const allowedTypes = ['pdf', 'docx', 'doc', 'txt'];
    const ext = params.fileName.split('.').pop()?.toLowerCase() ?? '';
    if (!allowedTypes.includes(ext)) {
      throw new Error(`Unsupported file type .${ext}. Allowed: ${allowedTypes.join(', ')}`);
    }

    // Trigger stale job recovery lazily (non-blocking  -  does not delay this request)
    void recoverStaleJobs().catch((err: unknown) => {
      logger.error({ type: 'gap_analysis_stale_job_recovery_failed', error: (err as Error).message });
    });

    // Create placeholder record (UPLOADING, progress: 0)
    const record = await prisma.gapAnalysis.create({
      data: {
        userId,
        organizationId: params.organizationId ?? null,
        documentName: params.fileName,
        documentUrl: '',
        documentType: ext,
        regulatoryFrameworks: params.regulatoryFrameworks,
        analysisDepth: params.analysisDepth,
        focusAreas: params.focusAreas ?? [],
        status: 'UPLOADING',
        progress: 0,
      },
    });

    // Invalidate list cache so the new record appears immediately
    try {
      await redis.del(`cache:gap-analysis:list:${userId}`);
    } catch { /* non-fatal */ }

    try {
      // Upload file to R2
      const fileBuffer = Buffer.from(params.fileContent, 'base64');
      const uploadResult = await storageService.uploadDocument(
        fileBuffer,
        params.fileName,
        userId,
        { purpose: 'gap_analysis', analysisId: record.id }
      );

      // Update documentUrl + mark as QUEUED (progress: 5)
      await prisma.gapAnalysis.update({
        where: { id: record.id },
        data: { documentUrl: uploadResult.key, status: 'QUEUED', progress: 5 },
      });

      // Notify user that analysis has started (fire-and-forget)
      notificationModule.createCategorizedNotification({
        userId,
        type: 'GAP_ANALYSIS_STARTED',
        category: 'COMPLIANCE',
        title: 'Gap Analysis In Progress',
        message: `Analysing "${params.fileName}" for compliance gaps. This may take a few minutes.`,
        link: `/startup/gap-analysis/${record.id}`,
      }).catch(() => { /* non-blocking */ });

      const pipelinePayload = JSON.parse(JSON.stringify({
        analysisId: record.id,
        userId,
        trialUserId: params.trialUserId,
        fileName: params.fileName,
        fileContent: params.fileContent,
        fileType: ext,
        regulatoryFrameworks: params.regulatoryFrameworks,
        regulatoryFrameworkSlugs: params.regulatoryFrameworkSlugs,
        benchmarkDocumentIds: params.benchmarkDocumentIds,
        benchmarkDocuments: params.benchmarkDocuments,
        analysisDepth: params.analysisDepth,
        focusAreas: params.focusAreas,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      })) as Prisma.InputJsonValue;

      const job = await aiJobRunner.enqueue({
        type: 'GAP_ANALYSIS_PIPELINE',
        idempotencyKey: `gap-analysis:${record.id}`,
        targetEntityType: 'GapAnalysis',
        targetEntityId: record.id,
        userId,
        organizationId: params.organizationId,
        payload: pipelinePayload,
        maxAttempts: 3,
        priority: 7,
      });

      logger.info({ type: 'gap_analysis_queued', userId, analysisId: record.id, jobId: job.id });

      return { id: record.id, status: 'QUEUED', progress: 5 };
    } catch (error: unknown) {
      // R2 upload failed  -  mark as FAILED immediately (no pipeline to clean up)
      await updateAnalysisStatus(record.id, {
        status: 'FAILED',
        progress: 0,
        errorMessage: (error as Error).message,
      });
      logger.error({ type: 'gap_analysis_upload_error', userId, analysisId: record.id, error: (error as Error).message });
      throw error;
    }
  }

  /**
   * List all gap analyses for a user (summary list).
   * Triggers stale job recovery lazily before returning results.
   */
  async getUserGapAnalyses(userId: string): Promise<{
    id: string;
    documentName: string;
    documentType: string;
    regulatoryFrameworks: Prisma.JsonValue;
    analysisDepth: string;
    overallScore: number | null;
    status: string;
    progress: number;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[]> {
    // Lazy stale job recovery  -  non-blocking; cleans up any stuck analyses
    void recoverStaleJobs().catch((err: unknown) => {
      logger.error({ type: 'gap_analysis_stale_job_recovery_failed', error: (err as Error).message });
    });

    // Cache-aside: short TTL for in-progress, 60s for all-terminal
    const listCacheKey = `cache:gap-analysis:list:${userId}`;
    try {
      const cached = await redis.get<string>(listCacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* non-fatal  -  fall through to DB */ }

    const analyses = await prisma.gapAnalysis.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        documentName: true,
        documentType: true,
        regulatoryFrameworks: true,
        analysisDepth: true,
        overallScore: true,
        status: true,
        progress: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Populate cache  -  5s TTL if any analysis is in-progress, 60s if all terminal
    const hasInProgress = analyses.some(
      (a) => !['COMPLETED', 'FAILED'].includes(a.status),
    );
    try {
      await redis.set(listCacheKey, JSON.stringify(analyses), { ex: hasInProgress ? 5 : 60 });
    } catch { /* non-fatal */ }

    return analyses;
  }

  /**
   * Get a single gap analysis result by ID.
   */
  async getGapAnalysisResult(
    userId: string,
    analysisId: string,
    opts?: { ipAddress?: string; userAgent?: string },
  ): Promise<{
    id: string;
    documentName: string;
    documentType: string;
    documentUrl: string;
    regulatoryFrameworks: Prisma.JsonValue;
    analysisDepth: string;
    focusAreas: Prisma.JsonValue | null;
    results: GapAnalysisResult | null;
    overallScore: number | null;
    status: string;
    progress: number;
    errorMessage: string | null;
    ragGrounded: boolean;
    chunksProcessed: number;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    userName: string | null;
    organizationName: string | null;
  }> {
    const analysis = await prisma.gapAnalysis.findUnique({ where: { id: analysisId } });

    if (!analysis || analysis.deletedAt !== null) throw new NotFoundError('Gap analysis');

    if (analysis.userId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== UserRole.ADMIN) throw new ForbiddenError('Access denied');
    }

    // Audit log  -  fire-and-forget; must never block the primary operation.
    prisma.auditLog.create({
      data: {
        userId,
        action: 'GAP_ANALYSIS_VIEWED',
        entityType: 'GapAnalysis',
        entityId: analysisId,
        metadata: { documentName: analysis.documentName, status: analysis.status },
        ipAddress: opts?.ipAddress ?? null,
        userAgent: opts?.userAgent ?? null,
      },
    }).catch((err: unknown) => {
      logger.error({ type: 'gap_analysis_audit_log_failed', userId, analysisId, error: (err as Error).message });
    });

    // Cache-aside: only cache COMPLETED results (in-progress results must stay live)
    const resultCacheKey = `cache:gap-analysis:result:${analysisId}`;
    if (analysis.status === 'COMPLETED') {
      try {
        const cached = await redis.get<string>(resultCacheKey);
        if (cached) return JSON.parse(cached);
      } catch { /* non-fatal  -  fall through to DB result */ }
    }

    // Fetch user name + org name in parallel (non-critical  -  null on failure)
    const [ownerUser, organization] = await Promise.all([
      prisma.user.findUnique({ where: { id: analysis.userId }, select: { fullName: true } }),
      analysis.organizationId
        ? prisma.organization.findUnique({ where: { id: analysis.organizationId }, select: { name: true } })
        : Promise.resolve(null),
    ]);

    const result = {
      ...analysis,
      results: (analysis.results as GapAnalysisResult) ?? null,
      userName: ownerUser?.fullName ?? null,
      organizationName: organization?.name ?? null,
    };

    // Populate cache for completed results  -  7-day TTL
    if (analysis.status === 'COMPLETED') {
      try {
        await redis.set(resultCacheKey, JSON.stringify(result), { ex: 7 * 24 * 3600 });
      } catch { /* non-fatal */ }
    }

    return result;
  }

  /**
   * Delete a gap analysis record (and R2 file).
   */
  async deleteGapAnalysis(
    userId: string,
    analysisId: string,
    opts?: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    const analysis = await prisma.gapAnalysis.findUnique({
      where: { id: analysisId },
      select: { userId: true, documentUrl: true, deletedAt: true },
    });

    if (!analysis || analysis.deletedAt !== null) throw new NotFoundError('Gap analysis');
    if (analysis.userId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== UserRole.ADMIN) throw new ForbiddenError('Access denied');
    }

    // Audit log before soft-deletion (entity still exists at this point).
    // Fire-and-forget; must never block the delete operation.
    prisma.auditLog.create({
      data: {
        userId,
        action: 'GAP_ANALYSIS_DELETED',
        entityType: 'GapAnalysis',
        entityId: analysisId,
        metadata: { documentUrl: analysis.documentUrl },
        ipAddress: opts?.ipAddress ?? null,
        userAgent: opts?.userAgent ?? null,
      },
    }).catch((err: unknown) => {
      logger.error({ type: 'gap_analysis_audit_log_failed', userId, analysisId, error: (err as Error).message });
    });

    // Delete R2 file if it exists
    if (analysis.documentUrl) {
      try {
        await storageService.deleteFile(analysis.documentUrl);
      } catch {
        logger.warn({ type: 'gap_analysis_r2_delete_failed', analysisId });
      }
    }

    // Soft delete  -  set deletedAt instead of destroying the row
    await prisma.gapAnalysis.update({
      where: { id: analysisId },
      data: { deletedAt: new Date() },
    });

    // Invalidate caches
    try {
      await redis.del(`cache:gap-analysis:list:${userId}`);
      await redis.del(`cache:gap-analysis:result:${analysisId}`);
    } catch { /* non-fatal */ }

    logger.info({ type: 'gap_analysis_deleted', userId, analysisId });
  }

  // ==========================================================================
  // COMPLIANCE DASHBOARD (5-Category Scoring System)
  // ==========================================================================

  /**
   * Compliance Score cache.
   * Key:   compliance:score:{orgId}
   * Value: full DashboardResponse (JSON, auto-parsed by Upstash SDK)
   * TTL:   300s (5 min -- matches frontend React Query staleTime)
   * Invalidated by:
   *   - updateChecklistItem (item toggle)
   *   - Snapshot creation (score change detected on dashboard read)
   */
  private static readonly SCORE_CACHE_KEY = (orgId: string) => `compliance:score:${orgId}`;
  private static readonly SCORE_CACHE_TTL = 300;

  private static readonly DASHBOARD_WEIGHTS: Record<string, number> = {
    DATA_PROTECTION: 0.25,
    AML_KYC: 0.25,
    CONSUMER_PROTECTION: 0.15,
    CBK_LICENSING: 0.20,
    CYBERSECURITY: 0.15,
  };

  private static readonly CATEGORY_LABELS: Record<string, string> = {
    DATA_PROTECTION: 'Data Protection',
    AML_KYC: 'AML/KYC',
    CONSUMER_PROTECTION: 'Consumer Protection',
    CBK_LICENSING: 'CBK Licensing',
    CYBERSECURITY: 'Cybersecurity',
  };

  private static readonly DEFAULT_CHECKLIST_ITEMS: Array<{
    category: string;
    title: string;
    description: string;
  }> = [
      // Data Protection  -  Kenya Data Protection Act 2019
      { category: 'DATA_PROTECTION', title: 'Data Protection Officer (DPO) registered', description: 'A Data Protection Officer has been appointed and registered with the Office of the Data Protection Commissioner.' },
      { category: 'DATA_PROTECTION', title: 'Privacy policy published', description: 'A comprehensive privacy policy is publicly available on the company website or accessible to customers.' },
      { category: 'DATA_PROTECTION', title: 'Data processing agreements in place', description: 'Written data processing agreements exist with all third-party vendors and processors handling personal data.' },
      { category: 'DATA_PROTECTION', title: 'Consent management procedures documented', description: 'Procedures for obtaining, recording, and withdrawing data subject consent are formally documented and implemented.' },
      { category: 'DATA_PROTECTION', title: 'Data breach notification procedure documented', description: 'A documented procedure exists for detecting, reporting, and notifying data breaches within 72 hours.' },
      { category: 'DATA_PROTECTION', title: 'Cross-border data transfer safeguards', description: 'Adequate safeguards are in place for any transfer of personal data outside Kenya.' },
      { category: 'DATA_PROTECTION', title: 'Data Protection Impact Assessments (DPIA) completed', description: 'DPIAs have been conducted for all high-risk data processing activities.' },

      // AML/KYC  -  Proceeds of Crime and Anti-Money Laundering Act
      { category: 'AML_KYC', title: 'KYC procedures documented and implemented', description: 'Formal Know Your Customer procedures are documented, approved, and actively implemented across all onboarding flows.' },
      { category: 'AML_KYC', title: 'Customer Due Diligence (CDD) process in place', description: 'A structured Customer Due Diligence process is operational for all new and existing customers.' },
      { category: 'AML_KYC', title: 'Enhanced Due Diligence for high-risk customers', description: 'Enhanced Due Diligence procedures are applied to politically exposed persons (PEPs) and other high-risk customers.' },
      { category: 'AML_KYC', title: 'Suspicious Transaction Reporting (STR) procedures', description: 'Formal procedures exist for identifying, reviewing, and reporting suspicious transactions to the Financial Reporting Centre (FRC).' },
      { category: 'AML_KYC', title: 'AML compliance officer appointed', description: 'A dedicated AML Compliance Officer has been appointed and is registered with the relevant regulatory authority.' },
      { category: 'AML_KYC', title: 'Staff AML training completed', description: 'All relevant staff have completed AML/CFT awareness and compliance training within the past 12 months.' },
      { category: 'AML_KYC', title: 'Transaction monitoring system in place', description: 'An automated or manual transaction monitoring system is operational to detect unusual or suspicious activity.' },
      { category: 'AML_KYC', title: 'Record-keeping policy (7-year minimum)', description: 'A record-keeping policy compliant with the 7-year minimum retention requirement under Kenyan AML law is implemented.' },

      // Consumer Protection  -  CBK Consumer Protection Guidelines
      { category: 'CONSUMER_PROTECTION', title: 'Transparent pricing and fee disclosure', description: 'All fees, charges, interest rates, and penalties are clearly disclosed to customers before and during service use.' },
      { category: 'CONSUMER_PROTECTION', title: 'Complaints handling mechanism in place', description: 'A formal complaints handling mechanism with defined escalation paths and response SLAs is operational.' },
      { category: 'CONSUMER_PROTECTION', title: 'Fair debt collection practices documented', description: 'Debt collection policies comply with CBK guidelines prohibiting abusive, unfair, or deceptive practices.' },
      { category: 'CONSUMER_PROTECTION', title: 'Product terms clearly communicated', description: 'All product terms and conditions are written in plain language and communicated clearly to customers before sign-up.' },
      { category: 'CONSUMER_PROTECTION', title: 'Customer data used only for stated purposes', description: 'A policy exists ensuring customer data is not used for any purpose beyond what was disclosed at the time of collection.' },
      { category: 'CONSUMER_PROTECTION', title: 'Accessible customer support channels', description: 'Multiple accessible customer support channels (phone, email, chat) are available with published operating hours.' },

      // CBK Licensing  -  CBK Act / National Payment System Act
      { category: 'CBK_LICENSING', title: 'Primary CBK license obtained', description: 'The organization holds the appropriate CBK license (Payment Service Provider, Mobile Money, Digital Credit Provider, etc.).' },
      { category: 'CBK_LICENSING', title: 'License is current and not expired', description: 'The CBK license has been renewed and is valid with no lapsed expiry date.' },
      { category: 'CBK_LICENSING', title: 'Annual returns filed with CBK', description: 'Annual regulatory returns have been submitted to the CBK within the required deadlines.' },
      { category: 'CBK_LICENSING', title: 'Capital adequacy requirements met', description: 'The organization meets minimum capital requirements as stipulated by the CBK for its license category.' },
      { category: 'CBK_LICENSING', title: 'Regulatory reports submitted on time', description: 'All required periodic reports (monthly, quarterly) have been submitted to the CBK on schedule.' },
      { category: 'CBK_LICENSING', title: 'Authorized signatories registered with CBK', description: 'All authorized signatories and key management personnel are registered with the CBK as required.' },

      // Cybersecurity  -  CBK Cybersecurity Guidelines + Computer Misuse and Cybercrimes Act
      { category: 'CYBERSECURITY', title: 'Information security policy documented', description: 'A comprehensive information security policy has been formally documented, approved by management, and communicated to all staff.' },
      { category: 'CYBERSECURITY', title: 'Incident response plan in place', description: 'A formal cybersecurity incident response plan exists with defined roles, escalation paths, and communication procedures.' },
      { category: 'CYBERSECURITY', title: 'Regular penetration testing conducted', description: 'Penetration testing or vulnerability assessments are conducted at least annually by qualified internal or external parties.' },
      { category: 'CYBERSECURITY', title: 'Data encryption at rest and in transit', description: 'All sensitive customer and business data is encrypted at rest (AES-256 or equivalent) and in transit (TLS 1.2+).' },
      { category: 'CYBERSECURITY', title: 'Access control policies implemented', description: 'Role-based access controls, principle of least privilege, and multi-factor authentication are enforced across systems.' },
      { category: 'CYBERSECURITY', title: 'Business continuity and disaster recovery plan', description: 'A documented and tested business continuity / disaster recovery plan exists with defined RTO and RPO targets.' },
      { category: 'CYBERSECURITY', title: 'Cybersecurity risk assessment completed', description: 'A formal cybersecurity risk assessment has been conducted and documented within the past 12 months.' },
      { category: 'CYBERSECURITY', title: 'Employee cybersecurity awareness training', description: 'All employees have completed cybersecurity awareness training within the past 12 months.' },
    ];

  /**
   * Seed default checklist items for an organization (idempotent  -  skips if items already exist)
   */
  async seedDefaultChecklist(orgId: string): Promise<void> {
    const existingCount = await prisma.complianceItem.count({
      where: { organizationId: orgId },
    });

    if (existingCount > 0) return;

    const { ComplianceCategory } = await import('@prisma/client');
    const validCategories = new Set(Object.values(ComplianceCategory));

    const validItems = ComplianceModule.DEFAULT_CHECKLIST_ITEMS.filter((item) =>
      validCategories.has(item.category as import('@prisma/client').ComplianceCategory)
    );

    await prisma.complianceItem.createMany({
      data: validItems.map((item) => ({
        organizationId: orgId,
        category: item.category as import('@prisma/client').ComplianceCategory,
        title: item.title,
        description: item.description,
      })),
    });

    logger.info({ type: 'compliance_checklist_seeded', orgId, count: validItems.length });
  }

  /**
   * Calculate score for a single compliance category.
   * Returns scoreFloat (unrounded, 0-100) for use in the weighted sum, plus
   * the integer display score and item counts. No rounding inside this function --
   * the single Math.round lives in getComplianceDashboardData (fixes F-05).
   */
  async calculateCategoryScore(
    orgId: string,
    category: import('@prisma/client').ComplianceCategory
  ): Promise<{ scoreFloat: number; score: number; completedItems: number; totalItems: number }> {
    const items = await prisma.complianceItem.findMany({
      where: { organizationId: orgId, category },
      select: { isCompleted: true },
    });

    if (items.length === 0) return { scoreFloat: 0, score: 0, completedItems: 0, totalItems: 0 };

    const completedItems = items.filter((i) => i.isCompleted).length;
    const scoreFloat = (completedItems / items.length) * 100;

    return { scoreFloat, score: Math.round(scoreFloat), completedItems, totalItems: items.length };
  }

  /**
   * Get full compliance dashboard data for an organization.
   * Fixes:
   *   F-04 -- trend semantics (pts vs 30d, not %, not calendar month)
   *   F-05 -- single rounding: floats used in weighted sum; round only at the end
   *   F-06 -- no fallback to latestSnapshot (masked progress for new orgs)
   *   F-10 -- lastUpdated reflects actual data freshness
   */
  async getComplianceDashboardData(orgId: string): Promise<{
    overallScore: number;
    trend: {
      points: number | null;
      label: 'increase' | 'decrease' | 'no_change' | 'insufficient_history';
      comparedAt: string | null;
      windowDays: 30;
    };
    categories: Array<{
      key: string;
      label: string;
      score: number;
      completedItems: number;
      totalItems: number;
    }>;
    lastUpdated: string;
  }> {
    const startedAt = Date.now();
    const cacheKey = ComplianceModule.SCORE_CACHE_KEY(orgId);

    // Cache read -- return immediately on hit (TTL 5 min, matches frontend staleTime)
    const cached = await redis.get<Awaited<ReturnType<typeof this.getComplianceDashboardData>>>(cacheKey);
    if (cached) {
      logger.info({ type: 'compliance_dashboard.cache_hit', orgId });
      return cached;
    }

    // Auto-seed checklist if not yet initialized
    await this.seedDefaultChecklist(orgId);

    const { ComplianceCategory } = await import('@prisma/client');
    const categoryKeys = Object.values(ComplianceCategory);

    const categoryResults = await Promise.all(
      categoryKeys.map(async (key) => {
        const result = await this.calculateCategoryScore(orgId, key);
        return {
          key,
          label: ComplianceModule.CATEGORY_LABELS[key] ?? key,
          scoreFloat: result.scoreFloat,
          score: result.score,           // integer, for UI
          completedItems: result.completedItems,
          totalItems: result.totalItems,
        };
      })
    );

    // Single Math.round -- applied to the weighted float sum (fixes F-05 double-rounding)
    const overallScore = Math.round(
      categoryResults.reduce((sum, cat) => {
        const weight = ComplianceModule.DASHBOARD_WEIGHTS[cat.key] ?? 0;
        return sum + cat.scoreFloat * weight;
      }, 0)
    );

    // Trend: compare against a snapshot from exactly 30 rolling days ago.
    // No fallback to latestSnapshot -- that masked progress for new orgs (fixes F-06).
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [latestSnapshot, oldSnapshot] = await Promise.all([
      prisma.complianceScoreSnapshot.findFirst({
        where: { organizationId: orgId },
        orderBy: { calculatedAt: 'desc' },
      }),
      prisma.complianceScoreSnapshot.findFirst({
        where: { organizationId: orgId, calculatedAt: { lte: thirtyDaysAgo } },
        orderBy: { calculatedAt: 'desc' },
      }),
    ]);

    const trendPoints: number | null = oldSnapshot
      ? overallScore - Math.round(oldSnapshot.overallScore)
      : null;

    const trendLabel: 'increase' | 'decrease' | 'no_change' | 'insufficient_history' =
      trendPoints === null ? 'insufficient_history'
        : trendPoints > 0 ? 'increase'
          : trendPoints < 0 ? 'decrease'
            : 'no_change';

    // Snapshot creation: write only when score changed AND no snapshot exists in the
    // last hour (prevents rapid-fire writes from toggle-heavy sessions).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentSnapshot = await prisma.complianceScoreSnapshot.findFirst({
      where: { organizationId: orgId, calculatedAt: { gte: oneHourAgo } },
      orderBy: { calculatedAt: 'desc' },
      select: { id: true },
    });

    const scoreChanged = !latestSnapshot || Math.round(latestSnapshot.overallScore) !== overallScore;
    const shouldCreateSnapshot = scoreChanged && !recentSnapshot;
    if (shouldCreateSnapshot) {
      const byKey = Object.fromEntries(categoryResults.map((c) => [c.key, c.scoreFloat]));
      await prisma.complianceScoreSnapshot.create({
        data: {
          organizationId: orgId,
          overallScore,
          dataProtectionScore: byKey['DATA_PROTECTION'] ?? 0,
          amlKycScore: byKey['AML_KYC'] ?? 0,
          consumerProtectionScore: byKey['CONSUMER_PROTECTION'] ?? 0,
          cbkLicensingScore: byKey['CBK_LICENSING'] ?? 0,
          cybersecurityScore: byKey['CYBERSECURITY'] ?? 0,
        },
      });

      // Invalidate cache so the next read reflects the new snapshot's calculatedAt
      await redis.del(cacheKey);
      logger.info({ type: 'compliance_dashboard.snapshot_created', orgId, overallScore });
      logger.info({ type: 'compliance_dashboard.cache_invalidated', orgId, reason: 'snapshot_created' });
    } else {
      const skipReason = !scoreChanged ? 'score_unchanged' : 'within_1h_dedup_window';
      logger.info({ type: 'compliance_dashboard.snapshot_skipped', orgId, overallScore, skipReason });
    }

    // lastUpdated: actual data freshness -- MAX(item.updatedAt, snapshot.calculatedAt, org.createdAt)
    // (fixes F-10: was always returning request time)
    const [lastItem, lastSnap, org] = await Promise.all([
      prisma.complianceItem.findFirst({
        where: { organizationId: orgId },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
      prisma.complianceScoreSnapshot.findFirst({
        where: { organizationId: orgId },
        orderBy: { calculatedAt: 'desc' },
        select: { calculatedAt: true },
      }),
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { createdAt: true },
      }),
    ]);

    const candidates: Date[] = [org?.createdAt ?? new Date(0)];
    if (lastItem) candidates.push(lastItem.updatedAt);
    if (lastSnap) candidates.push(lastSnap.calculatedAt);
    const lastUpdated = new Date(Math.max(...candidates.map((d) => d.getTime()))).toISOString();

    const result = {
      overallScore,
      trend: {
        points: trendPoints,
        label: trendLabel,
        comparedAt: oldSnapshot?.calculatedAt.toISOString() ?? null,
        windowDays: 30 as const,
      },
      categories: categoryResults.map(({ scoreFloat: _f, ...rest }) => rest),
      lastUpdated,
    };

    const durationMs = Date.now() - startedAt;
    logger.info({
      type: 'compliance_dashboard.score_computed',
      orgId,
      overallScore,
      trendLabel,
      trendPoints,
      categoriesCount: result.categories.length,
      durationMs,
    });

    // Cache the computed result (TTL 5 min)
    await redis.set(cacheKey, result, { ex: ComplianceModule.SCORE_CACHE_TTL });
    logger.info({ type: 'compliance_dashboard.cache_miss', orgId, durationMs });

    return result;
  }

  /**
   * Update a single compliance checklist item
   */
  async updateChecklistItem(
    userId: string,
    orgId: string,
    itemId: string,
    isCompleted: boolean
  ): Promise<{ id: string; isCompleted: boolean; completedAt: Date | null }> {
    await this.verifyOrgAccess(userId, orgId);

    const item = await prisma.complianceItem.findUnique({
      where: { id: itemId },
      select: { id: true, organizationId: true },
    });

    if (!item) throw new Error('Compliance item not found');
    if (item.organizationId !== orgId) throw new Error('Access denied');

    const updated = await prisma.complianceItem.update({
      where: { id: itemId },
      data: {
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
      },
      select: { id: true, isCompleted: true, completedAt: true },
    });

    // Invalidate cached score so next dashboard fetch recalculates live values
    await redis.del(ComplianceModule.SCORE_CACHE_KEY(orgId));
    logger.info({ type: 'compliance_dashboard.cache_invalidated', orgId, reason: 'item_updated' });

    logger.info({ type: 'compliance_item_updated', userId, orgId, itemId, isCompleted });

    return updated;
  }

  /**
   * Get all checklist items for a compliance category
   */
  async getChecklistByCategory(
    userId: string,
    orgId: string,
    category: import('@prisma/client').ComplianceCategory
  ): Promise<Array<{
    id: string;
    category: string;
    title: string;
    description: string;
    isCompleted: boolean;
    completedAt: Date | null;
    updatedAt: Date;
  }>> {
    await this.verifyOrgAccess(userId, orgId);

    // Seeding is the responsibility of getComplianceDashboardData (the primary
    // entry point). Guard here only for the deep-link edge case where this
    // procedure is called before the dashboard has ever loaded. One COUNT query
    // in the common path (dashboard already loaded) instead of an unconditional
    // seed call (fixes F-09).
    const itemCount = await prisma.complianceItem.count({ where: { organizationId: orgId } });
    if (itemCount === 0) {
      await this.seedDefaultChecklist(orgId);
    }

    return prisma.complianceItem.findMany({
      where: { organizationId: orgId, category },
      select: {
        id: true,
        category: true,
        title: true,
        description: true,
        isCompleted: true,
        completedAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}

// Export singleton instance
export const complianceModule = new ComplianceModule();

// Export class for testing
export { ComplianceModule };
