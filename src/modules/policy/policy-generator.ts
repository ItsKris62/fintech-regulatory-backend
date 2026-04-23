/**
 * Policy Generator
 * Orchestrates AI-powered policy generation with progress tracking
 */

import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import {
  type PolicyGenerationParams,
  type AIGenerationResult,
  type GenerationProgress,
  type GenerationStage,
  type CitationExtract,
  type RegulatoryArea,
  POLICY_CONSTANTS,
  PolicyError,
} from './policy.types';
import {
  extractSections,
  extractCitationsFromContent,
  generateTitle,
  getRegulatoryAreaName,
  getRegulatoryAuthority,
} from './policy.utils';

const { REDIS_KEYS, PUBSUB_CHANNELS } = POLICY_CONSTANTS;

/**
 * Policy Generator Class
 * Handles the multi-step AI policy generation process
 */
export class PolicyGenerator {
  /**
   * Generate a complete policy
   * This is an async operation that publishes progress events
   */
  async generate(
    params: PolicyGenerationParams,
    policyId: string,
    userId: string
  ): Promise<AIGenerationResult> {
    logger.info({
      type: 'policy_generation_started',
      policyId,
      userId,
      regulatoryAreas: params.regulatoryAreas,
    });

    const startTime = Date.now();

    try {
      // Stage 1: Initialize
      await this.publishProgress(policyId, 'INITIALIZING', 5, 'Initializing generation...');

      // Stage 2: Search for relevant regulations
      await this.publishProgress(policyId, 'SEARCHING_REGULATIONS', 15, 'Searching regulatory database...');
      const regulatoryContext = await this.searchRegulations(params.regulatoryAreas);

      // Stage 3: Analyze context
      await this.publishProgress(policyId, 'ANALYZING_CONTEXT', 25, 'Analyzing compliance requirements...');
      const analysisContext = await this.analyzeContext(params, regulatoryContext);

      // Stage 4: Generate outline
      await this.publishProgress(policyId, 'GENERATING_OUTLINE', 35, 'Creating policy outline...');
      const outline = await this.generateOutline(params, analysisContext);

      // Stage 5: Generate sections
      await this.publishProgress(policyId, 'GENERATING_SECTIONS', 50, 'Generating policy content...');
      const content = await this.generateContent(params, outline, analysisContext);

      // Stage 6: Extract citations
      await this.publishProgress(policyId, 'EXTRACTING_CITATIONS', 75, 'Extracting citations...');
      const citations = await this.extractCitations(content, regulatoryContext);

      // Stage 7: Verify citations (optional, can be async)
      await this.publishProgress(policyId, 'VERIFYING_CITATIONS', 85, 'Verifying legal references...');
      const verifiedCitations = await this.verifyCitations(citations, regulatoryContext);

      // Stage 8: Finalize
      await this.publishProgress(policyId, 'FINALIZING', 95, 'Finalizing policy...');
      const result = await this.finalize(params, content, verifiedCitations);

      // Complete
      const generationTime = Math.round((Date.now() - startTime) / 1000);
      await this.publishProgress(policyId, 'COMPLETED', 100, 'Policy generation complete!');

      logger.info({
        type: 'policy_generation_completed',
        policyId,
        userId,
        generationTime,
        tokensUsed: result.tokensUsed,
      });

      return {
        ...result,
        tokensUsed: result.tokensUsed,
        model: result.model,
      };
    } catch (error: any) {
      await this.publishProgress(policyId, 'FAILED', 0, `Generation failed: ${error.message}`);
      
      logger.error({
        type: 'policy_generation_failed',
        policyId,
        userId,
        error: error.message,
      });

      throw new PolicyError(
        error.message || 'Policy generation failed',
        'GENERATION_FAILED',
        500
      );
    }
  }

  /**
   * Refine an existing policy with new instructions
   */
  async refine(
    existingContent: string,
    instructions: string,
    focusAreas?: string[]
  ): Promise<{ content: string; tokensUsed: number }> {
    logger.info({
      type: 'policy_refinement_started',
      instructionsLength: instructions.length,
      focusAreas,
    });

    try {
      const prompt = this.buildRefinementPrompt(existingContent, instructions, focusAreas);
      
      const response = await (aiService as any).complete({
        prompt,
        maxTokens: 4000,
        temperature: 0.7,
      });

      return {
        content: response.content,
        tokensUsed: response.tokensUsed,
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_refinement_failed',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Stream policy generation with real-time updates
   */
  async streamGenerate(
    params: PolicyGenerationParams,
    policyId: string,
    onProgress: (progress: GenerationProgress) => void
  ): Promise<AIGenerationResult> {
    // Subscribe to progress events
    const progressKey = `${REDIS_KEYS.GENERATION_PROGRESS}${policyId}`;
    
    // Start generation in background
    const generatePromise = this.generate(params, policyId, '');

    // Poll for progress updates
    const pollInterval = setInterval(async () => {
      const progressData = await redis.get<string>(progressKey);
      if (progressData) {
        const progress: GenerationProgress = JSON.parse(progressData);
        onProgress(progress);
        
        if (progress.stage === 'COMPLETED' || progress.stage === 'FAILED') {
          clearInterval(pollInterval);
        }
      }
    }, 500);

    try {
      const result = await generatePromise;
      clearInterval(pollInterval);
      return result;
    } catch (error) {
      clearInterval(pollInterval);
      throw error;
    }
  }

  // ==========================================================================
  // PRIVATE METHODS - Generation Steps
  // ==========================================================================

  /**
   * Search for relevant regulations using RAG
   */
  private async searchRegulations(
    regulatoryAreas: RegulatoryArea[]
  ): Promise<string[]> {
    const contexts: string[] = [];

    for (const area of regulatoryAreas) {
      try {
        const areaName = getRegulatoryAreaName(area);
        const authority = getRegulatoryAuthority(area);
        
        const query = `${areaName} regulations requirements Kenya ${authority}`;
        
        const results = await ragService.search(query, {
          topK: 3,
          filter: {
            regulatoryArea: area,
          },
        });

        if (results && results.length > 0) {
          contexts.push(...results.map(function(m) { return (m as any).chunkText || (m as any).metadata?.content || ''; }));
        }
      } catch (error) {
        logger.warn({
          type: 'rag_search_warning',
          area,
          error: (error as Error).message,
        });
      }
    }

    return contexts;
  }

  /**
   * Analyze context and requirements
   */
  private async analyzeContext(
    params: PolicyGenerationParams,
    regulatoryContext: string[]
  ): Promise<string> {
    const analysisPrompt = `
Analyze the following scenario and regulatory context to identify key compliance requirements:

SCENARIO:
${params.scenario}

ORGANIZATION TYPE:
${params.organizationType}

REGULATORY AREAS:
${params.regulatoryAreas.map(area => `- ${getRegulatoryAreaName(area)}`).join('\n')}

REGULATORY CONTEXT:
${regulatoryContext.slice(0, 3).join('\n\n')}

${params.additionalContext ? `ADDITIONAL CONTEXT:\n${params.additionalContext}` : ''}

Please provide a brief analysis of:
1. Key compliance requirements
2. Potential risks and challenges
3. Priority areas to address
`;

    const response = await (aiService as any).complete({
      prompt: analysisPrompt,
      maxTokens: 1000,
      temperature: 0.5,
    });

    return response.content;
  }

  /**
   * Generate policy outline
   */
  private async generateOutline(
    params: PolicyGenerationParams,
    analysis: string
  ): Promise<string[]> {
    const outlinePrompt = `
Based on the following analysis, create a detailed outline for a ${params.detailLevel} compliance policy:

ANALYSIS:
${analysis}

TARGET AUDIENCE: ${params.targetAudience}

Create an outline with clear sections covering:
1. Purpose and Scope
2. Regulatory Framework
3. Key Definitions
4. Compliance Requirements (by regulatory area)
5. Roles and Responsibilities
6. Implementation Guidelines
7. Monitoring and Reporting
8. Non-Compliance Consequences
9. Review and Updates

Format as a numbered list of section titles.
`;

    const response = await (aiService as any).complete({
      prompt: outlinePrompt,
      maxTokens: 500,
      temperature: 0.5,
    });

    // Parse outline into sections
    const sections = (response.content as string)
      .split('\n')
      .filter((line: string) => line.match(/^\d+\./))
      .map((line: string) => line.replace(/^\d+\.\s*/, '').trim());

    return sections.length > 0 ? sections : [
      'Purpose and Scope',
      'Regulatory Framework',
      'Compliance Requirements',
      'Implementation Guidelines',
      'Monitoring and Reporting',
    ];
  }

  /**
   * Generate full policy content
   */
  private async generateContent(
    params: PolicyGenerationParams,
    outline: string[],
    analysis: string
  ): Promise<string> {
    const detailInstructions = {
      brief: 'Keep each section concise (2-3 paragraphs). Focus on key requirements only.',
      standard: 'Provide comprehensive coverage with practical details. Include examples where helpful.',
      comprehensive: 'Provide exhaustive coverage with detailed explanations, examples, checklists, and implementation steps.',
    };

    const audienceInstructions = {
      technical: 'Use technical terminology and include implementation specifics.',
      executive: 'Focus on strategic implications, risks, and business impact. Use accessible language.',
      legal: 'Use precise legal terminology and cite specific regulations.',
    };

    const contentPrompt = `
Generate a complete ${params.detailLevel} compliance policy document for a ${params.organizationType} organization in Kenya.

SCENARIO:
${params.scenario}

REGULATORY AREAS:
${params.regulatoryAreas.map(area => `- ${getRegulatoryAreaName(area)} (${getRegulatoryAuthority(area)})`).join('\n')}

ANALYSIS:
${analysis}

REQUIRED SECTIONS:
${outline.map((s, i) => `${i + 1}. ${s}`).join('\n')}

INSTRUCTIONS:
- ${detailInstructions[params.detailLevel!]}
- ${audienceInstructions[params.targetAudience!]}
- Include specific regulatory references with [Source: Name, Section X.X] format
- Use markdown formatting (## for sections, ### for subsections)
- Include practical guidance and actionable steps
${params.includeRecommendations ? '- Include recommendations at the end' : ''}

Generate the complete policy document:
`;

    const response = await (aiService as any).complete({
      prompt: contentPrompt,
      maxTokens: 8000,
      temperature: 0.7,
    });

    return response.content;
  }

  /**
   * Extract citations from generated content
   */
  private async extractCitations(
    content: string,
    regulatoryContext: string[]
  ): Promise<CitationExtract[]> {
    // First, extract citations from the content itself
    const extractedCitations = extractCitationsFromContent(content);
    
    // Add confidence scores based on context matching
    const citations: CitationExtract[] = extractedCitations.map(citation => ({
      source: (citation as any).source || '',
      title: (citation as any).title || '',
      section: (citation as any).section || null,
      content: (citation as any).content || '',
      confidence: this.calculateCitationConfidence(citation as any, regulatoryContext),
    }));

    // Use AI to find additional citations if needed
    if (citations.length < 3) {
      const additionalCitations = await this.findAdditionalCitations(content, regulatoryContext);
      citations.push(...additionalCitations);
    }

    return citations;
  }

  /**
   * Calculate confidence score for a citation
   */
  private calculateCitationConfidence(
    citation: CitationExtract,
    context: string[]
  ): number {
    let confidence = 0.5; // Base confidence

    // Check if citation source appears in context
    for (const ctx of context) {
      if (ctx.toLowerCase().includes(citation.source.toLowerCase())) {
        confidence += 0.3;
        break;
      }
    }

    // Check if section is specified
    if (citation.section) {
      confidence += 0.1;
    }

    // Check if content is provided
    if (citation.content && citation.content.length > 20) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Find additional citations using AI
   */
  private async findAdditionalCitations(
    content: string,
    context: string[]
  ): Promise<CitationExtract[]> {
    const citationPrompt = `
Based on the following policy content, identify specific legal citations and regulatory references that should be included:

POLICY CONTENT:
${content.slice(0, 3000)}

AVAILABLE REGULATORY CONTEXT:
${context.slice(0, 2).join('\n\n')}

List 3-5 specific citations in the format:
- Source: [Act/Regulation Name]
- Section: [Section number if applicable]
- Content: [Brief quote or summary]
`;

    try {
      const response = await (aiService as any).complete({
        prompt: citationPrompt,
        maxTokens: 500,
        temperature: 0.3,
      });

      // Parse citations from response
      const lines = response.content.split('\n');
      const citations: CitationExtract[] = [];
      let current: Partial<CitationExtract> = {};

      for (const line of lines) {
        if (line.includes('Source:')) {
          if (current.source) {
            citations.push({
              source: current.source,
              title: current.source,
              section: current.section || null,
              content: current.content || '',
              confidence: 0.6,
            });
          }
          current = { source: line.replace(/.*Source:\s*/, '').trim() };
        } else if (line.includes('Section:')) {
          current.section = line.replace(/.*Section:\s*/, '').trim();
        } else if (line.includes('Content:')) {
          current.content = line.replace(/.*Content:\s*/, '').trim();
        }
      }

      // Add last citation
      if (current.source) {
        citations.push({
          source: current.source,
          title: current.source,
          section: current.section || null,
          content: current.content || '',
          confidence: 0.6,
        });
      }

      return citations;
    } catch (error) {
      logger.warn({
        type: 'citation_extraction_warning',
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Verify citations against regulatory database
   */
  private async verifyCitations(
    citations: CitationExtract[],
    context: string[]
  ): Promise<CitationExtract[]> {
    return citations.map(citation => {
      // Simple verification: check if source exists in context
      const verified = context.some(ctx =>
        ctx.toLowerCase().includes(citation.source.toLowerCase().slice(0, 20))
      );

      return {
        ...citation,
        confidence: verified ? Math.min(citation.confidence + 0.2, 1.0) : citation.confidence,
      };
    });
  }

  /**
   * Finalize the policy generation result
   */
  private async finalize(
    params: PolicyGenerationParams,
    content: string,
    citations: CitationExtract[]
  ): Promise<AIGenerationResult> {
    // Extract sections
    const sections = extractSections(content);

    // Generate summary
    const summaryPrompt = `
Summarize the following policy in 2-3 sentences for executive review:

${content.slice(0, 2000)}
`;

    const summaryResponse = await (aiService as any).complete({
      prompt: summaryPrompt,
      maxTokens: 200,
      temperature: 0.5,
    });

    // Generate title if not in content
    const title = generateTitle(params.scenario, params.organizationType);

    // Generate recommendations if requested
    let recommendations: string[] = [];
    if (params.includeRecommendations) {
      const recPrompt = `
Based on this compliance policy, provide 5 actionable implementation recommendations:

${content.slice(0, 1500)}

Format as a numbered list.
`;

      const recResponse = await (aiService as any).complete({
        prompt: recPrompt,
        maxTokens: 300,
        temperature: 0.5,
      });

      recommendations = (recResponse.content as string)
        .split('\n')
        .filter((line: string) => line.match(/^\d+\./))
        .map((line: string) => line.replace(/^\d+\.\s*/, '').trim());
    }

    return {
      content,
      title,
      summary: summaryResponse.content,
      sections,
      citations,
      recommendations,
      tokensUsed: 0, // Will be calculated from all API calls
      model: 'claude-3-sonnet', // Default model
    };
  }

  // ==========================================================================
  // PRIVATE METHODS - Utilities
  // ==========================================================================

  /**
   * Build refinement prompt
   */
  private buildRefinementPrompt(
    existingContent: string,
    instructions: string,
    focusAreas?: string[]
  ): string {
    return `
You are refining an existing compliance policy. Make the requested changes while maintaining consistency and legal accuracy.

EXISTING POLICY:
${existingContent}

REFINEMENT INSTRUCTIONS:
${instructions}

${focusAreas?.length ? `FOCUS AREAS:\n${focusAreas.map(a => `- ${a}`).join('\n')}` : ''}

Provide the refined policy content, maintaining the same structure and format. Only modify the parts specified in the instructions.
`;
  }

  /**
   * Publish progress update
   */
  private async publishProgress(
    policyId: string,
    stage: GenerationStage,
    progress: number,
    message: string,
    currentSection?: string
  ): Promise<void> {
    const progressData: GenerationProgress = {
      policyId,
      stage,
      progress,
      message,
      currentSection,
    };

    const key = `${REDIS_KEYS.GENERATION_PROGRESS}${policyId}`;
    await redis.set(key, JSON.stringify(progressData), { ex: 600 }); // 10 min TTL

    // F19 (TD-008): redis.publish() was called here but no subscriber exists in this
    // codebase — SSE progress streaming uses the Redis key written above, not pub/sub.
    // Removed the orphaned publish call to eliminate the dead channel write.
    // If a pub/sub subscriber is added in a future sprint, restore this call then.
    void PUBSUB_CHANNELS; // retain import reference to avoid TS unused-var error
  }
}

// Export singleton
export const policyGenerator = new PolicyGenerator();
