import pino from 'pino';
import { appConfig } from '@/config/app.config';

/**
 * Logger configuration for structured logging
 * Uses Pino for high-performance JSON logging
 */
const loggerConfig = {
  // Log level based on environment
  level: appConfig.isDevelopment ? 'debug' : 'info',

  /**
   * PII and secret redaction for structured logs.
   *
   * Categories:
   * - Auth secrets: password, token, accessToken, refreshToken, authorization,
   *   apiKey, secret, cookie.
   * - Contact PII: email, phone, mpesaPhoneNumber.
   * - Identifier PII: nationalId and Supabase Auth IDs.
   * - Generic catch-alls: top-level fields plus one-level nested metadata fields
   *   that commonly arrive through request bodies, webhook payloads, or helper
   *   metadata.
   *
   * DPA 2019 concern: logs are retained operational records, so avoid storing
   * personal data or credentials in log sinks while preserving field presence
   * for debugging.
   */
  redact: {
    paths: [
      // Top-level paths
      'email',
      'password',
      'currentPassword',
      'newPassword',
      'token',
      'accessToken',
      'refreshToken',
      'authorization',
      'apiKey',
      'phoneNumber',
      'phone',
      'mpesaPhoneNumber',
      'ipAddress',
      'nationalId',
      'secret',
      'cookie',
      'supabaseAuthId',
      // Agent/automation credentials (X-Agent-Credential header, issued
      // service-principal secrets, HMAC signing secrets, webhook ingress
      // secrets) - none of these should ever reach a log sink in plaintext.
      'credential',
      'agentCredential',
      'hmacSecret',
      'webhookIngressSecret',
      // Wildcard one-level-nested
      '*.email',
      '*.password',
      '*.currentPassword',
      '*.newPassword',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.authorization',
      '*.apiKey',
      '*.phoneNumber',
      '*.phone',
      '*.mpesaPhoneNumber',
      '*.ipAddress',
      '*.nationalId',
      '*.secret',
      '*.cookie',
      '*.supabaseAuthId',
      '*.credential',
      '*.agentCredential',
      '*.hmacSecret',
      '*.webhookIngressSecret',
      // Common request and parameter envelopes
      'user.email',
      'params.email',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-agent-credential"]',
    ],
    censor: '[REDACTED]',
  },

  // Production: JSON format, Development: Pretty print
  ...(appConfig.isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),

  // Base configuration
  base: {
    env: appConfig.env,
  },

  // Format time as ISO string
  timestamp: () => `,"time":"${new Date().toISOString()}"`,

  // Serialize errors properly
  serializers: {
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
};

/**
 * Main logger instance
 */
export const logger = pino(loggerConfig);

/**
 * Create child logger with request context
 * @param requestId Unique request ID
 * @param userId Optional user ID
 * @returns Child logger instance
 */
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({
    requestId,
    userId,
  });
}

/**
 * Log performance timing
 * @param label Operation label
 * @param startTime Start time in milliseconds
 * @param metadata Additional metadata
 */
export function logPerformance(label: string, startTime: number, metadata?: Record<string, unknown>) {
  const duration = Date.now() - startTime;

  logger.info(
    {
      type: 'performance',
      label,
      duration,
      ...metadata,
    },
    `${label} completed in ${duration}ms`
  );
}

/**
 * Log API call (external service)
 * @param service Service name
 * @param method HTTP method or operation
 * @param duration Duration in milliseconds
 * @param success Whether call was successful
 * @param metadata Additional metadata
 */
export function logApiCall(
  service: string,
  method: string,
  duration: number,
  success: boolean,
  metadata?: Record<string, unknown>
) {
  const logLevel = success ? 'info' : 'error';

  logger[logLevel](
    {
      type: 'api_call',
      service,
      method,
      duration,
      success,
      ...metadata,
    },
    `${service} ${method} - ${success ? 'success' : 'failed'} (${duration}ms)`
  );
}

/**
 * Log database query (slow queries only in production)
 * @param operation Database operation
 * @param model Prisma model
 * @param duration Duration in milliseconds
 * @param metadata Additional metadata
 */
export function logDatabaseQuery(
  operation: string,
  model: string,
  duration: number,
  metadata?: Record<string, unknown>
) {
  // In production, only log slow queries (> 1000ms)
  if (appConfig.isProduction && duration < 1000) {
    return;
  }

  logger.debug(
    {
      type: 'db_query',
      operation,
      model,
      duration,
      ...metadata,
    },
    `DB: ${model}.${operation} (${duration}ms)`
  );
}

/**
 * Log authentication event
 * @param event Event type (login, logout, etc.)
 * @param userId User ID
 * @param success Whether auth was successful
 * @param metadata Additional metadata
 */
export function logAuth(
  event: string,
  userId?: string,
  success: boolean = true,
  metadata?: Record<string, unknown>
) {
  logger.info(
    {
      type: 'auth',
      event,
      userId,
      success,
      ...metadata,
    },
    `Auth: ${event} - ${success ? 'success' : 'failed'}`
  );
}

/**
 * Log business event (policy generated, document uploaded, etc.)
 * @param event Event type
 * @param userId User ID
 * @param metadata Additional metadata
 */
export function logBusinessEvent(event: string, userId: string, metadata?: Record<string, unknown>) {
  logger.info(
    {
      type: 'business_event',
      event,
      userId,
      ...metadata,
    },
    `Business Event: ${event}`
  );
}

/**
 * Log error with context
 * @param error Error object or message
 * @param context Error context
 * @param userId Optional user ID
 */
export function logError(error: Error | string, context?: Record<string, unknown>, userId?: string) {
  const errorObj = error instanceof Error ? error : new Error(error);

  logger.error(
    {
      type: 'error',
      error: errorObj,
      userId,
      ...context,
    },
    `Error: ${errorObj.message}`
  );
}

/**
 * Log security event (suspicious activity, rate limit, etc.)
 * @param event Event type
 * @param severity Severity level
 * @param metadata Additional metadata
 */
export function logSecurity(
  event: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  metadata?: Record<string, unknown>
) {
  logger.warn(
    {
      type: 'security',
      event,
      severity,
      ...metadata,
    },
    `Security Event [${severity.toUpperCase()}]: ${event}`
  );
}

/**
 * Performance timer utility
 * @param label Operation label
 * @returns Stop function to end timer
 *
 * @example
 * const stop = performanceTimer('policy-generation');
 * // ... do work ...
 * stop({ policyId: '123' }); // Logs performance
 */
export function performanceTimer(label: string) {
  const startTime = Date.now();

  return (metadata?: Record<string, unknown>) => {
    logPerformance(label, startTime, metadata);
  };
}

/**
 * Log startup information
 */
export function logStartup() {
  logger.info(
    {
      type: 'startup',
      env: appConfig.env,
      port: appConfig.port,
      nodeVersion: process.version,
    },
    'SheriaBot Backend Starting...'
  );
}

/**
 * Log shutdown information
 */
export function logShutdown(signal: string) {
  logger.info(
    {
      type: 'shutdown',
      signal,
    },
    'SheriaBot Backend Shutting Down...'
  );
}

/**
 * Export logger types
 */
export type Logger = typeof logger;
export type RequestLogger = ReturnType<typeof createRequestLogger>;
