import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { logger } from '@/utils/logger';

/**
 * Runtime security middleware.
 * Registers Fastify hooks for request-level security checks.
 */

/** Patterns that indicate common injection attempts */
const SUSPICIOUS_PATTERNS = [
  /<script\b/i,
  /javascript:/i,
  /on\w+\s*=/i,
  /\bUNION\b.*\bSELECT\b/i,
  /\bDROP\b.*\bTABLE\b/i,
  /\bINSERT\b.*\bINTO\b/i,
  /\bDELETE\b.*\bFROM\b/i,
  /--\s*$/,
  /;\s*--/,
  /\bexec\b.*\bxp_/i,
];

function isSuspicious(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return SUSPICIOUS_PATTERNS.some((p) => p.test(value));
}

function scanObject(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === 'string') return isSuspicious(obj);
  if (Array.isArray(obj)) return obj.some(scanObject);
  if (typeof obj === 'object') return Object.values(obj as Record<string, unknown>).some(scanObject);
  return false;
}

export function registerSecurityMiddleware(app: FastifyInstance): void {
  // -- Request ID injection ----------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const existingId =
      (request.headers['x-request-id'] as string) ||
      (request.headers['x-correlation-id'] as string);

    (request as any).requestId = existingId || randomUUID();
  });

  // -- Client IP extraction (behind Render proxy) ------------------------
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const forwarded = request.headers['x-forwarded-for'];
    const clientIp = typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : request.ip;

    (request as any).clientIp = clientIp;
  });

  // -- Suspicious payload detection -------------------------------------
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.body) return;

    if (scanObject(request.body)) {
      logger.warn(
        {
          type: 'security',
          event: 'suspicious_payload',
          severity: 'high',
          ip: (request as any).clientIp,
          url: request.url,
          method: request.method,
          requestId: (request as any).requestId,
        },
        'Suspicious payload detected'
      );

      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Request contains potentially unsafe content',
      });
    }
  });

  // -- Response security headers -----------------------------------------
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
}
