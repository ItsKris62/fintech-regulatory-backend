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
import { redis } from '@/lib/redis/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { sendEmail } from '@/lib/email/client';
import { storageService } from '@/lib/storage/storage.service';
import { logger } from '@/utils/logger';
import { complianceScorer } from './compliance-scorer';
import { complianceAnalyzer } from './compliance-analyzer';
import { complianceTracker } from './compliance-tracker';
import type { GeneratedChecklist } from '@/lib/ai/prompts/checklist-generation';
import type { GapAnalysisResult } from '@/lib/ai/prompts/gap-analysis';
// pdf-parse and mammoth are CommonJS modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
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
      const cached = await redis.get(cacheKey);
      
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

      // 6. Generate answer using AI
      const aiResponse = await aiService.answerComplianceQuery({
        query: validated.query,
        context,
        regulatoryAreas: validated.regulatoryAreas || [],
        includeRecommendations: validated.includeRecommendations,
      } as any) as any;

      // 7. Extract citations
      const citations = this.extractCitationsFromRag(ragResults);

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
        citations,
        regulatoryAreas: detectedAreas as RegulatoryArea[],
        confidence: aiResponse.confidence || 0.85,
        recommendations: aiResponse.recommendations,
        relatedQueries: aiResponse.relatedQueries,
        processingTimeMs: Date.now() - startTime,
        createdAt: savedQuery.createdAt,
      };

      // 11. Cache result
      await redis.setex(cacheKey, QUERY_CACHE_TTL, JSON.stringify(result));

      // 12. Record rate limit usage
      await this.recordQueryUsage(userId);

      logger.info({
        type: 'compliance_query_success',
        userId,
        queryId: savedQuery.id,
        processingTimeMs: result.processingTimeMs,
      });

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
    await redis.setex(
      `${REDIS_KEYS.SUBSCRIPTION}${userId}`,
      24 * 60 * 60,
      JSON.stringify(subscription)
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
    const key = `${REDIS_KEYS.QUERY_RATE}${userId}`;
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, 3600); // 1 hour
    }

    if (count > MAX_QUERIES_PER_HOUR) {
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
    const key = `${REDIS_KEYS.QUICK_CHECK_RATE}${userId}`;
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, 3600);
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
        context += `[${result.source || 'Regulation'}] ${result.content}\n\n`;
      }
    }

    if (additionalContext) {
      context += `\nAdditional context:\n${additionalContext}`;
    }

    return context;
  }

  /**
   * Extract citations from RAG results
   */
  private extractCitationsFromRag(ragResults: any[]): any[] {
    return ragResults.map((result, index) => ({
      id: `citation-${index}`,
      source: result.source || 'Unknown',
      title: result.title || '',
      section: result.section || '',
      content: result.content?.slice(0, 500) || '',
      url: result.url,
      relevanceScore: result.score || 0.8,
      regulatoryArea: result.regulatoryArea || 'CBK',
    }));
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
   * Verify user has access to organization
   */
  private async verifyOrgAccess(
    userId: string,
    orgId: string,
    requiredRole: 'MEMBER' | 'ADMIN' | 'OWNER' = 'MEMBER'
  ): Promise<void> {
    const member = await (prisma as any).organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
    });

    if (!member) {
      throw new ComplianceError(
        'You do not have access to this organization',
        'UNAUTHORIZED',
        403
      );
    }

    const roleHierarchy = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
    const requiredLevel = roleHierarchy[requiredRole] || 1;
    const userLevel = roleHierarchy[member.role as keyof typeof roleHierarchy] || 0;

    if (userLevel < requiredLevel) {
      throw new ComplianceError(
        'Insufficient permissions for this action',
        'UNAUTHORIZED',
        403
      );
    }
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
      organizationId?: string;
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

    try {
      // 1. Create a placeholder record with GENERATING status
      const record = await prisma.checklist.create({
        data: {
          userId,
          organizationId: params.organizationId ?? null,
          title: `${params.productType} — ${params.businessStage}`,
          productType: params.productType,
          businessStage: params.businessStage,
          targetSegments: params.targetSegments,
          servicesOffered: params.servicesOffered,
          additionalConcerns: params.additionalConcerns ?? null,
          items: [], // Legacy field — kept for schema compat
          itemProgress: {},
          progress: 0,
          status: 'GENERATING',
        },
      });

      // 2. Build RAG query from product + services
      const ragQuery = `Kenya fintech compliance requirements for ${params.productType} offering ${params.servicesOffered.join(', ')} at ${params.businessStage} stage`;

      let ragContext: string | undefined;
      try {
        const ragResults = await ragService.search(ragQuery, { topK: 12, minScore: 0.6 });
        if (ragResults.length > 0) {
          ragContext = ragResults
            .map((r, i) =>
              `[REGULATORY CONTEXT ${i + 1} — ${r.documentTitle || 'Kenyan Regulation'}]\n${r.chunkText}`
            )
            .join('\n\n---\n\n');
        }
      } catch (ragErr: unknown) {
        logger.warn({
          type: 'checklist_rag_search_failed',
          userId,
          error: (ragErr as Error).message,
        });
        // Continue without RAG context — AI uses its training knowledge
      }

      // 3. Generate checklist with Claude AI
      const generatedChecklist = await aiService.generateComplianceChecklist({
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
          itemProgress[item.id] = 'NOT_STARTED';
        }
      }

      // 5. Update DB record to COMPLETED
      const updated = await prisma.checklist.update({
        where: { id: record.id },
        data: {
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
        durationMs: Date.now() - startTime,
      });

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
      logger.error({
        type: 'checklist_generate_error',
        userId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * List all checklists for a user.
   */
  async getUserChecklists(userId: string): Promise<{
    id: string;
    title: string;
    productType: string | null;
    businessStage: string | null;
    progress: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    totalItems: number;
    criticalItems: number;
  }[]> {
    const checklists = await prisma.checklist.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        productType: true,
        businessStage: true,
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
   * Ensures the requesting user owns the checklist.
   */
  async getChecklist(userId: string, checklistId: string): Promise<{
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

    if (!checklist) {
      throw new Error('Checklist not found');
    }

    // RBAC: only owner or admin can view
    if (checklist.userId !== userId) {
      // Check if user is admin
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
   * Delete a checklist (hard delete — user confirms intent).
   */
  async deleteChecklist(userId: string, checklistId: string): Promise<void> {
    const checklist = await prisma.checklist.findUnique({
      where: { id: checklistId },
      select: { userId: true },
    });

    if (!checklist) throw new Error('Checklist not found');
    if (checklist.userId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') throw new Error('Access denied');
    }

    await prisma.checklist.delete({ where: { id: checklistId } });

    logger.info({ type: 'checklist_deleted', userId, checklistId });
  }

  // ==========================================================================
  // GAP ANALYSIS OPERATIONS
  // ==========================================================================

  /**
   * Extract plain text from a file buffer based on its type.
   */
  private async extractTextFromFile(
    fileBuffer: Buffer,
    fileType: string
  ): Promise<string> {
    const ext = fileType.toLowerCase().replace('.', '');

    if (ext === 'pdf') {
      const result = await pdfParse(fileBuffer);
      return result.text;
    }

    if (ext === 'docx' || ext === 'doc') {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return result.value;
    }

    if (ext === 'txt') {
      return fileBuffer.toString('utf-8');
    }

    throw new Error(`Unsupported file type: ${ext}. Supported types: pdf, docx, txt`);
  }

  /**
   * Run a full AI+RAG gap analysis on an uploaded policy document.
   * Handles: upload to R2, text extraction, RAG retrieval, AI analysis, DB save.
   */
  async runGapAnalysis(
    userId: string,
    params: {
      fileName: string;
      fileType: string;
      fileContent: string; // base64-encoded file content
      regulatoryFrameworks: string[];
      analysisDepth: 'quick' | 'standard' | 'deep';
      focusAreas?: string[];
      organizationId?: string;
    }
  ): Promise<{
    id: string;
    status: string;
    results: GapAnalysisResult | null;
    overallScore: number | null;
    documentName: string;
    createdAt: Date;
  }> {
    logger.info({
      type: 'gap_analysis_run_started',
      userId,
      fileName: params.fileName,
      frameworks: params.regulatoryFrameworks,
      analysisDepth: params.analysisDepth,
    });

    const startTime = Date.now();

    // Validate file size (base64 → actual size)
    const estimatedBytes = Math.round((params.fileContent.length * 3) / 4);
    const maxBytes = 10 * 1024 * 1024; // 10MB
    if (estimatedBytes > maxBytes) {
      throw new Error(`File too large. Maximum size is 10MB (estimated: ${(estimatedBytes / 1024 / 1024).toFixed(1)}MB)`);
    }

    // Validate file type
    const allowedTypes = ['pdf', 'docx', 'doc', 'txt'];
    const ext = params.fileName.split('.').pop()?.toLowerCase() ?? '';
    if (!allowedTypes.includes(ext)) {
      throw new Error(`Unsupported file type .${ext}. Allowed: ${allowedTypes.join(', ')}`);
    }

    // 1. Create placeholder record with UPLOADING status
    const record = await (prisma as unknown as {
      gapAnalysis: {
        create: (args: { data: Record<string, unknown> }) => Promise<{ id: string; status: string; results: unknown; overallScore: unknown; documentName: string; createdAt: Date }>;
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<{ id: string; status: string; results: unknown; overallScore: unknown; documentName: string; createdAt: Date }>;
      };
    }).gapAnalysis.create({
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
      },
    });

    try {
      // 2. Upload to R2
      const fileBuffer = Buffer.from(params.fileContent, 'base64');
      const uploadResult = await storageService.uploadDocument(
        fileBuffer,
        params.fileName,
        userId,
        { purpose: 'gap_analysis', analysisId: record.id }
      );

      // Update document URL
      const gapAnalysisTable = (prisma as unknown as {
        gapAnalysis: {
          update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<{ id: string; status: string; results: unknown; overallScore: unknown; documentName: string; createdAt: Date }>;
        };
      }).gapAnalysis;

      await gapAnalysisTable.update({
        where: { id: record.id },
        data: { documentUrl: uploadResult.key, status: 'ANALYZING' },
      });

      // 3. Extract text from document
      const policyText = await this.extractTextFromFile(fileBuffer, ext);

      if (!policyText || policyText.trim().length < 50) {
        throw new Error('Could not extract meaningful text from the document. Please ensure it is not encrypted or image-only.');
      }

      // 4. Build RAG query from frameworks + focus areas
      const frameworkNames = params.regulatoryFrameworks.join(', ');
      const focusText = params.focusAreas?.length ? ` focusing on ${params.focusAreas.join(', ')}` : '';
      const ragQuery = `${frameworkNames} compliance requirements Kenya${focusText}`;

      let ragContext: string | undefined;
      try {
        const ragResults = await ragService.search(ragQuery, { topK: 15, minScore: 0.6 });
        if (ragResults.length > 0) {
          ragContext = ragResults
            .map((r, i) => {
              const label = r.documentTitle || 'Kenyan Regulation';
              return `[REGULATORY CONTEXT ${i + 1} — ${label}]\n${r.chunkText}`;
            })
            .join('\n\n---\n\n');
        }
      } catch (ragErr: unknown) {
        logger.warn({
          type: 'gap_analysis_rag_search_failed',
          userId,
          error: (ragErr as Error).message,
        });
      }

      // 5. Run AI gap analysis
      const gapResults = await aiService.performGapAnalysis({
        policyText,
        documentName: params.fileName,
        documentType: ext,
        regulatoryFrameworks: params.regulatoryFrameworks,
        analysisDepth: params.analysisDepth,
        focusAreas: params.focusAreas,
        ragContext,
      });

      // 6. Save completed results
      const completed = await gapAnalysisTable.update({
        where: { id: record.id },
        data: {
          results: gapResults as unknown as Record<string, unknown>,
          overallScore: gapResults.overallScore,
          status: 'COMPLETED',
        },
      });

      logger.info({
        type: 'gap_analysis_run_success',
        userId,
        analysisId: record.id,
        overallScore: gapResults.overallScore,
        totalGaps: gapResults.metadata.totalGaps,
        durationMs: Date.now() - startTime,
      });

      return {
        id: completed.id,
        status: completed.status,
        results: completed.results as GapAnalysisResult,
        overallScore: completed.overallScore as number | null,
        documentName: completed.documentName,
        createdAt: completed.createdAt,
      };
    } catch (error: unknown) {
      // Mark as FAILED and propagate
      const gapAnalysisTable = (prisma as unknown as {
        gapAnalysis: {
          update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<void>;
        };
      }).gapAnalysis;

      await gapAnalysisTable.update({
        where: { id: record.id },
        data: {
          status: 'FAILED',
          errorMessage: (error as Error).message,
        },
      });

      logger.error({
        type: 'gap_analysis_run_error',
        userId,
        analysisId: record.id,
        error: (error as Error).message,
      });

      throw error;
    }
  }

  /**
   * List all gap analyses for a user (summary list).
   */
  async getUserGapAnalyses(userId: string): Promise<{
    id: string;
    documentName: string;
    documentType: string;
    regulatoryFrameworks: unknown;
    analysisDepth: string;
    overallScore: number | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }[]> {
    const analyses = await (prisma as unknown as {
      gapAnalysis: {
        findMany: (args: { where: { userId: string }; orderBy: { createdAt: string }; select: Record<string, boolean> }) => Promise<{
          id: string;
          documentName: string;
          documentType: string;
          regulatoryFrameworks: unknown;
          analysisDepth: string;
          overallScore: number | null;
          status: string;
          createdAt: Date;
          updatedAt: Date;
        }[]>;
      };
    }).gapAnalysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        documentName: true,
        documentType: true,
        regulatoryFrameworks: true,
        analysisDepth: true,
        overallScore: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return analyses;
  }

  /**
   * Get a single gap analysis result by ID.
   */
  async getGapAnalysisResult(userId: string, analysisId: string): Promise<{
    id: string;
    documentName: string;
    documentType: string;
    documentUrl: string;
    regulatoryFrameworks: unknown;
    analysisDepth: string;
    focusAreas: unknown;
    results: GapAnalysisResult | null;
    overallScore: number | null;
    status: string;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const analysis = await (prisma as unknown as {
      gapAnalysis: {
        findUnique: (args: { where: { id: string } }) => Promise<{
          id: string;
          userId: string;
          documentName: string;
          documentType: string;
          documentUrl: string;
          regulatoryFrameworks: unknown;
          analysisDepth: string;
          focusAreas: unknown;
          results: unknown;
          overallScore: number | null;
          status: string;
          errorMessage: string | null;
          createdAt: Date;
          updatedAt: Date;
        } | null>;
      };
    }).gapAnalysis.findUnique({ where: { id: analysisId } });

    if (!analysis) throw new Error('Gap analysis not found');

    if (analysis.userId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') throw new Error('Access denied');
    }

    return {
      ...analysis,
      results: (analysis.results as GapAnalysisResult) ?? null,
    };
  }

  /**
   * Delete a gap analysis record (and R2 file).
   */
  async deleteGapAnalysis(userId: string, analysisId: string): Promise<void> {
    const analysis = await (prisma as unknown as {
      gapAnalysis: {
        findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<{ userId: string; documentUrl: string } | null>;
        delete: (args: { where: { id: string } }) => Promise<void>;
      };
    }).gapAnalysis.findUnique({
      where: { id: analysisId },
      select: { userId: true, documentUrl: true },
    });

    if (!analysis) throw new Error('Gap analysis not found');
    if (analysis.userId !== userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') throw new Error('Access denied');
    }

    // Delete R2 file if it exists
    if (analysis.documentUrl) {
      try {
        await storageService.deleteFile(analysis.documentUrl);
      } catch {
        logger.warn({ type: 'gap_analysis_r2_delete_failed', analysisId });
      }
    }

    await (prisma as unknown as { gapAnalysis: { delete: (args: { where: { id: string } }) => Promise<void> } })
      .gapAnalysis.delete({ where: { id: analysisId } });

    logger.info({ type: 'gap_analysis_deleted', userId, analysisId });
  }
}

// Export singleton instance
export const complianceModule = new ComplianceModule();

// Export class for testing
export { ComplianceModule };
