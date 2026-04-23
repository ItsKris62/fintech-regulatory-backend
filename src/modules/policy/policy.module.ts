/**
 * Policy Module
 * Main module orchestrating all policy operations
 * 
 * Operations:
 * - CRUD operations for policies
 * - AI-powered policy generation
 * - Export to PDF/DOCX/JSON/Markdown
 * - Policy comparison and coverage analysis
 * - Citation management
 * - Versioning
 */

import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { mailer as _mailer } from '@/lib/email/mailer.service';
import { sendEmail } from '@/lib/email/client';
import { getSystemConfigNumber } from '@/lib/system-config';
import { logger } from '@/utils/logger';
import { config } from '@/config';
import { policyGenerator } from './policy-generator';
import { policyExporter } from './policy-exporter';
import { policyComparator } from './policy-comparator';
import {
  toPolicy,
  toPolicyWithDetails,
  toCitation,
  canEditPolicy,
  canPublishPolicy,
  canDeletePolicy,
  policyGenerationSchema,
  policyUpdateSchema,
  exportOptionsSchema,
  generatePolicyReadyEmail,
  generatePolicyFailedEmail,
} from './policy.utils';
import {
  type Policy,
  type PolicyWithDetails,
  type Citation,
  type PolicyVersion,
  type PolicyGenerationParams,
  type PolicyGenerationResult,
  type PolicyRefinementParams,
  type GenerationProgress,
  type ExportFormat,
  type ExportResult,
  type ExportOptions,
  type ComparisonResult,
  type ComplianceAnalysis,
  type PolicyFilters,
  type PaginatedPolicies,
  type RegulatoryArea,
  POLICY_CONSTANTS,
  PolicyError,
} from './policy.types';

const { REDIS_KEYS, POLICY_CACHE_TTL, MAX_GENERATIONS_PER_HOUR } = POLICY_CONSTANTS;

/**
 * Policy Module Class
 * Central orchestrator for all policy-related business logic
 */
class PolicyModule {
  private readonly appUrl: string;

  constructor() {
    this.appUrl = config.appUrl || 'http://localhost:3000';
  }

  // ==========================================================================
  // CRUD OPERATIONS
  // ==========================================================================

  /**
   * Get policy by ID
   */
  async getPolicy(userId: string, policyId: string): Promise<PolicyWithDetails> {
    logger.info({
      type: 'policy_get_started',
      userId,
      policyId,
    });

    try {
      // Check cache first
      const cacheKey = `${REDIS_KEYS.POLICY}${policyId}`;
      const cached = await redis.get<string>(cacheKey);
      
      if (cached) {
        const policy = JSON.parse(cached);
        // Verify user has access
        await this.checkAccess(userId, policy);
        return policy;
      }

      // Get from database
      const dbPolicy = await prisma.policy.findUnique({
        where: { id: policyId },
        include: {
          citations: true,
          user: {
            select: { id: true, fullName: true, email: true },
          },
          _count: {
            select: { comments: true },
          },
        },
      });

      if (!dbPolicy) {
        throw new PolicyError('Policy not found', 'POLICY_NOT_FOUND', 404);
      }

      const policy = toPolicyWithDetails(dbPolicy);

      // Check access
      await this.checkAccess(userId, policy);

      // Cache result
      await redis.set(cacheKey, JSON.stringify(policy), { ex: POLICY_CACHE_TTL });

      logger.info({
        type: 'policy_get_success',
        userId,
        policyId,
      });

      return policy;
    } catch (error: any) {
      logger.error({
        type: 'policy_get_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * List policies with filters
   */
  async listPolicies(
    userId: string,
    filters?: PolicyFilters
  ): Promise<PaginatedPolicies> {
    logger.info({
      type: 'policy_list_started',
      userId,
      filters,
    });

    try {
      const {
        status,
        regulatoryAreas,
        organizationType,
        search,
        organizationId,
        startDate,
        endDate,
        page = 1,
        limit = 20,
        sortBy = 'createdAt',
        sortOrder = 'desc',
      } = filters || {};

      // Build where clause
      const where: any = {
        OR: [
          { userId },
          { organization: { members: { some: { userId } } } },
        ],
      };

      if (status) {
        where.status = status;
      }

      if (regulatoryAreas?.length) {
        where.regulatoryAreas = { hasSome: regulatoryAreas };
      }

      if (organizationType) {
        where.organizationType = organizationType;
      }

      if (organizationId) {
        where.organizationId = organizationId;
      }

      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { content: { contains: search, mode: 'insensitive' } },
        ];
      }

      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = startDate;
        if (endDate) where.createdAt.lte = endDate;
      }

      const skip = (page - 1) * limit;

      // Get policies with pagination
      const [policies, total] = await Promise.all([
        prisma.policy.findMany({
          where,
          orderBy: { [sortBy]: sortOrder },
          skip,
          take: limit,
        }),
        prisma.policy.count({ where }),
      ]);

      logger.info({
        type: 'policy_list_success',
        userId,
        count: policies.length,
        total,
      });

      return {
        policies: policies.map(toPolicy),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_list_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update policy
   */
  async updatePolicy(
    userId: string,
    policyId: string,
    updates: {
      title?: string;
      description?: string;
      content?: string;
      regulatoryAreas?: RegulatoryArea[];
    }
  ): Promise<Policy> {
    logger.info({
      type: 'policy_update_started',
      userId,
      policyId,
      updates: Object.keys(updates),
    });

    try {
      // Validate updates
      const validated = policyUpdateSchema.parse(updates);

      // Get policy and check access
      const policy = await this.getPolicy(userId, policyId);

      // Check if editable
      if (!canEditPolicy(policy.status)) {
        throw new PolicyError(
          `Cannot edit policy with status: ${policy.status}`,
          'POLICY_LOCKED',
          403
        );
      }

      // Check if content change requires versioning
      if (validated.content && validated.content !== policy.content) {
        await this.createVersion(policy, userId, 'Content updated');
      }

      // Update policy
      const updatedPolicy = await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          ...validated,
          updatedAt: new Date(),
        },
      });

      // Invalidate cache
      await this.invalidatePolicyCache(policyId);

      logger.info({
        type: 'policy_update_success',
        userId,
        policyId,
      });

      return toPolicy(updatedPolicy);
    } catch (error: any) {
      logger.error({
        type: 'policy_update_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Delete policy (soft delete)
   */
  async deletePolicy(userId: string, policyId: string): Promise<boolean> {
    logger.info({
      type: 'policy_delete_started',
      userId,
      policyId,
    });

    try {
      // Get policy and check access
      const policy = await this.getPolicy(userId, policyId);

      // Check if deletable
      if (!canDeletePolicy(policy.status)) {
        throw new PolicyError(
          `Cannot delete policy with status: ${policy.status}`,
          'INVALID_STATUS',
          403
        );
      }

      // Soft delete
      await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          status: 'ARCHIVED',
          updatedAt: new Date(),
        },
      });

      // Invalidate cache
      await this.invalidatePolicyCache(policyId);

      logger.info({
        type: 'policy_delete_success',
        userId,
        policyId,
      });

      return true;
    } catch (error: any) {
      logger.error({
        type: 'policy_delete_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Publish policy
   */
  async publishPolicy(userId: string, policyId: string): Promise<Policy> {
    logger.info({
      type: 'policy_publish_started',
      userId,
      policyId,
    });

    try {
      const policy = await this.getPolicy(userId, policyId);

      if (!canPublishPolicy(policy.status)) {
        throw new PolicyError(
          `Cannot publish policy with status: ${policy.status}`,
          'INVALID_STATUS',
          403
        );
      }

      const updatedPolicy = await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          status: 'COMPLETED',
          publishedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await this.invalidatePolicyCache(policyId);

      logger.info({
        type: 'policy_publish_success',
        userId,
        policyId,
      });

      return toPolicy(updatedPolicy);
    } catch (error: any) {
      logger.error({
        type: 'policy_publish_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // AI GENERATION
  // ==========================================================================

  /**
   * Generate a new policy using AI
   */
  async generatePolicy(
    userId: string,
    params: PolicyGenerationParams
  ): Promise<PolicyGenerationResult> {
    logger.info({
      type: 'policy_generate_started',
      userId,
      regulatoryAreas: params.regulatoryAreas,
    });

    try {
      // Validate params
      const validated = policyGenerationSchema.parse(params);

      // Check rate limit
      await this.checkGenerationRateLimit(userId);

      // Get user info for organization
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { organizationId: true, fullName: true, email: true },
      });

      // Create policy record with GENERATING status
      const policy = await (prisma as any).policy.create({
        data: {
          title: `Generating: ${validated.scenario.slice(0, 50)}...`,
          scenario: validated.scenario,
          organizationType: validated.organizationType,
          regulatoryAreas: validated.regulatoryAreas,
          status: 'PROCESSING' as any,
          content: '',
          userId,
          organizationId: user?.organizationId,
          version: 1,
        },
      });

      // Start async generation
      this.processGeneration(policy.id, userId, validated, user?.fullName, user?.email)
        .catch(error => {
          logger.error({
            type: 'policy_generation_background_error',
            policyId: policy.id,
            error: error.message,
          });
        });

      // Record rate limit
      await this.recordGenerationAttempt(userId);

      return {
        policyId: policy.id,
        status: 'PROCESSING' as any,
        message: 'Policy generation started. You will be notified when complete.',
        estimatedTime: 120, // ~2 minutes estimated
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_generate_error',
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Process generation in background
   */
  private async processGeneration(
    policyId: string,
    userId: string,
    params: PolicyGenerationParams,
    userName?: string,
    userEmail?: string
  ): Promise<void> {
    try {
      // Generate policy content
      const result = await policyGenerator.generate(params, policyId, userId);

      // Update policy with generated content
      await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          title: result.title,
          content: result.content,
          summary: result.summary,
          status: 'COMPLETED',
          aiModel: result.model,
          tokensUsed: result.tokensUsed,
          updatedAt: new Date(),
        },
      });

      // Create citations
      if (result.citations.length > 0) {
        await (prisma as any).citation.createMany({
          data: result.citations.map(c => ({
            policyId,
            source: c.source,
            title: c.title,
            section: c.section,
            content: c.content,
            confidence: c.confidence,
            verified: false,
          })),
        });
      }

      // Record AI usage
      await (prisma as any).aiUsage.create({
        data: {
          userId,
          type: 'POLICY_GENERATION',
          tokens: result.tokensUsed,
          model: result.model,
        },
      });

      // Invalidate cache
      await this.invalidatePolicyCache(policyId);

      // Send success email
      if (userEmail && userName) {
        const policyUrl = `${this.appUrl}/policies/${policyId}`;
        const emailContent = generatePolicyReadyEmail(userName, result.title, policyUrl);
        
        await sendEmail({
          to: userEmail,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      }

      logger.info({
        type: 'policy_generation_complete',
        policyId,
        userId,
        tokensUsed: result.tokensUsed,
      });
    } catch (error: any) {
      // Update policy to failed status
      await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          status: 'FAILED',
          updatedAt: new Date(),
        },
      });

      // Send failure email
      if (userEmail && userName) {
        const retryUrl = `${this.appUrl}/policies/new`;
        const emailContent = generatePolicyFailedEmail(
          userName,
          'Policy Generation',
          error.message,
          retryUrl
        );
        
        await sendEmail({
          to: userEmail,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      }

      throw error;
    }
  }

  /**
   * Refine existing policy with new instructions
   */
  async refinePolicy(
    userId: string,
    policyId: string,
    params: PolicyRefinementParams
  ): Promise<Policy> {
    logger.info({
      type: 'policy_refine_started',
      userId,
      policyId,
    });

    try {
      // Get policy
      const policy = await this.getPolicy(userId, policyId);

      if (!canEditPolicy(policy.status)) {
        throw new PolicyError(
          `Cannot refine policy with status: ${policy.status}`,
          'POLICY_LOCKED',
          403
        );
      }

      // Create version before refinement
      await this.createVersion(policy, userId, 'Pre-refinement backup');

      // Refine using generator
      const result = await policyGenerator.refine(
        policy.content,
        params.instructions,
        params.focusAreas
      );

      // Update policy
      const updatedPolicy = await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          content: result.content,
          tokensUsed: { increment: result.tokensUsed },
          updatedAt: new Date(),
        },
      });

      // Record AI usage
      await (prisma as any).aiUsage.create({
        data: {
          userId,
          type: 'POLICY_REFINEMENT',
          tokens: result.tokensUsed,
          model: 'claude-3-sonnet',
        },
      });

      // Invalidate cache
      await this.invalidatePolicyCache(policyId);

      logger.info({
        type: 'policy_refine_success',
        userId,
        policyId,
        tokensUsed: result.tokensUsed,
      });

      return toPolicy(updatedPolicy);
    } catch (error: any) {
      logger.error({
        type: 'policy_refine_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get generation progress
   */
  async getGenerationProgress(policyId: string): Promise<GenerationProgress | null> {
    const progressKey = `${REDIS_KEYS.GENERATION_PROGRESS}${policyId}`;
    const data = await redis.get<string>(progressKey);
    
    if (!data) return null;
    return JSON.parse(data);
  }

  // ==========================================================================
  // EXPORT
  // ==========================================================================

  /**
   * Export policy to specified format
   */
  async exportPolicy(
    userId: string,
    policyId: string,
    format: ExportFormat,
    options?: ExportOptions
  ): Promise<ExportResult> {
    logger.info({
      type: 'policy_export_started',
      userId,
      policyId,
      format,
    });

    try {
      // Validate options
      const validated = options ? exportOptionsSchema.parse({ format, ...options }) : { format };

      // Check cache for existing export
      const cacheKey = `${REDIS_KEYS.EXPORT_CACHE}${policyId}:${format}`;
      const cached = await redis.get<string>(cacheKey);
      
      if (cached) {
        const cachedResult = JSON.parse(cached);
        // Check if still valid
        if (new Date(cachedResult.expiresAt) > new Date()) {
          return cachedResult;
        }
      }

      // Get policy
      const policy = await this.getPolicy(userId, policyId);

      // Export
      const result = await policyExporter.export(policy, format, validated as any);

      // Cache result
      await redis.set(
        cacheKey,
        JSON.stringify(result),
        { ex: POLICY_CONSTANTS.EXPORT_CACHE_TTL }
      );

      logger.info({
        type: 'policy_export_success',
        userId,
        policyId,
        format,
        fileSize: result.fileSize,
      });

      return result;
    } catch (error: any) {
      logger.error({
        type: 'policy_export_error',
        userId,
        policyId,
        format,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // COMPARISON & ANALYSIS
  // ==========================================================================

  /**
   * Compare multiple policies
   */
  async comparePolicies(
    userId: string,
    policyIds: string[]
  ): Promise<ComparisonResult> {
    logger.info({
      type: 'policy_compare_started',
      userId,
      policyIds,
    });

    try {
      // Get all policies
      const policies = await Promise.all(
        policyIds.map(id => this.getPolicy(userId, id))
      );

      // Compare
      const result = await policyComparator.compare(policies);

      logger.info({
        type: 'policy_compare_success',
        userId,
        policyCount: policies.length,
      });

      return result;
    } catch (error: any) {
      logger.error({
        type: 'policy_compare_error',
        userId,
        policyIds,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze policy compliance coverage
   */
  async analyzeCompliance(
    userId: string,
    policyId: string,
    requiredAreas?: RegulatoryArea[]
  ): Promise<ComplianceAnalysis> {
    logger.info({
      type: 'policy_analyze_started',
      userId,
      policyId,
    });

    try {
      const policy = await this.getPolicy(userId, policyId);

      // Default required areas for fintech
      const areas = requiredAreas || [
        'DATA_PROTECTION',
        'AML_CFT',
        'CONSUMER_PROTECTION',
        'CYBERSECURITY',
        'DIGITAL_LENDING',
      ];

      const coverage = policyComparator.analyzePolicyCoverage(policy, areas);

      // Calculate scores
      const areaScores = areas.map(area => {
        const isCovered = policy.regulatoryAreas.includes(area);
        return {
          area,
          score: isCovered ? 100 : 0,
          status: isCovered ? 'compliant' as const : 'non-compliant' as const,
          findings: isCovered
            ? [`Policy addresses ${area}`]
            : [`Missing coverage for ${area}`],
        };
      });

      const overallScore = Math.round(
        areaScores.reduce((sum, a) => sum + a.score, 0) / areaScores.length
      );

      const analysis: ComplianceAnalysis = {
        policyId,
        overallScore,
        areaScores,
        strengths: areaScores
          .filter(a => a.status === 'compliant')
          .map(a => `Comprehensive coverage of ${a.area}`),
        weaknesses: coverage.gaps.map(g => g.description),
        recommendations: coverage.gaps.map(g => g.recommendation),
        checklist: areaScores.map(a => ({
          requirement: `${a.area} compliance`,
          area: a.area,
          status: a.status === 'compliant' ? 'passed' as const : 'failed' as const,
          details: a.findings[0],
          reference: null,
        })),
        analyzedAt: new Date(),
      };

      logger.info({
        type: 'policy_analyze_success',
        userId,
        policyId,
        overallScore,
      });

      return analysis;
    } catch (error: any) {
      logger.error({
        type: 'policy_analyze_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // CITATIONS
  // ==========================================================================

  /**
   * Get citations for a policy
   */
  async getCitations(userId: string, policyId: string): Promise<Citation[]> {
    // Verify access
    await this.getPolicy(userId, policyId);

    const citations = await prisma.citation.findMany({
      where: { policyId },
      orderBy: { createdAt: 'asc' },
    });

    return citations.map(toCitation);
  }

  /**
   * Verify citations for a policy
   */
  async verifyCitations(
    userId: string,
    policyId: string
  ): Promise<{ verified: number; failed: number; citations: Citation[] }> {
    logger.info({
      type: 'policy_verify_citations_started',
      userId,
      policyId,
    });

    try {
      const citations = await this.getCitations(userId, policyId);

      // Simple verification - in production, verify against actual sources
      let verified = 0;
      let failed = 0;

      const updatedCitations = await Promise.all(
        citations.map(async citation => {
          // Simulate verification (in production, check RAG database)
          const isVerified = citation.confidence > 0.7;

          await prisma.citation.update({
            where: { id: citation.id },
            data: {
              verified: isVerified,
            },
          });

          if (isVerified) {
            verified++;
          } else {
            failed++;
          }

          return { ...citation, verified: isVerified };
        })
      );

      logger.info({
        type: 'policy_verify_citations_success',
        userId,
        policyId,
        verified,
        failed,
      });

      return {
        verified,
        failed,
        citations: updatedCitations,
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_verify_citations_error',
        userId,
        policyId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // VERSIONING
  // ==========================================================================

  /**
   * Get policy versions
   */
  async getVersions(userId: string, policyId: string): Promise<PolicyVersion[]> {
    await this.getPolicy(userId, policyId);

    const versions = await (prisma as any).policyVersion.findMany({
      where: { policyId },
      orderBy: { version: 'desc' },
    });

    return versions;
  }

  /**
   * Restore policy to a previous version
   */
  async restoreVersion(
    userId: string,
    policyId: string,
    versionId: string
  ): Promise<Policy> {
    logger.info({
      type: 'policy_restore_version_started',
      userId,
      policyId,
      versionId,
    });

    try {
      const policy = await this.getPolicy(userId, policyId);

      if (!canEditPolicy(policy.status)) {
        throw new PolicyError(
          `Cannot restore version for policy with status: ${policy.status}`,
          'POLICY_LOCKED',
          403
        );
      }

      const version = await (prisma as any).policyVersion.findUnique({
        where: { id: versionId },
      });

      if (!version || version.policyId !== policyId) {
        throw new PolicyError('Version not found', 'POLICY_NOT_FOUND', 404);
      }

      // Create current version backup
      await this.createVersion(policy, userId, 'Pre-restore backup');

      // Restore content
      const updatedPolicy = await (prisma as any).policy.update({
        where: { id: policyId },
        data: {
          title: version.title,
          content: version.content,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      await this.invalidatePolicyCache(policyId);

      logger.info({
        type: 'policy_restore_version_success',
        userId,
        policyId,
        restoredVersion: version.version,
      });

      return toPolicy(updatedPolicy);
    } catch (error: any) {
      logger.error({
        type: 'policy_restore_version_error',
        userId,
        policyId,
        versionId,
        error: error.message,
      });
      throw error;
    }
  }

  // ==========================================================================
  // PRIVATE HELPER METHODS
  // ==========================================================================

  /**
   * Check if user has access to policy
   */
  private async checkAccess(userId: string, policy: Policy | PolicyWithDetails): Promise<void> {
    // Owner has access
    if (policy.userId === userId) return;

    // Organization member has access
    if (policy.organizationId) {
      const member = await (prisma as any).organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: policy.organizationId,
          },
        },
      });

      if (member) return;
    }

    throw new PolicyError(
      'You do not have access to this policy',
      'INSUFFICIENT_PERMISSIONS',
      403
    );
  }

  /**
   * Check generation rate limit
   */
  private async checkGenerationRateLimit(userId: string): Promise<void> {
    const key = `${REDIS_KEYS.GENERATION_RATE}${userId}`;
    const count = await redis.get<string>(key);
    const limit = await getSystemConfigNumber('maxPoliciesPerHour', MAX_GENERATIONS_PER_HOUR);

    if (count && parseInt(count) >= limit) {
      throw new PolicyError(
        `Rate limit exceeded. Maximum ${limit} policy generations per hour.`,
        'RATE_LIMIT_EXCEEDED',
        429
      );
    }
  }

  /**
   * Record generation attempt for rate limiting
   */
  private async recordGenerationAttempt(userId: string): Promise<void> {
    // F18 (TD-008): Atomic single-call set+TTL on first write eliminates the
    // incr+expire race where the key could persist forever if the process died
    // between the two calls. Fail-open: Redis errors are non-fatal here.
    try {
      const key = `${REDIS_KEYS.GENERATION_RATE}${userId}`;
      const count = await redis.incr(key);
      if (count === 1) {
        // Set TTL on first write — no nx flag needed (always overwrite is correct here)
        await redis.set(key, String(count), { ex: 3600 });
      }
    } catch {
      // Non-fatal: rate limit tracking failure must not block policy generation.
    }
  }

  /**
   * Create a policy version
   */
  private async createVersion(
    policy: Policy | PolicyWithDetails,
    userId: string,
    changeDescription: string
  ): Promise<void> {
    await (prisma as any).policyVersion.create({
      data: {
        policyId: policy.id,
        version: policy.version,
        title: policy.title,
        content: policy.content,
        changeDescription,
        createdBy: userId,
      },
    });

    // Increment policy version
    await (prisma as any).policy.update({
      where: { id: policy.id },
      data: { version: { increment: 1 } },
    });
  }

  /**
   * Invalidate policy cache
   */
  private async invalidatePolicyCache(policyId: string): Promise<void> {
    await redis.del(`${REDIS_KEYS.POLICY}${policyId}`);
    
    // Also clear export caches
    const exportFormats = ['PDF', 'DOCX', 'JSON', 'MARKDOWN'];
    for (const format of exportFormats) {
      await redis.del(`${REDIS_KEYS.EXPORT_CACHE}${policyId}:${format}`);
    }
  }
}

// Export singleton instance
export const policyModule = new PolicyModule();

// Export class for testing
export { PolicyModule };
