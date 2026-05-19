import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, orgMemberProcedure } from '../trpc/trpc';
import { BillingMetric } from '@prisma/client';
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
import { logger } from '@/utils/logger';
import { incrementTrialUsage } from '@/modules/trial';
import { prisma } from '@/lib/prisma/client';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { appConfig } from '@/config/app.config';
import { gapAnalysisExportService } from '@/services/gap-analysis-export.service';
import { checklistExportService } from '@/services/checklist-export.service';
import { storageService } from '@/lib/storage/storage.service';
import { GapAnalysisResultSchema } from '@/lib/ai/prompts/gap-analysis';

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
  query: orgMemberProcedure
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

        // Generate answer grounded in retrieved evidence
        const answer = await ctx.aiService.answerComplianceQuery({
          question: input.question,
          organizationType: input.organizationType,
          industry: input.industry,
          context: input.context,
          ragContext: ragContext.context || undefined,
        });

        // Build RAG source citations for JSON storage.
        //
        // TODO: Migrate compliance query citations to use the Citation table
        // instead of the inline JSON field. The schema now supports this via
        // Citation.complianceQueryId + Citation.rawSource. See audit finding #13.
        //
        // Correct pattern for now: store RAG source references as JSON directly on
        // ComplianceQuery.citations (Json? column). This preserves full
        // auditability and AI explainability without FK dependencies.
        const queryCitations = ragContext.results.map((source: any) => ({
          documentId: source.documentId ?? null,
          documentTitle: source.documentTitle || 'Unknown',
          section: source.section || '',
          textSnippet: (source.chunkText || '').slice(0, 500),
          score: source.score ?? 0,
          citation: source.citation ?? null,
          authorityStatus: source.authorityStatus ?? 'IN_FORCE',
          isBinding: source.isBinding ?? true,
          source: source.source ?? null,
          version: source.version ?? null,
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
            organizationId: ctx.orgMembership!.organizationId,
            response: answer.content,
            citations: queryCitations.length > 0 ? queryCitations : undefined,
            metadata: {
              model: answer.model,
              tokensUsed: answer.inputTokens + answer.outputTokens,
              ragSources: ragContext.results.length,
              ragContextChars: ragContext.context?.length ?? 0,
              grounded: ragContext.results.length > 0,
              cacheBypassed: ragContext.results.length > 0,
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
            },
          },
        });

        const agenticComplexityLevel =
          PLAN_ENTITLEMENTS[ctx.plan ?? 'REGULATOR'].agenticComplexityLevel;

        // Track token usage for free trial users (fire-and-forget, non-fatal).
        if (ctx.plan === 'FREE_TRIAL') {
          incrementTrialUsage(ctx.user!.id, 'totalTokensUsed', answer.inputTokens + answer.outputTokens).catch(() => {});
        }

        const duration = Date.now() - startTime;

        // -- Orchestrated path --------------------------------------------------
        if (appConfig.features.orchestratorEnabled) {
          await runOrchestrator({
            complianceQueryId:      query.id,
            question:               input.question,
            answer:                 answer.content,
            ragResults:             ragContext.results,
            agenticComplexityLevel,
            shadow:                 false,
          });

          const run = await prisma.complianceQueryRun.findFirst({
            where:   { complianceQueryId: query.id },
            orderBy: { createdAt: 'desc' },
            select:  { id: true, route: true, grounded: true, verifierVerdict: true, acceptedChunkIds: true },
          });

          const route = run?.route ?? 'simple';
          const grounded = run?.grounded ?? false;
          const accepted = Array.isArray(run?.acceptedChunkIds) ? (run!.acceptedChunkIds as unknown[]).length : 0;
          const abstained = route === 'abstain' || accepted === 0 || run?.verifierVerdict === 'FAIL_ABSTAIN';
          // Confidence derived from verifier verdict. null when no run row (double-failure edge case).
          const confidence =
            run?.verifierVerdict === 'PASS'    ? 0.9 :
            run?.verifierVerdict === 'PARTIAL' ? 0.7 :
            null;

          logger.info({
            type:            'compliance_query_success',
            userId:          ctx.user!.id,
            queryId:         query.id,
            duration,
            tokensUsed:      answer.inputTokens + answer.outputTokens,
            citationsCount:  queryCitations.length,
            route,
            grounded,
            abstained,
            confidence,
            orchestrated:    true,
          });

          return {
            queryId:            query.id,
            answer:             answer.content,
            citations:          queryCitations,
            confidence,
            suggestedFollowUps: [],
            route,
            grounded,
            abstained,
            // null only on double-failure (orchestrator threw AND error-row write failed).
            // Frontend must disable the reportGap affordance when runId is null.
            runId:              run?.id ?? null,
          };
        }

        // -- Legacy grounded query path -----------------------------------------
        // Shadow orchestrator is fire-and-forget: never blocks the user response.
        runOrchestrator({
          complianceQueryId:      query.id,
          question:               input.question,
          answer:                 answer.content,
          ragResults:             ragContext.results,
          agenticComplexityLevel,
          shadow:                 true,
        }).catch(() => {});

        logger.info({
          type:           'compliance_query_success',
          userId:         ctx.user!.id,
          queryId:        query.id,
          duration,
          tokensUsed:     answer.inputTokens + answer.outputTokens,
          citationsCount: queryCitations.length,
          orchestrated:   false,
        });

        return {
          queryId:            query.id,
          answer:             answer.content,
          citations:          queryCitations,
          confidence:         null,
          suggestedFollowUps: [],
          route:              null as string | null,
          grounded:           ragContext.results.length > 0,
          abstained:          false,
          runId:              null as string | null,
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
  followUp: orgMemberProcedure
    .use(rateLimited('complianceQuery'))
    .input(followUpQuerySchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;
      logger.info({ type: 'compliance_query_followup', userId, organizationId });
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

        // Strict OR semantics (Option 2): block follow-up if either the user is not the
        // original author OR the query does not belong to the active org. Legacy null-org
        // queries are read-only -- even the original author cannot follow up (null !== orgId).
        const userMismatch = originalQuery.userId !== userId;
        const orgMismatch = originalQuery.organizationId !== organizationId;
        if (ctx.user!.role !== 'ADMIN' && (userMismatch || orgMismatch)) {
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

        // Generate answer grounded in retrieved evidence and original query context
        const answer = await ctx.aiService.answerFollowUpQuery(
          originalQuery.query,
          originalQuery.response || originalQuery.summary || '',
          input.question,
          ragContext.context || undefined,
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
          authorityStatus: source.authorityStatus ?? 'IN_FORCE',
          isBinding: source.isBinding ?? true,
          source: source.source ?? null,
          version: source.version ?? null,
        }));

        // Save follow-up query with citations as JSON
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId,
            organizationId,
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
          userId,
          organizationId,
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
          userId,
          organizationId,
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
            authorityStatus: r.authorityStatus ?? 'IN_FORCE',
            isBinding: r.isBinding ?? true,
            sourceAuthority: r.source ?? null,
            version: r.version ?? null,
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
   * Get query history, scoped to the caller's active organization.
   *
   * @protected @org-member
   */
  history: orgMemberProcedure
    .input(getQueryHistorySchema)
    .query(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;
      logger.info({ type: 'compliance_query_history', userId, organizationId });
      try {
        const { page, limit } = input;
        const skip = (page - 1) * limit;

        const where: any = {
          OR: [
            { organizationId },
            { organizationId: null }, // Legacy rows per KNOWN_ISSUES B5; remove when migrated
          ],
        };

        // Filter by user unless admin (admins see all queries within the org context)
        if (ctx.user!.role !== 'ADMIN') {
          where.userId = userId;
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
          userId,
          organizationId,
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
  getScore: orgMemberProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.orgMembership!.organizationId;

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
  getScoreHistory: orgMemberProcedure
    .input(z.object({ days: z.number().min(7).max(365).default(90) }))
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.orgMembership!.organizationId;

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
  getRecommendations: orgMemberProcedure.query(async ({ ctx }) => {
    try {
      const orgId = ctx.orgMembership!.organizationId;

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
  getRequirements: orgMemberProcedure
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
        const orgId = ctx.orgMembership!.organizationId;

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
  updateRequirement: orgMemberProcedure
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
  getDeadlines: orgMemberProcedure
    .input(z.object({ daysAhead: z.number().min(1).max(365).default(30) }))
    .query(async ({ input, ctx }) => {
      try {
        const orgId = ctx.orgMembership!.organizationId;

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
  getRoadmap: orgMemberProcedure
    .use(rateLimited('complianceQuery'))
    .query(async ({ ctx }) => {
      try {
        const orgId = ctx.orgMembership!.organizationId;

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
  // ===========================================================================
  // QUERY FEEDBACK
  // ===========================================================================

  /**
   * Submit or toggle feedback (thumbs up / thumbs down) on a compliance query.
   *
   * Toggle semantics (server-side):
   *  - No existing feedback  -> create with given rating
   *  - Existing same rating  -> delete (toggle off), return null
   *  - Existing diff rating  -> update to new rating
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
        // Same rating clicked again -> toggle off
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

  // ==========================================================================
  // SAVED RESPONSES
  // ==========================================================================

  /**
   * Toggle save/bookmark status for a compliance query response.
   *
   *  - Not saved -> save it, return { saved: true }
   *  - Already saved -> unsave it, return { saved: false }
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

      // Fire-and-forget audit log -- never block the response
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
  exportDocx: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('gapAnalysis'))
    .input(z.object({ analysisId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const orgId = ctx.orgMembership!.organizationId;

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

      // 2. Access check: org-scoped records require active membership in that org.
      // Legacy null-org records stay accessible to their owner only.
      const hasAccess = analysis.organizationId
        ? analysis.organizationId === orgId
        : analysis.userId === userId;

      if (!hasAccess) {
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

      // 5. Build DOCX buffer -- fetch org name separately (GapAnalysis has no direct org relation)
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

      // 8b. Persist report tracking fields (fire-and-forget -- non-blocking)
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
  exportChecklistDocx: orgMemberProcedure
    .use(withPlanContext)
    .use(requirePlanFeature('checklistGenerations'))
    .input(z.object({ checklistId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const orgId = ctx.orgMembership!.organizationId;

      // 1. Fetch the checklist with items and user -- no direct org relation on Checklist model
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

      // 2. Access check: org-scoped records require active membership in that org.
      // The two known legacy null-org rows are kept and remain owner-only.
      const hasAccess = checklist.organizationId
        ? checklist.organizationId === orgId
        : checklist.userId === userId;

      if (!hasAccess) {
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

      // 11. Signed URL -- 15-minute expiry
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
   * Report a corpus gap for a compliance query that returned no grounded evidence.
   * Writes a CorpusGapFeedback row for the corpus expansion backlog.
   *
   * @protected -- orgMemberProcedure; queryId ownership verified against ctx.user.id
   */
  reportGap: orgMemberProcedure
    .input(z.object({
      queryId:           z.string().cuid(),
      // null when orchestrator double-failed (run row not written). Frontend must
      // disable the "Tell us what's missing" button when runId is null.
      runId:             z.string().cuid().nullable(),
      suggestedDocument: z.string().max(500).optional(),
      notes:             z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Verify the query belongs to the calling user (IDOR protection).
      const complianceQuery = await prisma.complianceQuery.findUnique({
        where:  { id: input.queryId },
        select: { userId: true, query: true },
      });

      if (!complianceQuery || complianceQuery.userId !== ctx.user!.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Compliance query not found' });
      }

      // Null runId means the orchestrator double-failed -- no run row was written.
      // The frontend should have disabled the reportGap affordance in this case.
      if (!input.runId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No run record available for this query' });
      }

      // Verify the run belongs to this query (prevents runId spoofing).
      const run = await prisma.complianceQueryRun.findFirst({
        where:  { id: input.runId, complianceQueryId: input.queryId },
        select: { id: true },
      });

      if (!run) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Query run not found' });
      }

      const feedback = await prisma.corpusGapFeedback.create({
        data: {
          complianceQueryId: input.queryId,
          runId:             input.runId,
          userId:            ctx.user!.id,
          organizationId:    ctx.orgMembership!.organizationId,
          question:          complianceQuery.query,
          suggestedDocument: input.suggestedDocument,
          notes:             input.notes,
        },
        select: { id: true },
      });

      logger.info({
        type:             'corpus_gap_feedback_submitted',
        userId:           ctx.user!.id,
        organizationId:   ctx.orgMembership!.organizationId,
        queryId:          input.queryId,
        runId:            input.runId,
        feedbackId:       feedback.id,
        hasSuggestedDoc:  !!input.suggestedDocument,
      });

      return { feedbackId: feedback.id };
    }),

});
