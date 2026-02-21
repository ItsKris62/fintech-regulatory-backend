import pino from 'pino';

/**
 * Production-grade Pino logger with sensitive field redaction.
 *
 * This wraps the existing src/utils/logger.ts patterns but adds:
 * - Configurable log level via LOG_LEVEL env var
 * - Sensitive field redaction in production
 * - Request serializer with header redaction
 */

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

/** Fields to redact from all log output */
const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'refreshToken',
  'accessToken',
  'authorization',
  'cookie',
  'jwt',
  'secret',
  'apiKey',
  'api_key',
  'ANTHROPIC_API_KEY',
  'PINECONE_API_KEY',
  'RESEND_API_KEY',
  'R2_SECRET_ACCESS_KEY',
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
  'req.headers.authorization',
  'req.headers.cookie',
];

const productionLogger = pino({
  level: logLevel,

  // Redact sensitive fields
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },

  base: {
    env: process.env.NODE_ENV || 'development',
    service: 'sheriabot-api',
  },

  timestamp: () => `,"time":"${new Date().toISOString()}"`,

  serializers: {
    error: pino.stdSerializers.err,
    req(req: any) {
      return {
        method: req.method,
        url: req.url,
        remoteAddress: req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      };
    },
    res: pino.stdSerializers.res,
  },

  // Pretty print in development only
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }),
});

export { productionLogger };

/**
 * Create a child logger bound to a request context.
 */
export function createProductionRequestLogger(
  requestId: string,
  userId?: string
): pino.Logger {
  return productionLogger.child({ requestId, userId });
}
