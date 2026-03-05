import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { createContext } from './server/trpc/context';
import { appRouter } from './server/trpc/router';
import { logger } from './utils/logger';
import { prisma } from './lib/prisma/client';
import { redis } from './lib/redis/client';
import { errorTracker } from './lib/error-tracker';
import securityPlugin from './plugins/security.plugin';
import { registerSecurityMiddleware } from './middleware/security.middleware';

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
    bodyLimit: 10485760, // 10 MB
    trustProxy: true, // Required behind Railway's reverse proxy
  });

  // ── CORS — must be registered before Helmet so security headers don't ──
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
      // Allow all Vercel preview deployment subdomains
      if (/^https:\/\/[^.]+\.vercel\.app$/.test(origin)) return cb(null, true);
      cb(new Error(`CORS: origin '${origin}' not allowed`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ── Security headers (production-hardened Helmet) ─────────────────────
  // Registered after CORS so CORS headers are already set when Helmet runs.
  await app.register(securityPlugin);

  // ── Runtime security middleware ───────────────────────────────────────
  registerSecurityMiddleware(app);

  // ── tRPC – all procedures exposed under /trpc ────────────────────────────
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

  // ── Lightweight health check (no DB calls) ────────────────────────────
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

  // ── Detailed health check ─────────────────────────────────────────────────
  app.get('/health/detailed', async (_request, reply) => {
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

    // Redis
    try {
      const t = Date.now();
      await redis.ping();
      const info = await redis.info('memory');
      const memMatch = info.match(/used_memory:(\d+)/);
      const memMB = memMatch ? Math.round(parseInt(memMatch[1]) / (1024 * 1024)) : 0;
      checks.redis = { status: 'healthy', latencyMs: Date.now() - t, message: `${memMB}MB used` };
    } catch (err: unknown) {
      checks.redis = { status: 'down', message: (err as Error).message };
      overallStatus = 'degraded';
    }

    // Storage (R2) — passive check
    checks.storage = { status: 'healthy' };

    // Pinecone / Vector DB — passive check
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

  // ── Root endpoint ────────────────────────────────────────────────────────
  app.get('/', async () => ({
    name: 'SheriaBot API',
    version: '1.0.0',
    description: 'AI-Powered Regulatory Compliance Platform for Kenya',
    endpoints: { health: '/health', healthDetailed: '/health/detailed', trpc: '/trpc' },
  }));

  // ── Catch-all error handler ──────────────────────────────────────────────
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
