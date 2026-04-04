import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { router, protectedProcedure } from '../trpc/trpc';
import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { rateLimited, withPlanContext, requirePlanFeature, checkUsageLimit } from '../trpc/middleware';
import {
  complianceQuerySchema,
  searchDocumentsSchema,
  getQueryHistorySchema,
  getQuerySchema,
  followUpQuerySchema,
  quickCheckSchema,
} from '../schemas/compliance.schema';
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { complianceModule } from '@/modules/compliance';
import { checklistService } from '@/modules/compliance/checklist.service';
import {
  generateChecklistAsyncInputSchema,
  updateChecklistItemInputSchema,
  getChecklistStatusInputSchema,
} from '@/modules/compliance/checklist.types';
import { logger } from '@/utils/logger';
import { NotFoundError, ForbiddenError } from '@/utils/error';
import { redis } from '@/lib/redis/client';
import { incrementTrialUsage } from '@/modules/trial';
import { getQuota } from '@/utils/entitlements';
import { prisma } from '@/lib/prisma/client';
import { gapAnalysisExportService } from '@/services/gap-analysis-export.service';
import { checklistExportService } from '@/services/checklist-export.service';
import { storageService } from '@/lib/storage/storage.service';
import { GapAnalysisResultSchema } from '@/lib/ai/prompts/gap-analysis';
import { GAP_ANALYSIS_UPLOAD_LIMITS, GAP_ANALYSIS_MAX_BASE64_CHARS } from '@/config/upload-limits.config';

/**
 * Compliance Router
 *
 * Handles compliance queries with RAG-powered answers, document search,
 * and compliance checking features.
 */
export const complianceRouter = router({
  /**
   * Submit compliance query with RAG
   *
   * @protected
   * @rate-limited
   */
  query: protectedProcedure
    .use(rateLimited('complianceQuery'))
    .use(withPlanContext)
    .use(checkUsageLimit(BillingMetric.COMPLIANCE_QUERIES))
    .input(complianceQuerySchema)
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();

      try {
        logger.info({
          type: 'compliance_query_start',
          userId: ctx.user!.id,
          question: input.question.substring(0, 100),
        });

        // Search RAG for relevant context
        const ragContext = await searchAndGetContext(input.question, {
          topK: 10,
          minScore: 0.7,
        });

        // Generate answer with AI using RAG context
        const answer = await ctx.aiService.answerComplianceQuery({
          question: input.question,
          organizationType: input.organizationType,
          industry: input.industry,
          context: input.context,
        });

        // Build RAG source citations for JSON storage.
        //
        // ARCHITECTURAL NOTE: Citation.policyId is a FK → Policy.id.
        // ComplianceQuery is NOT a Policy. Inserting Citation rows with
        // policyId = complianceQuery.id violates Citation_policyId_fkey.
        // Additionally, source.documentId from the vector store is a content
        // hash (not a LegalDocument.id DB primary key), so it cannot safely
        // be used as Citation.documentId either.
        //
        // Correct pattern: store RAG source references as JSON directly on
        // ComplianceQuery.citations (Json? column). This preserves full
        // auditability and AI explainability without FK dependencies.
        const queryCitations = ragContext.results.map((source: any) => ({
          documentId: source.documentId ?? null,
          documentTitle: source.documentTitle || 'Unknown',
          section: source.section || '',
          textSnippet: (source.chunkText || '').slice(0, 500),
          score: source.score ?? 0,
          citation: source.citation ?? null,
        }));

        // Guard: warn if RAG chunks are missing documentIds (ingestion gap)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const missingDocIds = queryCitations.filter((c: any) => !c.documentId).length;
        if (missingDocIds > 0) {
          logger.warn({
            type: 'compliance_query_citations_missing_doc_ids',
            userId: ctx.user!.id,
            missingCount: missingDocIds,
            totalCount: queryCitations.length,
          });
        }

        // Persist query with citations stored atomically as JSON
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId: ctx.user!.id,
            organizationId: ctx.user!.organizationId ?? null,
            response: answer.content,
            citations: queryCitations.length > 0 ? queryCitations : undefined,
            metadata: {
              model: answer.model,
              tokensUsed: answer.inputTokens + answer.outputTokens,
              ragSources: ragContext.results.length,
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
            },
          },
        });

        // Track token usage for free trial users (fire-and-forget, non-fatal).
        if (ctx.plan === 'FREE_TRIAL') {
          incrementTrialUsage(ctx.user!.id, 'totalTokensUsed', answer.inputTokens + answer.outputTokens).catch(() => {});
        }

        const duration = Date.now() - startTime;

        logger.info({
          type: 'compliance_query_success',
          userId: ctx.user!.id,
          queryId: query.id,
          duration,
          tokensUsed: answer.inputTokens + answer.outputTokens,
          citationsCount: queryCitations.length,
        });

        return {
          queryId: query.id,
          answer: answer.content,
          citations: queryCitations,
          confidence: null,
          suggestedFollowUps: [],
        };
      } catch (error: any) {
        const duration = Date.now() - startTime;

        logger.error({
          type: 'compliance_query_error',
          userId: ctx.user!.id,
          error: error.message,
          duration,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process compliance query',
          cause: error,
        });
      }
    }),

  /**
   * Follow-up query
   *
   * @protected
   * @rate-limited
   */
  followUp: protectedProcedure
    .use(rateLimited('complianceQuery'))
    .input(followUpQuerySchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Get original query
        const originalQuery = await ctx.prisma.complianceQuery.findUnique({
          where: { id: input.originalQueryId },
        });

        if (!originalQuery) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Original query not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN' && originalQuery.userId !== ctx.user!.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Access denied to this query',
          });
        }

        // Search RAG with context from original query
        const ragContext = await searchAndGetContext(input.question, {
          topK: 10,
          minScore: 0.7,
        });

        // Generate answer with context from original query
        const answer = await ctx.aiService.answerFollowUpQuery(
          originalQuery.query,
          (originalQuery as any).answer || originalQuery.summary || '',
          input.question
        );

        // Same citation pattern as the primary query mutation:
        // store RAG source references as JSON on ComplianceQuery, not in
        // the Citation table (which has a FK constraint to Policy.id).
        const queryCitations = ragContext.results.map((source: any) => ({
          documentId: source.documentId ?? null,
          documentTitle: source.documentTitle || 'Unknown',
          section: source.section || '',
          textSnippet: (source.chunkText || '').slice(0, 500),
          score: source.score ?? 0,
          citation: source.citation ?? null,
        }));

        // Save follow-up query with citations as JSON
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId: ctx.user!.id,
            organizationId: ctx.user!.organizationId ?? null,
            response: answer.content,
            citations: queryCitations.length > 0 ? queryCitations : undefined,
            metadata: {
              followUpTo: input.originalQueryId,
              model: answer.model,
              tokensUsed: answer.inputTokens + answer.outputTokens,
            },
          },
        });

        logger.info({
          type: 'compliance_followup_success',
          userId: ctx.user!.id,
          queryId: query.id,
          originalQueryId: input.originalQueryId,
          citationsCount: queryCitations.length,
        });

        return {
          queryId: query.id,
          answer: answer.content,
          citations: queryCitations,
        };
      } catch (error: any) {
        logger.error({
          type: 'compliance_followup_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process follow-up query',
          cause: error,
        });
      }
    }),

  /**
   * Search legal documents with RAG
   *
   * @protected
   */
  search: protectedProcedure
    .input(searchDocumentsSchema)
    .query(async ({ input, ctx }) => {
      try {
        logger.info({
          type: 'compliance_search_start',
          userId: ctx.user!.id,
          query: input.query.substring(0, 100),
        });

        // Search with RAG and reranking
        const results = await ctx.ragService.searchWithReranking(input.query, {
          topK: input.limit,
          minScore: 0.7,
          filter: input.filter,
        });

        // Generate search summary
        const summary = ctx.ragService.generateSearchSummary(input.query, results);

        logger.info({
          type: 'compliance_search_success',
          userId: ctx.user!.id,
          resultsCount: results.length,
        });

        return {
          results: results.map((r: any) => ({
            text: r.chunkText,
            source: r.documentTitle,
            section: r.section,
            score: r.score,
            documentId: r.documentId,
          })),
          summary,
          totalResults: results.length,
        };
      } catch (error: any) {
        logger.error({
          type: 'compliance_search_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to search documents',
          cause: error,
        });
      }
    }),

  /**
   * Get query history
   *
   * @protected
   */
  history: protectedProcedure
    .input(getQueryHistorySchema)
    .query(async ({ input, ctx }) => {
      try {
        const { page, limit } = input;
        const skip = (page - 1) * limit;

        const where: any = {};

        // Filter by user unless admin
        if (ctx.user!.role !== 'ADMIN') {
          where.userId = ctx.user!.id;
        }

        const [queries, total] = await Promise.all([
          ctx.prisma.complianceQuery.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              query: true,
              createdAt: true,
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          }),
          ctx.prisma.complianceQuery.count({ where }),
        ]);

        return {
          queries,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        };
      } catch (error: any) {
        logger.error({
          type: 'compliance_history_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get query history',
          cause: error,
        });
      }
    }),

  /**
   * Get query by ID
   *
   * @protected
   */
  get: protectedProcedure
    .input(getQuerySchema)
    .query(async ({ input, ctx }) => {
      try {
        const query = await ctx.prisma.complianceQuery.findUnique({
          where: { id: input.id },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
          },
        });

        if (!query) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Query not found',
          });
        }

        // Check access
        if (ctx.user!.role !== 'ADMIN') {
          const hasAccess = query.userId === ctx.user!.id;

          if (!hasAccess) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Access denied to this query',
            });
          }
        }

        return query;
      } catch (error: any) {
        logger.error({
          type: 'compliance_get_query_error',
          userId: ctx.user!.id,
          queryId: input.id,
          error: error.message,
        });

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get query',
          cause: error,
        });
      }
    }),

  /**
   * Quick compliance check
   *
   * @protected
   * @rate-limited
   */
  quickCheck: protectedProcedure
    .use(rateLimited('quickCheck'))
    .input(quickCheckSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await ctx.aiService.quickComplianceCheck(input.scenario);

        logger.info({
          type: 'compliance_quick_check',
          userId: ctx.user!.id,
          organizationType: input.organizationType,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'compliance_quick_check_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to perform quick check',
          cause: error,
        });
      }
    }),

  /**
   * Get compliance score for the user's organization
   *
   * @protected
   */
  getScore: protectedProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.user!.organizationId;

      if (!orgId) {
        return { score: 0, grade: 'N/A', areas: [], calculatedAt: new Date().toISOString() };
      }

      const score = await complianceModule.calculateComplianceScore(ctx.user!.id, orgId);

      logger.info({
        type: 'compliance_score_retrieved',
        userId: ctx.user!.id,
        orgId,
      });

      return score;
    } catch (error: any) {
      logger.error({
        type: 'compliance_score_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get compliance score',
        cause: error,
      });
    }
  }),

  /**
   * Get compliance score history
   *
   * @protected
   */
  getScoreHistory: protectedProcedure
    .input(z.object({ days: z.number().min(7).max(365).default(90) }))
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          return [];
        }

        const history = await complianceModule.getComplianceScoreHistory(
          ctx.user!.id,
          orgId,
          input.days
        );

        logger.info({
          type: 'compliance_score_history_retrieved',
          userId: ctx.user!.id,
          orgId,
          days: input.days,
        });

        return history;
      } catch (error: any) {
        logger.error({
          type: 'compliance_score_history_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get compliance score history',
          cause: error,
        });
      }
    }),


  /**
   * Get compliance recommendations
   *
   * @protected
   */
  getRecommendations: protectedProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.user!.organizationId;

      if (!orgId) {
        return [];
      }

      const recommendations = await complianceModule.getRecommendations(ctx.user!.id, orgId);

      logger.info({
        type: 'compliance_recommendations_retrieved',
        userId: ctx.user!.id,
        orgId,
      });

      return recommendations;
    } catch (error: any) {
      logger.error({
        type: 'compliance_recommendations_error',
        userId: ctx.user!.id,
        error: error.message,
      });

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get compliance recommendations',
        cause: error,
      });
    }
  }),

  /**
   * Get requirements for the organization
   *
   * @protected
   */
  getRequirements: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        status: z.string().optional(),
        area: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          return { requirements: [], total: 0, page: 1, limit: 20, totalPages: 0 };
        }

        const result = await complianceModule.getRequirements(ctx.user!.id, orgId, {
          page: input.page,
          limit: input.limit,
          status: input.status as any,
          area: input.area as any,
        });

        logger.info({
          type: 'compliance_requirements_retrieved',
          userId: ctx.user!.id,
          orgId,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'compliance_requirements_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get compliance requirements',
          cause: error,
        });
      }
    }),

  /**
   * Update a requirement's status
   *
   * @protected
   */
  updateRequirement: protectedProcedure
    .input(
      z.object({
        requirementId: z.string(),
        status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'WAIVED', 'OVERDUE']),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const updated = await complianceModule.updateRequirementStatus(
          ctx.user!.id,
          input.requirementId,
          input.status as any,
          input.notes
        );

        logger.info({
          type: 'compliance_requirement_updated',
          userId: ctx.user!.id,
          requirementId: input.requirementId,
          status: input.status,
        });

        return updated;
      } catch (error: any) {
        logger.error({
          type: 'compliance_requirement_update_error',
          userId: ctx.user!.id,
          requirementId: input.requirementId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update requirement',
          cause: error,
        });
      }
    }),

  /**
   * Get upcoming compliance deadlines
   *
   * @protected
   */
  getDeadlines: protectedProcedure
    .input(z.object({ daysAhead: z.number().min(1).max(365).default(30) }))
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          return [];
        }

        const deadlines = await complianceModule.checkDeadlines(
          ctx.user!.id,
          orgId,
          input.daysAhead
        );

        logger.info({
          type: 'compliance_deadlines_retrieved',
          userId: ctx.user!.id,
          orgId,
          count: deadlines.length,
        });

        return deadlines;
      } catch (error: any) {
        logger.error({
          type: 'compliance_deadlines_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get compliance deadlines',
          cause: error,
        });
      }
    }),

  /**
   * Generate a compliance roadmap
   *
   * @protected
   * @rate-limited
   */
  getRoadmap: protectedProcedure
    .use(rateLimited('complianceQuery'))
    .query(async ({ ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          return { phases: [], estimatedDays: 0, priority: [] };
        }

        const roadmap = await complianceModule.generateRoadmap(ctx.user!.id, orgId);

        logger.info({
          type: 'compliance_roadmap_generated',
          userId: ctx.user!.id,
          orgId,
        });

        return roadmap;
      } catch (error: any) {
        logger.error({
          type: 'compliance_roadmap_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate compliance roadmap',
          cause: error,
        });
      }
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // COMPLIANCE CHECKLIST PROCEDURES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Generate an AI+RAG compliance checklist.
   * Requires authentication. RBAC: STARTUP, ENTERPRISE, ADMIN.
   *
   * @protected
   * @rate-limited
   */
  generateChecklist: protectedProcedure
    .use(rateLimited('complianceQuery'))
    .use(withPlanContext)
    .use(requirePlanFeature('checklistGenerations'))
    .use(checkUsageLimit(BillingMetric.CHECKLIST_GENERATIONS))
    .input(
      z.object({
        productType: z.string().min(1).max(100),
        businessStage: z.string().min(1).max(100),
        targetSegments: z.array(z.string()).min(1).max(10),
        servicesOffered: z.array(z.string()).min(1).max(20),
        additionalConcerns: z.string().max(1000).optional(),
        organizationId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // RBAC: Regulators cannot generate checklists (they issue them)
        if (ctx.user!.role === 'REGULATOR') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Regulators cannot generate compliance checklists',
          });
        }

        logger.info({
          type: 'checklist_generate_request',
          userId: ctx.user!.id,
          productType: input.productType,
          businessStage: input.businessStage,
        });

        const result = await complianceModule.generateChecklist(ctx.user!.id, {
          productType: input.productType,
          businessStage: input.businessStage,
          targetSegments: input.targetSegments,
          servicesOffered: input.servicesOffered,
          additionalConcerns: input.additionalConcerns,
          organizationId: input.organizationId ?? ctx.user!.organizationId ?? undefined,
        });

        logger.info({
          type: 'checklist_generate_success',
          userId: ctx.user!.id,
          checklistId: result.id,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'checklist_generate_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error.message || 'Failed to generate compliance checklist',
          cause: error,
        });
      }
    }),

  /**
   * List all checklists for the current user.
   *
   * @protected
   */
  getUserChecklists: protectedProcedure.query(async ({ ctx }) => {
    try {
      const checklists = await complianceModule.getUserChecklists(ctx.user!.id);

      logger.info({
        type: 'user_checklists_retrieved',
        userId: ctx.user!.id,
        count: checklists.length,
      });

      return checklists;
    } catch (error: any) {
      logger.error({
        type: 'user_checklists_error',
        userId: ctx.user!.id,
        error: error.message,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve checklists',
        cause: error,
      });
    }
  }),

  /**
   * Get a single checklist by ID.
   *
   * @protected
   */
  getChecklist: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const checklist = await complianceModule.getChecklist(ctx.user!.id, input.id);

        logger.info({
          type: 'checklist_retrieved',
          userId: ctx.user!.id,
          checklistId: input.id,
        });

        return checklist;
      } catch (error: any) {
        logger.error({
          type: 'checklist_retrieve_error',
          userId: ctx.user!.id,
          checklistId: input.id,
          error: error.message,
        });

        if (error.message === 'Checklist not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Checklist not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this checklist' });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve checklist',
          cause: error,
        });
      }
    }),

  /**
   * @deprecated Use `updateChecklistItem` for normalized checklists (post-March 2026).
   * This procedure operates on the legacy JSON-blob `itemProgress` field and is kept
   * only for backward-compatibility with existing frontend code targeting legacy checklists.
   * It will be removed once all legacy checklists are migrated.
   *
   * @protected
   * @middleware withPlanContext — write mutation
   */
  updateChecklistProgress: protectedProcedure
    .use(withPlanContext)
    .input(
      z.object({
        checklistId: z.string().min(1),
        itemProgress: z.record(
          z.string(),
          z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'])
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      logger.warn({
        type: 'deprecated_procedure_called',
        procedure: 'compliance.updateChecklistProgress',
        replacement: 'compliance.updateChecklistItem',
        userId: ctx.user!.id,
        checklistId: input.checklistId,
        message: 'updateChecklistProgress is deprecated. Migrate to updateChecklistItem for normalized checklists.',
      });

      try {
        const result = await complianceModule.updateChecklistProgress(
          ctx.user!.id,
          input.checklistId,
          input.itemProgress
        );

        logger.info({
          type: 'checklist_progress_update_success',
          userId: ctx.user!.id,
          checklistId: input.checklistId,
          progress: result.progress,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'checklist_progress_update_error',
          userId: ctx.user!.id,
          checklistId: input.checklistId,
          error: error.message,
        });

        if (error.message === 'Checklist not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Checklist not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        if (error.message.includes('Invalid')) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update checklist progress',
          cause: error,
        });
      }
    }),

  /**
   * Soft-delete a checklist (sets deletedAt; record is NOT destroyed).
   *
   * @protected
   * @middleware withPlanContext — write mutation
   */
  deleteChecklist: protectedProcedure
    .use(withPlanContext)
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await complianceModule.deleteChecklist(ctx.user!.id, input.id);

        logger.info({
          type: 'checklist_deleted',
          userId: ctx.user!.id,
          checklistId: input.id,
        });

        return { success: true };
      } catch (error: any) {
        logger.error({
          type: 'checklist_delete_error',
          userId: ctx.user!.id,
          checklistId: input.id,
          error: error.message,
        });

        if (error.message === 'Checklist not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Checklist not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete checklist',
          cause: error,
        });
      }
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // NORMALIZED CHECKLIST PROCEDURES (post-March 2026)
  //
  // Middleware policy (per Additional Instruction 9):
  //   READ queries  — no plan gate (reads are free)
  //   WRITE mutations — withPlanContext applied; requirePlanFeature NOT applied
  //     (plan gate already enforced on generateChecklistAsync via checkUsageLimit)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Fire-and-forget checklist generation.
   * Returns immediately with { checklistId, status: 'GENERATING' }.
   * Frontend must poll `getChecklistStatus` until status leaves GENERATING.
   *
   * Polling contract: 80 polls × 3 s interval = 4-minute budget.
   * Server-side lazy stale cleanup marks GENERATING → FAILED after 5 minutes.
   *
   * @protected
   * @middleware withPlanContext — write mutation; checkUsageLimit enforces monthly cap
   */
  generateChecklistAsync: protectedProcedure
    .use(rateLimited('complianceQuery'))
    .use(withPlanContext)
    // deferIncrement: true — usage counter is committed only after the DB placeholder
    // is successfully written, preventing lost credits on service failure (Gap #4).
    .use(checkUsageLimit(BillingMetric.CHECKLIST_GENERATIONS, { deferIncrement: true }))
    .input(generateChecklistAsyncInputSchema)
    .mutation(async ({ input, ctx }) => {
      let orgId = ctx.user!.organizationId;

      // If user has no org (e.g. registration race condition where org creation
      // was not awaited), auto-create a default one and link it now.
      if (!orgId) {
        try {
          const org = await ctx.prisma.organization.create({
            data: {
              name: ctx.user!.email.split('@')[0] + ' Organisation',
              type: ctx.user!.role,
              users: { connect: { id: ctx.user!.id } },
            } as any,
            select: { id: true },
          });
          orgId = org.id;
          // Bust the Redis user cache so subsequent requests pick up the new orgId.
          await redis.del(`user:session:${ctx.user!.supabaseAuthId}`).catch(() => {});
          logger.info({
            type: 'checklist_auto_created_org',
            userId: ctx.user!.id,
            orgId,
          });
        } catch (orgErr: unknown) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to create your organisation profile. Please contact support.',
            cause: orgErr,
          });
        }
      }

      try {
        logger.info({
          type: 'checklist_generate_async_start',
          userId: ctx.user!.id,
          orgId,
          productType: input.productType,
          businessStage: input.businessStage,
        });

        // Returns immediately — background generation runs in the service.
        // incrementUsage() is called AFTER the DB write succeeds (Gap #4 fix).
        const result = await checklistService.generateChecklist(
          ctx.user!.id,
          orgId,
          input,
          ctx.plan === 'FREE_TRIAL' ? ctx.user!.id : undefined,
        );

        // Commit the usage counter now that the DB record exists.
        await ctx.incrementUsage?.();

        logger.info({
          type: 'checklist_generate_async_accepted',
          userId: ctx.user!.id,
          checklistId: result.checklistId,
        });

        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to initiate checklist generation';
        logger.error({
          type: 'checklist_generate_async_error',
          userId: ctx.user!.id,
          error: msg,
        });
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Poll the status of a generating checklist.
   * Returns status, progress 0–100, item counts, and isNormalized flag.
   * Frontend should call this every 3 s until status !== 'GENERATING'.
   *
   * READ — no plan gate.
   *
   * @protected
   */
  getChecklistStatus: protectedProcedure
    .input(getChecklistStatusInputSchema)
    .query(async ({ input, ctx }) => {
      const orgId = ctx.user!.organizationId;
      if (!orgId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Your account must be associated with an organization.',
        });
      }

      try {
        return await checklistService.getChecklistStatus(input.checklistId, ctx.user!.id, orgId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to get checklist status';
        if (error instanceof TRPCError) throw error;
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * List all checklists for the caller's organization (normalized path).
   * Excludes soft-deleted records. Applies lazy stale cleanup.
   *
   * READ — no plan gate.
   *
   * @protected
   */
  listChecklists: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user!.organizationId;
    if (!orgId) return [];

    try {
      return await checklistService.listChecklists(orgId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to list checklists';
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
    }
  }),

  /**
   * Get full checklist detail with categories + items (normalized checklists only).
   * Use `getChecklist` for legacy JSON-blob checklists (isNormalized = false).
   *
   * READ — no plan gate.
   *
   * @protected
   */
  getChecklistDetail: protectedProcedure
    .input(z.object({ checklistId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const orgId = ctx.user!.organizationId;
      if (!orgId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Your account must be associated with an organization.',
        });
      }

      try {
        return await checklistService.getChecklistDetail(input.checklistId, ctx.user!.id, orgId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to get checklist detail';
        if (error instanceof TRPCError) throw error;
        if (msg === 'Checklist not found') throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: msg });
        if (msg.includes('Legacy checklist')) throw new TRPCError({ code: 'BAD_REQUEST', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Update a single normalized ChecklistItem's status and optional notes.
   * Recalculates checklist-level progress; marks checklist COMPLETED when all
   * applicable items are done.
   *
   * @protected
   * @middleware withPlanContext — write mutation
   */
  updateChecklistItem: protectedProcedure
    .use(withPlanContext)
    .input(updateChecklistItemInputSchema)
    .mutation(async ({ input, ctx }) => {
      const orgId = ctx.user!.organizationId;
      if (!orgId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Your account must be associated with an organization.',
        });
      }

      try {
        const result = await checklistService.updateItemStatus(ctx.user!.id, orgId, input);

        logger.info({
          type: 'checklist_item_updated',
          userId: ctx.user!.id,
          checklistId: input.checklistId,
          itemId: input.itemId,
          newStatus: input.status,
          checklistProgress: result.checklist.progress,
        });

        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to update checklist item';
        if (error instanceof TRPCError) throw error;
        if (msg === 'Checklist not found' || msg === 'Checklist item not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: msg });
        }
        if (msg.includes('Access denied')) throw new TRPCError({ code: 'FORBIDDEN', message: msg });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: error });
      }
    }),

  /**
   * Return the caller's checklist generation usage for the current period.
   * Used by the frontend UsageIndicator and to gate the "Generate" CTA.
   *
   * Returns:
   *   used    — number of checklists generated in the current period
   *   limit   — plan cap (-1 = unlimited, 0 = unavailable, n = cap)
   *   period  — 'month' | 'lifetime'
   *   planName — current SubscriptionPlan enum value
   *
   * READ — no plan gate.
   *
   * @protected
   */
  getChecklistUsage: protectedProcedure
    .use(withPlanContext)
    .query(async ({ ctx }) => {
      const plan     = ctx.plan ?? SubscriptionPlan.REGULATOR;
      const scopeId  = ctx.user!.organizationId ?? ctx.user!.id;
      const { limit, period } = getQuota(plan, 'checklistGenerations');

      if (limit === -1) {
        return { used: 0, limit: -1, period, planName: plan };
      }

      const periodKey = period === 'lifetime'
        ? 'lifetime'
        : new Date().toISOString().slice(0, 7);
      const usageKey  = `sheriabot:usage:${scopeId}:${BillingMetric.CHECKLIST_GENERATIONS}:${periodKey}`;

      const raw  = await redis.get<number>(usageKey);
      const used = typeof raw === 'number' ? raw : Number(raw ?? 0);

      return { used, limit, period, planName: plan };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // GAP ANALYSIS PROCEDURES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Return the list of regulatory frameworks available to the current user.
   *
   * Each framework carries a `locked` flag: true when the framework's tier
   * exceeds the user's current subscription plan.  Locked frameworks are
   * visible (so users understand what they're missing) but the frontend
   * should prevent them from being selected.
   *
   * Tier access ladder: STARTUP < BUSINESS < ENTERPRISE.
   * REGULATOR users see all frameworks (they can't run analyses anyway).
   *
   * @protected
   */
  getFrameworks: protectedProcedure
    .use(withPlanContext)
    .query(async ({ ctx }) => {
      const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;

      // Map SubscriptionPlan → numeric tier level for comparison
      const tierLevel: Record<string, number> = {
        REGULATOR: 3,
        STARTUP: 1,
        BUSINESS: 2,
        ENTERPRISE: 3,
      };
      const frameworkTierLevel: Record<string, number> = {
        STARTUP: 1,
        BUSINESS: 2,
        ENTERPRISE: 3,
      };
      const userLevel = tierLevel[plan] ?? 0;

      const frameworks = await prisma.regulatoryFramework.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { slug: true, name: true, category: true, description: true, tier: true },
      });

      return frameworks.map((fw) => ({
        slug: fw.slug,
        name: fw.name,
        category: fw.category,
        description: fw.description,
        tier: fw.tier,
        locked: userLevel < (frameworkTierLevel[fw.tier] ?? 1),
      }));
    }),

  /**
   * Run a full AI+RAG gap analysis on an uploaded policy document.
   * Accepts base64-encoded file content (max 10MB), uploads to R2,
   * extracts text, retrieves regulatory context from Pinecone, and
   * generates a structured gap analysis via Claude AI.
   *
   * @protected
   * @rate-limited
   */
  runGapAnalysis: protectedProcedure
    .use(rateLimited('gapAnalysis', 5))
    .use(withPlanContext)
    .use(requirePlanFeature('gapAnalysis'))
    .use(checkUsageLimit(BillingMetric.GAP_ANALYSES, { deferIncrement: true }))
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileType: z.enum(['pdf', 'docx', 'doc', 'txt']),
        fileContent: z.string().min(1).max(GAP_ANALYSIS_MAX_BASE64_CHARS), // base64-encoded; ~20 MB decoded ceiling
        regulatoryFrameworks: z.array(z.string()).min(1).max(10),
        analysisDepth: z.enum(['quick', 'standard', 'deep']).default('standard'),
        focusAreas: z.array(z.string()).max(10).optional(),
        organizationId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // RBAC: Regulators cannot run gap analyses on client documents
        if (ctx.user!.role === 'REGULATOR') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Regulators cannot run gap analyses on uploaded documents',
          });
        }

        // Per-tier file size enforcement.
        // fileContent is base64; actual decoded byte size ≈ base64.length * 0.75
        const decodedBytes = Math.ceil(input.fileContent.length * 0.75);
        const gapLimits = GAP_ANALYSIS_UPLOAD_LIMITS[ctx.plan ?? SubscriptionPlan.REGULATOR];
        if (gapLimits.maxFileSizeMB === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Gap analysis file uploads are not available on your current plan.',
          });
        }
        const maxGapBytes = gapLimits.maxFileSizeMB * 1024 * 1024;
        if (decodedBytes > maxGapBytes) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `File exceeds the ${gapLimits.maxFileSizeMB} MB limit for your plan.`,
          });
        }

        // Validate framework slugs against the DB registry and enforce tier access.
        const plan = ctx.plan ?? SubscriptionPlan.REGULATOR;
        const frameworkTierLevel: Record<string, number> = { STARTUP: 1, BUSINESS: 2, ENTERPRISE: 3 };
        const tierLevel: Record<string, number> = { REGULATOR: 3, STARTUP: 1, BUSINESS: 2, ENTERPRISE: 3 };
        const userLevel = tierLevel[plan] ?? 0;

        const dbFrameworks = await prisma.regulatoryFramework.findMany({
          where: { slug: { in: input.regulatoryFrameworks }, isActive: true },
          select: { slug: true, name: true, tier: true },
        });

        // Reject any slugs not found in the DB
        const foundSlugs = new Set(dbFrameworks.map((f) => f.slug));
        const invalidSlugs = input.regulatoryFrameworks.filter((s) => !foundSlugs.has(s));
        if (invalidSlugs.length > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid framework slug(s): ${invalidSlugs.join(', ')}`,
          });
        }

        // Reject slugs the user's plan does not have access to
        const lockedFrameworks = dbFrameworks.filter(
          (f) => userLevel < (frameworkTierLevel[f.tier] ?? 1)
        );
        if (lockedFrameworks.length > 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Your plan does not include access to: ${lockedFrameworks.map((f) => f.name).join(', ')}. Please upgrade.`,
          });
        }

        // Idempotency: deduplicate concurrent/retry submissions of the same file.
        // Key = SHA-256(base64 content) scoped to org, TTL = 15 min.
        const orgId = input.organizationId ?? ctx.user!.organizationId ?? ctx.user!.id;
        const fileHash = createHash('sha256').update(input.fileContent).digest('hex');
        const dedupKey = `sheriabot:gapanalysis:dedup:${orgId}:${fileHash}`;

        const existing = await redis.get<string>(dedupKey);
        if (existing) {
          // Return the in-progress or recently-completed analysis instead of creating a duplicate.
          const existingAnalysis = await prisma.gapAnalysis.findUnique({ where: { id: existing } });
          if (existingAnalysis) {
            logger.info({ type: 'gap_analysis_dedup_hit', userId: ctx.user!.id, analysisId: existing });
            return existingAnalysis;
          }
        }

        logger.info({
          type: 'gap_analysis_request',
          userId: ctx.user!.id,
          fileName: input.fileName,
          frameworks: input.regulatoryFrameworks,
          depth: input.analysisDepth,
        });

        // Map validated slugs to full framework names for AI/RAG prompt quality.
        const frameworkNames = dbFrameworks.map((f) => f.name);

        const result = await complianceModule.runGapAnalysis(ctx.user!.id, {
          fileName: input.fileName,
          fileType: input.fileType,
          fileContent: input.fileContent,
          regulatoryFrameworks: frameworkNames,
          analysisDepth: input.analysisDepth,
          focusAreas: input.focusAreas,
          organizationId: input.organizationId ?? ctx.user!.organizationId ?? undefined,
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
          trialUserId: ctx.plan === 'FREE_TRIAL' ? ctx.user!.id : undefined,
        });

        // Store dedup sentinel so retries within 15 min return the same analysis.
        await redis.set(dedupKey, result.id, { ex: 900 });

        // Commit the usage counter now that the job is queued (deferIncrement pattern).
        // Usage is consumed at queue time, not completion — prevents free retries on timeout.
        await ctx.incrementUsage?.();

        logger.info({
          type: 'gap_analysis_request_success',
          userId: ctx.user!.id,
          analysisId: result.id,
          status: result.status,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'gap_analysis_request_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error.message || 'Failed to run gap analysis',
          cause: error,
        });
      }
    }),

  /**
   * List all gap analyses for the current user.
   *
   * @protected
   */
  getGapAnalyses: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const analyses = await complianceModule.getUserGapAnalyses(ctx.user!.id);

        logger.info({
          type: 'gap_analysis_list_retrieved',
          userId: ctx.user!.id,
          count: analyses.length,
        });

        return analyses;
      } catch (error: unknown) {
        logger.error({
          type: 'gap_analysis_list_error',
          userId: ctx.user!.id,
          error: (error as Error).message,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve gap analyses',
          cause: error,
        });
      }
    }),

  /**
   * Get a specific gap analysis result by ID.
   *
   * @protected
   */
  getGapAnalysisResult: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      try {
        const result = await complianceModule.getGapAnalysisResult(ctx.user!.id, input.id, {
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
        });

        logger.info({
          type: 'gap_analysis_result_retrieved',
          userId: ctx.user!.id,
          analysisId: input.id,
        });

        return result;
      } catch (error: unknown) {
        if (error instanceof NotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        if (error instanceof ForbiddenError) {
          throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve gap analysis',
          cause: error,
        });
      }
    }),

  /**
   * Returns the caller's per-tier gap analysis file size limit.
   * Used by the frontend to enforce the file size constraint before upload.
   */
  getGapAnalysisLimits: protectedProcedure
    .use(withPlanContext)
    .query(({ ctx }) => {
      const limits = GAP_ANALYSIS_UPLOAD_LIMITS[ctx.plan];
      return { maxFileSizeMB: limits.maxFileSizeMB };
    }),

  /**
   * Delete a gap analysis record and its R2 file.
   *
   * @protected
   */
  deleteGapAnalysis: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        await complianceModule.deleteGapAnalysis(ctx.user!.id, input.id, {
          ipAddress: ctx.req.ip,
          userAgent: ctx.req.headers['user-agent'] as string | undefined,
        });

        logger.info({
          type: 'gap_analysis_deleted',
          userId: ctx.user!.id,
          analysisId: input.id,
        });

        return { success: true };
      } catch (error: unknown) {
        logger.error({
          type: 'gap_analysis_delete_error',
          userId: ctx.user!.id,
          analysisId: input.id,
          error: (error as Error).message,
        });

        if (error instanceof NotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        if (error instanceof ForbiddenError) {
          throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete gap analysis',
          cause: error,
        });
      }
    }),

  // -------------------------------------------------------------------------
  // Compliance Dashboard (5-Category Scoring)
  // -------------------------------------------------------------------------

  /**
   * Get full compliance dashboard data for the user's organization.
   * Auto-seeds default checklist items on first access.
   *
   * @protected
   */
  getComplianceDashboard: protectedProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.user!.organizationId;

      if (!orgId) {
        return {
          overallScore: 0,
          trend: 0,
          categories: [],
          lastUpdated: new Date().toISOString(),
        };
      }

      const data = await complianceModule.getComplianceDashboardData(orgId);

      logger.info({
        type: 'compliance_dashboard_retrieved',
        userId: ctx.user!.id,
        orgId,
        overallScore: data.overallScore,
      });

      return data;
    } catch (error: any) {
      logger.error({
        type: 'compliance_dashboard_error',
        userId: ctx.user!.id,
        error: error.message,
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to load compliance dashboard',
        cause: error,
      });
    }
  }),

  /**
   * Mark a Phase-8 compliance dashboard item as completed or incomplete.
   * Operates on the ComplianceItem model (the startup dashboard seeded checklist).
   *
   * NOTE: renamed from updateChecklistItem → updateDashboardItem to avoid conflict
   * with the normalized ChecklistItem update added in March 2026.
   * Frontend reference in startup/page.tsx updated during Task 4.
   *
   * @protected
   */
  updateDashboardItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string().min(1),
        isCompleted: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'User has no organization' });
        }

        const result = await complianceModule.updateChecklistItem(
          ctx.user!.id,
          orgId,
          input.itemId,
          input.isCompleted
        );

        logger.info({
          type: 'compliance_item_updated',
          userId: ctx.user!.id,
          orgId,
          itemId: input.itemId,
          isCompleted: input.isCompleted,
        });

        return result;
      } catch (error: any) {
        if (error instanceof TRPCError) throw error;

        if (error.message === 'Compliance item not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Compliance item not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }

        logger.error({
          type: 'compliance_item_update_error',
          userId: ctx.user!.id,
          error: error.message,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update compliance item',
          cause: error,
        });
      }
    }),

  /**
   * Get all checklist items for a specific compliance category.
   *
   * @protected
   */
  getChecklistByCategory: protectedProcedure
    .input(
      z.object({
        category: z.enum([
          'DATA_PROTECTION',
          'AML_KYC',
          'CONSUMER_PROTECTION',
          'CBK_LICENSING',
          'CYBERSECURITY',
        ]),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) return [];

        const items = await complianceModule.getChecklistByCategory(
          ctx.user!.id,
          orgId,
          input.category as import('@prisma/client').ComplianceCategory
        );

        logger.info({
          type: 'compliance_checklist_by_category_retrieved',
          userId: ctx.user!.id,
          orgId,
          category: input.category,
          count: items.length,
        });

        return items;
      } catch (error: any) {
        logger.error({
          type: 'compliance_checklist_by_category_error',
          userId: ctx.user!.id,
          error: error.message,
        });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get checklist items',
          cause: error,
        });
      }
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // QUERY FEEDBACK
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Submit or toggle feedback (thumbs up / thumbs down) on a compliance query.
   *
   * Toggle semantics (server-side):
   *  - No existing feedback  → create with given rating
   *  - Existing same rating  → delete (toggle off), return null
   *  - Existing diff rating  → update to new rating
   *
   * @protected
   */
  submitFeedback: protectedProcedure
    .input(
      z.object({
        queryId: z.string().min(1),
        rating: z.enum(['up', 'down']),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      // Verify query exists and caller has access
      const query = await ctx.prisma.complianceQuery.findUnique({
        where: { id: input.queryId },
        select: { id: true, userId: true },
      });

      if (!query) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Query not found' });
      }

      if (ctx.user!.role !== 'ADMIN' && query.userId !== userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this query' });
      }

      const existing = await ctx.prisma.queryFeedback.findUnique({
        where: { queryId_userId: { queryId: input.queryId, userId } },
        select: { rating: true },
      });

      let newRating: 'up' | 'down' | null;

      if (existing && existing.rating === input.rating) {
        // Same rating clicked again → toggle off
        await ctx.prisma.queryFeedback.delete({
          where: { queryId_userId: { queryId: input.queryId, userId } },
        });
        newRating = null;
      } else {
        // Create or switch to new rating
        await ctx.prisma.queryFeedback.upsert({
          where: { queryId_userId: { queryId: input.queryId, userId } },
          create: { queryId: input.queryId, userId, rating: input.rating },
          update: { rating: input.rating },
        });
        newRating = input.rating;
      }

      logger.info({
        type: 'query_feedback_submitted',
        userId,
        queryId: input.queryId,
        rating: newRating,
      });

      return { rating: newRating };
    }),

  /**
   * Get the current user's feedback rating for a specific query.
   *
   * @protected
   */
  getFeedbackStatus: protectedProcedure
    .input(z.object({ queryId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      const feedback = await ctx.prisma.queryFeedback.findUnique({
        where: { queryId_userId: { queryId: input.queryId, userId } },
        select: { rating: true },
      });

      return { rating: (feedback?.rating ?? null) as 'up' | 'down' | null };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // SAVED RESPONSES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Toggle save/bookmark status for a compliance query response.
   *
   *  - Not saved → save it, return { saved: true }
   *  - Already saved → unsave it, return { saved: false }
   *
   * @protected
   */
  toggleSave: protectedProcedure
    .input(
      z.object({
        queryId: z.string().min(1),
        notes: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      const query = await ctx.prisma.complianceQuery.findUnique({
        where: { id: input.queryId },
        select: { id: true, userId: true },
      });

      if (!query) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Query not found' });
      }

      if (ctx.user!.role !== 'ADMIN' && query.userId !== userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this query' });
      }

      const existing = await ctx.prisma.savedResponse.findUnique({
        where: { queryId_userId: { queryId: input.queryId, userId } },
        select: { id: true },
      });

      if (existing) {
        await ctx.prisma.savedResponse.delete({
          where: { queryId_userId: { queryId: input.queryId, userId } },
        });

        logger.info({ type: 'response_unsaved', userId, queryId: input.queryId });
        return { saved: false, savedAt: null as Date | null };
      }

      const record = await ctx.prisma.savedResponse.create({
        data: { queryId: input.queryId, userId, notes: input.notes ?? null },
        select: { createdAt: true },
      });

      logger.info({ type: 'response_saved', userId, queryId: input.queryId });
      return { saved: true, savedAt: record.createdAt as Date };
    }),

  /**
   * Get save status for a specific query response.
   *
   * @protected
   */
  getSavedStatus: protectedProcedure
    .input(z.object({ queryId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      const record = await ctx.prisma.savedResponse.findUnique({
        where: { queryId_userId: { queryId: input.queryId, userId } },
        select: { createdAt: true, notes: true },
      });

      return {
        saved: !!record,
        savedAt: (record?.createdAt ?? null) as Date | null,
        notes: (record?.notes ?? null) as string | null,
      };
    }),

  /**
   * List all saved responses for the current user, paginated.
   *
   * @protected
   */
  listSavedResponses: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(50).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const skip = (input.page - 1) * input.limit;

      const [items, total] = await Promise.all([
        ctx.prisma.savedResponse.findMany({
          where: { userId },
          skip,
          take: input.limit,
          orderBy: { createdAt: 'desc' },
          include: {
            query: {
              select: { id: true, query: true, response: true, createdAt: true },
            },
          },
        }),
        ctx.prisma.savedResponse.count({ where: { userId } }),
      ]);

      logger.info({ type: 'saved_responses_listed', userId, count: items.length, total });

      return {
        items,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  /**
   * Log a client-side PDF export to the audit log.
   * Called fire-and-forget from the frontend immediately after the print window opens.
   *
   * @protected
   */
  logExport: protectedProcedure
    .input(z.object({
      analysisId: z.string().min(1),
      format: z.enum(['pdf', 'docx']),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      // Fire-and-forget audit log — never block the response
      prisma.auditLog.create({
        data: {
          userId,
          action: 'GAP_ANALYSIS_EXPORTED',
          entityType: 'GapAnalysis',
          entityId: input.analysisId,
          metadata: { format: input.format },
          ipAddress: ctx.req.ip ?? null,
          userAgent: (ctx.req.headers['user-agent'] as string | undefined) ?? null,
        },
      }).catch((err: unknown) => {
        logger.error({ type: 'gap_analysis_export_audit_log_failed', userId, analysisId: input.analysisId, error: (err as Error).message });
      });

      logger.info({ type: 'gap_analysis_pdf_exported', userId, analysisId: input.analysisId, format: input.format });

      return { success: true };
    }),

  /**
   * Generate and upload a DOCX report for a completed gap analysis.
   * Returns a signed R2 download URL with 15-minute expiry.
   *
   * Gated: BUSINESS and ENTERPRISE plans only (requirePlanFeature('gapAnalysis') already
   * restricts to these tiers via the entitlements config).
   *
   * @protected
   */
  exportDocx: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('gapAnalysis'))
    .input(z.object({ analysisId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      // 1. Fetch the analysis record with user relation
      const analysis = await prisma.gapAnalysis.findUnique({
        where: { id: input.analysisId },
        include: {
          user: { select: { fullName: true, email: true } },
        },
      });

      if (!analysis) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap analysis not found' });
      }

      // 2. Ownership check (or ADMIN role)
      if (analysis.userId !== userId && ctx.user!.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this analysis' });
      }

      // 3. Must be completed
      if (analysis.status !== 'COMPLETED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot export a ${analysis.status.toLowerCase()} analysis. Wait for it to complete.`,
        });
      }

      // 4. Parse and validate the results JSON
      const parsed = GapAnalysisResultSchema.safeParse(analysis.results);
      if (!parsed.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Analysis results are malformed and cannot be exported' });
      }

      // 5. Build DOCX buffer — fetch org name separately (GapAnalysis has no direct org relation)
      const orgName = analysis.organizationId
        ? (await prisma.organization.findUnique({ where: { id: analysis.organizationId }, select: { name: true } }))?.name
        : undefined;
      const userName = analysis.user?.fullName;

      const docxBuffer = await gapAnalysisExportService.generateGapAnalysisDocx({
        result: parsed.data,
        analysisId: input.analysisId,
        documentName: analysis.documentName,
        regulatoryFrameworks: Array.isArray(analysis.regulatoryFrameworks)
          ? (analysis.regulatoryFrameworks as string[])
          : [],
        analysisDepth: analysis.analysisDepth,
        ragGrounded: analysis.ragGrounded,
        chunksProcessed: (analysis as any).chunksProcessed ?? 0,
        createdAt: analysis.createdAt,
        organizationName: orgName ?? undefined,
        userName: userName ?? undefined,
      });

      // 6. Build a sanitised filename
      const orgSafe = gapAnalysisExportService.sanitiseFilename(orgName ?? userName ?? 'Organisation');
      const dateSafe = analysis.createdAt.toISOString().slice(0, 10);
      const filename = `SheriaBot_Gap_Analysis_${orgSafe}_${dateSafe}.docx`;

      // 7. Upload to R2
      const uploadResult = await storageService.uploadGapAnalysisExport(
        docxBuffer,
        filename,
        input.analysisId,
        userId,
      );

      // 8. Generate signed URL with 15-minute expiry (900 seconds)
      const downloadUrl = await storageService.getDownloadUrl(uploadResult.key, 900, false, filename);

      const expiresAt = new Date(Date.now() + 900 * 1000).toISOString();

      // 8b. Persist report tracking fields (fire-and-forget — non-blocking)
      prisma.gapAnalysis.update({
        where: { id: input.analysisId },
        data: { reportUrl: uploadResult.key, reportGeneratedAt: new Date() },
      }).catch((err: unknown) => {
        logger.error({ type: 'gap_analysis_report_tracking_update_failed', userId, analysisId: input.analysisId, error: (err as Error).message });
      });

      // 9. Write audit log (fire-and-forget)
      prisma.auditLog.create({
        data: {
          userId,
          action: 'GAP_ANALYSIS_EXPORTED',
          entityType: 'GapAnalysis',
          entityId: input.analysisId,
          metadata: { format: 'docx', filename, r2Key: uploadResult.key },
          ipAddress: ctx.req.ip ?? null,
          userAgent: (ctx.req.headers['user-agent'] as string | undefined) ?? null,
        },
      }).catch((err: unknown) => {
        logger.error({ type: 'gap_analysis_export_audit_log_failed', userId, analysisId: input.analysisId, error: (err as Error).message });
      });

      logger.info({ type: 'gap_analysis_docx_exported', userId, analysisId: input.analysisId, filename, r2Key: uploadResult.key });

      return { downloadUrl, expiresAt, fileName: filename };
    }),

  /**
   * Export a completed compliance checklist as a DOCX file.
   *
   * Generates a professionally formatted Word document, uploads it to R2,
   * and returns a signed download URL with 15-minute expiry.
   *
   * Gated: STARTUP plan and above (same gate as generateChecklist).
   *
   * @protected
   */
  exportChecklistDocx: protectedProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('checklistGenerations'))
    .input(z.object({ checklistId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      // 1. Fetch the checklist with items and user — no direct org relation on Checklist model
      const checklist = await prisma.checklist.findUnique({
        where: { id: input.checklistId },
        include: {
          user:          { select: { fullName: true } },
          checklistItems: {
            orderBy: [{ category: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
          },
        },
      });

      if (!checklist) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Checklist not found' });
      }

      // 2. Ownership check (or ADMIN)
      if (checklist.userId !== userId && ctx.user!.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this checklist' });
      }

      // 3. Only export completed checklists
      if (checklist.status !== 'COMPLETED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot export a ${checklist.status.toLowerCase()} checklist. Wait for generation to complete.`,
        });
      }

      // 4. Must be normalized (has ChecklistItem rows)
      const checklistItemRows = checklist.checklistItems;
      const itemCount = checklistItemRows.length;
      if (itemCount === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This checklist has no items and cannot be exported.',
        });
      }

      // 5. Fetch org name separately (Checklist has organizationId but no @relation to Organization)
      const orgName = checklist.organizationId
        ? (await prisma.organization.findUnique({ where: { id: checklist.organizationId }, select: { name: true } }))?.name
        : undefined;

      // 6. Group items by category
      const categoryMap = new Map<string, typeof checklistItemRows>();
      for (const item of checklistItemRows) {
        const cat = item.category ?? 'General';
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat)!.push(item);
      }

      const categories = Array.from(categoryMap.entries()).map(([name, items]) => {
        const completedCount = items.filter((i) => i.status === 'COMPLETED').length;
        return {
          name,
          completedCount,
          totalCount: items.length,
          items: items.map((i) => ({
            id:                  i.id,
            itemCode:            i.itemCode ?? null,
            category:            i.category ?? 'General',
            title:               i.title,
            description:         i.description,
            guidance:            i.guidance ?? null,
            regulatoryReference: i.regulatoryReference ?? '',
            actionItems:         Array.isArray(i.actionItems) ? (i.actionItems as string[]) : [],
            deadline:            i.deadline ?? null,
            penalty:             i.penalty ?? null,
            priority:            i.priority,
            status:              i.status,
            notes:               i.notes ?? null,
            completedAt:         i.completedAt ?? null,
          })),
        };
      });

      // 7. Parse summary JSON
      const summaryRaw = checklist.summary as Record<string, unknown> | null;
      const summary = summaryRaw
        ? {
            criticalItems:           typeof summaryRaw['criticalItems'] === 'number' ? summaryRaw['criticalItems'] : undefined,
            highItems:               typeof summaryRaw['highItems'] === 'number' ? summaryRaw['highItems'] : undefined,
            estimatedCompletionDays: typeof summaryRaw['estimatedCompletionDays'] === 'number' ? summaryRaw['estimatedCompletionDays'] : undefined,
          }
        : null;

      // 8. Compute progress
      const completedItems = checklistItemRows.filter((i) => i.status === 'COMPLETED').length;
      const progress = itemCount > 0 ? Math.round((completedItems / itemCount) * 100) : 0;

      // 9. Build DOCX buffer
      const docxBuffer = await checklistExportService.generateChecklistDocx({
        checklistId:   checklist.id,
        title:         checklist.title,
        productType:   checklist.productType ?? null,
        businessStage: checklist.businessStage ?? null,
        progress,
        completedItems,
        totalItems:    checklist.totalItems > 0 ? checklist.totalItems : itemCount,
        generatedAt:   checklist.generatedAt ?? null,
        createdAt:     checklist.createdAt,
        summary,
        categories,
        organizationName: orgName ?? undefined,
        userName:         checklist.user?.fullName ?? undefined,
      });

      // 10. Build sanitised filename
      const orgSafe = checklistExportService.sanitiseFilename(
        orgName ?? checklist.user?.fullName ?? 'Organisation',
      );
      const dateSafe = checklist.createdAt.toISOString().slice(0, 10);
      const filename = `SheriaBot_Checklist_${orgSafe}_${dateSafe}.docx`;

      // 10. Upload to R2
      const uploadResult = await storageService.uploadChecklistExport(
        docxBuffer,
        filename,
        checklist.id,
        userId,
      );

      // 11. Signed URL — 15-minute expiry
      const downloadUrl = await storageService.getDownloadUrl(uploadResult.key, 900, false, filename);
      const expiresAt = new Date(Date.now() + 900 * 1000).toISOString();

      // 12. Audit log (fire-and-forget)
      prisma.auditLog.create({
        data: {
          userId,
          action: 'CHECKLIST_EXPORTED',
          entityType: 'Checklist',
          entityId: checklist.id,
          metadata: { format: 'docx', filename, r2Key: uploadResult.key },
          ipAddress: ctx.req.ip ?? null,
          userAgent: (ctx.req.headers['user-agent'] as string | undefined) ?? null,
        },
      }).catch((err: unknown) => {
        logger.error({ type: 'checklist_export_audit_log_failed', userId, checklistId: checklist.id, error: (err as Error).message });
      });

      logger.info({ type: 'checklist_docx_exported', userId, checklistId: checklist.id, filename, r2Key: uploadResult.key });

      return { downloadUrl, expiresAt, fileName: filename };
    }),

  /**
   * Retry a FAILED checklist generation.
   * Resets the existing record to GENERATING and re-fires the generation pipeline.
   * Does NOT consume additional generation credits.
   * Capped at 3 retries per checklist.
   *
   * @protected
   * @middleware withPlanContext — write mutation (no checkUsageLimit — no credit consumed)
   */
  retryChecklist: protectedProcedure
    .use(withPlanContext)
    .input(z.object({ checklistId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const orgId = ctx.user!.organizationId ?? '';

      try {
        const result = await checklistService.retryChecklist(
          input.checklistId,
          userId,
          orgId,
        );

        logger.info({
          type: 'checklist_retry_queued',
          userId,
          checklistId: input.checklistId,
          retryCount: result.retryCount,
        });

        return result;
      } catch (error: any) {
        logger.error({
          type: 'checklist_retry_error',
          userId,
          checklistId: input.checklistId,
          error: error.message,
        });

        if (error.message === 'Checklist not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Checklist not found' });
        }
        if (error.message?.includes('Access denied') || error.message?.includes('do not own')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        if (error.message?.includes('not in FAILED')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only FAILED checklists can be retried',
          });
        }
        if (error.message?.includes('Maximum retry')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Maximum retry attempts reached for this checklist',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retry checklist generation',
          cause: error,
        });
      }
    }),
});
