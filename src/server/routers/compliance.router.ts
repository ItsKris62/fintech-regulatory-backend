import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc/trpc';
import { rateLimited } from '../trpc/middleware';
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
import { logger } from '@/utils/logger';

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

        // Save query to database
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId: ctx.user!.id,
            organizationId: ctx.user!.organizationId,
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

        // Create citations from RAG sources
        const citations = await Promise.all(
          ragContext.results.map((source: any) =>
            (ctx.prisma.citation.create as any)({
              data: {
                policyId: query.id,
                actName: source.documentTitle || 'Unknown',
                section: source.section || '',
                textSnippet: source.chunkText || '',
                confidence: 'high',
                verified: true,
                documentId: source.documentId,
              },
            })
          )
        );

        const duration = Date.now() - startTime;

        logger.info({
          type: 'compliance_query_success',
          userId: ctx.user!.id,
          queryId: query.id,
          duration,
          tokensUsed: answer.inputTokens + answer.outputTokens,
          citationsCount: citations.length,
        });

        return {
          queryId: query.id,
          answer: answer.content,
          citations,
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

        // Save follow-up query
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId: ctx.user!.id,
            organizationId: ctx.user!.organizationId,
            metadata: {
              followUpTo: input.originalQueryId,
              model: answer.model,
              tokensUsed: answer.inputTokens + answer.outputTokens,
            },
          },
        });

        // Create citations
        const citations = await Promise.all(
          ragContext.results.map((source: any) =>
            (ctx.prisma.citation.create as any)({
              data: {
                policyId: query.id,
                actName: source.documentTitle || 'Unknown',
                section: source.section || '',
                textSnippet: source.chunkText || '',
                confidence: 'high',
                verified: true,
              },
            })
          )
        );

        logger.info({
          type: 'compliance_followup_success',
          userId: ctx.user!.id,
          queryId: query.id,
          originalQueryId: input.originalQueryId,
        });

        return {
          queryId: query.id,
          answer: answer.content,
          citations,
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
   * Analyze compliance gaps for the organization
   *
   * @protected
   * @rate-limited
   */
  getGapAnalysis: protectedProcedure
    .use(rateLimited('complianceQuery'))
    .query(async ({ ctx }) => {
      try {
        const orgId = ctx.user!.organizationId;

        if (!orgId) {
          return [];
        }

        const gaps = await complianceModule.analyzeComplianceGaps(ctx.user!.id, orgId);

        logger.info({
          type: 'compliance_gap_analysis_retrieved',
          userId: ctx.user!.id,
          orgId,
          gapCount: gaps.length,
        });

        return gaps;
      } catch (error: any) {
        logger.error({
          type: 'compliance_gap_analysis_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get compliance gap analysis',
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
});
