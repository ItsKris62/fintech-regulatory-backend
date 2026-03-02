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
import { logger } from '@/utils/logger';
import { complianceScorer } from './compliance-scorer';
import { complianceAnalyzer } from './compliance-analyzer';
import { complianceTracker } from './compliance-tracker';
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
        regulatoryAreas: (originalQuery.regulatoryAreas as RegulatoryArea[]) ?? [],
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
          regulatoryAreas: q.regulatoryAreas,
          confidence: q.confidence ?? undefined,
          recommendations: Array.isArray(q.recommendations) ? q.recommendations : undefined,
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
}

// Export singleton instance
export const complianceModule = new ComplianceModule();

// Export class for testing
export { ComplianceModule };
