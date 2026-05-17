import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { stream } from '@/lib/ai/client';
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';
import { isTokenRevoked } from '@/utils/token-revocation';
import { aiConfig } from '@/config/ai.config';
import { rateLimiter } from '@/lib/redis/rate-limiter';
import {
  generateComplianceSystemPrompt,
  generateComplianceUserPrompt,
} from '@/lib/ai/prompts/compliance-query';
import type { OrgMembershipEntry } from '@/server/trpc/context';

// ── Constants ────────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX     = 100; // same window as tRPC rateLimited('complianceQuery')
const RATE_LIMIT_WINDOW  = 900; // 15 min
const HEARTBEAT_INTERVAL = 15_000; // 15 s — below Render's ~60 s idle timeout
const USAGE_TTL_SECONDS  = 35 * 24 * 60 * 60; // 35 days (matches middleware)

// Redis metric key segment — matches BillingMetric.COMPLIANCE_QUERIES enum value
const METRIC_KEY = 'COMPLIANCE_QUERIES';

// ── Input schema ─────────────────────────────────────────────────────────────
const inputSchema = z.object({
  question:         z.string().min(1).max(5000),
  organizationType: z.string().optional(),
  industry:         z.string().optional(),
  context:          z.string().optional(),
});

// ── Auth resolution ──────────────────────────────────────────────────────────
interface AuthContext {
  userId:         string;
  organizationId: string;
  plan:           string;
  orgMembership:  OrgMembershipEntry;
}

async function resolveAuth(authHeader: string | undefined): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.id) return null;

    const supabaseUserId = data.user.id;
    if (await isTokenRevoked(token, supabaseUserId)) return null;

    // User profile — Redis cache first (same key as tRPC context)
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

    // Org membership — ACTIVE check with Redis cache (same key as middleware)
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

    // Resolve plan from org
    const org = await prisma.organization.findUnique({
      where:  { id: dbUser.organizationId },
      select: { plan: true },
    });

    return {
      userId:         dbUser.id,
      organizationId: dbUser.organizationId,
      plan:           org?.plan ?? 'REGULATOR',
      orgMembership:  entry,
    };
  } catch (err: any) {
    logger.warn({ type: 'compliance_stream_auth_error', error: err?.message });
    return null;
  }
}

// ── Usage enforcement ─────────────────────────────────────────────────────────
// Replicates checkUsageLimit(BillingMetric.COMPLIANCE_QUERIES) from tRPC middleware.
// NOTE: FREE_TRIAL effective plan is not resolved here — trial users are treated
// as their base org plan. Stage 3 TODO: mirror withPlanContext trial resolution.
interface UsageCheck {
  allowed: boolean;
  statusCode: 403 | 429;
  message: string;
  increment: () => Promise<void>;
}

async function checkAndPrepareUsage(auth: AuthContext): Promise<UsageCheck> {
  const planKey = auth.plan as keyof typeof PLAN_ENTITLEMENTS;
  const entitlements = PLAN_ENTITLEMENTS[planKey] ?? PLAN_ENTITLEMENTS['REGULATOR'];
  const quota = entitlements.complianceQueries;

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

  if (current >= quota.limit) {
    const label = quota.period === 'lifetime' ? 'Lifetime' : 'Monthly';
    return {
      allowed:    false,
      statusCode: 429,
      message:    `${label} limit reached (${current}/${quota.limit}). Upgrade your plan for more.`,
      increment:  async () => {},
    };
  }

  const increment = async (): Promise<void> => {
    const newCount = await redis.incr(usageKey);
    if (newCount === 1 && quota.period !== 'lifetime') {
      await redis.expire(usageKey, USAGE_TTL_SECONDS);
    }
    logger.debug({ type: 'usage_incremented', orgId: auth.organizationId, metric: METRIC_KEY, current: newCount });
  };

  return { allowed: true, statusCode: 429, message: '', increment };
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseData(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

// ── Route registration ────────────────────────────────────────────────────────
export async function registerComplianceStreamRoute(
  app: FastifyInstance,
  allowedOrigins: string[],
): Promise<void> {
  app.post<{ Body: unknown }>(
    '/api/compliance/stream',
    async (request, reply) => {

      // ═══════════════════════════════════════════════════════════════════════
      // PRE-HIJACK: all checks that need HTTP error responses
      // ═══════════════════════════════════════════════════════════════════════

      // ── Auth ───────────────────────────────────────────────────────────────
      const auth = await resolveAuth(request.headers.authorization);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // ── Input validation ───────────────────────────────────────────────────
      const parsed = inputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', issues: parsed.error.flatten() });
      }
      const input = parsed.data;

      // ── Rate limiting (same Redis counter as tRPC rateLimited('complianceQuery')) ──
      try {
        await rateLimiter.checkOrThrow(auth.userId, 'complianceQuery', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
      } catch {
        logger.warn({ type: 'compliance_stream_rate_limit', userId: auth.userId });
        return reply.status(429).send({ error: 'Rate limit exceeded. Please try again later.' });
      }

      // ── Usage entitlement enforcement ──────────────────────────────────────
      const usage = await checkAndPrepareUsage(auth);
      if (!usage.allowed) {
        return reply.status(usage.statusCode).send({ error: usage.message });
      }

      // ── RAG retrieval (before hijack so we can return HTTP 500 if needed) ──
      const ragContext = await searchAndGetContext(input.question, { topK: 10, minScore: 0.7 }).catch((err: any) => {
        logger.error({ type: 'compliance_stream_rag_error', error: err?.message });
        return { results: [], context: null };
      });

      // ── Persist query record ───────────────────────────────────────────────
      const query = await (prisma.complianceQuery.create as any)({
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
          },
        },
      });

      // ═══════════════════════════════════════════════════════════════════════
      // POST-HIJACK: SSE socket — HTTP error responses no longer possible
      // ═══════════════════════════════════════════════════════════════════════
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
        // Disables Nginx/Render proxy response buffering — required for true streaming
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      });

      const write = (obj: Record<string, unknown>): void => {
        if (!reply.raw.destroyed) reply.raw.write(sseData(obj));
      };

      // ── AbortController — wired to client disconnect ──────────────────────
      const streamController = new AbortController();
      request.raw.on('close', () => {
        streamController.abort();
        clearInterval(heartbeatTimer);
        logger.info({ type: 'compliance_stream_client_disconnect', userId: auth.userId, queryId: query.id });
      });

      // ── Keepalive heartbeat every 15 s ────────────────────────────────────
      // Render's idle timeout is ~60 s. Claude's first-token latency plus
      // mid-generation pauses can exceed this without a keepalive.
      const heartbeatTimer = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(sseComment('heartbeat'));
      }, HEARTBEAT_INTERVAL);

      write({ type: 'connected', queryId: query.id, ragSources: ragContext.results.length });

      // ── Stream AI synthesis ───────────────────────────────────────────────
      const systemPrompt = generateComplianceSystemPrompt();
      const userPrompt   = generateComplianceUserPrompt({
        question:         input.question,
        organizationType: input.organizationType,
        industry:         input.industry,
        context:          input.context,
        ragContext:       ragContext.context ?? undefined,
      });
      const maxTokens = ragContext.context ? 3000 : aiConfig.parameters.queryMaxTokens;

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
              write({ type: 'chunk', text: chunk });
            },
          },
          'query',
        );

        // Signal frontend: synthesis complete, verification starting
        write({ type: 'synthesis_complete' });

        // ── Persist full answer ─────────────────────────────────────────────
        await (prisma.complianceQuery.update as any)({
          where: { id: query.id },
          data: {
            response: fullContent,
            status:   'completed',
            metadata: {
              streaming:        true,
              ragSources:       ragContext.results.length,
              grounded:         ragContext.results.length > 0,
              tokensUsed:       result.inputTokens + result.outputTokens,
              organizationType: input.organizationType,
              industry:         input.industry,
              context:          input.context,
            },
          },
        });

        // ── Usage increment (deferred to here so failed synthesis costs nothing) ──
        await usage.increment().catch((err: any) => {
          logger.error({ type: 'compliance_stream_usage_increment_failed', userId: auth.userId, error: err?.message });
        });

        // ── Orchestrator ────────────────────────────────────────────────────
        const agenticComplexityLevel =
          PLAN_ENTITLEMENTS[auth.plan as keyof typeof PLAN_ENTITLEMENTS]?.agenticComplexityLevel ?? 'simple';

        // Citation shape mirrors the tRPC compliance.query mutation (queryCitations)
        type CitationRow = {
          documentId:    string | null;
          documentTitle: string;
          section:       string;
          textSnippet:   string;
          score:         number;
          citation:      string | null;
        };

        let route: string             = 'simple';
        let grounded                  = ragContext.results.length > 0;
        let abstained                 = false;
        let runId: string | null      = null;
        let confidence: number | null = null;
        let citations: CitationRow[]  = [];

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
            abstained = route === 'abstain' || accepted === 0 || run.verifierVerdict === 'FAIL_ABSTAIN';

            // Build citations from verifier-accepted chunks only.
            // Join AcceptedChunkRef with ragContext.results to recover text snippets.
            const acceptedRefs = Array.isArray(run.acceptedChunkIds)
              ? (run.acceptedChunkIds as unknown as Array<{
                  documentId: string; documentTitle: string; section?: string; rank: number;
                }>)
              : [];
            citations = acceptedRefs.map((ref): CitationRow => {
              const match =
                ragContext.results.find(
                  (r: any) => r.documentId === ref.documentId && (r.section ?? '') === (ref.section ?? ''),
                ) ??
                ragContext.results.find((r: any) => r.documentId === ref.documentId);
              return {
                documentId:    ref.documentId,
                documentTitle: ref.documentTitle,
                section:       ref.section ?? '',
                textSnippet:   match ? ((match as any).chunkText || '').slice(0, 500) : '',
                score:         (match as any)?.score ?? 0,
                citation:      (match as any)?.citation ?? null,
              };
            });
          }
        } else {
          // Legacy shadow path — include all RAG sources as citations (mirrors tRPC legacy path).
          // fire-and-forget; runId remains null — frontend must disable "Tell us what's missing".
          citations = ragContext.results.map((source: any): CitationRow => ({
            documentId:    source.documentId ?? null,
            documentTitle: source.documentTitle || 'Unknown',
            section:       source.section || '',
            textSnippet:   (source.chunkText || '').slice(0, 500),
            score:         source.score ?? 0,
            citation:      source.citation ?? null,
          }));
          runOrchestrator({
            complianceQueryId:      query.id,
            question:               input.question,
            answer:                 fullContent,
            ragResults:             ragContext.results,
            agenticComplexityLevel,
            shadow:                 true,
          }).catch(() => {});
        }

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
      } catch (err: any) {
        const isDisconnect = streamController.signal.aborted;

        logger.error({
          type:        'compliance_stream_error',
          userId:      auth.userId,
          queryId:     query.id,
          error:       err?.message,
          disconnect:  isDisconnect,
        });

        // Mark query failed (best-effort; ignore if socket already gone)
        await (prisma.complianceQuery.update as any)({
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
