import { FastifyRequest, FastifyReply } from 'fastify';
import { SubscriptionPlan } from '@prisma/client';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { storageService } from '@/lib/storage/storage.service';
import { mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';

/** User shape attached to every authenticated tRPC context. */
export interface User {
  id: string;          // Prisma User.id (cuid)
  email: string;
  role: string;
  organizationId?: string;
  sessionId?: string;
  supabaseAuthId: string; // Supabase auth.users UUID (= JWT sub)
}

export interface Context {
  user: User | null;
  prisma: typeof prisma;
  aiService: typeof aiService;
  ragService: typeof ragService;
  storageService: typeof storageService;
  mailer: typeof mailer;
  req: FastifyRequest;
  res: FastifyReply;
  // Populated by withPlanContext middleware (optional — only present after that middleware runs)
  plan?: SubscriptionPlan;
  customLimits?: Record<string, unknown> | null;
  usageInfo?: { metric: string; current: number; limit: number };
}

/** How long to cache the Prisma user lookup in Upstash (matches Supabase default token TTL). */
const USER_CACHE_TTL_SECONDS = 3600;

/**
 * Create tRPC context for each request.
 *
 * Auth flow:
 * 1. Extract Bearer token from Authorization header.
 * 2. Verify it via supabaseAdmin.auth.getUser() — works for both HS256 and RS256
 *    Supabase project configurations without requiring a local JWT secret.
 * 3. Use the returned user.id (Supabase user UUID) to look up the Prisma User.
 *    Lookup is cached in Upstash Redis for USER_CACHE_TTL_SECONDS.
 * 4. Attach the full Prisma user (role, organizationId, etc.) to context.
 */
export async function createContext({
  req,
  res,
}: {
  req: FastifyRequest;
  res: FastifyReply;
}): Promise<Context> {
  const authHeader = req.headers.authorization;
  let user: User | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    try {
      // Verify the JWT via Supabase — handles HS256 and RS256 transparently
      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user?.id) {
        throw new Error(authError?.message ?? 'Invalid token');
      }

      const supabaseUserId = authData.user.id;

      // Cache key for the Prisma user profile
      const cacheKey = `user:session:${supabaseUserId}`;

      // Try Redis cache first.
      // @upstash/redis auto-parses JSON responses, so the stored JSON string
      // is returned as an already-deserialized object — use get<User> directly.
      //
      // Isolated try/catch: a cache parse failure (e.g. stale pre-migration
      // entries stored without JSON.stringify, resulting in "[object Object]")
      // must fall through to Prisma rather than crashing context creation and
      // leaving every request unauthenticated until the TTL expires.
      let cacheHit = false;
      try {
        const cached = await redis.get<User>(cacheKey);
        if (cached && typeof cached === 'object') {
          user = cached;
          cacheHit = true;
        }
      } catch (cacheErr: any) {
        logger.warn({
          type: 'context_cache_parse_error',
          supabaseUserId,
          error: cacheErr.message,
          action: 'evicting_corrupt_key_and_falling_through_to_prisma',
        });
        // Evict the corrupt key so subsequent requests stop hitting the error
        await redis.del(cacheKey).catch(() => {});
      }

      if (!cacheHit) {
        // Cache miss or corrupt entry — look up by supabaseAuthId in Prisma
        const dbUser = await prisma.user.findUnique({
          where: { supabaseAuthId: supabaseUserId },
          select: {
            id: true,
            email: true,
            role: true,
            organizationId: true,
            supabaseAuthId: true,
          },
        });

        if (dbUser && dbUser.supabaseAuthId) {
          user = {
            id: dbUser.id,
            email: dbUser.email,
            role: dbUser.role,
            organizationId: dbUser.organizationId ?? undefined,
            supabaseAuthId: dbUser.supabaseAuthId,
            // sessionId is populated in the Redis cache by the login handler;
            // it will be present from the next request once the cache is warm.
          };

          // Re-populate cache with well-formed JSON
          await redis.set(cacheKey, JSON.stringify(user), { ex: USER_CACHE_TTL_SECONDS });
        }
      }

      if (user) {
        logger.debug({
          type: 'context_user_authenticated',
          userId: user.id,
          role: user.role,
        });
      } else {
        logger.warn({
          type: 'context_supabase_user_not_in_db',
          supabaseUserId,
          ip: req.ip,
        });
      }
    } catch (error: any) {
      logger.warn({
        type: 'context_invalid_token',
        error: error.message,
        ip: req.ip,
      });
    }
  }

  return {
    user,
    prisma,
    aiService,
    ragService,
    storageService,
    mailer,
    req,
    res,
  };
}
