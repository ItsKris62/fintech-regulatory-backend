import { FastifyRequest, FastifyReply } from 'fastify';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { storageService } from '@/lib/storage/storage.service';
import { mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!SUPABASE_JWT_SECRET) {
  throw new Error('SUPABASE_JWT_SECRET environment variable is required');
}

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
}

/** How long to cache the Prisma user lookup in Upstash (matches Supabase default token TTL). */
const USER_CACHE_TTL_SECONDS = 3600;

/**
 * Create tRPC context for each request.
 *
 * Auth flow:
 * 1. Extract Bearer token from Authorization header.
 * 2. Verify it as a Supabase-issued JWT using SUPABASE_JWT_SECRET.
 * 3. Use decoded.sub (Supabase user UUID) to look up the Prisma User.
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
      // Verify the Supabase JWT locally (fast — no network call)
      interface SupabaseJwtPayload extends JwtPayload {
        sub: string;   // Supabase user UUID
        email: string;
        role?: string; // Supabase DB role (not our app role)
        user_metadata?: { role?: string; organizationId?: string };
        session_id?: string;
      }

      const decoded = jwt.verify(token, SUPABASE_JWT_SECRET!) as SupabaseJwtPayload;
      const supabaseUserId = decoded.sub;

      if (!supabaseUserId) throw new Error('JWT missing sub claim');

      // Cache key for the Prisma user profile
      const cacheKey = `user:session:${supabaseUserId}`;

      // Try Redis cache first
      const cached = await redis.get<string>(cacheKey);
      if (cached) {
        user = JSON.parse(cached) as User;
      } else {
        // Cache miss — look up by supabaseAuthId in Prisma
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
            sessionId: decoded.session_id,
          };

          // Cache for subsequent requests
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
