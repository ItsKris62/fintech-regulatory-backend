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
        const missingDocIds = queryCitations.filter(c => !c.documentId).length;
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
   * Update checklist item progress states.
   * Maps item IDs to NOT_STARTED | IN_PROGRESS | COMPLETED.
   *
   * @protected
   */
  updateChecklistProgress: protectedProcedure
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
   * Delete a checklist.
   *
   * @protected
   */
  deleteChecklist: protectedProcedure
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
  // GAP ANALYSIS PROCEDURES
  // ══════════════════════════════════════════════════════════════════════════

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
    .use(rateLimited('complianceQuery'))
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileType: z.enum(['pdf', 'docx', 'doc', 'txt']),
        fileContent: z.string().min(1), // base64-encoded
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

        logger.info({
          type: 'gap_analysis_request',
          userId: ctx.user!.id,
          fileName: input.fileName,
          frameworks: input.regulatoryFrameworks,
          depth: input.analysisDepth,
        });

        const result = await complianceModule.runGapAnalysis(ctx.user!.id, {
          fileName: input.fileName,
          fileType: input.fileType,
          fileContent: input.fileContent,
          regulatoryFrameworks: input.regulatoryFrameworks,
          analysisDepth: input.analysisDepth,
          focusAreas: input.focusAreas,
          organizationId: input.organizationId ?? ctx.user!.organizationId ?? undefined,
        });

        logger.info({
          type: 'gap_analysis_request_success',
          userId: ctx.user!.id,
          analysisId: result.id,
          overallScore: result.overallScore,
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
   * Get the most recent gap analysis result for the current user.
   * Replaces the legacy requirements-based getGapAnalysis.
   *
   * @protected
   */
  getGapAnalysis: protectedProcedure
    .input(z.object({ id: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        if (input?.id) {
          // Return specific analysis by ID
          return await complianceModule.getGapAnalysisResult(ctx.user!.id, input.id);
        }

        // Return list of all analyses for this user
        const analyses = await complianceModule.getUserGapAnalyses(ctx.user!.id);

        logger.info({
          type: 'gap_analysis_list_retrieved',
          userId: ctx.user!.id,
          count: analyses.length,
        });

        return analyses;
      } catch (error: any) {
        logger.error({
          type: 'gap_analysis_retrieve_error',
          userId: ctx.user!.id,
          error: error.message,
        });

        if (error.message === 'Gap analysis not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap analysis not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve gap analysis',
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
        const result = await complianceModule.getGapAnalysisResult(ctx.user!.id, input.id);

        logger.info({
          type: 'gap_analysis_result_retrieved',
          userId: ctx.user!.id,
          analysisId: input.id,
        });

        return result;
      } catch (error: any) {
        if (error.message === 'Gap analysis not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap analysis not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve gap analysis',
          cause: error,
        });
      }
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
        await complianceModule.deleteGapAnalysis(ctx.user!.id, input.id);

        logger.info({
          type: 'gap_analysis_deleted',
          userId: ctx.user!.id,
          analysisId: input.id,
        });

        return { success: true };
      } catch (error: any) {
        logger.error({
          type: 'gap_analysis_delete_error',
          userId: ctx.user!.id,
          analysisId: input.id,
          error: error.message,
        });

        if (error.message === 'Gap analysis not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Gap analysis not found' });
        }
        if (error.message.includes('Access denied')) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
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
   * Mark a compliance checklist item as completed or incomplete.
   *
   * @protected
   */
  updateChecklistItem: protectedProcedure
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
});
