import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { runRouterAgent } from './router.agent';
import { runGraderAgent } from './grader.agent';
import { runVerifierAgent } from './verifier.agent';
import { TOKEN_BUDGETS, type ControlTokens, type QueryRunTrace, type AcceptedChunkRef } from './types';
import type { SearchResult } from '@/lib/rag/rag.service';
import type { CorpusVersionSnapshot } from '@/lib/rag/corpus-version';
import { resolveJurisdictionContext, type JurisdictionContext } from '@/types/jurisdiction';

export interface OrchestratorInput {
  complianceQueryId: string;
  question: string;
  answer: string;
  ragResults: SearchResult[];
  jurisdictionContext?: JurisdictionContext;
  corpusVersionSnapshot?: CorpusVersionSnapshot;
  retrievalVersion?: string;
  agenticComplexityLevel: 'simple' | 'complex';
  shadow: boolean;
  synthesisTokens?: {
    input: number;
    output: number;
    model?: string;
    provider?: string;
  };
}

export async function runOrchestrator(input: OrchestratorInput): Promise<void> {
  const t0 = Date.now();
  const budget = TOKEN_BUDGETS[input.agenticComplexityLevel];
  const controlTokens: ControlTokens = {};
  if (input.synthesisTokens) {
    controlTokens.synthesis = {
      input: input.synthesisTokens.input,
      output: input.synthesisTokens.output,
    };
  }
  const jurisdictionContext = input.jurisdictionContext
    ?? resolveJurisdictionContext({}, { allowLegacyDefault: true });
  const corpusVersionSnapshot = input.corpusVersionSnapshot ?? {};
  const retrievalVersion = input.retrievalVersion ?? 'legacy-unscoped';

  try {
    // ── 1. Router ──────────────────────────────────────────────────────────────
    const routerResult = await runRouterAgent(input.question, jurisdictionContext);
    controlTokens.router = routerResult.tokens;

    // Tier gating: downgrade 'complex' to 'simple' when plan only allows 'simple'
    let route = routerResult.route;
    let routeDowngraded = false;
    let routeDowngradeReason: string | null = null;

    if (input.agenticComplexityLevel === 'simple' && route === 'complex') {
      routeDowngraded = true;
      routeDowngradeReason = 'plan tier: simple — complex route not available';
      route = 'simple';
    }

    // ── Abstain short-circuit ──────────────────────────────────────────────────
    if (route === 'abstain') {
      const wallMs = Date.now() - t0;
      const routerTokens = routerResult.tokens;

      await prisma.complianceQueryRun.create({
        data: {
          complianceQueryId:    input.complianceQueryId,
          shadow:               input.shadow,
          status:               'completed',
          route:                'abstain',
          routeConfidence:      routerResult.confidence,
          routeDowngraded:      false,
          routeDowngradeReason: null,
          grounded:             false,
          ragSources:           input.ragResults.length,
          jurisdictions:         [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : null,
          jurisdictionSource:    jurisdictionContext.jurisdictionSource,
          corpusVersionSnapshot,
          retrievalVersion,
          retrievedVectorIds:    input.ragResults.map((result) => result.vectorId),
          gradeChunksInspected: 0,
          acceptedChunkIds:     [],
          rejectedChunkCount:   0,
          tokenBudgetExceeded:  false,
          controlTokens:        { router: routerTokens } as any,
          inputTokens:          routerTokens.input,
          outputTokens:         routerTokens.output,
          graderFailed:         false,
          routerParseFallback:  routerResult.parseFailed,
          verifierParseFallback: false,
          verifierVerdict:      null,
          fallbackReason:       routerResult.parseFailed ? 'router_parse_fail' : null,
          errorMessage:         null,
          wallMs,
        },
      });

      logger.info({
        type:              'orchestrator_run_abstained',
        complianceQueryId: input.complianceQueryId,
        shadow:            input.shadow,
        routeConfidence:   routerResult.confidence,
        wallMs,
      });

      return;
    }

    // ── 2. Grader ──────────────────────────────────────────────────────────────
    const graderResult = await runGraderAgent(
      input.question,
      input.ragResults,
      jurisdictionContext,
      budget.maxGradeChunks
    );
    controlTokens.grader = graderResult.tokens;

    const gradeChunksInspected = graderResult.accepted.length + graderResult.rejected.length;

    const acceptedChunkIds: AcceptedChunkRef[] = graderResult.accepted.map(r => ({
      vectorId:      r.vectorId,
      chunkId:       r.chunkId,
      documentId:    r.documentId,
      documentTitle: r.documentTitle,
      jurisdictionCode: r.jurisdictionCode,
      section:       r.section,
      contentHash:   r.contentHash,
      rank:          r.rank,
    }));

    // ── 3. Verifier ────────────────────────────────────────────────────────────
    const verifierResult = await runVerifierAgent(input.answer, graderResult.accepted, jurisdictionContext);
    controlTokens.verifier = verifierResult.tokens;

    // ── 4. Token accounting ────────────────────────────────────────────────────
    const inputTokens =
      (controlTokens.router?.input   ?? 0) +
      (controlTokens.grader?.input   ?? 0) +
      (controlTokens.synthesis?.input ?? 0) +
      (controlTokens.verifier?.input ?? 0);
    const outputTokens =
      (controlTokens.router?.output   ?? 0) +
      (controlTokens.grader?.output   ?? 0) +
      (controlTokens.synthesis?.output ?? 0) +
      (controlTokens.verifier?.output ?? 0);

    const tokenBudgetExceeded = (inputTokens + outputTokens) > budget.maxTotalTokens;

    if (tokenBudgetExceeded) {
      logger.warn({
        type: 'orchestrator_token_budget_exceeded',
        complianceQueryId: input.complianceQueryId,
        totalTokensUsed: inputTokens + outputTokens,
        maxTotalTokens: budget.maxTotalTokens,
        agenticComplexityLevel: input.agenticComplexityLevel,
      });
    }

    // ── 5. Fallback reason summary ─────────────────────────────────────────────
    const fallbackParts: string[] = [];
    if (routerResult.parseFailed) fallbackParts.push('router_parse_fail');
    if (graderResult.gradeFailed) fallbackParts.push('grader_fail');
    if (verifierResult.parseFailed) fallbackParts.push('verifier_parse_fail');
    const fallbackReason = fallbackParts.length > 0 ? fallbackParts.join('; ') : null;

    const wallMs = Date.now() - t0;

    const trace: QueryRunTrace = {
      complianceQueryId:    input.complianceQueryId,
      shadow:               input.shadow,
      status:               'completed',
      route,
      routeConfidence:      routerResult.confidence,
      routeDowngraded,
      routeDowngradeReason,
      grounded:             graderResult.accepted.length > 0,
      ragSources:           input.ragResults.length,
      subQuestions:         routerResult.subQuestions,
      retrievalQueries:     [input.question],
      jurisdictions:        [...jurisdictionContext.jurisdictions],
      primaryJurisdiction: jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : null,
      jurisdictionSource:   jurisdictionContext.jurisdictionSource,
      corpusVersionSnapshot,
      retrievalVersion,
      retrievedVectorIds:   input.ragResults.map((result) => result.vectorId),
      gradeChunksInspected,
      acceptedChunkIds,
      rejectedChunkCount:   graderResult.rejected.length,
      tokenBudgetExceeded,
      controlTokens,
      inputTokens,
      outputTokens,
      graderFailed:         graderResult.gradeFailed,
      routerParseFallback:  routerResult.parseFailed,
      verifierParseFallback: verifierResult.parseFailed,
      verifierVerdict:      verifierResult.verdict,
      unsupportedClaims:    verifierResult.unsupportedClaims,
      fallbackReason,
      errorMessage:         null,
      wallMs,
    };

    // ── 6. Persist trace ───────────────────────────────────────────────────────
    await prisma.complianceQueryRun.create({
      data: {
        complianceQueryId:    trace.complianceQueryId,
        shadow:               trace.shadow,
        status:               trace.status,
        route:                trace.route,
        routeConfidence:      trace.routeConfidence,
        routeDowngraded:      trace.routeDowngraded,
        routeDowngradeReason: trace.routeDowngradeReason,
        grounded:             trace.grounded,
        ragSources:           trace.ragSources,
        subQuestions:         trace.subQuestions.length > 0 ? trace.subQuestions : undefined,
        retrievalQueries:     trace.retrievalQueries as any,
        jurisdictions:        trace.jurisdictions,
        primaryJurisdiction:  trace.primaryJurisdiction,
        jurisdictionSource:   trace.jurisdictionSource,
        corpusVersionSnapshot: trace.corpusVersionSnapshot,
        retrievalVersion:     trace.retrievalVersion,
        retrievedVectorIds:   trace.retrievedVectorIds,
        gradeChunksInspected: trace.gradeChunksInspected,
        acceptedChunkIds:     trace.acceptedChunkIds as any,
        rejectedChunkCount:   trace.rejectedChunkCount,
        tokenBudgetExceeded:  trace.tokenBudgetExceeded,
        controlTokens:        trace.controlTokens as any,
        inputTokens:          trace.inputTokens,
        outputTokens:         trace.outputTokens,
        graderFailed:         trace.graderFailed,
        routerParseFallback:  trace.routerParseFallback,
        verifierParseFallback: trace.verifierParseFallback,
        verifierVerdict:      trace.verifierVerdict,
        unsupportedClaims:    trace.unsupportedClaims.length > 0 ? trace.unsupportedClaims : undefined,
        fallbackReason:       trace.fallbackReason,
        errorMessage:         trace.errorMessage,
        wallMs:               trace.wallMs,
      },
    });

    if (input.complianceQueryId) {
      try {
        const existingQuery = await prisma.complianceQuery.findUnique({
          where: { id: input.complianceQueryId },
          select: { metadata: true },
        });
        if (existingQuery) {
          const existingMeta = (typeof existingQuery.metadata === 'object' && existingQuery.metadata !== null)
            ? existingQuery.metadata as Record<string, unknown>
            : {};
          await prisma.complianceQuery.update({
            where: { id: input.complianceQueryId },
            data: {
              metadata: {
                ...existingMeta,
                tokensUsed: inputTokens + outputTokens,
                tokenBreakdown: {
                  router: controlTokens.router,
                  grader: controlTokens.grader,
                  synthesis: controlTokens.synthesis,
                  verifier: controlTokens.verifier,
                  totalInputTokens: inputTokens,
                  totalOutputTokens: outputTokens,
                  totalTokens: inputTokens + outputTokens,
                  estimated: false,
                },
              },
            },
          });
        }
      } catch (metaErr: unknown) {
        logger.warn({
          type: 'compliance_query_token_metadata_update_error',
          complianceQueryId: input.complianceQueryId,
          error: metaErr instanceof Error ? metaErr.message : String(metaErr),
        });
      }
    }

    logger.info({
      type:               'orchestrator_run_complete',
      complianceQueryId:  input.complianceQueryId,
      shadow:             input.shadow,
      route,
      routeConfidence:    trace.routeConfidence,
      routeDowngraded,
      grounded:           trace.grounded,
      verifierVerdict:    trace.verifierVerdict,
      unsupportedClaims:  trace.unsupportedClaims.length,
      tokenBudgetExceeded,
      totalTokens:        inputTokens + outputTokens,
      wallMs,
    });
  } catch (err: any) {
    // Shadow-mode errors must never propagate to the user-facing response.
    // Best-effort: try to write an error row so failures are visible in the trace table.
    const wallMs = Date.now() - t0;
    logger.error({
      type:              'orchestrator_run_error',
      complianceQueryId: input.complianceQueryId,
      error:             err?.message,
      wallMs,
    });

    prisma.complianceQueryRun.create({
      data: {
        complianceQueryId: input.complianceQueryId,
        shadow:            input.shadow,
        status:            'error',
        route:             'simple',
        grounded:          input.ragResults.length > 0,
        ragSources:        input.ragResults.length,
        jurisdictions:      [...jurisdictionContext.jurisdictions],
        primaryJurisdiction: jurisdictionContext.mode === 'SINGLE' ? jurisdictionContext.primaryJurisdiction : null,
        jurisdictionSource: jurisdictionContext.jurisdictionSource,
        corpusVersionSnapshot,
        retrievalVersion,
        retrievedVectorIds: input.ragResults.map((result) => result.vectorId),
        wallMs,
        errorMessage:      String(err?.message ?? err),
      },
    }).catch(() => {}); // double-guard: ignore DB write failure in error path
  }
}
