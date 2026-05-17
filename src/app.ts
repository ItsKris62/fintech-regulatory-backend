import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { createContext } from './server/trpc/context';
import { appRouter } from './server/trpc/router';
import { logger } from './utils/logger';
import { prisma } from './lib/prisma/client';
import { redis } from './lib/redis/client';
import { errorTracker } from './lib/error-tracker';
import { supabaseAdmin } from './lib/supabase';
import securityPlugin from './plugins/security.plugin';
import { registerSecurityMiddleware } from './middleware/security.middleware';
import { stripeWebhookService } from './lib/stripe/webhook.service';
import { intaSendWebhookService } from './lib/intasend/webhook.service';
import { resendWebhookService } from './lib/resend/webhook.service';
import type { IntaSendWebhookPayload } from './modules/intasend/intasend.types';
import { alertPubSub } from './lib/redis/pubsub';
import { consumeAlertStreamToken } from './lib/alerts/stream-token';
import { registerComplianceStreamRoute } from './routes/compliance-stream.route';

/**
 * Zod schema for IntaSend webhook payloads.
 *
 * IntaSend does not sign webhook bodies, so we cannot verify authenticity via
 * HMAC. Instead we:
 *  1. Validate the payload shape strictly here (rejects log-injection strings
 *     and unexpected types before they reach handleEvent).
 *  2. In handleEvent, confirm the invoice exists in our DB *before* calling
 *     IntaSend's status API with the caller-supplied invoice_id (SSRF guard).
 */
const intaSendWebhookSchema = z.object({
  invoice_id:    z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  state:         z.string().min(1).max(32),
  failed_reason: z.string().max(512).optional(),
  failed_code:   z.string().max(64).optional(),
  meta:          z.record(z.string(), z.unknown()).optional(),
  challenge:     z.string().max(512).optional(),
}).passthrough();

/**
 * Build and configure the Fastify application.
 *
 * Returns a fully-initialised FastifyInstance with all plugins registered.
 * Using an async factory function (rather than top-level await) keeps this
 * file compatible with CommonJS output from esbuild/tsx and avoids the
 * "Top-level await is not supported with the 'cjs' output format" error.
 *
 * Call this once from src/index.ts inside the start() bootstrap function.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // Structured logging handled by Pino via src/utils/logger
    maxParamLength: 5000,
    bodyLimit: 31457280, // 30 MB  -  covers 20 MB base64 gap analysis uploads
    // Render's reverse proxy is trusted  -  accepts X-Forwarded-For.
    // Override with TRUST_PROXY env var if deploying behind a different proxy.
    // See: https://fastify.dev/docs/latest/Reference/Server/#trustproxy
    trustProxy: process.env.TRUST_PROXY ?? true,
  });

  // -- CORS  -  must be registered before Helmet so security headers don't --
  // conflict with CORS preflight handling.
  // Support comma-separated FRONTEND_URL for multiple origins
  // (e.g. production + Vercel preview deployments)
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (server-to-server, Postman, curl)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // No wildcard regex  -  every allowed origin must be listed explicitly in
      // FRONTEND_URL (comma-separated). Add Vercel preview URLs there as needed.
      cb(new Error(`CORS: origin '${origin}' not allowed`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // -- Security headers (production-hardened Helmet) ---------------------
  // Registered after CORS so CORS headers are already set when Helmet runs.
  await app.register(securityPlugin);

  // -- Runtime security middleware ---------------------------------------
  registerSecurityMiddleware(app);

  // -- Stripe Webhook  -  raw body required for signature verification --------
  // Registered in an encapsulated plugin so the Buffer content-type parser is
  // scoped only to this route and does NOT override the global JSON parser.
  await app.register(async (webhookApp) => {
    // Override application/json parser to return raw Buffer instead of parsed object.
    // Stripe's constructEvent() needs the exact bytes Stripe signed.
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    webhookApp.post<{ Body: Buffer }>(
      '/webhooks/stripe',
      async (request, reply) => {
        const signature = request.headers['stripe-signature'];

        if (!signature || typeof signature !== 'string') {
          logger.warn({ type: 'stripe_webhook_missing_signature', ip: request.ip });
          return reply.status(400).send({ error: 'Missing Stripe-Signature header' });
        }

        try {
          await stripeWebhookService.handleEvent(request.body, signature);
          return reply.status(200).send({ received: true });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Webhook processing error';

          // Signature mismatch -> return 400 so Stripe retries with correct secret
          if (err instanceof Error && err.message.includes('No signatures found')) {
            logger.warn({ type: 'stripe_webhook_invalid_signature', error: message });
            return reply.status(400).send({ error: 'Invalid webhook signature' });
          }

          logger.error({ type: 'stripe_webhook_error', error: message });
          return reply.status(500).send({ error: 'Webhook handler failed' });
        }
      },
    );
  });

  // -- IntaSend Webhook  -  JSON body, re-verified via IntaSend status API -------
  // IntaSend sends standard JSON (no raw Buffer needed).
  // Security:
  //  1. Payload shape is validated via intaSendWebhookSchema before processing.
  //  2. handleEvent checks the invoice exists in our DB before calling the
  //     IntaSend status API, preventing SSRF with attacker-controlled IDs.
  app.post<{ Body: IntaSendWebhookPayload }>(
    '/api/webhooks/intasend',
    async (request, reply) => {
      const parseResult = intaSendWebhookSchema.safeParse(request.body);
      if (!parseResult.success) {
        logger.warn({
          type:   'intasend_webhook_invalid_body',
          ip:     request.ip,
          errors: parseResult.error.flatten(),
        });
        return reply.status(400).send({ error: 'Invalid webhook payload' });
      }

      const payload = parseResult.data as IntaSendWebhookPayload;
      try {
        await intaSendWebhookService.handleEvent(payload);
        return reply.status(200).send({ received: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Webhook processing error';
        logger.error({ type: 'intasend_webhook_error', error: message });
        return reply.status(500).send({ error: 'Webhook handler failed' });
      }
    },
  );

  // -- Resend Webhook  -  raw body required for Svix signature verification ----
  // Encapsulated plugin so the Buffer parser is scoped only to this route and
  // does NOT override the global JSON parser used by tRPC and other routes.
  await app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    webhookApp.post<{ Body: Buffer }>(
      '/webhooks/resend',
      async (request, reply) => {
        const svixId        = request.headers['svix-id'] as string | undefined;
        const svixTimestamp = request.headers['svix-timestamp'] as string | undefined;
        const svixSignature = request.headers['svix-signature'] as string | undefined;

        if (!svixId || !svixTimestamp || !svixSignature) {
          logger.warn({ type: 'resend_webhook_missing_headers', ip: request.ip });
          return reply.status(400).send({ error: 'missing_headers' });
        }

        // Phase A: synchronous verification (must complete before 200 is sent)
        const verification = resendWebhookService.verifyAndParse(
          request.body,
          svixId,
          svixTimestamp,
          svixSignature,
        );

        if (!verification.valid) {
          logger.warn({
            type:   'resend_webhook_rejected',
            reason: verification.reason,
            ip:     request.ip,
          });
          return reply.status(400).send({ error: verification.reason });
        }

        // Respond 200 immediately — Resend must not time out waiting for DB writes
        void reply.status(200).send({ received: true });

        // Phase B: fire-and-forget; errors caught and logged, never rethrown
        resendWebhookService
          .processEventBackground(
            verification.payload,
            verification.eventType,
            verification.messageId,
          )
          .catch((err) => {
            logger.error(
              {
                err,
                messageId: verification.messageId,
                eventType: verification.eventType,
              },
              'Resend webhook background processing failed',
            );
          });
      },
    );
  });

  // -- tRPC - all procedures exposed under /trpc ----------------------------
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ path, error }: { path: string | undefined; error: { message: string; code: string; stack?: string } }) {
        logger.error({
          type: 'trpc_error',
          path,
          error: error.message,
          code: error.code,
          stack: error.stack,
        });

        // Track errors for rate alerting
        errorTracker.track(error.message, error.code);
      },
    },
  });

  // -- Lightweight health check (no DB calls) ----------------------------
  app.get('/health', async () => {
    const mem = process.memoryUsage();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      memory: {
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
      },
    };
  });

  // -- Detailed health check (admin-only) -----------------------------------
  app.get('/health/detailed', async (request, reply) => {
    // -- Auth gate: valid Supabase JWT with role === 'ADMIN' required ---------
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    try {
      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (authError || !authData?.user?.id) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const dbUser = await prisma.user.findUnique({
        where: { supabaseAuthId: authData.user.id },
        select: { role: true },
      });

      if (!dbUser || dbUser.role !== 'ADMIN') {
        return reply.status(403).send({ error: 'Forbidden' });
      }
    } catch (err: unknown) {
      logger.warn({
        type: 'health_detailed_auth_error',
        error: err instanceof Error ? err.message : String(err),
        ip: request.ip,
      });
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    // -- End auth gate --------------------------------------------------------

    const checks: Record<string, { status: string; latencyMs?: number; message?: string }> = {};
    let overallStatus: 'ok' | 'degraded' | 'down' = 'ok';

    // Database
    try {
      const t = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'healthy', latencyMs: Date.now() - t };
    } catch (err: unknown) {
      checks.database = { status: 'down', message: (err as Error).message };
      overallStatus = 'degraded';
    }

    // Upstash Redis (HTTP ping  -  info() not supported by REST API)
    try {
      const t = Date.now();
      await redis.ping();
      checks.redis = { status: 'healthy', latencyMs: Date.now() - t, message: 'Upstash HTTP' };
    } catch (err: unknown) {
      checks.redis = { status: 'down', message: (err as Error).message };
      overallStatus = 'degraded';
    }

    // Storage (R2)  -  passive check
    checks.storage = { status: 'healthy' };

    // Pinecone / Vector DB  -  passive check
    checks.vectordb = { status: 'healthy' };

    if (checks.database?.status === 'down' && checks.redis?.status === 'down') {
      overallStatus = 'down';
    }

    const mem = process.memoryUsage();
    const errorSummary = errorTracker.getSummary();

    reply.status(overallStatus === 'down' ? 503 : 200).send({
      status: overallStatus,
      services: checks,
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '1.0.0',
      timestamp: new Date().toISOString(),
      memory: {
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
      },
      errors: {
        uniqueErrors: errorSummary.totalUniqueErrors,
        recentErrors: errorSummary.topErrors.slice(0, 5),
      },
    });
  });

  // -- Root endpoint --------------------------------------------------------
  app.get('/', async () => ({
    name: 'SheriaBot API',
    version: '1.0.0',
    description: 'AI-Powered Regulatory Compliance Platform for Kenya',
    endpoints: { health: '/health', healthDetailed: '/health/detailed', trpc: '/trpc' },
  }));

  // -- Regulatory Alerts SSE stream -----------------------------------------
  // EventSource does not support custom request headers, so the browser first
  // asks tRPC for a short-lived stream token and passes that here.
  app.get<{ Querystring: { token?: string } }>(
    '/api/alerts/stream',
    async (request, reply) => {
      const token = request.query.token;

      if (!token) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const userId = await consumeAlertStreamToken(token).catch((err: unknown) => {
        logger.warn({
          type: 'alert_sse_token_error',
          error: err instanceof Error ? err.message : String(err),
          ip: request.ip,
        });
        return null;
      });

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // Hand the socket to raw Node — Fastify must not finalize the response.
      reply.hijack();

      const requestOrigin = typeof request.headers.origin === 'string'
        ? request.headers.origin
        : undefined;
      const corsHeaders = requestOrigin && allowedOrigins.includes(requestOrigin)
        ? {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Vary': 'Origin',
          }
        : {};

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      });

      // Confirm connection to the client.
      reply.raw.write('data: {"type":"CONNECTED"}\n\n');

      // Subscribe to this user's alert channel.
      const unsubscribe = await alertPubSub.subscribe(userId, (event) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });

      // Keep-alive comment every 30 s prevents proxy / load-balancer timeouts.
      const keepAliveInterval = setInterval(() => {
        if (!reply.raw.destroyed) {
          reply.raw.write(': ping\n\n');
        }
      }, 30000);

      // Cleanup — must call unsubscribe() to avoid leaking EventEmitter listeners.
      request.raw.on('close', () => {
        clearInterval(keepAliveInterval);
        unsubscribe();
        logger.info({ type: 'alert_sse_disconnected', userId });
      });

      logger.info({ type: 'alert_sse_connected', userId });
    },
  );

  // -- Compliance SSE stream -------------------------------------------------
  // POST /api/compliance/stream — streams Claude tokens as text/event-stream.
  // Auth: Bearer token (same Supabase JWT as tRPC). Does NOT use EventSource
  // query-param tokens because fetch() streaming supports custom headers.
  await registerComplianceStreamRoute(app, allowedOrigins);

  // -- Catch-all error handler ----------------------------------------------
  app.setErrorHandler<Error>((error, request, reply) => {
    const statusCode = (error as any).statusCode || 500;

    logger.error({
      type: 'fastify_error',
      error: error.message,
      stack: error.stack,
      url: request.url,
      method: request.method,
    });

    errorTracker.track(error, 'FASTIFY_ERROR');

    reply.status(statusCode).send({
      error: 'Internal Server Error',
      message:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Something went wrong',
    });
  });

  return app;
}
