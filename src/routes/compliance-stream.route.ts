import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { stream } from '@/lib/ai/client';
import { ragService, searchAndGetRegulatoryEvidenceContext } from '@/lib/rag/rag.service';
import { getPineconeDiagnostics } from '@/lib/rag/client';
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
  type ComplianceFallbackReason,
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
  JURISDICTION_CODES,
  JurisdictionContractError,
  jurisdictionLabel,
  resolveJurisdictionContext,
  serializeJurisdictionContext,
  type JurisdictionContext,
} from '@/types/jurisdiction';

// Constants
const RATE_LIMIT_MAX     = 100; // same window as tRPC rateLimited('complianceQuery')
const RATE_LIMIT_WINDOW  = 900; // 15 min
const HEARTBEAT_INTERVAL = 15_000; // 15 s, below Render's ~60 s idle timeout
const USAGE_TTL_SECONDS  = 35 * 24 * 60 * 60; // 35 days (matches middleware)
const RAG_TOP_K = 20;
const RAG_MIN_SCORE = 0.6;
const STANDARD_CONTEXT_CHUNKS = 12;
const DETAILED_CONTEXT_CHUNKS = 18;
const STANDARD_CONTEXT_CHARS = 10_000;
const DETAILED_CONTEXT_CHARS = 18_000;

// Redis metric key segment; matches BillingMetric.COMPLIANCE_QUERIES enum value
const METRIC_KEY = 'COMPLIANCE_QUERIES';

// Input schema
const inputSchema = z.object({
  question:         z.string().min(1).max(5000),
  mode:             z.enum(['SINGLE', 'COMPARE']).optional(),
  jurisdictions:    z.array(z.enum(JURISDICTION_CODES)).max(1).optional(),
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

export function buildComplianceRagQuery(
  question: string,
  detectedRegulations: string[] = [],
  jurisdictionContext?: JurisdictionContext,
): string {
  const lower = question.toLowerCase();
  const boosts = new Set<string>();
  const jurisdiction = jurisdictionContext?.primaryJurisdiction ?? 'KE';
  const jurisdictionName = jurisdictionLabel(jurisdiction);

  if (detectedRegulations.length > 0) {
    for (const regulation of detectedRegulations) boosts.add(regulation);
  }

  if (/\b(aml|anti[-\s]?money|cft|terrorist financ|kyc|know your customer|suspicious transaction|frc)\b/i.test(question)) {
    ['AML/CFT', 'POCAMLA', 'Financial Reporting Centre', 'KYC', 'suspicious transaction reporting'].forEach((term) => boosts.add(term));
  }

  if (/\b(payment|psp|payment service provider|mobile money|e-money|m-pesa|mpesa|national payment|cbk)\b/i.test(question)) {
    const paymentTermsByJurisdiction = {
      KE: ['Central Bank of Kenya', 'CBK', 'National Payment System', 'payment service provider', 'mobile money', 'e-money'],
      RW: ['National Bank of Rwanda', 'BNR', 'payment service provider', 'payment systems', 'e-money'],
      MW: ['Reserve Bank of Malawi', 'RBM', 'payment service provider', 'payment systems', 'mobile money', 'e-money'],
      NG: ['Central Bank of Nigeria', 'CBN', 'payment service provider', 'payment systems', 'mobile money'],
    };
    paymentTermsByJurisdiction[jurisdiction].forEach((term) => boosts.add(term));
  }

  if (lower.includes('data protection') || lower.includes('personal data') || lower.includes('privacy') || lower.includes('odpc')) {
    const privacyRegulatorByJurisdiction = {
      KE: 'ODPC',
      RW: 'Data Protection and Privacy Office',
      MW: 'Malawi data protection authority',
      NG: 'Nigeria Data Protection Commission',
    };
    ['Data Protection Act', privacyRegulatorByJurisdiction[jurisdiction], 'data controller', 'data processor', 'personal data'].forEach((term) => boosts.add(term));
  }

  if (lower.includes('digital lender') || lower.includes('digital lending') || lower.includes('digital credit')) {
    ['digital credit provider', 'digital lender', 'CBK Digital Credit Providers'].forEach((term) => boosts.add(term));
  }

  if (lower.includes('fintech')) {
    [`${jurisdictionName} fintech compliance`, 'banking', 'payments', 'lending', 'capital markets'].forEach((term) => boosts.add(term));
  }

  return [question, ...boosts].join(' ');
}

export function getFallbackReasonForRetrieval(resultsCount: number, context: string | null | undefined): ComplianceFallbackReason {
  if (resultsCount === 0) return 'NO_RAG_CHUNKS';
  if (!context?.trim()) return 'LOW_RELEVANCE';
  return 'LOW_RELEVANCE';
}

export function hasUsableRetrievedChunks(results: Array<{ documentTitle?: string | null; chunkText?: string | null }>): boolean {
  return results.some((result) => !!result.documentTitle?.trim() && !!result.chunkText?.trim());
}

export function selectGenerationSources<T>(
  retrievedResults: T[],
  acceptedResults: T[],
  gradeFailed: boolean,
): { sources: T[]; usedVerifierFallback: boolean; allChunksFailedVerification: boolean } {
  if (acceptedResults.length > 0) {
    return { sources: acceptedResults, usedVerifierFallback: false, allChunksFailedVerification: false };
  }

  if (gradeFailed && retrievedResults.length > 0) {
    return { sources: retrievedResults, usedVerifierFallback: true, allChunksFailedVerification: false };
  }

  return {
    sources: [],
    usedVerifierFallback: false,
    allChunksFailedVerification: retrievedResults.length > 0,
  };
}

function getRetrievedDocumentTitles(results: Array<{ documentTitle: string }>): string[] {
  return Array.from(new Set(results.map((result) => result.documentTitle).filter(Boolean)));
}

function getRetrievedChunkScores(results: Array<{ score: number; documentTitle: string; section?: string; pageStart?: number; pageEnd?: number }>): Array<{
  rank: number;
  documentTitle: string;
  section?: string;
  pageStart?: number;
  pageEnd?: number;
  score: number;
}> {
  return results.map((result, index) => ({
    rank: index + 1,
    documentTitle: result.documentTitle,
    section: result.section,
    pageStart: result.pageStart,
    pageEnd: result.pageEnd,
    score: Number(result.score.toFixed(4)),
  }));
}

function buildJurisdictionMetadata(context: JurisdictionContext, corpusVersions: Record<string, string | undefined>, retrievalVersion: string): Record<string, unknown> {
  return {
    ...serializeJurisdictionContext(context),
    corpusVersionSnapshot: corpusVersions,
    retrievalVersion,
  };
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
      let jurisdictionContext: JurisdictionContext;
      try {
        jurisdictionContext = resolveJurisdictionContext(input, { allowLegacyDefault: true });
      } catch (error) {
        if (error instanceof JurisdictionContractError) {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        throw error;
      }
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
      const ragQuery = buildComplianceRagQuery(input.question, detectedRegulations, jurisdictionContext);
      const pineconeDiagnostics = getPineconeDiagnostics();

      logger.info({
        type: 'compliance_stream_rag_retrieval_start',
        userId: auth.userId,
        orgId: auth.organizationId,
        query: input.question,
        answerDetail: input.answerDetail,
        jurisdiction: jurisdictionContext.primaryJurisdiction,
        jurisdictionSource: jurisdictionContext.jurisdictionSource,
        detectedRegulations,
        ragQuery,
        pinecone: pineconeDiagnostics,
      });

      // RAG retrieval (before hijack so we can return HTTP 500 if needed)
      const ragContext = await searchAndGetRegulatoryEvidenceContext({
        query: ragQuery,
        jurisdictionContext,
        topK: RAG_TOP_K,
        minScore: RAG_MIN_SCORE,
        preferActiveSources: true,
      }).catch((err: unknown) => {
        logger.error({
          type: 'compliance_stream_rag_error',
          userId: auth.userId,
          orgId: auth.organizationId,
          jurisdiction: jurisdictionContext.primaryJurisdiction,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          results: [],
          context: '',
          citations: [],
          corpusVersions: {},
          retrievalVersion: 'regulatory-evidence-v1',
        };
      });

      logger.info({
        type: 'compliance_stream_rag_retrieval_complete',
        userId: auth.userId,
        orgId: auth.organizationId,
        query: input.question,
        answerDetail: input.answerDetail,
        detectedRegulations,
        ragQuery,
        pinecone: pineconeDiagnostics,
        retrievedChunksCount: ragContext.results.length,
        retrievedDocumentTitles: getRetrievedDocumentTitles(ragContext.results),
        retrievedChunkScores: getRetrievedChunkScores(ragContext.results),
        verificationInputCount: ragContext.results.length,
      });

      // Persist query record
      const query = await prisma.complianceQuery.create({
        data: {
          query:          input.question,
          userId:         auth.userId,
          organizationId: auth.organizationId,
          status:         'processing',
          mode:           jurisdictionContext.mode,
          jurisdictions:  [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
          jurisdictionSource:  jurisdictionContext.jurisdictionSource,
          corpusVersionSnapshot: ragContext.corpusVersions,
          metadata: {
            ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
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

      write({
        type: 'connected',
        queryId: query.id,
        ragSources: ragContext.results.length,
        mode: jurisdictionContext.mode,
        jurisdictions: [...jurisdictionContext.jurisdictions],
        primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
      });

      if (!hasUsableSourceContext(ragContext) || !hasUsableRetrievedChunks(ragContext.results)) {
        const fallbackReason = getFallbackReasonForRetrieval(ragContext.results.length, ragContext.context);
        const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer(fallbackReason);

        await prisma.complianceQuery.update({
          where: { id: query.id },
          data: {
            response: sourceInsufficientAnswer,
            status: 'completed',
            citations: [],
            metadata: {
              ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
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
              fallbackReason,
              detectedRegulations,
              ragQuery,
              pinecone: pineconeDiagnostics,
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
          fallbackReason,
          mode: jurisdictionContext.mode,
          jurisdictions: [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
          corpusVersionSnapshot: ragContext.corpusVersions,
          retrievalVersion: ragContext.retrievalVersion,
        });

        clearInterval(heartbeatTimer);
        reply.raw.end();

        logger.info({
          type: 'compliance_stream_source_insufficient',
          userId: auth.userId,
          orgId: auth.organizationId,
          queryId: query.id,
          query: input.question,
          answerDetail: input.answerDetail,
          detectedRegulations,
          ragQuery,
          pinecone: pineconeDiagnostics,
          retrievedChunksCount: ragContext.results.length,
          retrievedDocumentTitles: getRetrievedDocumentTitles(ragContext.results),
          retrievedChunkScores: getRetrievedChunkScores(ragContext.results),
          verificationInputCount: ragContext.results.length,
          verifiedSourcesCount: 0,
          rejectedSourcesCount: ragContext.results.length,
          fallbackTriggered: true,
          fallbackReason,
          unitsConsumed: 0,
        });

        return;
      }

      const preGenerationGrade = await runGraderAgent(input.question, ragContext.results, jurisdictionContext, 10);
      const generationSelection = selectGenerationSources(
        ragContext.results,
        preGenerationGrade.accepted,
        preGenerationGrade.gradeFailed,
      );
      const acceptedResults = generationSelection.sources;
      const contextChunkLimit = input.answerDetail === 'detailed' ? DETAILED_CONTEXT_CHUNKS : STANDARD_CONTEXT_CHUNKS;
      const contextCharLimit = input.answerDetail === 'detailed' ? DETAILED_CONTEXT_CHARS : STANDARD_CONTEXT_CHARS;
      const acceptedContext = ragService.getContextForPrompt(acceptedResults, contextChunkLimit, contextCharLimit);

      logger.info({
        type: 'compliance_stream_source_verification_complete',
        userId: auth.userId,
        orgId: auth.organizationId,
        query: input.question,
        answerDetail: input.answerDetail,
        detectedRegulations,
        ragQuery,
        pinecone: pineconeDiagnostics,
        retrievedChunksCount: ragContext.results.length,
        retrievedDocumentTitles: getRetrievedDocumentTitles(ragContext.results),
        retrievedChunkScores: getRetrievedChunkScores(ragContext.results),
        verificationInputCount: ragContext.results.length,
        verifiedSourcesCount: preGenerationGrade.accepted.length,
        rejectedSourcesCount: preGenerationGrade.rejected.length,
        fallbackTriggered: generationSelection.allChunksFailedVerification,
        fallbackReason: generationSelection.allChunksFailedVerification ? 'ALL_CHUNKS_FAILED_VERIFICATION' : null,
        verifierFailedOpen: generationSelection.usedVerifierFallback,
      });

      if (generationSelection.allChunksFailedVerification || !hasUsableRetrievedChunks(acceptedResults) || !acceptedContext.trim()) {
        const fallbackReason: ComplianceFallbackReason = 'ALL_CHUNKS_FAILED_VERIFICATION';
        const sourceInsufficientAnswer = buildComplianceSourceInsufficiencyAnswer(fallbackReason);

        await prisma.complianceQuery.update({
          where: { id: query.id },
          data: {
            response: sourceInsufficientAnswer,
            status: 'completed',
            citations: [],
            metadata: {
              ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
              streaming: true,
              ragSources: ragContext.results.length,
              acceptedSources: preGenerationGrade.accepted.length,
              graderFailed: preGenerationGrade.gradeFailed,
              verifierFailedOpen: generationSelection.usedVerifierFallback,
              grounded: false,
              abstained: true,
              sourceInsufficient: true,
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
              answerDetail: input.answerDetail,
              unitsConsumed: 0,
              fallbackTriggered: true,
              fallbackReason,
              detectedRegulations,
              ragQuery,
              pinecone: pineconeDiagnostics,
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
          fallbackReason,
          mode: jurisdictionContext.mode,
          jurisdictions: [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
          corpusVersionSnapshot: ragContext.corpusVersions,
          retrievalVersion: ragContext.retrievalVersion,
        });

        clearInterval(heartbeatTimer);
        reply.raw.end();

        logger.info({
          type: 'compliance_stream_no_accepted_sources',
          userId: auth.userId,
          orgId: auth.organizationId,
          queryId: query.id,
          query: input.question,
          answerDetail: input.answerDetail,
          detectedRegulations,
          ragQuery,
          pinecone: pineconeDiagnostics,
          retrievedSources: ragContext.results.length,
          retrievedChunksCount: ragContext.results.length,
          retrievedDocumentTitles: getRetrievedDocumentTitles(ragContext.results),
          retrievedChunkScores: getRetrievedChunkScores(ragContext.results),
          verificationInputCount: ragContext.results.length,
          verifiedSourcesCount: preGenerationGrade.accepted.length,
          rejectedSourcesCount: preGenerationGrade.rejected.length,
          graderFailed: preGenerationGrade.gradeFailed,
          verifierFailedOpen: generationSelection.usedVerifierFallback,
          fallbackTriggered: true,
          fallbackReason,
          unitsConsumed: 0,
        });

        return;
      }

      // Stream AI synthesis
      const systemPrompt = generateComplianceSystemPrompt(input.answerDetail, jurisdictionContext);
      const userPrompt   = generateComplianceUserPrompt({
        question:         input.question,
        organizationType: input.organizationType,
        industry:         input.industry,
        context:          input.context,
        answerDetail:     input.answerDetail,
        jurisdictionContext,
        ragContext:       acceptedContext || undefined,
      });
      const maxTokens = input.answerDetail === 'detailed'
        ? Math.max(aiConfig.parameters.queryMaxTokens, 5000)
        : Math.max(aiConfig.parameters.queryMaxTokens, 3000);

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
              ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
              streaming:        true,
              ragSources:       ragContext.results.length,
              acceptedSources:   acceptedResults.length,
              grounded:         true,
              graderFailed:     preGenerationGrade.gradeFailed,
              verifierFailedOpen: generationSelection.usedVerifierFallback,
              tokensUsed:       result.inputTokens + result.outputTokens,
              organizationType: input.organizationType,
              industry:         input.industry,
              context:          input.context,
              answerDetail:     input.answerDetail,
              unitsConsumed:    requiredCredits,
              fallbackTriggered: false,
              fallbackReason: null,
              detectedRegulations,
              ragQuery,
              pinecone: pineconeDiagnostics,
            },
          },
        });

        // Orchestrator
        const agenticComplexityLevel =
          auth.entitlements.agenticComplexityLevel ?? 'simple';

        let route: string             = 'simple';
        let grounded                  = ragContext.results.length > 0;
        let abstained                 = false;
        let runId: string | null      = null;
        let confidence: number | null = null;
        const baselineCitations = buildCitationsFromChunks(
          acceptedResults,
          generationSelection.usedVerifierFallback ? 'not_checked' : 'verified',
        );
        let citations: SourceCitation[]  = baselineCitations;
        let acceptedChunksForClaims = acceptedResults;
        let fallbackReason: ComplianceFallbackReason | null = null;

        if (appConfig.features.orchestratorEnabled) {
          await runOrchestrator({
            complianceQueryId:      query.id,
            question:               input.question,
            answer:                 fullContent,
            ragResults:             ragContext.results,
            jurisdictionContext,
            corpusVersionSnapshot:  ragContext.corpusVersions,
            retrievalVersion:       ragContext.retrievalVersion,
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
            abstained = route === 'abstain';
            fallbackReason =
              route === 'abstain' ? 'OUT_OF_SCOPE' :
              null;

            const verifiedCitations = buildCitationsFromAcceptedRefs(
              run.acceptedChunkIds,
              ragContext.results,
              run.verifierVerdict === 'PASS' ? 'verified' : 'unverified',
            );
            if (hasUsableCitations(verifiedCitations)) {
              citations = verifiedCitations;
              acceptedChunksForClaims = findAcceptedChunks(run.acceptedChunkIds, ragContext.results);
            } else {
              citations = baselineCitations;
              acceptedChunksForClaims = acceptedResults;
            }
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
            jurisdictionContext,
            corpusVersionSnapshot:  ragContext.corpusVersions,
            retrievalVersion:       ragContext.retrievalVersion,
            agenticComplexityLevel,
            shadow:                 true,
          }).catch(() => {});
        }

        const claimVerification = verifyAnswerClaims(fullContent, acceptedChunksForClaims);
        await persistClaimVerification(prisma, query.id, claimVerification);
        const citationValidation = validateCitationsForJurisdiction(citations, jurisdictionContext);

        if (
          abstained ||
          !hasUsableCitations(citations) ||
          !citationValidation.valid ||
          claimVerification.unsupportedClaims.length > 0
        ) {
          fallbackReason =
            fallbackReason ??
            (!hasUsableCitations(citations) || !citationValidation.valid || claimVerification.unsupportedClaims.length > 0
              ? 'ALL_CHUNKS_FAILED_VERIFICATION'
              : 'LOW_RELEVANCE');
          const sourceInsufficientAnswer = claimVerification.unsupportedClaims.length > 0
            ? buildUnsupportedClaimsAnswer(claimVerification.unsupportedClaims.map((claim) => claim.claimText))
            : buildComplianceSourceInsufficiencyAnswer(fallbackReason);
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
              ...buildJurisdictionMetadata(jurisdictionContext, ragContext.corpusVersions, ragContext.retrievalVersion),
              streaming: true,
              ragSources: ragContext.results.length,
              acceptedSources: citations.length,
              grounded,
              abstained,
              sourceInsufficient: abstained && citations.length === 0,
              fallbackTriggered: abstained,
              fallbackReason,
              unitsConsumed: abstained ? 0 : requiredCredits,
              route,
              runId,
              claimVerificationVerdict: claimVerification.verdict,
              verifiedClaims: claimVerification.supportedClaims.length,
              unsupportedClaims: claimVerification.unsupportedClaims.map((claim) => claim.claimText),
              citationJurisdictionValid: citationValidation.valid,
              citationJurisdictionInvalidCount: citationValidation.invalidCitations.length,
              organizationType: input.organizationType,
              industry: input.industry,
              context: input.context,
              answerDetail: input.answerDetail,
              detectedRegulations,
              ragQuery,
              pinecone: pineconeDiagnostics,
            },
          },
        });

        if (!abstained) {
          // Usage increment deferred so failed or unverified synthesis costs nothing.
          await usage.increment(result.inputTokens + result.outputTokens).catch((err: unknown) => {
            logger.error({
              type: 'compliance_stream_usage_increment_failed',
              userId: auth.userId,
              orgId: auth.organizationId,
              queryId: query.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        write({ type: 'chunk', text: fullContent });
        write({
          type: 'done',
          queryId: query.id,
          route,
          grounded,
          abstained,
          runId,
          citations,
          confidence,
          fallbackReason,
          mode: jurisdictionContext.mode,
          jurisdictions: [...jurisdictionContext.jurisdictions],
          primaryJurisdiction: jurisdictionContext.primaryJurisdiction,
          corpusVersionSnapshot: ragContext.corpusVersions,
          retrievalVersion: ragContext.retrievalVersion,
        });

        logger.info({
          type:         'compliance_stream_complete',
          userId:       auth.userId,
          orgId:        auth.organizationId,
          queryId:      query.id,
          query:        input.question,
          answerDetail: input.answerDetail,
          detectedRegulations,
          ragQuery,
          pinecone: pineconeDiagnostics,
          retrievedChunksCount: ragContext.results.length,
          retrievedDocumentTitles: getRetrievedDocumentTitles(ragContext.results),
          retrievedChunkScores: getRetrievedChunkScores(ragContext.results),
          verificationInputCount: ragContext.results.length,
          verifiedSourcesCount: citations.length,
          rejectedSourcesCount: Math.max(ragContext.results.length - citations.length, 0),
          ragSources:   ragContext.results.length,
          tokensUsed:   result.inputTokens + result.outputTokens,
          route,
          grounded,
          abstained,
          fallbackTriggered: abstained,
          fallbackReason,
          unitsConsumed: abstained ? 0 : requiredCredits,
          orchestrated: appConfig.features.orchestratorEnabled,
        });
      } catch (err: unknown) {
        const isDisconnect = streamController.signal.aborted;

        logger.error({
          type:        'compliance_stream_error',
          userId:      auth.userId,
          orgId:       auth.organizationId,
          queryId:     query.id,
          query:       input.question,
          answerDetail: input.answerDetail,
          detectedRegulations,
          ragQuery,
          pinecone: pineconeDiagnostics,
          retrievedChunksCount: ragContext.results.length,
          retrievedDocumentTitles: getRetrievedDocumentTitles(ragContext.results),
          retrievedChunkScores: getRetrievedChunkScores(ragContext.results),
          verificationInputCount: ragContext.results.length,
          verifiedSourcesCount: 0,
          rejectedSourcesCount: ragContext.results.length,
          fallbackTriggered: true,
          fallbackReason: 'ROUTE_ERROR',
          unitsConsumed: 0,
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
