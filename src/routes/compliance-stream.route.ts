import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { stream } from '@/lib/ai/client';
import { ragService, searchAndGetContext } from '@/lib/rag/rag.service';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { getPilotEntitlements } from '@/utils/entitlements';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { isTokenRevoked } from '@/utils/token-revocation';
import { aiConfig } from '@/config/ai.config';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import { resolveEffectivePlan } from '@/modules/billing/resolve-effective-plan';
import { checkTrialLimit, incrementTrialUsageAtomic } from '@/modules/trial';
import type { TrialContextState } from '@/modules/trial/trial.types';
import type { EffectivePlan } from '@/types/plan.types';
import type { EffectivePlanSource, PilotEntitlementProfile } from '@/types/plan.types';
import type { PlanEntitlementConfig } from '@/config/entitlements.config';
import {
  generateComplianceSystemPrompt,
  generateComplianceUserPrompt,
} from '@/lib/ai/prompts/compliance-query';
import type { OrgMembershipEntry } from '@/server/trpc/context';
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
  type SourceCitation,
} from '@/lib/source-grounding/citations';
import {
  persistClaimVerification,
  verifyAnswerClaims,
} from '@/lib/source-grounding/claim-verification';

// Constants
const RATE_LIMIT_MAX     = 100; // same window as tRPC rateLimited('complianceQuery')
const RATE_LIMIT_WINDOW  = 900; // 15 min
const HEARTBEAT_INTERVAL = 15_000; // 15 s, below Render's ~60 s idle timeout
const USAGE_TTL_SECONDS  = 35 * 24 * 60 * 60; // 35 days (matches middleware)

// Redis metric key segment; matches BillingMetric.COMPLIANCE_QUERIES enum value
const METRIC_KEY = 'COMPLIANCE_QUERIES';

// Input schema
const inputSchema = z.object({
  question:         z.string().min(1).max(5000),
  organizationType: z.string().optional(),
  industry:         z.string().optional(),
  context:          z.string().optional(),
  answerDetail:     z.enum(['standard', 'detailed']).default('standard'),
});

export function extractNamedRegulations(question: string): string[] {
  const regex = /\b([A-Z][A-Za-z0-9&]*\s+)+(Act|Regulations?|Guidelines?|Circular|Notice|Rules?|Framework)(?:\s+\d{4})?\b/g;
  const matches = question.match(regex);
  if (!matches) return [];
  return Array.from(new Set(matches.map(m => m.trim())));
}

// Auth resolution
interface AuthContext {
  userId:         string;
  organizationId: string;
  plan:           EffectivePlan;
  effectivePlanSource: EffectivePlanSource;
  entitlementProfile: PilotEntitlementProfile | null;
  entitlements: PlanEntitlementConfig;
  trialState:     TrialContextState | undefined;
  orgMembership:  OrgMembershipEntry;
}

export async function resolveAuth(authHeader: string | undefined): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.id) return null;

    const supabaseUserId = data.user.id;
    if (await isTokenRevoked(token, supabaseUserId)) return null;

    // User profile: Redis cache first (same key as tRPC context)
    const cacheKey = `user:session:${supabaseUserId}`;
    let dbUser: { id: string; organizationId: string | null; role: string } | null = null;

    try {
      const cached = await redis.get<typeof dbUser>(cacheKey);
      if (cached && typeof cached === 'object') dbUser = cached as typeof dbUser;
    } catch { /* fall through to Prisma */ }

    if (!dbUser) {
      dbUser = await prisma.user.findUnique({
        where:  { supabaseAuthId: supabaseUserId },
        select: { id: true, organizationId: true, role: true },
      });
    }

    if (!dbUser?.organizationId) return null;

    // Org membership: ACTIVE check with Redis cache (same key as middleware)
    const orgCacheKey = `sheriabot:orgmem:${dbUser.id}:${dbUser.organizationId}`;
    let entry: OrgMembershipEntry | null = null;

    try {
      const raw = await redis.get<OrgMembershipEntry>(orgCacheKey);
      if (raw && typeof raw === 'object' && 'status' in raw) entry = raw;
    } catch { /* fall through to Prisma */ }

    if (!entry) {
      const member = await prisma.organizationMember.findUnique({
        where:  { userId_organizationId: { userId: dbUser.id, organizationId: dbUser.organizationId } },
        select: { userId: true, organizationId: true, role: true, status: true },
      });
      if (member) entry = member as OrgMembershipEntry;
    }

    if (!entry || entry.status !== 'ACTIVE') return null;

    const resolved = await resolveEffectivePlan({
      userId: dbUser.id,
      organizationId: dbUser.organizationId,
      prisma,
      redis,
    });

    return {
      userId:         dbUser.id,
      organizationId: dbUser.organizationId,
      plan:           resolved.plan,
      effectivePlanSource: resolved.source,
      entitlementProfile: resolved.entitlementProfile,
      entitlements: resolved.source === 'PILOT' && resolved.entitlementProfile
        ? getPilotEntitlements(resolved.entitlementProfile)
        : PLAN_ENTITLEMENTS[resolved.plan],
      trialState:     resolved.trialState,
      orgMembership:  entry,
    };
  } catch (err: unknown) {
    logger.warn({
      type: 'compliance_stream_auth_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Usage enforcement
// Replicates checkUsageLimit(BillingMetric.COMPLIANCE_QUERIES) from tRPC middleware.
// FREE_TRIAL users are enforced against trial JSON counters before Redis quotas.
interface UsageCheck {
  allowed: boolean;
  statusCode: 403 | 429;
  message: string;
  increment: (tokensUsed?: number) => Promise<void>;
}

export async function checkAndPrepareUsage(auth: AuthContext, requiredCredits: number = 1): Promise<UsageCheck> {
  if (auth.plan === 'FREE_TRIAL') {
    const queryCheck = await checkTrialLimit(auth.userId, 'complianceQueries');
    if (queryCheck.current + requiredCredits > queryCheck.limit) {
      return {
        allowed: false,
        statusCode: 403,
        message: requiredCredits === 2 
          ? `Detailed answers require 2 query credits. Please switch to Standard or upgrade.` 
          : `Trial limit reached (${queryCheck.current}/${queryCheck.limit}). Upgrade to continue.`,
        increment: async () => {},
      };
    }

    const tokenCheck = await checkTrialLimit(auth.userId, 'totalTokensUsed');
    if (!tokenCheck.allowed) {
      return {
        allowed: false,
        statusCode: 403,
        message: `Trial token budget reached (${tokenCheck.current}/${tokenCheck.limit}). Upgrade to continue.`,
        increment: async () => {},
      };
    }

    return {
      allowed: true,
      statusCode: 429,
      message: '',
      increment: async (tokensUsed?: number) => {
        await incrementTrialUsageAtomic(auth.userId, 'complianceQueries', requiredCredits);
        if (tokensUsed !== undefined && tokensUsed > 0) {
          const tokenIncrement = await incrementTrialUsageAtomic(auth.userId, 'totalTokensUsed', tokensUsed);
          if (!tokenIncrement.allowed) {
            logger.warn({
              type: 'compliance_stream_trial_usage_increment_blocked',
              userId: auth.userId,
              feature: 'totalTokensUsed',
              incrementBy: tokensUsed,
              current: tokenIncrement.newCount,
              limit: tokenIncrement.limit,
            });
          }
        }
      },
    };
  }

  const quota = auth.entitlements.complianceQueries;

  // Unlimited (-1): skip all Redis I/O
  if (quota.limit === -1) {
    return {
      allowed:     true,
      statusCode:  429,
      message:     '',
      increment:   async () => {},
    };
  }

  // Blocked (0): feature unavailable on this plan
  if (quota.limit === 0) {
    return {
      allowed:    false,
      statusCode: 403,
      message:    `Compliance queries are not available on the ${auth.plan} plan.`,
      increment:  async () => {},
    };
  }

  // Monthly/lifetime quota check
  const periodKey = quota.period === 'lifetime'
    ? 'lifetime'
    : new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const usageKey  = `sheriabot:usage:${auth.organizationId}:${METRIC_KEY}:${periodKey}`;

  const currentRaw = await redis.get<number>(usageKey);
  const current    = typeof currentRaw === 'number' ? currentRaw : Number(currentRaw ?? 0);

  if (current + requiredCredits > quota.limit) {
    const label = quota.period === 'lifetime' ? 'Lifetime' : 'Monthly';
    return {
      allowed:    false,
      statusCode: 429,
      message:    requiredCredits === 2 
        ? `Detailed answers require 2 query credits. Please switch to Standard or upgrade your plan.`
        : `${label} limit reached (${current}/${quota.limit}). Upgrade your plan for more.`,
      increment:  async () => {},
    };
  }

  const increment = async (): Promise<void> => {
    const newCount = await redis.incrby(usageKey, requiredCredits);
    if (newCount === requiredCredits && quota.period !== 'lifetime') {
      await redis.expire(usageKey, USAGE_TTL_SECONDS);
    }
    logger.debug({ type: 'usage_incremented', orgId: auth.organizationId, metric: METRIC_KEY, current: newCount });
  };

  return { allowed: true, statusCode: 429, message: '', increment };
}

// SSE helpers
function sseData(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

// Route registration
export async function registerComplianceStreamRoute(
  app: FastifyInstance,
  allowedOrigins: string[],
): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/compliance/stream',
    async (request, reply) => {

      // Pre-hijack: all checks that need HTTP error responses.
      // Auth
      const auth = await resolveAuth(request.headers.authorization);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // Input validation
      const parsed = inputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', issues: parsed.error.flatten() });
      }
      const input = parsed.data;
      const requiredCredits = input.answerDetail === 'detailed' ? 2 : 1;

      // Rate limiting (same Redis counter as tRPC rateLimited('complianceQuery'))
      try {
        await rateLimiter.checkOrThrow(auth.userId, 'complianceQuery', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
      } catch {
        logger.warn({ type: 'compliance_stream_rate_limit', userId: auth.userId });
        return reply.status(429).send({ error: 'Rate limit exceeded. Please try again later.' });
      }

      // Usage entitlement enforcement
      const usage = await checkAndPrepareUsage(auth, requiredCredits);
      if (!usage.allowed) {
        return reply.status(usage.statusCode).send({ error: usage.message });
      }

      // Named regulation detection
      const detectedRegulations = extractNamedRegulations(input.question);
      let augmentedQuery = input.question;
      if (detectedRegulations.length > 0) {
        augmentedQuery += ` ${detectedRegulations.join(' ')}`;
      }

      // RAG retrieval (before hijack so we can return HTTP 500 if needed)
      const ragContext = await searchAndGetContext(augmentedQuery, { topK: 10, minScore: 0.7, preferActiveSources: true }).catch((err: unknown) => {
        logger.error({
          type: 'compliance_stream_rag_error',
          error: err instanceof Error ? err.message : String(err),
        });
        return { results: [], context: null };
      });

      // Persist query record
      const query = await prisma.complianceQuery.create({
        data: {
          query:          input.question,
          userId:         auth.userId,
          organizationId: auth.organizationId,
          status:         'processing',
          metadata: {
            streaming:        true,
            ragSources:       ragContext.results.length,
            organizationType: input.organizationType,
            industry:         input.industry,
            context:          input.context,
            answerDetail:     input.answerDetail,
            detectedRegulations,
          },
        },
      });

      // Post-hijack: HTTP error responses are no longer possible.
      reply.hijack();

      const requestOrigin = typeof request.headers.origin === 'string'
        ? request.headers.origin
        : undefined;
      const corsHeaders = requestOrigin && allowedOrigins.includes(requestOrigin)
        ? {
            'Access-Control-Allow-Origin':      requestOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Vary': 'Origin',
          }
        : {};

      reply.raw.writeHead(200, {
        'Content-Type':    'text/event-stream',
        // no-cache: prevent proxy caching; no-transform: prevent Render/nginx buffering/compression
        'Cache-Control':   'no-cache, no-transform',
        'Connection':      'keep-alive',
        // Disables Nginx/Render proxy response buffering; required for true streaming
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      });

      const write = (obj: Record<string, unknown>): void => {
        if (!reply.raw.destroyed) reply.raw.write(sseData(obj));
      };

      // AbortController wired to client disconnect
      const streamController = new AbortController();
      request.raw.on('close', () => {
        streamController.abort();
        clearInterval(heartbeatTimer);
        logger.info({ type: 'compliance_stream_client_disconnect', userId: auth.userId, queryId: query.id });
      });

      // Keepalive heartbeat every 15 s
      // Render's idle timeout is ~60 s. Claude's first-token latency plus
      // mid-generation pauses can exceed this without a keepalive.
      const heartbeatTimer = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(sseComment('heartbeat'));
      }, HEARTBEAT_INTERVAL);

      write({ type: 'connected', queryId: query.id, ragSources: ragContext.results.length });

      if (!hasUsableSourceContext(ragContext)) {
        const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer();

        await prisma.complianceQuery.update({
          where: { id: query.id },
          data: {
            response: sourceInsufficientAnswer,
            status: 'completed',
            citations: [],
            metadata: {
              streaming: true,
              ragSources: ragContext.results.length,
              ragContextChars: ragContext.context?.length ?? 0,
              grounded: false,
              abstained: true,
              sourceInsufficient: true,
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
              answerDetail: input.answerDetail,
              unitsConsumed: 0,
              fallbackTriggered: true,
              detectedRegulations,
            },
          },
        });

        write({ type: 'chunk', text: sourceInsufficientAnswer });
        write({
          type: 'done',
          queryId: query.id,
          route: 'abstain',
          grounded: false,
          abstained: true,
          runId: null,
          citations: [],
          confidence: null,
        });

        clearInterval(heartbeatTimer);
        reply.raw.end();

        logger.info({
          type: 'compliance_stream_source_insufficient',
          userId: auth.userId,
          queryId: query.id,
        });

        return;
      }

      const preGenerationGrade = await runGraderAgent(input.question, ragContext.results, 10);
      const acceptedResults = preGenerationGrade.accepted;
      const acceptedContext = ragService.getContextForPrompt(acceptedResults, 10, 4000);

      if (!hasUsableSourceContext({ results: acceptedResults, context: acceptedContext })) {
        const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer();

        await prisma.complianceQuery.update({
          where: { id: query.id },
          data: {
            response: sourceInsufficientAnswer,
            status: 'completed',
            citations: [],
            metadata: {
              streaming: true,
              ragSources: ragContext.results.length,
              acceptedSources: acceptedResults.length,
              graderFailed: preGenerationGrade.gradeFailed,
              grounded: false,
              abstained: true,
              sourceInsufficient: true,
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
              answerDetail: input.answerDetail,
              unitsConsumed: 0,
              fallbackTriggered: true,
              detectedRegulations,
            },
          },
        });

        write({ type: 'chunk', text: sourceInsufficientAnswer });
        write({
          type: 'done',
          queryId: query.id,
          route: 'abstain',
          grounded: false,
          abstained: true,
          runId: null,
          citations: [],
          confidence: null,
        });

        clearInterval(heartbeatTimer);
        reply.raw.end();

        logger.info({
          type: 'compliance_stream_no_accepted_sources',
          userId: auth.userId,
          queryId: query.id,
          retrievedSources: ragContext.results.length,
          graderFailed: preGenerationGrade.gradeFailed,
        });

        return;
      }

      // Stream AI synthesis
      const systemPrompt = generateComplianceSystemPrompt(input.answerDetail);
      const userPrompt   = generateComplianceUserPrompt({
        question:         input.question,
        organizationType: input.organizationType,
        industry:         input.industry,
        context:          input.context,
        answerDetail:     input.answerDetail,
        ragContext:       acceptedContext || undefined,
      });
      const maxTokens = acceptedContext ? 3000 : aiConfig.parameters.queryMaxTokens;

      let fullContent = '';

      try {
        const result = await stream(
          {
            prompt:               userPrompt,
            systemPrompt,
            maxTokens,
            temperature:          aiConfig.parameters.queryTemperature,
            externalAbortSignal:  streamController.signal,
            onChunk: (chunk) => {
              fullContent += chunk;
            },
          },
          'query',
        );

        // Signal frontend: synthesis complete, verification starting
        write({ type: 'synthesis_complete' });

        // Persist full answer
        await prisma.complianceQuery.update({
          where: { id: query.id },
          data: {
            response: fullContent,
            status:   'completed',
            metadata: {
              streaming:        true,
              ragSources:       ragContext.results.length,
              acceptedSources:   acceptedResults.length,
              grounded:         true,
              graderFailed:     preGenerationGrade.gradeFailed,
              tokensUsed:       result.inputTokens + result.outputTokens,
              organizationType: input.organizationType,
              industry:         input.industry,
              context:          input.context,
              answerDetail:     input.answerDetail,
              unitsConsumed:    requiredCredits,
              fallbackTriggered: false,
              detectedRegulations,
            },
          },
        });

        // Usage increment deferred so failed synthesis costs nothing
        await usage.increment(result.inputTokens + result.outputTokens).catch((err: unknown) => {
          logger.error({
            type: 'compliance_stream_usage_increment_failed',
            userId: auth.userId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        // Orchestrator
        const agenticComplexityLevel =
          auth.entitlements.agenticComplexityLevel ?? 'simple';

        let route: string             = 'simple';
        let grounded                  = ragContext.results.length > 0;
        let abstained                 = false;
        let runId: string | null      = null;
        let confidence: number | null = null;
        let citations: SourceCitation[]  = [];
        let acceptedChunksForClaims = acceptedResults;

        if (appConfig.features.orchestratorEnabled) {
          await runOrchestrator({
            complianceQueryId:      query.id,
            question:               input.question,
            answer:                 fullContent,
            ragResults:             ragContext.results,
            agenticComplexityLevel,
            shadow:                 false,
          });

          const run = await prisma.complianceQueryRun.findFirst({
            where:   { complianceQueryId: query.id },
            orderBy: { createdAt: 'desc' },
            select:  { id: true, route: true, grounded: true, verifierVerdict: true, acceptedChunkIds: true },
          });

          if (run) {
            route    = run.route;
            grounded = run.grounded;
            runId    = run.id;
            confidence =
              run.verifierVerdict === 'PASS'    ? 0.9 :
              run.verifierVerdict === 'PARTIAL' ? 0.7 :
              null;
            const accepted = Array.isArray(run.acceptedChunkIds)
              ? (run.acceptedChunkIds as unknown[]).length
              : 0;
            abstained = route === 'abstain' || accepted === 0 || run.verifierVerdict === 'FAIL' || run.verifierVerdict === 'FAIL_ABSTAIN';

            citations = buildCitationsFromAcceptedRefs(
              run.acceptedChunkIds,
              ragContext.results,
              run.verifierVerdict === 'PASS' ? 'verified' : 'unverified',
            );
            acceptedChunksForClaims = findAcceptedChunks(run.acceptedChunkIds, ragContext.results);
          }
        } else {
          // Legacy shadow path: include pre-generation accepted sources, but do not mark them verified.
          // Fire-and-forget; runId remains null, so frontend must disable "Tell us what's missing".
          citations = buildCitationsFromChunks(acceptedResults, 'not_checked');
          runOrchestrator({
            complianceQueryId:      query.id,
            question:               input.question,
            answer:                 fullContent,
            ragResults:             ragContext.results,
            agenticComplexityLevel,
            shadow:                 true,
          }).catch(() => {});
        }

        const claimVerification = verifyAnswerClaims(fullContent, acceptedChunksForClaims);
        await persistClaimVerification(prisma, query.id, claimVerification);

        if (abstained || !hasUsableCitations(citations) || claimVerification.unsupportedClaims.length > 0) {
          const sourceInsufficientAnswer = claimVerification.unsupportedClaims.length > 0
            ? buildUnsupportedClaimsAnswer(claimVerification.unsupportedClaims.map((claim) => claim.claimText))
            : buildComplianceSourceInsufficiencyAnswer();
          fullContent = sourceInsufficientAnswer;
          citations = [];
          confidence = null;
          grounded = false;
          abstained = true;
        }

        await prisma.complianceQuery.update({
          where: { id: query.id },
          data:  {
            response: fullContent,
            citations,
            confidence,
            metadata: {
              streaming: true,
              ragSources: ragContext.results.length,
              acceptedSources: citations.length,
              grounded,
              abstained,
              sourceInsufficient: abstained && citations.length === 0,
              route,
              runId,
              claimVerificationVerdict: claimVerification.verdict,
              verifiedClaims: claimVerification.supportedClaims.length,
              unsupportedClaims: claimVerification.unsupportedClaims.map((claim) => claim.claimText),
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
            },
          },
        });

        write({ type: 'chunk', text: fullContent });
        write({ type: 'done', queryId: query.id, route, grounded, abstained, runId, citations, confidence });

        logger.info({
          type:         'compliance_stream_complete',
          userId:       auth.userId,
          queryId:      query.id,
          ragSources:   ragContext.results.length,
          tokensUsed:   result.inputTokens + result.outputTokens,
          route,
          grounded,
          abstained,
          orchestrated: appConfig.features.orchestratorEnabled,
        });
      } catch (err: unknown) {
        const isDisconnect = streamController.signal.aborted;

        logger.error({
          type:        'compliance_stream_error',
          userId:      auth.userId,
          queryId:     query.id,
          error:       err instanceof Error ? err.message : String(err),
          disconnect:  isDisconnect,
        });

        // Mark query failed (best-effort; ignore if socket already gone)
        await prisma.complianceQuery.update({
          where: { id: query.id },
          data:  { status: 'failed' },
        }).catch(() => {});

        // Only write SSE error event if client is still connected
        if (!isDisconnect && !reply.raw.destroyed) {
          write({ type: 'error', message: 'An error occurred while generating the response' });
        }
      } finally {
        clearInterval(heartbeatTimer);
        if (!reply.raw.destroyed) reply.raw.end();
      }
    },
  );
}
