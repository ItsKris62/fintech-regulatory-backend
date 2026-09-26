import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../lib/redis/client';
import { prisma } from '../lib/prisma/client';
import { logger } from '../utils/logger';
import { verifySupabaseTokenLocally } from '../server/trpc/context';

export const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function isIdempotencyRequiredRoute(url: string): boolean {
  const cleanUrl = url.split('?')[0];
  return (
    cleanUrl.startsWith('/api/checkout') ||
    cleanUrl.startsWith('/api/payments') ||
    cleanUrl.includes('billing.createCheckoutSession') ||
    cleanUrl.includes('billing.initiateMpesaPayment')
  );
}

export async function resolveOrgIdFromSession(request: FastifyRequest): Promise<string | null> {
  // 1. Check if request.user was already resolved and typed via fastify-augment.d.ts
  if (request.user?.organizationId) {
    return request.user.organizationId;
  }

  // 2. Resolve from verified Authorization Bearer token
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7).trim();
  if (!token) return null;

  try {
    const verified = await verifySupabaseTokenLocally(token);
    if (verified.status !== 'VALID') {
      return null;
    }

    const supabaseUserId = verified.payload.sub;
    if (!supabaseUserId) return null;

    // Check Redis session cache first (same key as tRPC context)
    const cacheKey = `user:session:${supabaseUserId}`;
    const cached = await redis.get<string | { organizationId?: string }>(cacheKey);
    if (cached) {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (parsed?.organizationId) {
        return parsed.organizationId;
      }
    }

    // Database lookup if not in Redis cache
    const dbUser = await prisma.user.findUnique({
      where: { supabaseAuthId: supabaseUserId },
      select: { organizationId: true },
    });

    return dbUser?.organizationId ?? null;
  } catch (err: unknown) {
    logger.warn({
      type: 'idempotency_auth_resolution_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface IdempotencyRecord {
  status: 'pending' | 'completed';
  statusCode?: number;
  body?: unknown;
  createdAt: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
    isIdempotencyHit?: boolean;
  }
}

async function getStoredRecord(key: string): Promise<IdempotencyRecord | null> {
  try {
    const raw = await redis.get<IdempotencyRecord | string>(key);
    if (!raw) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as IdempotencyRecord;
      } catch {
        return null;
      }
    }
    return raw as IdempotencyRecord;
  } catch (err: unknown) {
    logger.warn({
      type: 'idempotency_read_error',
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const idempotencyPluginFn: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only inspect mutating methods
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
      return;
    }

    // Route guard: Idempotency is strictly scoped to payment/checkout routes
    if (!isIdempotencyRequiredRoute(request.url)) {
      return;
    }

    // No-op when the idempotency header is absent
    const headerKey = request.headers['idempotency-key'];
    if (!headerKey || typeof headerKey !== 'string' || !headerKey.trim()) {
      return;
    }

    const trimmedKey = headerKey.trim();

    // Length validation: reject keys > 255 chars with 400 Bad Request
    if (trimmedKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return reply.status(400).send({
        error: `Idempotency-Key header must not exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      });
    }

    // Resolve organization ID strictly from verified session (fail-open if unverified)
    const orgId = await resolveOrgIdFromSession(request);
    if (!orgId) {
      logger.info({
        type: 'idempotency_skipped_no_verified_org',
        url: request.url,
      });
      return;
    }

    const redisKey = `sheriabot:idempotency:${orgId}:${trimmedKey}`;

    // Attempt to acquire pending lock
    const pendingRecord: IdempotencyRecord = {
      status: 'pending',
      createdAt: Date.now(),
    };

    const acquired = await redis.set(
      redisKey,
      JSON.stringify(pendingRecord),
      { nx: true, ex: IDEMPOTENCY_TTL_SECONDS },
    ).catch((err: unknown) => {
      logger.error({
        type: 'idempotency_set_pending_error',
        key: redisKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    if (acquired) {
      // Lock acquired successfully; attach key to request for lifecycle hooks
      request.idempotencyKey = redisKey;
      return;
    }

    // Lock was not acquired: check current state of the key
    const existing = await getStoredRecord(redisKey);
    if (existing?.status === 'pending') {
      logger.warn({
        type: 'idempotency_conflict_in_flight',
        key: redisKey,
        orgId,
      });
      // 409 includes a Retry-After hint
      reply.header('Retry-After', '2');
      return reply.status(409).send({
        error: 'A concurrent request with this Idempotency-Key is currently in progress. Please retry shortly.',
      });
    }

    if (existing?.status === 'completed') {
      logger.info({
        type: 'idempotency_cache_hit',
        key: redisKey,
        orgId,
        statusCode: existing.statusCode,
      });
      request.isIdempotencyHit = true;
      // Set-Cookie must be excluded from cached responses
      reply.removeHeader('set-cookie');
      reply.header('x-cache-lookup', 'HIT');
      return reply.status(existing.statusCode ?? 200).send(existing.body);
    }
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (request.isIdempotencyHit || !request.idempotencyKey) {
      return payload;
    }

    const redisKey = request.idempotencyKey;

    // Strict 2xx caching policy: release lock on all non-2xx responses (both 4xx and 5xx)
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      await redis.del(redisKey).catch((err: unknown) => {
        logger.error({
          type: 'idempotency_del_on_non_2xx_failed',
          key: redisKey,
          statusCode: reply.statusCode,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return payload;
    }

    // Buffer check: skip cache write for raw buffers / non-JSON responses
    if (Buffer.isBuffer(payload)) {
      return payload;
    }

    // Cache successful 2xx response with completed status
    let responseBody = payload;
    if (typeof payload === 'string') {
      try {
        responseBody = JSON.parse(payload);
      } catch {
        // Keep string if not valid JSON
      }
    }

    const completedRecord: IdempotencyRecord = {
      status: 'completed',
      statusCode: reply.statusCode,
      body: responseBody,
      createdAt: Date.now(),
    };

    await redis.set(
      redisKey,
      JSON.stringify(completedRecord),
      { ex: IDEMPOTENCY_TTL_SECONDS },
    ).catch((err: unknown) => {
      logger.error({
        type: 'idempotency_cache_store_failed',
        key: redisKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return payload;
  });

  app.addHook('onError', async (request: FastifyRequest, _reply: FastifyReply, error: Error) => {
    if (request.idempotencyKey) {
      logger.warn({
        type: 'idempotency_route_error_released',
        key: request.idempotencyKey,
        error: error.message,
      });
      await redis.del(request.idempotencyKey).catch(() => {});
    }
  });
};

export const idempotencyPlugin = fp(idempotencyPluginFn, {
  name: 'idempotency-plugin',
  fastify: '5.x',
});

export default idempotencyPlugin;
