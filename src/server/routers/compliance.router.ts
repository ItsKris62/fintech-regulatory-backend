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
  getSuggestedQueriesSchema,
  recordSuggestionClickSchema,
} from '../schemas/compliance.schema';
import { ragService, searchAndGetRegulatoryEvidenceContext } from '@/lib/rag/rag.service';
import { complianceModule } from '@/modules/compliance';
import { logger } from '@/utils/logger';
import { incrementTrialUsage } from '@/modules/trial';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { appConfig } from '@/config/app.config';
import { gapAnalysisExportService } from '@/services/gap-analysis-export.service';
import { checklistExportService } from '@/services/checklist-export.service';
import { complianceQueryExportService } from '@/services/complianceQueryExport.service';
import { storageService } from '@/lib/storage/storage.service';
import { GapAnalysisResultSchema } from '@/lib/ai/prompts/gap-analysis';
import {
  buildComplianceSourceInsufficiencyAnswer,
  buildUnsupportedClaimsAnswer,
  hasUsableSourceContext,
} from '@/lib/source-grounding/source-insufficiency';
import {
  buildCitationsFromAcceptedRefs,
  buildCitationsFromChunks,
  findAcceptedChunks,
  hasUsableCitations,
  validateCitationsForJurisdiction,
  type SourceCitation,
} from '@/lib/source-grounding/citations';
import {
  persistClaimVerification,
  verifyAnswerClaims,
} from '@/lib/source-grounding/claim-verification';
import {
  JURISDICTION_CAPABILITIES,
  JurisdictionContractError,
  resolveJurisdictionContext,
  resolvePersistedJurisdictionContext,
  serializeJurisdictionContext,
  type JurisdictionContext,
} from '@/types/jurisdiction';

function toTrpcJurisdictionError(error: JurisdictionContractError): TRPCError {
  return new TRPCError({
    code: error.code === 'JURISDICTION_NOT_AVAILABLE' ? 'BAD_REQUEST' : 'BAD_REQUEST',
    message: error.message,
    cause: error,
  });
}

function buildJurisdictionMetadata(context: JurisdictionContext, corpusVersions: Record<string, string | undefined>, retrievalVersion: string): Record<string, unknown> {
  return {
    ...serializeJurisdictionContext(context),
    corpusVersionSnapshot: corpusVersions,
    retrievalVersion,
  };
}

/**
 * Compliance Router
 *
 * Handles compliance queries with RAG-powered answers, document search,
 * and compliance checking features.
 */
export const complianceRouter = router({
  jurisdictionCapabilities: protectedProcedure
    .query(() => ({
      jurisdictions: Object.values(JURISDICTION_CAPABILITIES).map((capability) => ({
        code: capability.code,
        name: capability.label,
        queryEnabled: capability.queryEnabled,
        status: capability.status,
      })),
    })),

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
      let jurisdictionContext: JurisdictionContext;
      try {
        jurisdictionContext = resolveJurisdictionContext(input, { allowLegacyDefault: true });
      } catch (error) {
        if (error instanceof JurisdictionContractError) throw toTrpcJurisdictionError(error);
        throw error;
      }

      try {
        logger.info({
          type: 'compliance_query_start',
          userId: ctx.user!.id,
          question: input.question.substring(0, 100),
          jurisdiction: jurisdictionContext.primaryJurisdiction,
          jurisdictionSource: jurisdictionContext.jurisdictionSource,
        });

        // Search RAG for relevant context
        const ragContext = await searchAndGetRegulatoryEvidenceContext({
          query: input.question,
          jurisdictionContext,
          topK: 10,
          minScore: 0.7,
          preferActiveSources: true,
        });

        const agenticComplexityLevel =
          PLAN_ENTITLEMENTS[ctx.plan ?? 'REGULATOR'].agenticComplexityLevel;

        if (!hasUsableSourceContext(ragContext)) {
          const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer();
          const query = await (ctx.prisma.complianceQuery.create as any)({
            data: {
              query: input.question,
              userId: ctx.user!.id,
              organizationId: ctx.orgMembership!.organizationId,
              response: sourceInsufficientAnswer,
              citations: [],
              confidence: null,
              status: 'completed',
              mode: jurisdictionContext.mode,
              jurisdictions: [...jurisdictionContext.jurisdictions],
              primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
              jurisdictionSource: jurisdictionContext.jurisdictionSource,
              corpusVersionSnapshot: ragContext.corpusVersions,
              metadata: {
                ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
                ragSources: ragContext.results.length,
                ragContextChars: ragContext.context?.length ?? 0,
                grounded: false,
                abstained: true,
                sourceInsufficient: true,
                organizationType: input.organizationType,
                industry: input.industry,
                context: input.context,
              },
            },
          });

          logger.info({
            type: 'compliance_query_source_insufficient',
            userId: ctx.user!.id,
            queryId: query.id,
          });

          return {
            queryId: query.id,
            answer: sourceInsufficientAnswer,
            citations: [],
            confidence: null,
            suggestedFollowUps: [],
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
            route: 'abstain',
            grounded: false,
            abstained: true,
            runId: null as string | null,
          };
        }

        const preGenerationGrade = await runGraderAgent(
          input.question,
          ragContext.results,
          jurisdictionContext,
          10,
        );
        const acceptedResults = preGenerationGrade.accepted;
        const acceptedContext = ragService.getContextForPrompt(acceptedResults, 10, 4000);

        if (!hasUsableSourceContext({ results: acceptedResults, context: acceptedContext })) {
          const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer();
          const query = await (ctx.prisma.complianceQuery.create as any)({
            data: {
              query: input.question,
              userId: ctx.user!.id,
              organizationId: ctx.orgMembership!.organizationId,
              response: sourceInsufficientAnswer,
              citations: [],
              confidence: null,
              status: 'completed',
              mode: jurisdictionContext.mode,
              jurisdictions: [...jurisdictionContext.jurisdictions],
              primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
              jurisdictionSource: jurisdictionContext.jurisdictionSource,
              corpusVersionSnapshot: ragContext.corpusVersions,
              metadata: {
                ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
                ragSources: ragContext.results.length,
                acceptedSources: acceptedResults.length,
                graderFailed: preGenerationGrade.gradeFailed,
                grounded: false,
                abstained: true,
                sourceInsufficient: true,
                organizationType: input.organizationType,
                industry: input.industry,
                context: input.context,
              },
            },
          });

          logger.info({
            type: 'compliance_query_no_accepted_sources',
            userId: ctx.user!.id,
            queryId: query.id,
            retrievedSources: ragContext.results.length,
            graderFailed: preGenerationGrade.gradeFailed,
          });

          return {
            queryId: query.id,
            answer: sourceInsufficientAnswer,
            citations: [],
            confidence: null,
            suggestedFollowUps: [],
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
            route: 'abstain',
            grounded: false,
            abstained: true,
            runId: null as string | null,
          };
        }

        // Generate answer grounded in retrieved evidence
        const answer = await ctx.aiService.answerComplianceQuery({
          question: input.question,
          organizationType: input.organizationType,
          industry: input.industry,
          context: input.context,
          jurisdictionContext,
          ragContext: acceptedContext || undefined,
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
        const queryCitations = buildCitationsFromChunks(acceptedResults, 'not_checked');
        const legacyClaimVerification = !appConfig.features.orchestratorEnabled
          ? verifyAnswerClaims(answer.content, acceptedResults)
          : null;
        const finalAnswerContent = legacyClaimVerification?.unsupportedClaims.length
          ? buildUnsupportedClaimsAnswer(legacyClaimVerification.unsupportedClaims.map((claim) => claim.claimText))
          : answer.content;
        const finalQueryCitations = legacyClaimVerification?.unsupportedClaims.length ? [] : queryCitations;
        const finalCitationValidation = validateCitationsForJurisdiction(finalQueryCitations, jurisdictionContext);
        const safeFinalAnswerContent = finalCitationValidation.valid ? finalAnswerContent : buildComplianceSourceInsufficiencyAnswer();
        const safeFinalQueryCitations = finalCitationValidation.valid ? finalQueryCitations : [];

        // Guard: warn if RAG chunks are missing documentIds (ingestion gap)
        const missingDocIds = safeFinalQueryCitations.filter((c: SourceCitation) => !c.documentId).length;
        if (missingDocIds > 0) {
          logger.warn({
            type: 'compliance_query_citations_missing_doc_ids',
            userId: ctx.user!.id,
            missingCount: missingDocIds,
            totalCount: finalQueryCitations.length,
          });
        }

        // Persist query with citations stored atomically as JSON
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId: ctx.user!.id,
            organizationId: ctx.orgMembership!.organizationId,
            response: safeFinalAnswerContent,
            citations: safeFinalQueryCitations.length > 0 ? safeFinalQueryCitations : undefined,
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
            corpusVersionSnapshot: ragContext.corpusVersions,
            metadata: {
              ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
              model: answer.model,
              tokensUsed: answer.inputTokens + answer.outputTokens,
              ragSources: ragContext.results.length,
              acceptedSources: acceptedResults.length,
              ragContextChars: acceptedContext.length,
              grounded: hasUsableCitations(safeFinalQueryCitations),
              citationJurisdictionValid: finalCitationValidation.valid,
              citationJurisdictionInvalidCount: finalCitationValidation.invalidCitations.length,
              cacheBypassed: true,
              graderFailed: preGenerationGrade.gradeFailed,
              claimVerificationVerdict: legacyClaimVerification?.verdict,
              unsupportedClaims: legacyClaimVerification?.unsupportedClaims.map((claim) => claim.claimText) ?? [],
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
            },
          },
        });

        // Track token usage for free trial users (fire-and-forget, non-fatal).
        if (ctx.plan === 'FREE_TRIAL') {
          incrementTrialUsage(ctx.user!.id, 'totalTokensUsed', answer.inputTokens + answer.outputTokens).catch(() => { });
        }

        const duration = Date.now() - startTime;

        // -- Orchestrated path --------------------------------------------------
        if (appConfig.features.orchestratorEnabled) {
          await runOrchestrator({
            complianceQueryId: query.id,
            question: input.question,
            answer: answer.content,
            ragResults: ragContext.results,
            jurisdictionContext,
            corpusVersionSnapshot: ragContext.corpusVersions,
            retrievalVersion: ragContext.retrievalVersion,
            agenticComplexityLevel,
            shadow: false,
          });

          const run = await prisma.complianceQueryRun.findFirst({
            where: { complianceQueryId: query.id },
            orderBy: { createdAt: 'desc' },
            select: { id: true, route: true, grounded: true, verifierVerdict: true, acceptedChunkIds: true },
          });

          const route = run?.route ?? 'simple';
          const grounded = run?.grounded ?? false;
          const accepted = Array.isArray(run?.acceptedChunkIds) ? (run!.acceptedChunkIds as unknown[]).length : 0;
          const abstained = route === 'abstain' || accepted === 0 || run?.verifierVerdict === 'FAIL' || run?.verifierVerdict === 'FAIL_ABSTAIN';
          // Confidence derived from verifier verdict. null when no run row (double-failure edge case).
          const confidence =
            run?.verifierVerdict === 'PASS' ? 0.9 :
              run?.verifierVerdict === 'PARTIAL' ? 0.7 :
                null;
          const acceptedCitations = buildCitationsFromAcceptedRefs(
            run?.acceptedChunkIds,
            ragContext.results,
            run?.verifierVerdict === 'PASS' ? 'verified' : 'unverified',
          );
          const acceptedCitationValidation = validateCitationsForJurisdiction(acceptedCitations, jurisdictionContext);
          const acceptedChunksForClaims = findAcceptedChunks(run?.acceptedChunkIds, ragContext.results);
          const claimVerification = verifyAnswerClaims(answer.content, acceptedChunksForClaims);
          await persistClaimVerification(ctx.prisma, query.id, claimVerification);

          if (
            abstained ||
            run?.verifierVerdict === 'FAIL' ||
            !hasUsableCitations(acceptedCitations) ||
            !acceptedCitationValidation.valid ||
            claimVerification.unsupportedClaims.length > 0
          ) {
            const sourceInsufficientAnswer = claimVerification.unsupportedClaims.length > 0
              ? buildUnsupportedClaimsAnswer(claimVerification.unsupportedClaims.map((claim) => claim.claimText))
              : buildComplianceSourceInsufficiencyAnswer();
            await ctx.prisma.complianceQuery.update({
              where: { id: query.id },
              data: {
                response: sourceInsufficientAnswer,
                citations: [],
                confidence: null,
                metadata: {
                  model: answer.model,
                  tokensUsed: answer.inputTokens + answer.outputTokens,
                  ragSources: ragContext.results.length,
                  acceptedSources: accepted,
                  grounded: false,
                  abstained: true,
                  sourceInsufficient: true,
                  ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
                  verifierVerdict: run?.verifierVerdict ?? null,
                  citationJurisdictionValid: acceptedCitationValidation.valid,
                  citationJurisdictionInvalidCount: acceptedCitationValidation.invalidCitations.length,
                  claimVerificationVerdict: claimVerification.verdict,
                  unsupportedClaims: claimVerification.unsupportedClaims.map((claim) => claim.claimText),
                  organizationType: input.organizationType,
                  industry: input.industry,
                  context: input.context,
                },
              },
            });

            return {
              queryId: query.id,
              answer: sourceInsufficientAnswer,
              citations: [],
              confidence: null,
              suggestedFollowUps: [],
              mode: jurisdictionContext.mode,
              jurisdictions: [...jurisdictionContext.jurisdictions],
              primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
              jurisdictionSource: jurisdictionContext.jurisdictionSource,
              route,
              grounded: false,
              abstained: true,
              runId: run?.id ?? null,
            };
          }

          await ctx.prisma.complianceQuery.update({
            where: { id: query.id },
            data: {
              citations: acceptedCitations,
              confidence,
              metadata: {
                model: answer.model,
                tokensUsed: answer.inputTokens + answer.outputTokens,
                ragSources: ragContext.results.length,
                acceptedSources: acceptedCitations.length,
                grounded,
                abstained,
                ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
                verifierVerdict: run?.verifierVerdict ?? null,
                claimVerificationVerdict: claimVerification.verdict,
                verifiedClaims: claimVerification.supportedClaims.length,
                unsupportedClaims: [],
                verificationStatus: run?.verifierVerdict === 'PASS' ? 'verified' : 'unverified',
                citationJurisdictionValid: acceptedCitationValidation.valid,
                citationJurisdictionInvalidCount: acceptedCitationValidation.invalidCitations.length,
                organizationType: input.organizationType,
                industry: input.industry,
                context: input.context,
              },
            },
          });

          logger.info({
            type: 'compliance_query_success',
            userId: ctx.user!.id,
            queryId: query.id,
            duration,
            tokensUsed: answer.inputTokens + answer.outputTokens,
            citationsCount: acceptedCitations.length,
            route,
            grounded,
            abstained,
            confidence,
            orchestrated: true,
          });

          return {
            queryId: query.id,
            answer: answer.content,
            citations: acceptedCitations,
            confidence,
            suggestedFollowUps: [],
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
            route,
            grounded,
            abstained,
            // null only on double-failure (orchestrator threw AND error-row write failed).
            // Frontend must disable the reportGap affordance when runId is null.
            runId: run?.id ?? null,
          };
        }

        // -- Legacy grounded query path -----------------------------------------
        // Shadow orchestrator is fire-and-forget: never blocks the user response.
        if (legacyClaimVerification) {
          await persistClaimVerification(ctx.prisma, query.id, legacyClaimVerification);
        }

        runOrchestrator({
          complianceQueryId: query.id,
          question: input.question,
          answer: answer.content,
          ragResults: ragContext.results,
          jurisdictionContext,
          corpusVersionSnapshot: ragContext.corpusVersions,
          retrievalVersion: ragContext.retrievalVersion,
          agenticComplexityLevel,
          shadow: true,
        }).catch(() => { });

        logger.info({
          type: 'compliance_query_success',
          userId: ctx.user!.id,
          queryId: query.id,
          duration,
          tokensUsed: answer.inputTokens + answer.outputTokens,
          citationsCount: finalQueryCitations.length,
          orchestrated: false,
          claimVerificationVerdict: legacyClaimVerification?.verdict,
        });

        return {
          queryId: query.id,
          answer: safeFinalAnswerContent,
          citations: safeFinalQueryCitations,
          confidence: null,
          suggestedFollowUps: [],
          mode: jurisdictionContext.mode,
          jurisdictions: [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
          jurisdictionSource: jurisdictionContext.jurisdictionSource,
          route: null as string | null,
          grounded: hasUsableCitations(safeFinalQueryCitations),
          abstained: safeFinalQueryCitations.length === 0,
          runId: null as string | null,
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
    .use(withPlanContext)
    .use(checkUsageLimit(BillingMetric.COMPLIANCE_QUERIES, { deferIncrement: true }))
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

        const jurisdictionContext = resolvePersistedJurisdictionContext(originalQuery);

        // Search RAG with context from original query
        const ragContext = await searchAndGetRegulatoryEvidenceContext({
          query: input.question,
          jurisdictionContext,
          topK: 10,
          minScore: 0.7,
          preferActiveSources: true,
        });

        if (!hasUsableSourceContext(ragContext)) {
          const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer();
          const query = await (ctx.prisma.complianceQuery.create as any)({
            data: {
              query: input.question,
              userId,
              organizationId,
              response: sourceInsufficientAnswer,
              citations: [],
              status: 'completed',
              mode: jurisdictionContext.mode,
              jurisdictions: [...jurisdictionContext.jurisdictions],
              primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
              jurisdictionSource: jurisdictionContext.jurisdictionSource,
              corpusVersionSnapshot: ragContext.corpusVersions,
              metadata: {
                ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
                followUpTo: input.originalQueryId,
                ragSources: ragContext.results.length,
                ragContextChars: ragContext.context?.length ?? 0,
                grounded: false,
                abstained: true,
                sourceInsufficient: true,
              },
            },
          });

          logger.info({
            type: 'compliance_followup_source_insufficient',
            userId: ctx.user!.id,
            queryId: query.id,
            originalQueryId: input.originalQueryId,
          });

          return {
            queryId: query.id,
            answer: sourceInsufficientAnswer,
            citations: [],
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
          };
        }

        const preGenerationGrade = await runGraderAgent(input.question, ragContext.results, jurisdictionContext, 10);
        const acceptedResults = preGenerationGrade.accepted;
        const acceptedContext = ragService.getContextForPrompt(acceptedResults, 10, 4000);

        if (!hasUsableSourceContext({ results: acceptedResults, context: acceptedContext })) {
          const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer();
          const query = await (ctx.prisma.complianceQuery.create as any)({
            data: {
              query: input.question,
              userId,
              organizationId,
              response: sourceInsufficientAnswer,
              citations: [],
              status: 'completed',
              mode: jurisdictionContext.mode,
              jurisdictions: [...jurisdictionContext.jurisdictions],
              primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
              jurisdictionSource: jurisdictionContext.jurisdictionSource,
              corpusVersionSnapshot: ragContext.corpusVersions,
              metadata: {
                ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
                followUpTo: input.originalQueryId,
                ragSources: ragContext.results.length,
                acceptedSources: acceptedResults.length,
                graderFailed: preGenerationGrade.gradeFailed,
                grounded: false,
                abstained: true,
                sourceInsufficient: true,
              },
            },
          });

          logger.info({
            type: 'compliance_followup_no_accepted_sources',
            userId,
            queryId: query.id,
            originalQueryId: input.originalQueryId,
            retrievedSources: ragContext.results.length,
            graderFailed: preGenerationGrade.gradeFailed,
          });

          return {
            queryId: query.id,
            answer: sourceInsufficientAnswer,
            citations: [],
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
          };
        }

        // Generate answer grounded in retrieved evidence and original query context
        const answer = await ctx.aiService.answerFollowUpQuery(
          originalQuery.query,
          originalQuery.response || originalQuery.summary || '',
          input.question,
          acceptedContext || undefined,
          jurisdictionContext,
        );

        // Same citation pattern as the primary query mutation:
        // store RAG source references as JSON on ComplianceQuery, not in
        // the Citation table (which has a FK constraint to Policy.id).
        const queryCitations = buildCitationsFromChunks(acceptedResults, 'not_checked');
        const claimVerification = verifyAnswerClaims(answer.content, acceptedResults);
        const finalAnswer = claimVerification.unsupportedClaims.length > 0
          ? buildUnsupportedClaimsAnswer(claimVerification.unsupportedClaims.map((claim) => claim.claimText))
          : answer.content;
        const finalCitations = claimVerification.unsupportedClaims.length > 0 ? [] : queryCitations;
        const finalCitationValidation = validateCitationsForJurisdiction(finalCitations, jurisdictionContext);
        const safeFinalAnswer = finalCitationValidation.valid ? finalAnswer : buildComplianceSourceInsufficiencyAnswer();
        const safeFinalCitations = finalCitationValidation.valid ? finalCitations : [];

        // Save follow-up query with citations as JSON
        const query = await (ctx.prisma.complianceQuery.create as any)({
          data: {
            query: input.question,
            userId,
            organizationId,
            response: safeFinalAnswer,
            citations: safeFinalCitations.length > 0 ? safeFinalCitations : undefined,
            mode: jurisdictionContext.mode,
            jurisdictions: [...jurisdictionContext.jurisdictions],
            primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
            jurisdictionSource: jurisdictionContext.jurisdictionSource,
            corpusVersionSnapshot: ragContext.corpusVersions,
            metadata: {
              ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
              followUpTo: input.originalQueryId,
              model: answer.model,
              tokensUsed: answer.inputTokens + answer.outputTokens,
              ragSources: ragContext.results.length,
              acceptedSources: acceptedResults.length,
              grounded: hasUsableCitations(safeFinalCitations),
              graderFailed: preGenerationGrade.gradeFailed,
              claimVerificationVerdict: claimVerification.verdict,
              unsupportedClaims: claimVerification.unsupportedClaims.map((claim) => claim.claimText),
              citationJurisdictionValid: finalCitationValidation.valid,
              citationJurisdictionInvalidCount: finalCitationValidation.invalidCitations.length,
            },
          },
        });

        await persistClaimVerification(ctx.prisma, query.id, claimVerification);

        await ctx.incrementUsage?.();

        if (ctx.plan === 'FREE_TRIAL') {
          const tokensUsed = answer.inputTokens + answer.outputTokens;
          if (tokensUsed > 0) {
            await incrementTrialUsage(ctx.user!.id, 'totalTokensUsed', tokensUsed);
          }
        }

        logger.info({
          type: 'compliance_followup_success',
          userId,
          organizationId,
          queryId: query.id,
          originalQueryId: input.originalQueryId,
          citationsCount: safeFinalCitations.length,
          claimVerificationVerdict: claimVerification.verdict,
        });

        return {
          queryId: query.id,
          answer: safeFinalAnswer,
          citations: safeFinalCitations,
          mode: jurisdictionContext.mode,
          jurisdictions: [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
          jurisdictionSource: jurisdictionContext.jurisdictionSource,
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
              primaryJurisdiction: true,
              jurisdictionSource: true,
              jurisdictions: true,
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

  getFollowUps: orgMemberProcedure
    .input(z.object({ originalQueryId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      const originalQuery = await ctx.prisma.complianceQuery.findUnique({
        where: { id: input.originalQueryId },
        select: { id: true, userId: true, organizationId: true },
      });

      if (!originalQuery) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Original query not found' });
      }

      if (
        ctx.user!.role !== 'ADMIN' &&
        (originalQuery.userId !== userId || originalQuery.organizationId !== organizationId)
      ) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this query' });
      }

      const followUps = await (ctx.prisma.complianceQuery.findMany as any)({
        where: {
          userId,
          organizationId,
          metadata: { path: ['followUpTo'], equals: input.originalQueryId },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          query: true,
          response: true,
          citations: true,
          confidence: true,
          createdAt: true,
          primaryJurisdiction: true,
          jurisdictionSource: true,
          jurisdictions: true,
        },
      });

      return { followUps };
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
  // SUGGESTED QUERIES
  // ===========================================================================

  /**
   * Get personalised suggested queries for the active user.
   *
   * Builds 5 suggestions from five signal tiers (graceful degradation):
   * 1. Organization.industry -> curated template match
   * 2. User's recent query regulatory areas (last ~20)
   * 3. Most recent active RegulatoryAlert
   * 4. Cohort popular templates (same organizationType, >=5 distinct orgs, 30d)
   * 5. Curated baseline
   *
   * Result is cached per-user in Redis for 1 hour.
   *
   * @protected @org-member
   */
  getSuggestedQueries: orgMemberProcedure
    .use(rateLimited('suggestedQueries'))
    .input(getSuggestedQueriesSchema)
    .query(async ({ ctx }) => {
      const userId = ctx.user!.id;
      const organizationId = ctx.orgMembership!.organizationId;

      logger.info({ type: 'suggested_queries_requested', userId, organizationId });

      try {
        const suggestions = await complianceModule.buildSuggestedQueries(userId, organizationId);

        logger.info({
          type: 'suggested_queries_shown',
          userId,
          organizationId,
          count: suggestions.length,
          signals: suggestions.map((s) => s.reason),
        });

        return { suggestions };
      } catch (error: any) {
        logger.error({
          type: 'suggested_queries_endpoint_error',
          userId,
          organizationId,
          error: error.message,
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to get suggested queries',
          cause: error,
        });
      }
    }),

  /**
   * Record a suggestion click for telemetry.
   *
   * Fire-and-forget from the frontend. Never blocks the user.
   *
   * @protected
   */
  recordSuggestionClick: protectedProcedure
    .use(rateLimited('suggestionClick'))
    .input(recordSuggestionClickSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      logger.info({
        type: 'suggested_query_clicked',
        userId,
        suggestionId: input.suggestionId,
        suggestionText: input.suggestionText,
        surface: input.surface,
      });

      ctx.prisma.auditLog.create({
        data: {
          userId,
          action: 'SUGGESTED_QUERY_CLICKED',
          entityType: 'ComplianceQuerySuggestion',
          entityId: input.suggestionId,
          metadata: {
            suggestionText: input.suggestionText ?? null,
            surface: input.surface,
          },
          ipAddress: ctx.req.ip ?? null,
          userAgent: (ctx.req.headers['user-agent'] as string | undefined) ?? null,
        },
      }).catch((err: unknown) => {
        logger.error({
          type: 'suggested_query_click_audit_log_failed',
          userId,
          suggestionId: input.suggestionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return { success: true };
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
    .use(rateLimited('compliance_feedback', 30, { window: 60 }))
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
      let action: 'created' | 'updated' | 'cleared';

      if (existing && existing.rating === input.rating) {
        // Same rating clicked again -> toggle off
        await ctx.prisma.queryFeedback.delete({
          where: { queryId_userId: { queryId: input.queryId, userId } },
        });
        newRating = null;
        action = 'cleared';
      } else {
        // Create or switch to new rating
        await ctx.prisma.queryFeedback.upsert({
          where: { queryId_userId: { queryId: input.queryId, userId } },
          create: { queryId: input.queryId, userId, rating: input.rating },
          update: { rating: input.rating },
        });
        newRating = input.rating;
        action = existing ? 'updated' : 'created';
      }

      logger.info({
        type: 'query_feedback_submitted',
        userId,
        queryId: input.queryId,
        rating: newRating,
        previousRating: existing?.rating ?? null,
        action,
        tracked: newRating !== null,
      });

      // Invalidate feedback summary cache -- fail-soft so a cache error never
      // blocks a successful vote write.
      try {
        const members = await redis.smembers<string[]>('sheriabot:idx:analytics:feedback-keys');
        if (members.length > 0) {
          await redis.del(...(members as [string, ...string[]]));
        }
        await redis.del('sheriabot:idx:analytics:feedback-keys');
        logger.info({
          type: 'analytics_feedback_cache_invalidated',
          success: true,
          keysInvalidated: members.length,
        });
      } catch (cacheErr: unknown) {
        logger.warn({
          type: 'analytics_feedback_cache_invalidated',
          success: false,
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }

      return { rating: newRating, action, tracked: newRating !== null };
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
        selectedBenchmarkDocuments: parsed.data.metadata.selectedBenchmarkDocuments ?? [],
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
          user: { select: { fullName: true } },
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
            id: i.id,
            itemCode: i.itemCode ?? null,
            category: i.category ?? 'General',
            title: i.title,
            description: i.description,
            guidance: i.guidance ?? null,
            regulatoryReference: i.regulatoryReference ?? '',
            actionItems: Array.isArray(i.actionItems) ? (i.actionItems as string[]) : [],
            deadline: i.deadline ?? null,
            penalty: i.penalty ?? null,
            priority: i.priority,
            status: i.status,
            notes: i.notes ?? null,
            completedAt: i.completedAt ?? null,
          })),
        };
      });

      // 7. Parse summary JSON
      const summaryRaw = checklist.summary as Record<string, unknown> | null;
      const summary = summaryRaw
        ? {
          criticalItems: typeof summaryRaw['criticalItems'] === 'number' ? summaryRaw['criticalItems'] : undefined,
          highItems: typeof summaryRaw['highItems'] === 'number' ? summaryRaw['highItems'] : undefined,
          estimatedCompletionDays: typeof summaryRaw['estimatedCompletionDays'] === 'number' ? summaryRaw['estimatedCompletionDays'] : undefined,
        }
        : null;

      // 8. Compute progress
      const completedItems = checklistItemRows.filter((i) => i.status === 'COMPLETED').length;
      const progress = itemCount > 0 ? Math.round((completedItems / itemCount) * 100) : 0;

      // 9. Build DOCX buffer
      const docxBuffer = await checklistExportService.generateChecklistDocx({
        checklistId: checklist.id,
        title: checklist.title,
        productType: checklist.productType ?? null,
        businessStage: checklist.businessStage ?? null,
        progress,
        completedItems,
        totalItems: checklist.totalItems > 0 ? checklist.totalItems : itemCount,
        generatedAt: checklist.generatedAt ?? null,
        createdAt: checklist.createdAt,
        summary,
        categories,
        organizationName: orgName ?? undefined,
        userName: checklist.user?.fullName ?? undefined,
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
   * Export a compliance query as a DOCX file.
   *
   * Generates a Word document containing the question and AI response,
   * uploads it to R2, and returns a signed download URL with 1-hour expiry.
   *
   * @protected @org-member - gated on complianceQuery feature
   */
  exportQueryDocx: orgMemberProcedure
    .use(withPlanContext)
    .input(z.object({ queryId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user!.id;

      // 1. Fetch the query
      const queryRecord = await prisma.complianceQuery.findUnique({
        where: { id: input.queryId },
        select: {
          id: true,
          query: true,
          response: true,
          userId: true,
          organizationId: true,
          createdAt: true,
          citations: true,
        },
      });

      if (!queryRecord) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Query not found' });
      }

      // 2. Access check - user owns the query or is admin
      if (ctx.user!.role !== 'ADMIN' && queryRecord.userId !== userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied to this query' });
      }

      // 3. Must have a response to export
      if (!queryRecord.response || queryRecord.response.trim().length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This query has no response to export.',
        });
      }

      // 4. Fetch org name for the DOCX cover
      const orgName = queryRecord.organizationId
        ? (await prisma.organization.findUnique({
          where: { id: queryRecord.organizationId },
          select: { name: true },
        }))?.name ?? undefined
        : undefined;

      // 5. Build DOCX buffer
      const docxBuffer = await complianceQueryExportService.generateComplianceQueryDocx({
        queryId: queryRecord.id,
        question: queryRecord.query,
        response: queryRecord.response,
        createdAt: queryRecord.createdAt,
        organizationName: orgName,
        citations: Array.isArray(queryRecord.citations) ? queryRecord.citations : [],
      });

      // 6. Build sanitised filename
      const dateSafe = queryRecord.createdAt.toISOString().slice(0, 10);
      const timestamp = Date.now();
      const filename = `SheriaBot_Compliance_Query_${dateSafe}_${timestamp}.docx`;

      // 7. Upload to R2 under exports/compliance-queries/
      const uploadResult = await storageService.uploadComplianceQueryExport(
        docxBuffer,
        input.queryId,
        timestamp,
        userId,
      );

      // 9. Generate signed URL with 1-hour expiry (3600 seconds)
      const downloadUrl = await storageService.getVaultDownloadUrl(uploadResult.key, 3600, filename);
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

      prisma.auditLog.create({
        data: {
          userId,
          action: 'COMPLIANCE_QUERY_EXPORTED',
          entityType: 'ComplianceQuery',
          entityId: queryRecord.id,
          metadata: { format: 'docx', filename, r2Key: uploadResult.key },
          ipAddress: ctx.req.ip ?? null,
          userAgent: (ctx.req.headers['user-agent'] as string | undefined) ?? null,
        },
      }).catch((err: unknown) => {
        logger.error({
          type: 'compliance_query_export_audit_log_failed',
          userId,
          queryId: input.queryId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      logger.info({
        type: 'compliance_query_docx_exported',
        userId,
        queryId: input.queryId,
        filename,
        r2Key: uploadResult.key,
      });

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
      queryId: z.string().cuid(),
      // null when orchestrator double-failed (run row not written). Frontend must
      // disable the "Tell us what's missing" button when runId is null.
      runId: z.string().cuid().nullable(),
      suggestedDocument: z.string().max(500).optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Verify the query belongs to the calling user (IDOR protection).
      const complianceQuery = await prisma.complianceQuery.findUnique({
        where: { id: input.queryId },
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
        where: { id: input.runId, complianceQueryId: input.queryId },
        select: { id: true },
      });

      if (!run) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Query run not found' });
      }

      const feedback = await prisma.corpusGapFeedback.create({
        data: {
          complianceQueryId: input.queryId,
          runId: input.runId,
          userId: ctx.user!.id,
          organizationId: ctx.orgMembership!.organizationId,
          question: complianceQuery.query,
          suggestedDocument: input.suggestedDocument,
          notes: input.notes,
        },
        select: { id: true },
      });

      logger.info({
        type: 'corpus_gap_feedback_submitted',
        userId: ctx.user!.id,
        organizationId: ctx.orgMembership!.organizationId,
        queryId: input.queryId,
        runId: input.runId,
        feedbackId: feedback.id,
        hasSuggestedDoc: !!input.suggestedDocument,
      });

      return { feedbackId: feedback.id };
    }),

});
