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
  generateGapAnalysisSystemPrompt,
  generateGapAnalysisUserPrompt,
  parseGapAnalysisOutput,
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
  ): Promise<GeneratedChecklist> {
    const startTime = Date.now();

    logger.info({
      type: 'checklist_generation_started',
      productType: params.productType,
      businessStage: params.businessStage,
      ragContextLength: params.ragContext?.length ?? 0,
    });

    const systemPrompt = generateChecklistSystemPrompt();
    const userPrompt = generateChecklistUserPrompt(params);

    // Use higher token limit — checklists are dense
    const result = await complete(
      {
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 8000,
        temperature: 0.2, // Low temperature for factual legal content
      },
      'policy'
    );

    // Parse and validate the JSON response
    let checklist: GeneratedChecklist;
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
          maxTokens: 8000,
          temperature: 0.1,
        },
        'policy'
      );
      checklist = parseChecklistOutput(retryResult.content);
    }

    logger.info({
      type: 'checklist_generation_complete',
      totalItems: checklist.metadata.totalItems,
      criticalItems: checklist.metadata.criticalItems,
      durationMs: Date.now() - startTime,
      cost: result.cost,
    });

    return checklist;
  }

  /**
   * Perform AI-powered gap analysis comparing a policy document
   * against Kenyan regulatory requirements.
   * @param params Gap analysis parameters including policy text and frameworks
   */
  async performGapAnalysis(
    params: GapAnalysisParams
  ): Promise<GapAnalysisResult> {
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

    // Parse and validate JSON response
    let gapAnalysis: GapAnalysisResult;
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

    return gapAnalysis;
  }
}

/**
 * Export singleton AI service instance
 */
export const aiService = new AIService();