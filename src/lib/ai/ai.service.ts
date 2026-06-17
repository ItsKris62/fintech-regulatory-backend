import { complete, stream, AICompletionResult } from './client';
import {
  PolicyGenerationParams,
  generatePolicySystemPrompt,
  generatePolicyUserPrompt,
  generatePolicyRefinementPrompt,
  generateCitationVerificationPrompt,
  extractPolicySections,
  generateFollowUpQuestionsPrompt,
} from './prompts/policy-generation';
import {
  ComplianceQueryParams,
  generateComplianceSystemPrompt,
  generateComplianceUserPrompt,
  generateFollowUpQueryPrompt,
  generateQuickCheckPrompt,
  generateRegulatoryComparisonPrompt,
  extractAnswerSections,
  generateCitationValidationPrompt,
} from './prompts/compliance-query';
import {
  ChecklistGenerationParams,
  GeneratedChecklist,
  generateChecklistSystemPrompt,
  generateChecklistUserPrompt,
  parseWithTierSchema,
} from './prompts/checklist-generation';
import {
  GapAnalysisParams,
  GapAnalysisResult,
  RawChunkGapItem,
  PolicyChunk,
  generateGapAnalysisSystemPrompt,
  generateGapAnalysisUserPrompt,
  generateChunkAnalysisUserPrompt,
  generateMergeUserPrompt,
  parseGapAnalysisOutput,
  parseChunkAnalysisOutput,
  GapAnalysisResultSchema,
} from './prompts/gap-analysis';
import { aiConfig } from '@/config/ai.config';
import { logger } from '@/utils/logger';
import { policyProgressPubSub } from '@/lib/redis/pubsub';
import {
  buildComplianceSourceInsufficiencyAnswer,
  COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE,
  GAP_ANALYSIS_SOURCE_INSUFFICIENCY_MESSAGE,
  POLICY_SOURCE_INSUFFICIENCY_MESSAGE,
  SourceInsufficiencyError,
} from '@/lib/source-grounding/source-insufficiency';

/**
 * Policy generation result
 */
export interface PolicyGenerationResult extends AICompletionResult {
  sections: {
    executiveSummary: string;
    regulatoryLandscape: string;
    recommendations: string;
    complianceChecklist: string;
    riskAssessment: string;
    implementationRoadmap: string;
    citations: string[];
  };
  followUpQuestions?: string[];
}

/**
 * Compliance query result
 */
export interface ComplianceQueryResult extends AICompletionResult {
  sections: {
    directAnswer: string;
    legalBasis: string;
    requirements: string;
    guidance: string;
    timeline: string;
    consequences: string;
    relatedConsiderations: string;
    citations: string[];
  };
}

/**
 * Progress update emitted by executeChecklistStream() and published via
 * the in-process EventEmitter to any connected SSE client.
 */
export interface ChecklistProgressUpdate {
  type: 'started' | 'progress' | 'parsing' | 'complete' | 'error';
  message: string;
  /** How many JSON category objects have been detected so far in the stream */
  categoriesDetected?: number;
  /** Final item count (only present on 'complete') */
  itemCount?: number;
}

/**
 * Minimal JSON repair helper used exclusively by the gap-analysis truncation path.
 * Attempts brace/bracket balancing on a truncated response so parseGapAnalysisOutput
 * can still recover a partial result.  Returns null when repair fails.
 */
function repairTruncatedGapAnalysisJson(content: string): GapAnalysisResult | null {
  try {
    return parseGapAnalysisOutput(content);
  } catch { /* fall through */ }

  let braces = 0, brackets = 0;
  for (const char of content) {
    if      (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }

  let repaired = content.trim().replace(/,\s*$/, '');
  while (brackets > 0) { repaired += ']'; brackets--; }
  while (braces   > 0) { repaired += '}'; braces--;   }

  try {
    const parsed = JSON.parse(repaired);
    const result = GapAnalysisResultSchema.safeParse(parsed);
    if (!result.success) return null;
    return parseGapAnalysisOutput(JSON.stringify(result.data));
  } catch {
    return null;
  }
}

/**
 * AI Service
 * High-level service for policy generation and compliance queries
 */
export class AIService {
  /**
   * Generate policy framework
   * @param params Policy generation parameters
   * @param policyId Optional policy ID for progress tracking
   */
  async generatePolicy(
    params: PolicyGenerationParams,
    policyId?: string
  ): Promise<PolicyGenerationResult> {
    const startTime = Date.now();

    try {
      if (policyId) {
        await policyProgressPubSub.started(policyId);
      }

      logger.info({
        type: 'policy_generation_started',
        policyId,
        organizationType: params.organizationType,
        regulatoryAreas: params.regulatoryAreas,
      });

      if (!params.ragContext?.trim()) {
        const content = `## Source status

${POLICY_SOURCE_INSUFFICIENCY_MESSAGE}

## Non-legal operational next steps

- Select or attach the relevant Acts, Regulations, Guidelines, Circulars, or benchmark documents.
- Narrow the policy request to the specific framework or regulator that should ground the policy.
- Re-run policy generation after verified source material is available.

No legal obligations, citations, penalties, deadlines, thresholds, or compliance conclusions were generated.`;

        const sections = extractPolicySections(content);

        if (policyId) {
          await policyProgressPubSub.complete(policyId, { sourceInsufficient: true });
        }

        logger.warn({
          type: 'policy_generation_source_insufficient',
          policyId,
          regulatoryAreas: params.regulatoryAreas,
        });

        return {
          content,
          model: 'source-insufficiency-guard',
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          cached: false,
          stopReason: 'source_insufficient',
          sections,
          followUpQuestions: [
            'Which verified regulatory source should ground this policy?',
            'Do you want to narrow the policy to a specific framework or regulator?',
          ],
        };
      }

      // Generate prompts
      const systemPrompt = generatePolicySystemPrompt();
      const userPrompt = generatePolicyUserPrompt(params);

      if (policyId) {
        await policyProgressPubSub.analyzing(policyId);
      }

      // Get AI completion
      const result = await complete(
        {
          prompt: userPrompt,
          systemPrompt,
          maxTokens: aiConfig.parameters.policyMaxTokens,
          temperature: aiConfig.parameters.policyTemperature,
        },
        'policy',
        aiConfig.caching.ttl.policyGeneration // Cache for 1 hour
      );

      if (policyId) {
        await policyProgressPubSub.generating(policyId);
      }

      // Extract sections
      const sections = extractPolicySections(result.content);

      if (policyId) {
        await policyProgressPubSub.checklist(policyId);
      }

      // Generate follow-up questions
      const followUpResult = await complete(
        {
          prompt: generateFollowUpQuestionsPrompt(result.content),
          systemPrompt: 'You are a helpful assistant that generates clarifying questions.',
          maxTokens: 500,
        },
        'query'
      );

      const followUpQuestions = followUpResult.content
        .split('\n')
        .filter(line => /^\d+\./.test(line))
        .map(line => line.replace(/^\d+\.\s*/, '').trim());

      const generationResult: PolicyGenerationResult = {
        ...result,
        sections,
        followUpQuestions,
      };

      if (policyId) {
        await policyProgressPubSub.complete(policyId, { generationTime: Date.now() - startTime });
      }

      logger.info({
        type: 'policy_generation_complete',
        policyId,
        duration: Date.now() - startTime,
        cost: result.cost,
        citationCount: sections.citations.length,
      });

      return generationResult;
    } catch (error: any) {
      if (policyId) {
        await policyProgressPubSub.failed(policyId, error.message);
      }

      logger.error({
        type: 'policy_generation_error',
        policyId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Stream policy generation with real-time updates
   * @param params Policy generation parameters
   * @param policyId Policy ID for progress tracking
   * @param onChunk Callback for each chunk
   */
  async streamPolicy(
    params: PolicyGenerationParams,
    policyId: string,
    onChunk: (chunk: string) => void
  ): Promise<PolicyGenerationResult> {
    const startTime = Date.now();

    try {
      await policyProgressPubSub.started(policyId);

      logger.info({
        type: 'policy_streaming_started',
        policyId,
      });

      const systemPrompt = generatePolicySystemPrompt();
      const userPrompt = generatePolicyUserPrompt(params);

      let fullContent = '';

      const result = await stream(
        {
          prompt: userPrompt,
          systemPrompt,
          maxTokens: aiConfig.parameters.policyMaxTokens,
          temperature: aiConfig.parameters.policyTemperature,
          onChunk: (chunk) => {
            fullContent += chunk;
            onChunk(chunk);

            // Update progress based on content length
            const progress = Math.min(90, Math.floor((fullContent.length / 10000) * 100));
            
            // Emit progress updates at milestones
            if (progress === 25) {
              policyProgressPubSub.analyzing(policyId);
            } else if (progress === 50) {
              policyProgressPubSub.generating(policyId);
            } else if (progress === 75) {
              policyProgressPubSub.checklist(policyId);
            }
          },
        },
        'policy'
      );

      const sections = extractPolicySections(result.content);

      const generationResult: PolicyGenerationResult = {
        ...result,
        sections,
      };

      await policyProgressPubSub.complete(policyId, { generationTime: Date.now() - startTime });

      logger.info({
        type: 'policy_streaming_complete',
        policyId,
        duration: Date.now() - startTime,
        cost: result.cost,
      });

      return generationResult;
    } catch (error: any) {
      await policyProgressPubSub.failed(policyId, error.message);

      logger.error({
        type: 'policy_streaming_error',
        policyId,
        error: error.message,
      });

      throw error;
    }
  }

  /**
   * Refine existing policy
   * @param originalPolicy Original policy content
   * @param refinementInstructions Instructions for refinement
   */
  async refinePolicy(
    originalPolicy: string,
    refinementInstructions: string
  ): Promise<PolicyGenerationResult> {
    logger.info({
      type: 'policy_refinement_started',
    });

    const systemPrompt = generatePolicySystemPrompt();
    const userPrompt = generatePolicyRefinementPrompt(originalPolicy, refinementInstructions);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: aiConfig.parameters.policyMaxTokens,
        temperature: aiConfig.parameters.policyTemperature,
      },
      'policy'
    );

    const sections = extractPolicySections(result.content);

    logger.info({
      type: 'policy_refinement_complete',
      cost: result.cost,
    });

    return {
      ...result,
      sections,
    };
  }

  /**
   * Verify citations in policy
   * @param citations Array of citations to verify
   */
  async verifyCitations(citations: string[]): Promise<AICompletionResult> {
    logger.info({
      type: 'citation_verification_started',
      citationCount: citations.length,
    });

    const systemPrompt = 'You are an expert in Kenyan law and regulations. Verify the accuracy of legal citations.';
    const userPrompt = generateCitationVerificationPrompt(citations);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 2000,
        temperature: 0.3,
      },
      'verification',
      aiConfig.caching.ttl.citationVerification // Cache for 7 days
    );

    logger.info({
      type: 'citation_verification_complete',
      cost: result.cost,
    });

    return result;
  }

  /**
   * Answer compliance query
   * @param params Compliance query parameters
   */
  async answerComplianceQuery(
    params: ComplianceQueryParams
  ): Promise<ComplianceQueryResult> {
    logger.info({
      type: 'compliance_query_started',
      question: params.question.substring(0, 100),
    });

    if (!params.ragContext?.trim()) {
      const content = buildComplianceSourceInsufficiencyAnswer();
      const sections = extractAnswerSections(content);

      logger.warn({
        type: 'compliance_query_source_insufficient_ai_guard',
        question: params.question.substring(0, 100),
      });

      return {
        content,
        model: 'source-insufficiency-guard',
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        cached: false,
        stopReason: 'source_insufficient',
        sections,
      };
    }

    const systemPrompt = generateComplianceSystemPrompt();
    const userPrompt = generateComplianceUserPrompt(params);

    // Grounded answers skip the 24hr cache — injected ragContext makes each prompt unique.
    // Larger output budget when context is present (prompt is significantly longer).
    // See KNOWN_ISSUES.md §C4 for the content-hashed retrieval-cache design.
    const maxTokens = params.ragContext ? 3000 : aiConfig.parameters.queryMaxTokens;
    const cacheTtl = params.ragContext ? undefined : aiConfig.caching.ttl.complianceQuery;

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens,
        temperature: aiConfig.parameters.queryTemperature,
      },
      'query',
      cacheTtl
    );

    const sections = extractAnswerSections(result.content);

    logger.info({
      type: 'compliance_query_complete',
      cost: result.cost,
      citationCount: sections.citations.length,
      grounded: !!params.ragContext,
    });

    return {
      ...result,
      sections,
    };
  }

  /**
   * Answer follow-up compliance query
   * @param originalQuestion Original question
   * @param originalAnswer Original answer
   * @param followUpQuestion Follow-up question
   */
  async answerFollowUpQuery(
    originalQuestion: string,
    originalAnswer: string,
    followUpQuestion: string,
    ragContext?: string
  ): Promise<ComplianceQueryResult> {
    logger.info({
      type: 'followup_query_started',
      grounded: !!ragContext,
    });

    if (!ragContext?.trim()) {
      const content = buildComplianceSourceInsufficiencyAnswer();
      const sections = extractAnswerSections(content);

      logger.warn({
        type: 'followup_query_source_insufficient_ai_guard',
      });

      return {
        content,
        model: 'source-insufficiency-guard',
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        cached: false,
        stopReason: 'source_insufficient',
        sections,
      };
    }

    const systemPrompt = generateComplianceSystemPrompt();
    const userPrompt = generateFollowUpQueryPrompt(
      originalQuestion,
      originalAnswer,
      followUpQuestion,
      ragContext
    );

    const maxTokens = ragContext ? 3000 : aiConfig.parameters.queryMaxTokens;

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens,
        temperature: aiConfig.parameters.queryTemperature,
      },
      'query'
    );

    const sections = extractAnswerSections(result.content);

    logger.info({
      type: 'followup_query_complete',
      cost: result.cost,
    });

    return {
      ...result,
      sections,
    };
  }

  /**
   * Perform quick compliance check
   * @param scenario Scenario to check
   */
  async quickComplianceCheck(scenario: string): Promise<AICompletionResult> {
    logger.info({
      type: 'quick_check_started',
    });

    const systemPrompt = generateComplianceSystemPrompt();
    const userPrompt = generateQuickCheckPrompt(scenario);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 1000,
        temperature: 0.3,
      },
      'query'
    );

    logger.info({
      type: 'quick_check_complete',
      cost: result.cost,
    });

    return result;
  }

  /**
   * Compare two regulatory requirements
   * @param requirement1 First requirement
   * @param requirement2 Second requirement
   */
  async compareRequirements(
    requirement1: string,
    requirement2: string
  ): Promise<AICompletionResult> {
    logger.info({
      type: 'requirement_comparison_started',
    });

    const systemPrompt = generateComplianceSystemPrompt();
    const userPrompt = generateRegulatoryComparisonPrompt(requirement1, requirement2);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 2000,
        temperature: 0.5,
      },
      'query'
    );

    logger.info({
      type: 'requirement_comparison_complete',
      cost: result.cost,
    });

    return result;
  }

  /**
   * Validate citations in compliance answer
   * @param answer Compliance answer
   * @param citations Citations to validate
   */
  async validateAnswerCitations(
    answer: string,
    citations: string[]
  ): Promise<AICompletionResult> {
    logger.info({
      type: 'answer_citation_validation_started',
      citationCount: citations.length,
    });

    const systemPrompt = 'You are an expert in Kenyan law. Verify legal citations for accuracy.';
    const userPrompt = generateCitationValidationPrompt(answer, citations);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 1500,
        temperature: 0.3,
      },
      'verification',
      aiConfig.caching.ttl.citationVerification
    );

    logger.info({
      type: 'answer_citation_validation_complete',
      cost: result.cost,
    });

    return result;
  }

  /**
   * Generate a RAG-grounded compliance checklist for a Kenyan fintech.
   * Used by the legacy complianceModule.generateChecklist() path (non-streaming).
   * The new async path (checklistService) uses executeChecklistStream() instead.
   */
  async generateComplianceChecklist(
    params: ChecklistGenerationParams
  ): Promise<{ checklist: GeneratedChecklist; inputTokens: number; outputTokens: number }> {
    const startTime = Date.now();

    logger.info({
      type: 'checklist_generation_started',
      productType: params.productType,
      businessStage: params.businessStage,
      ragContextLength: params.ragContext?.length ?? 0,
    });

    if (!params.ragContext?.trim()) {
      logger.warn({
        type: 'checklist_generation_source_insufficient_ai_guard',
        productType: params.productType,
        businessStage: params.businessStage,
      });
      throw new SourceInsufficiencyError(COMPLIANCE_SOURCE_INSUFFICIENCY_MESSAGE);
    }

    const systemPrompt = generateChecklistSystemPrompt();
    const userPrompt   = generateChecklistUserPrompt(params);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens:   aiConfig.parameters.checklistMaxTokens,
        temperature: 0.2,
      },
      'checklist'
    );

    const logCtx = {
      input: { productType: params.productType, businessStage: params.businessStage },
    };

    // On truncation or parse failure: use parseWithTierSchema (Tier 1 strictness) which
    // applies per-category Zod validation  -  no unvalidated data reaches the database.
    let checklist: GeneratedChecklist;
    let inputTokens  = result.inputTokens;
    let outputTokens = result.outputTokens;

    if (result.stopReason === 'max_tokens') {
      logger.warn({
        type:        'checklist_response_truncated',
        outputTokens: result.outputTokens,
        maxTokens:   aiConfig.parameters.checklistMaxTokens,
      });
    }

    try {
      checklist = parseWithTierSchema(result.content, 1, logCtx);
    } catch (parseError: unknown) {
      logger.warn({
        type:  'checklist_parse_retry',
        error: (parseError as Error).message,
      });

      const retryResult = await complete(
        {
          prompt:      userPrompt + '\n\nIMPORTANT: Return ONLY valid JSON, starting with { and ending with }. No other text.',
          systemPrompt,
          maxTokens:   aiConfig.parameters.checklistMaxTokens,
          temperature: 0.1,
        },
        'checklist'
      );
      inputTokens  += retryResult.inputTokens;
      outputTokens += retryResult.outputTokens;

      if (retryResult.stopReason === 'max_tokens') {
        logger.warn({
          type:        'checklist_retry_response_truncated',
          outputTokens: retryResult.outputTokens,
        });
      }

      // Relax to Tier 2 validation on the retry  -  fewer items acceptable
      checklist = parseWithTierSchema(retryResult.content, 2, logCtx);
    }

    logger.info({
      type:         'checklist_generation_complete',
      totalItems:   checklist.metadata.totalItems,
      criticalItems: checklist.metadata.criticalItems,
      durationMs:   Date.now() - startTime,
      cost:         result.cost,
    });

    return { checklist, inputTokens, outputTokens };
  }

  /**
   * Perform AI-powered gap analysis comparing a policy document
   * against Kenyan regulatory requirements.
   * @param params Gap analysis parameters including policy text and frameworks
   */
  async performGapAnalysis(
    params: GapAnalysisParams
  ): Promise<{ result: GapAnalysisResult; inputTokens: number; outputTokens: number }> {
    const startTime = Date.now();

    logger.info({
      type: 'gap_analysis_started',
      documentName: params.documentName,
      frameworks: params.regulatoryFrameworks,
      analysisDepth: params.analysisDepth,
      policyTextLength: params.policyText.length,
      ragContextLength: params.ragContext?.length ?? 0,
    });

    if (!params.ragContext?.trim()) {
      logger.warn({
        type: 'gap_analysis_source_insufficient_ai_guard',
        documentName: params.documentName,
        frameworks: params.regulatoryFrameworks,
      });
      throw new SourceInsufficiencyError(GAP_ANALYSIS_SOURCE_INSUFFICIENCY_MESSAGE);
    }

    const systemPrompt = generateGapAnalysisSystemPrompt();
    const userPrompt = generateGapAnalysisUserPrompt(params);

    // Deep analysis gets more tokens; quick gets fewer
    const maxTokens = params.analysisDepth === 'deep' ? 8000 : params.analysisDepth === 'standard' ? 5000 : 3000;

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens,
        temperature: 0.2,
      },
      'policy'
    );

    if (result.stopReason === 'max_tokens') {
      logger.warn({
        type: 'gap_analysis_response_truncated',
        outputTokens: result.outputTokens,
        maxTokens,
      });
      const partial = repairTruncatedGapAnalysisJson(result.content);
      if (partial) {
        logger.info({ type: 'gap_analysis_partial_recovered', outputTokens: result.outputTokens });
        return { result: partial, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      }
      throw new Error(
        `AI response was truncated at ${result.outputTokens} tokens and could not be partially recovered`
      );
    }

    // Parse and validate JSON response
    let gapAnalysis: GapAnalysisResult;
    let inputTokens = result.inputTokens;
    let outputTokens = result.outputTokens;
    try {
      gapAnalysis = parseGapAnalysisOutput(result.content);
    } catch (parseError: unknown) {
      logger.warn({
        type: 'gap_analysis_parse_retry',
        error: (parseError as Error).message,
      });
      const retryResult = await complete(
        {
          prompt: userPrompt + '\n\nIMPORTANT: Return ONLY valid JSON, starting with { and ending with }. No other text.',
          systemPrompt,
          maxTokens,
          temperature: 0.1,
        },
        'policy'
      );
      inputTokens += retryResult.inputTokens;
      outputTokens += retryResult.outputTokens;
      gapAnalysis = parseGapAnalysisOutput(retryResult.content);
    }

    logger.info({
      type: 'gap_analysis_complete',
      overallScore: gapAnalysis.overallScore,
      totalGaps: gapAnalysis.metadata.totalGaps,
      criticalGaps: gapAnalysis.metadata.criticalGaps,
      durationMs: Date.now() - startTime,
      cost: result.cost,
    });

    return { result: gapAnalysis, inputTokens, outputTokens };
  }

  /**
   * Perform multi-chunk gap analysis for large policy documents.
   *
   * Phase 1 (sequential): each chunk is analysed independently using a
   * condensed prompt that returns a flat JSON array of raw gap objects.
   * Phase 2 (merge): all raw gaps are consolidated into a full
   * GapAnalysisResult by a single merge call.
   *
   * Chunks must arrive pre-sanitised (sanitizePolicyText applied by the
   * caller before chunking).
   */
  async performMultiChunkGapAnalysis(params: {
    chunks: PolicyChunk[];
    documentName: string;
    documentType: string;
    regulatoryFrameworks: string[];
    analysisDepth: 'quick' | 'standard' | 'deep';
    focusAreas?: string[];
    ragContext?: string;
  }): Promise<{ result: GapAnalysisResult; chunksProcessed: number; totalInputTokens: number; totalOutputTokens: number; totalCost: number }> {
    const startTime = Date.now();
    const { chunks, ...baseParams } = params;
    const totalChunks = chunks.length;

    logger.info({
      type: 'gap_analysis_multi_chunk_started',
      documentName: params.documentName,
      frameworks: params.regulatoryFrameworks,
      totalChunks,
    });

    if (!params.ragContext?.trim()) {
      logger.warn({
        type: 'gap_analysis_multi_chunk_source_insufficient_ai_guard',
        documentName: params.documentName,
        frameworks: params.regulatoryFrameworks,
      });
      throw new SourceInsufficiencyError(GAP_ANALYSIS_SOURCE_INSUFFICIENCY_MESSAGE);
    }

    const systemPrompt = generateGapAnalysisSystemPrompt();
    // Chunks only need to identify gaps  -  keep token budget lean
    const chunkMaxTokens = 3000;
    const allRawGaps: RawChunkGapItem[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    // -- Phase 1: sequential per-chunk analysis --------------------------------
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.info({
        type: 'gap_analysis_chunk_processing',
        chunk: i + 1,
        total: totalChunks,
        documentName: params.documentName,
      });

      const chunkPrompt = generateChunkAnalysisUserPrompt(
        { ...baseParams, chunkText: chunk.text },
        chunk.index,
        chunk.total,
      );

      let chunkGaps: RawChunkGapItem[];
      try {
        const chunkResult = await complete(
          { prompt: chunkPrompt, systemPrompt, maxTokens: chunkMaxTokens, temperature: 0.2 },
          'policy',
        );
        totalInputTokens += chunkResult.inputTokens;
        totalOutputTokens += chunkResult.outputTokens;
        totalCost += chunkResult.cost;
        chunkGaps = parseChunkAnalysisOutput(chunkResult.content, i);
      } catch (chunkErr: unknown) {
        // A single failed chunk does not abort the whole analysis  -  log and skip
        logger.error({
          type: 'gap_analysis_chunk_error',
          chunk: i + 1,
          total: totalChunks,
          error: (chunkErr as Error).message,
        });
        continue;
      }

      allRawGaps.push(...chunkGaps);
      logger.info({
        type: 'gap_analysis_chunk_complete',
        chunk: i + 1,
        total: totalChunks,
        gapsFound: chunkGaps.length,
        cumulativeGaps: allRawGaps.length,
      });
    }

    // -- Phase 2: merge / consolidate all raw gaps -----------------------------
    const mergePrompt = generateMergeUserPrompt(allRawGaps, {
      ...baseParams,
      chunkCount: totalChunks,
    });

    const mergeMaxTokens =
      params.analysisDepth === 'deep' ? 8000 : params.analysisDepth === 'standard' ? 5000 : 3000;

    let mergeCompletionResult;
    try {
      mergeCompletionResult = await complete(
        { prompt: mergePrompt, systemPrompt, maxTokens: mergeMaxTokens, temperature: 0.2 },
        'policy',
      );
    } catch {
      // Retry once with a stricter JSON-only instruction
      mergeCompletionResult = await complete(
        {
          prompt: mergePrompt + '\n\nIMPORTANT: Return ONLY valid JSON starting with { and ending with }. No other text.',
          systemPrompt,
          maxTokens: mergeMaxTokens,
          temperature: 0.1,
        },
        'policy',
      );
    }

    totalInputTokens += mergeCompletionResult.inputTokens;
    totalOutputTokens += mergeCompletionResult.outputTokens;
    totalCost += mergeCompletionResult.cost;

    let gapAnalysis: GapAnalysisResult;
    try {
      gapAnalysis = parseGapAnalysisOutput(mergeCompletionResult.content);
    } catch (parseErr: unknown) {
      logger.warn({
        type: 'gap_analysis_merge_parse_retry',
        error: (parseErr as Error).message,
      });
      const retryResult = await complete(
        {
          prompt: mergePrompt + '\n\nIMPORTANT: Return ONLY valid JSON starting with { and ending with }. No other text.',
          systemPrompt,
          maxTokens: mergeMaxTokens,
          temperature: 0.1,
        },
        'policy',
      );
      totalInputTokens += retryResult.inputTokens;
      totalOutputTokens += retryResult.outputTokens;
      totalCost += retryResult.cost;
      gapAnalysis = parseGapAnalysisOutput(retryResult.content);
    }

    // Set chunksProcessed in the metadata blob so it flows through to the DB
    gapAnalysis.metadata.chunksProcessed = totalChunks;

    logger.info({
      type: 'gap_analysis_multi_chunk_complete',
      documentName: params.documentName,
      overallScore: gapAnalysis.overallScore,
      totalGaps: gapAnalysis.metadata.totalGaps,
      chunksProcessed: totalChunks,
      totalInputTokens,
      totalOutputTokens,
      estimatedCost: totalCost,
      durationMs: Date.now() - startTime,
    });

    return {
      result: gapAnalysis,
      chunksProcessed: totalChunks,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
    };
  }

  /**
   * Lean stream executor for the three-tier checklist generation pipeline.
   *
   * Accepts pre-built prompts + tier-specific configuration.
   * Streams the AI response and emits progress callbacks.
   * Returns raw content + token counts  -  parsing and validation are the
   * caller's (checklist.service.ts runTier) responsibility.
   *
   * Does NOT retry on failure  -  the tier system in checklist.service.ts
   * provides recovery by escalating to the next tier when this throws.
   *
   * Progress milestones:
   *   started   -  request sent to Anthropic
   *   progress  -  each new JSON category detected in the stream
   *   parsing   -  full response received, ready to validate
   */
  async executeChecklistStream(
    params: {
      systemPrompt:      string;
      userPrompt:        string;
      maxTokens:         number;
      overrideTimeoutMs: number;
      temperature?:      number;
    },
    onProgress: (update: ChecklistProgressUpdate) => void
  ): Promise<{ content: string; inputTokens: number; outputTokens: number; stopReason?: string | null }> {
    const startTime = Date.now();

    logger.info({
      type:             'checklist_stream_started',
      maxTokens:        params.maxTokens,
      overrideTimeoutMs: params.overrideTimeoutMs,
    });

    onProgress({ type: 'started', message: 'Connecting to AI  -  generating your compliance checklist...' });

    let accumulatedContent = '';
    let categoriesDetected = 0;

    const result = await stream(
      {
        prompt:            params.userPrompt,
        systemPrompt:      params.systemPrompt,
        maxTokens:         params.maxTokens,
        temperature:       params.temperature ?? 0.2,
        overrideTimeoutMs: params.overrideTimeoutMs,
        onChunk: (chunk: string) => {
          accumulatedContent += chunk;

          // Count opening category objects by detecting "name": keys.
          // This is a low-cost heuristic for streaming progress  -  one match
          // per category.
          const newCount = (accumulatedContent.match(/"name"\s*:/g) ?? []).length;
          if (newCount > categoriesDetected) {
            categoriesDetected = newCount;
            onProgress({
              type:               'progress',
              message:            `Building section ${categoriesDetected}...`,
              categoriesDetected,
            });
          }
        },
      },
      'checklist'
    );

    onProgress({ type: 'parsing', message: 'Validating checklist structure...' });

    if (result.stopReason === 'max_tokens') {
      logger.warn({
        type:        'checklist_stream_truncated',
        outputTokens: result.outputTokens,
        maxTokens:   params.maxTokens,
        durationMs:  Date.now() - startTime,
      });
      // Do NOT throw here  -  the tier system calls parseWithTierSchema on the
      // returned content, which handles truncated JSON via brace-balancing +
      // per-category Zod recovery.
    }

    logger.info({
      type:       'checklist_stream_raw_complete',
      outputTokens: result.outputTokens,
      durationMs: Date.now() - startTime,
    });

    return {
      content:      result.content,
      inputTokens:  result.inputTokens,
      outputTokens: result.outputTokens,
      stopReason:   result.stopReason,
    };
  }
}

/**
 * Export singleton AI service instance
 */
export const aiService = new AIService();
