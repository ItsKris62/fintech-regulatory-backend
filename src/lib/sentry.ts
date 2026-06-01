import * as Sentry from '@sentry/node';
import { TRPCError } from '@trpc/server';
import { logger } from '../utils/logger';

const IGNORED_TRPC_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TIMEOUT',
  'CONFLICT',
  'CLIENT_CLOSED_REQUEST',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'METHOD_NOT_SUPPORTED',
  'UNPROCESSABLE_CONTENT',
  'TOO_MANY_REQUESTS',
]);

/**
 * Checks whether an error is client-driven or expected, in which case we do NOT
 * want to report it to Sentry (saves Sentry free tier quota).
 */
export function isClientOrExpectedError(error: unknown): boolean {
  if (!error) return false;

  // Filter out client-side tRPC errors
  if (error instanceof TRPCError) {
    return IGNORED_TRPC_CODES.has(error.code);
  }

  const err = error as Record<string, unknown>;

  // Filter out Fastify client-side HTTP errors (4xx status codes)
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    return true;
  }

  // Filter out other standard validation / client-aborted errors
  const errorCode = String(err.code || err.errorCode || '');
  if (
    errorCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
    errorCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    errorCode === 'FST_ERR_VALIDATION'
  ) {
    return true;
  }

  // Filter out client socket/connection reset issues
  if (error instanceof Error) {
    const errMsg = error.message;
    if (
      errMsg.includes('ECONNRESET') ||
      errMsg.includes('ECONNREFUSED') ||
      errMsg.includes('request aborted') ||
      errMsg.includes('socket hang up')
    ) {
      return true;
    }
  }

  return false;
}

export function sanitizeHeadersForSentry(headers: Record<string, unknown>): Record<string, unknown> {
  const redactedHeaders = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-supabase-auth',
    'x-forwarded-for',
  ]);

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      redactedHeaders.has(key.toLowerCase()) ? '[Redacted]' : value,
    ]),
  );
}

/**
 * Initialize Sentry for the Fastify/Node backend server.
 * Should be imported and invoked at the absolute top of index.ts (immediately after dotenv/config).
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info({
      type: 'sentry_disabled',
      message: 'SENTRY_DSN not provided. Sentry error tracking is disabled.',
    });
    return;
  }

  const env = process.env.NODE_ENV || 'development';

  Sentry.init({
    dsn,
    environment: env,
    // Tracing sample rate (low for free tier)
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.01'),

    // CPU Profiling (disabled by default to keep resource usage minimum)
    profilesSampleRate: 0.0,

    // Filter events to prevent quota exhaustion
    beforeSend(event, hint) {
      const exception = hint?.originalException;
      if (isClientOrExpectedError(exception)) {
        return null; // Drops the event
      }
      return event;
    },

    // Custom trace sampler to ignore health checks
    tracesSampler(samplingContext) {
      const transactionName = samplingContext.name || '';
      if (
        transactionName.includes('/health') ||
        transactionName.includes('/health/detailed') ||
        transactionName.includes('GET /health')
      ) {
        return 0.0; // 0% sampling for health checks
      }
      // Return default sample rate
      return parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.01');
    },
  });

  logger.info({
    type: 'sentry_initialized',
    message: `Sentry initialized successfully. Environment: ${env}`,
  });
}
