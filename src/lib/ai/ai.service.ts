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
  parseChecklistOutput,
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
} from './prompts/gap-analysis';
import { aiConfig } from '@/config/ai.config';
import { logger } from '@/utils/logger';
import { policyProgressPubSub } from '@/lib/redis/pubsub';

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
 * Progress update emitted by streamComplianceChecklist()
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

    const systemPrompt = generateComplianceSystemPrompt();
    const userPrompt = generateComplianceUserPrompt(params);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: aiConfig.parameters.queryMaxTokens,
        temperature: aiConfig.parameters.queryTemperature,
      },
      'query',
      aiConfig.caching.ttl.complianceQuery // Cache for 24 hours
    );

    const sections = extractAnswerSections(result.content);

    logger.info({
      type: 'compliance_query_complete',
      cost: result.cost,
      citationCount: sections.citations.length,
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
    followUpQuestion: string
  ): Promise<ComplianceQueryResult> {
    logger.info({
      type: 'followup_query_started',
    });

    const systemPrompt = generateComplianceSystemPrompt();
    const userPrompt = generateFollowUpQueryPrompt(
      originalQuestion,
      originalAnswer,
      followUpQuestion
    );

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: aiConfig.parameters.queryMaxTokens,
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
   * @param params Checklist generation parameters including product type, stage, services
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

    const systemPrompt = generateChecklistSystemPrompt();
    const userPrompt = generateChecklistUserPrompt(params);

    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: aiConfig.parameters.checklistMaxTokens,
        temperature: 0.2, // Low temperature for factual legal content
      },
      'checklist'
    );

    // Detect truncation before attempting to parse — a truncated response will
    // always produce malformed JSON and retrying with the same token budget won't help.
    if (result.stopReason === 'max_tokens') {
      logger.warn({
        type: 'checklist_response_truncated',
        outputTokens: result.outputTokens,
        maxTokens: aiConfig.parameters.checklistMaxTokens,
      });
      const partial = this.attemptPartialParse<GeneratedChecklist>(result.content);
      if (partial) {
        logger.info({ type: 'checklist_partial_recovered', outputTokens: result.outputTokens });
        return { checklist: partial, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      }
      throw new Error(
        `AI response was truncated at ${result.outputTokens} tokens and could not be partially recovered`
      );
    }

    // Parse and validate the JSON response
    let checklist: GeneratedChecklist;
    let inputTokens = result.inputTokens;
    let outputTokens = result.outputTokens;
    try {
      checklist = parseChecklistOutput(result.content);
    } catch (parseError: unknown) {
      // Retry once with a simplified prompt on parse failure
      logger.warn({
        type: 'checklist_parse_retry',
        error: (parseError as Error).message,
      });
      const retryResult = await complete(
        {
          prompt: userPrompt + '\n\nIMPORTANT: Return ONLY valid JSON, starting with { and ending with }. No other text.',
          systemPrompt,
          maxTokens: aiConfig.parameters.checklistMaxTokens,
          temperature: 0.1,
        },
        'checklist'
      );
      inputTokens += retryResult.inputTokens;
      outputTokens += retryResult.outputTokens;
      if (retryResult.stopReason === 'max_tokens') {
        logger.warn({
          type: 'checklist_retry_response_truncated',
          outputTokens: retryResult.outputTokens,
          maxTokens: aiConfig.parameters.checklistMaxTokens,
        });
        const partial = this.attemptPartialParse<GeneratedChecklist>(retryResult.content);
        if (partial) {
          logger.info({ type: 'checklist_retry_partial_recovered', outputTokens: retryResult.outputTokens });
          return { checklist: partial, inputTokens, outputTokens };
        }
        throw new Error(
          `AI retry response was truncated at ${retryResult.outputTokens} tokens and could not be partially recovered`
        );
      }
      checklist = parseChecklistOutput(retryResult.content);
    }

    logger.info({
      type: 'checklist_generation_complete',
      totalItems: checklist.metadata.totalItems,
      criticalItems: checklist.metadata.criticalItems,
      durationMs: Date.now() - startTime,
      cost: result.cost,
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
      const partial = this.attemptPartialParse<GapAnalysisResult>(result.content);
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

    const systemPrompt = generateGapAnalysisSystemPrompt();
    // Chunks only need to identify gaps — keep token budget lean
    const chunkMaxTokens = 3000;
    const allRawGaps: RawChunkGapItem[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    // ── Phase 1: sequential per-chunk analysis ────────────────────────────────
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
        // A single failed chunk does not abort the whole analysis — log and skip
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

    // ── Phase 2: merge / consolidate all raw gaps ─────────────────────────────
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
   * Stream checklist generation with live progress callbacks.
   *
   * Identical to generateComplianceChecklist() in terms of prompts and
   * validation, but uses the streaming client so the caller receives
   * incremental updates instead of waiting in silence for 2-3 minutes.
   *
   * Progress milestones:
   *   started  — request sent to Anthropic
   *   progress — each new JSON category detected in the stream
   *   parsing  — full response received, now validating
   *   complete — checklist parsed and ready
   *   error    — unrecoverable failure (also thrown)
   */
  async streamComplianceChecklist(
    params: ChecklistGenerationParams,
    onProgress: (update: ChecklistProgressUpdate) => void
  ): Promise<{ checklist: GeneratedChecklist; inputTokens: number; outputTokens: number }> {
    const startTime = Date.now();

    logger.info({
      type: 'checklist_stream_started',
      productType: params.productType,
      businessStage: params.businessStage,
      ragContextLength: params.ragContext?.length ?? 0,
    });

    const systemPrompt = generateChecklistSystemPrompt();
    const userPrompt = generateChecklistUserPrompt(params);

    onProgress({ type: 'started', message: 'Connecting to AI — generating your compliance checklist...' });

    let accumulatedContent = '';
    let categoriesDetected = 0;

    const result = await stream(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: aiConfig.parameters.checklistMaxTokens,
        temperature: 0.2,
        onChunk: (chunk: string) => {
          accumulatedContent += chunk;

          // Each category object opens with a "name": key — use that as a
          // low-cost signal that a new section has started streaming.
          const newCount = (accumulatedContent.match(/"name"\s*:/g) ?? []).length;
          if (newCount > categoriesDetected) {
            categoriesDetected = newCount;
            onProgress({
              type: 'progress',
              message: `Building section ${categoriesDetected}...`,
              categoriesDetected,
            });
          }
        },
      },
      'checklist'
    );

    onProgress({ type: 'parsing', message: 'Validating checklist structure...' });

    // Truncation handling — identical logic to generateComplianceChecklist
    if (result.stopReason === 'max_tokens') {
      logger.warn({
        type: 'checklist_stream_truncated',
        outputTokens: result.outputTokens,
        maxTokens: aiConfig.parameters.checklistMaxTokens,
      });
      const partial = this.attemptPartialParse<GeneratedChecklist>(result.content);
      if (partial) {
        logger.info({ type: 'checklist_stream_partial_recovered', outputTokens: result.outputTokens });
        onProgress({
          type: 'complete',
          message: 'Checklist generated (partial — some sections may be incomplete)',
          itemCount: partial.categories.reduce((sum, c) => sum + c.items.length, 0),
          categoriesDetected,
        });
        return { checklist: partial, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      }
      const err = new Error(
        `AI response was truncated at ${result.outputTokens} tokens and could not be partially recovered`
      );
      onProgress({ type: 'error', message: err.message });
      throw err;
    }

    // Parse + validate
    let checklist: GeneratedChecklist;
    try {
      checklist = parseChecklistOutput(result.content);
    } catch (parseError: unknown) {
      logger.warn({
        type: 'checklist_stream_parse_retry',
        error: (parseError as Error).message,
      });
      onProgress({ type: 'parsing', message: 'Retrying parse with stricter JSON mode...' });

      const retryResult = await complete(
        {
          prompt: userPrompt + '\n\nIMPORTANT: Return ONLY valid JSON, starting with { and ending with }. No other text.',
          systemPrompt,
          maxTokens: aiConfig.parameters.checklistMaxTokens,
          temperature: 0.1,
        },
        'checklist'
      );

      if (retryResult.stopReason === 'max_tokens') {
        const partial = this.attemptPartialParse<GeneratedChecklist>(retryResult.content);
        if (partial) {
          onProgress({
            type: 'complete',
            message: 'Checklist generated (partial — some sections may be incomplete)',
            itemCount: partial.categories.reduce((sum, c) => sum + c.items.length, 0),
            categoriesDetected,
          });
          return {
            checklist: partial,
            inputTokens: result.inputTokens + retryResult.inputTokens,
            outputTokens: result.outputTokens + retryResult.outputTokens,
          };
        }
        const err = new Error(
          `AI retry response was truncated at ${retryResult.outputTokens} tokens and could not be partially recovered`
        );
        onProgress({ type: 'error', message: err.message });
        throw err;
      }

      checklist = parseChecklistOutput(retryResult.content);

      const itemCount = checklist.categories.reduce((sum, c) => sum + c.items.length, 0);
      logger.info({
        type: 'checklist_stream_complete',
        totalItems: itemCount,
        durationMs: Date.now() - startTime,
      });
      onProgress({ type: 'complete', message: 'Checklist generated successfully', itemCount, categoriesDetected });
      return {
        checklist,
        inputTokens: result.inputTokens + retryResult.inputTokens,
        outputTokens: result.outputTokens + retryResult.outputTokens,
      };
    }

    const itemCount = checklist.metadata.totalItems;
    logger.info({
      type: 'checklist_stream_complete',
      totalItems: itemCount,
      criticalItems: checklist.metadata.criticalItems,
      durationMs: Date.now() - startTime,
      cost: result.cost,
    });

    onProgress({ type: 'complete', message: 'Checklist generated successfully', itemCount, categoriesDetected });

    return { checklist, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }

  /**
   * Attempt to recover a valid object from truncated JSON.
   * Tries a normal parse first, then closes any unclosed braces/brackets.
   * Returns null if repair fails.
   */
  private attemptPartialParse<T>(content: string): T | null {
    try {
      return JSON.parse(content) as T;
    } catch {
      let braces = 0;
      let brackets = 0;
      for (const char of content) {
        if (char === '{') braces++;
        else if (char === '}') braces--;
        else if (char === '[') brackets++;
        else if (char === ']') brackets--;
      }

      let repaired = content.trim().replace(/,\s*$/, '');
      while (brackets > 0) { repaired += ']'; brackets--; }
      while (braces > 0) { repaired += '}'; braces--; }

      try {
        const parsed = JSON.parse(repaired) as T;
        logger.info({
          type: 'partial_json_recovered',
          originalLength: content.length,
          repairedLength: repaired.length,
        });
        return parsed;
      } catch {
        logger.warn({
          type: 'partial_json_recovery_failed',
          contentTail: content.slice(-200),
        });
        return null;
      }
    }
  }
}

/**
 * Export singleton AI service instance
 */
export const aiService = new AIService();