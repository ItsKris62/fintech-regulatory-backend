import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'crypto';
import type { MemberRole, MemberStatus, OrganizationMember } from '@prisma/client';

import type { EffectivePlan } from '@/types/plan.types';
import type { EffectivePlanSource, PilotEntitlementProfile, PilotPlanState } from '@/types/plan.types';
import type { TrialContextState } from '@/modules/trial/trial.types';
import type { PlanEntitlementConfig } from '@/config/entitlements.config';
import type { AppliedEnterpriseOverride } from '@/modules/billing/enterprise-contract-overrides';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { storageService } from '@/lib/storage/storage.service';
import { mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';
import { revokedBearerTokenKey } from '@/utils/request-identifiers';
import { SESSION_CONFIG, lastSeenKey } from '@/config/session';
import { isTokenRevoked, revokedJtiKey } from '@/utils/token-revocation';
import { extractJti, extractExp } from '@/utils/jwt';

/**
 * Minimal membership record attached by requireOrgMembership middleware.
 * Uses a typed subset instead of full OrganizationMember to survive JSON
 * round-trips through the Redis cache (Date fields become strings there).
 */
export interface OrgMembershipEntry {
  userId: string;
  organizationId: string;
  role: MemberRole;
  status: MemberStatus;
}

/** User shape attached to every authenticated tRPC context. */
export interface User {
  id: string;          // Prisma User.id (cuid)
  email: string;
  role: string;
  organizationId?: string;
  sessionId?: string;
  supabaseAuthId: string; // Supabase auth.users UUID (= JWT sub)
  mustChangePassword?: boolean;
  totpEnabled?: boolean;
  /** Unix ms timestamp of Session.expiresAt  -  enforced on every request (B6). */
  sessionExpiresAt?: number;
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
  // Populated by withPlanContext middleware (optional -- only present after that middleware runs)
  plan?: EffectivePlan;
  effectivePlanSource?: EffectivePlanSource;
  entitlementProfile?: PilotEntitlementProfile | null;
  entitlements?: PlanEntitlementConfig;
  appliedPlanOverrides?: AppliedEnterpriseOverride[];
  pilotState?: PilotPlanState | null;
  customLimits?: Record<string, unknown> | null;
  usageInfo?: { metric: string; current: number; limit: number };
  /** Present when plan === 'FREE_TRIAL'. Lightweight trial state for middleware consumers. */
  trialState?: TrialContextState;
  /**
   * Populated by checkUsageLimit when called with { deferIncrement: true }.
   * The router handler MUST call this after a successful DB write to commit
   * the usage counter. Never incremented if the service call throws.
   */
  incrementUsage?: () => Promise<void>;
  /** Populated by requireOrgMember middleware. Present only after that middleware runs. */
  orgMember?: OrganizationMember;
  /**
   * Populated by requireOrgMembership middleware (input-scoped, with caching and
   * denial rate limiting). Distinct from orgMember -- see middleware.ts for details.
   */
  orgMembership?: OrgMembershipEntry;
}

/** How long to cache the Prisma user lookup in Upstash (matches Supabase default token TTL). */
const USER_CACHE_TTL_SECONDS = 3600;

const SESSION_FINGERPRINT_MODES = ['off', 'monitor', 'enforce'] as const;
type SessionFingerprintMode = (typeof SESSION_FINGERPRINT_MODES)[number];

function parseSessionFingerprintMode(value: string | undefined): SessionFingerprintMode {
  const resolved = value ?? 'monitor';
  if ((SESSION_FINGERPRINT_MODES as readonly string[]).includes(resolved)) {
    return resolved as SessionFingerprintMode;
  }

  throw new Error(
    `Invalid SESSION_FINGERPRINT_MODE "${resolved}". Expected one of: ${SESSION_FINGERPRINT_MODES.join(', ')}.`,
  );
}

/**
 * Session fingerprint runtime mode. Read once at module load so an invalid
 * deployment value fails loudly during startup instead of drifting per request.
 */
const SESSION_FINGERPRINT_MODE = parseSessionFingerprintMode(process.env.SESSION_FINGERPRINT_MODE);

logger.info({
  type: 'session_fingerprint_mode_loaded',
  mode: SESSION_FINGERPRINT_MODE,
});

function resolveEffectiveFingerprintMode(user: User): SessionFingerprintMode {
  return user.role === 'ADMIN' ? 'enforce' : SESSION_FINGERPRINT_MODE;
}

/**
 * Create tRPC context for each request.
 *
 * Auth flow:
 * 1. Extract Bearer token from Authorization header.
 * 2. Verify it via supabaseAdmin.auth.getUser()  -  works for both HS256 and RS256
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
      // Verify the JWT via Supabase  -  handles HS256 and RS256 transparently
      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

      if (authError || !authData?.user?.id) {
        throw new Error(authError?.message ?? 'Invalid token');
      }

      const supabaseUserId = authData.user.id;

      // -- B4: JTI blocklist + user-level revocation check -------------
      // Run after Supabase signature verification so we only pay the Redis
      // round-trip for valid tokens. Fails open on Redis error (see util).
      const revoked = await isTokenRevoked(token, supabaseUserId);
      if (revoked) {
        throw new Error('Token has been revoked');
      }

      try {
        const bearerRevoked = await redis.exists(revokedBearerTokenKey(token));
        if (bearerRevoked === 1) {
          throw new Error('Token has been revoked');
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'Token has been revoked') {
          throw error;
        }

        logger.warn({
          type: 'token_hash_revocation_check_error',
          supabaseUserId,
          error: error instanceof Error ? error.message : String(error),
          action: 'fail_open',
        });
      }

      // Cache key for the Prisma user profile
      const cacheKey = `user:session:${supabaseUserId}`;

      // Try Redis cache first.
      // @upstash/redis auto-parses JSON responses, so the stored JSON string
      // is returned as an already-deserialized object  -  use get<User> directly.
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
        // Cache miss or corrupt entry  -  look up by supabaseAuthId in Prisma
        const dbUser = await prisma.user.findUnique({
          where: { supabaseAuthId: supabaseUserId },
          select: {
            id: true,
            email: true,
            role: true,
            organizationId: true,
            supabaseAuthId: true,
            mustChangePassword: true,
            totpEnabled: true,
            accountStatus: true,
            deletedAt: true,
          },
        });

        if (
          dbUser &&
          dbUser.supabaseAuthId &&
          !dbUser.deletedAt &&
          dbUser.accountStatus === 'active'
        ) {
          const activeSession = await prisma.session.findFirst({
            where: { userId: dbUser.id, expiresAt: { gte: new Date() } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, expiresAt: true },
          });

          if (!activeSession) {
            logger.warn({ type: 'context_no_active_local_session', userId: dbUser.id });
            await redis.del(cacheKey).catch(() => {});
          }

          if (activeSession) {
            user = {
              id: dbUser.id,
              email: dbUser.email,
              role: dbUser.role,
              organizationId: dbUser.organizationId ?? undefined,
              supabaseAuthId: dbUser.supabaseAuthId,
              mustChangePassword: dbUser.mustChangePassword,
              totpEnabled: dbUser.totpEnabled,
              sessionId: activeSession.id,
              sessionExpiresAt: activeSession.expiresAt.getTime(),
            };

            // Re-populate cache with well-formed JSON
            await redis.set(cacheKey, JSON.stringify(user), { ex: USER_CACHE_TTL_SECONDS });
          }
        }
      }

      if (user) {
        logger.debug({
          type: 'context_user_authenticated',
          userId: user.id,
          role: user.role,
        });

        if (!user.sessionId) {
          logger.warn({ type: 'context_missing_local_session', userId: user.id });
          await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
          user = null;
        }

        if (user?.sessionId) {
          const activeSession = await prisma.session.findFirst({
            where: { id: user.sessionId, userId: user.id, expiresAt: { gte: new Date() } },
            select: {
              id: true,
              expiresAt: true,
              user: { select: { accountStatus: true, deletedAt: true } },
            },
          });

          if (!activeSession || activeSession.user.deletedAt || activeSession.user.accountStatus !== 'active') {
            logger.warn({ type: 'context_local_session_revoked', userId: user.id, sessionId: user.sessionId });
            await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
            user = null;
          } else {
            user.sessionExpiresAt = activeSession.expiresAt.getTime();
          }
        }

        // -- B6: Enforce Session.expiresAt stored in Redis cache ----------
        if (user?.sessionExpiresAt && Date.now() > user.sessionExpiresAt) {
          logger.warn({
            type:   'context_session_expired',
            userId: user.id,
            expiredAt: new Date(user.sessionExpiresAt).toISOString(),
          });
          user = null;
        }

        // -- B3: Idle session timeout (30 min) ----------------------------
        if (user) {
          const idleUserId = user.id; // captured before any nulling inside try/catch
          const now = Date.now();
          try {
            const lastSeenRaw = await redis.get<string>(lastSeenKey(idleUserId));
            const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : null;

            if (lastSeen !== null && (now - lastSeen) > SESSION_CONFIG.IDLE_TIMEOUT_SECONDS * 1000) {
              logger.warn({
                type:         'context_idle_session_expired',
                userId:       idleUserId,
                idleSeconds:  Math.floor((now - lastSeen) / 1000),
              });
              // Evict Redis user cache so the next request also sees null
              await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
              user = null;
            } else {
              // Slide the window  -  fire-and-forget, never block the request
              void redis.set(lastSeenKey(idleUserId), String(now), {
                ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS,
              }).catch(() => {});
            }
          } catch (idleErr: unknown) {
            // Redis error on idle check: fail open (log + continue)
            logger.warn({
              type:  'context_idle_check_error',
              userId: idleUserId,
              error: idleErr instanceof Error ? idleErr.message : String(idleErr),
            });
          }
        }

        // -- B5: Session fingerprint anomaly detection --------------------
        // Compute the expected fingerprint and compare with what was stored
        // at login. Mode `off` skips this section entirely. Mode `monitor`
        // records mismatches without revocation. Mode `enforce` adds the JTI
        // to the Redis blocklist and rejects the request (user = null).
        if (user && user.role === 'ADMIN' && SESSION_FINGERPRINT_MODE === 'monitor') {
          logger.info({
            type: 'session_fingerprint_role_upgrade',
            userId: user.id,
            role: user.role,
            fromMode: SESSION_FINGERPRINT_MODE,
            toMode: 'enforce',
          });
        }

        if (user && user.sessionId) {
          const effectiveFingerprintMode = resolveEffectiveFingerprintMode(user);
          if (effectiveFingerprintMode !== 'off') {
            try {
              const storedFp = await redis.get<string>(`sheriabot:session_fingerprint:${user.sessionId}`);
              if (storedFp) {
                const currentIp = req.ip ?? '';
                const currentUa = (req.headers['user-agent'] ?? '').substring(0, 500);
                const currentFp = createHash('sha256').update(`${currentIp}:${currentUa}`).digest('hex');
                if (currentFp !== storedFp) {
                  const bearerToken = req.headers.authorization?.substring(7);
                  const jti = bearerToken ? extractJti(bearerToken) : null;
                  const exp = bearerToken ? extractExp(bearerToken) : null;
                  const anomalyType = effectiveFingerprintMode === 'enforce'
                    ? 'session_anomaly_blocked'
                    : 'session_anomaly_monitored';

                  logger.warn({
                    type:            anomalyType,
                    event:           anomalyType,
                    userId:          user.id,
                    sessionId:       user.sessionId,
                    jti,
                    // Do not log raw UAs in production; hashes are sufficient for correlation
                    storedFpPrefix:  storedFp.substring(0, 8),
                    currentFpPrefix: currentFp.substring(0, 8),
                    timestamp:       new Date().toISOString(),
                    mode:            effectiveFingerprintMode,
                  });

                  if (effectiveFingerprintMode === 'enforce') {
                    // Revoke the JTI so this token cannot be replayed on any subsequent request.
                    // TTL = remaining token lifetime (capped at 2 hours, same as revokeToken util).
                    if (jti) {
                      const ttlSeconds = exp
                        ? Math.min(Math.max(exp - Math.floor(Date.now() / 1000), 1), 7200)
                        : 3600;
                      await redis.set(revokedJtiKey(jti), 'session_anomaly', { ex: ttlSeconds })
                        .catch((revErr: unknown) => {
                          logger.error({
                            type:  'session_anomaly_blocklist_write_failed',
                            userId: user!.id,
                            jti,
                            error: revErr instanceof Error ? revErr.message : String(revErr),
                          });
                        });
                    }
                    // Evict the user session cache so the next request also sees null
                    await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
                    user = null;
                  }
                }
              }
            } catch (fpErr: unknown) {
              logger.warn({
                type:  'context_fingerprint_check_error',
                userId: user?.id,
                error: fpErr instanceof Error ? fpErr.message : String(fpErr),
              });
            }
          }
        }
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
