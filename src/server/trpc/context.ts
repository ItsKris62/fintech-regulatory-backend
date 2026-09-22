import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
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
import { nanoid } from 'nanoid';
import { appConfig } from '@/config/app.config';
import { SESSION_CONFIG, lastSeenKey, sessionStartKey } from '@/config/session';
import { revokedBearerTokenKey } from '@/utils/request-identifiers';
import { parseDeviceLabel } from '@/server/services/session.service';
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
  hasPasskey?: boolean;
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
  mfaEnforcement?: {
    state: 'grace' | 'enforced';
    deadline?: Date;
  };
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

/** Feature flags for context optimization and session LRU */
export const FEATURE_FLAG_CONTEXT_FAST_PATH = process.env.ENABLE_CONTEXT_FAST_PATH !== 'false';
export const FEATURE_FLAG_SESSION_LRU = process.env.ENABLE_SESSION_LRU !== 'false';

/** Production observability metrics counters */
export const contextMetrics = {
  memoryHits: 0,
  redisHits: 0,
  dbMisses: 0,
  expiredTokens: 0,
  signatureMismatches: 0,
  hardRejections: 0,
  fallbackToGetUser: 0,
  totalRequests: 0,
  reset() {
    this.memoryHits = 0;
    this.redisHits = 0;
    this.dbMisses = 0;
    this.expiredTokens = 0;
    this.signatureMismatches = 0;
    this.hardRejections = 0;
    this.fallbackToGetUser = 0;
    this.totalRequests = 0;
  },
};

// -----------------------------------------------------------------------------
// Fast-path in-process memory cache for hot user sessions (15–30s TTL)
// -----------------------------------------------------------------------------
interface MemorySessionCacheEntry {
  user: User;
  cachedAt: number;
}

const IN_MEMORY_SESSION_TTL_MS = 20_000; // 20s TTL
const MAX_IN_MEMORY_SESSIONS = 2000;
const inMemorySessionCache = new Map<string, MemorySessionCacheEntry>();

export function getInMemoryUserSession(supabaseUserId: string): User | null {
  if (!FEATURE_FLAG_SESSION_LRU) return null;
  const entry = inMemorySessionCache.get(supabaseUserId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > IN_MEMORY_SESSION_TTL_MS) {
    inMemorySessionCache.delete(supabaseUserId);
    return null;
  }
  return entry.user;
}

export function setInMemoryUserSession(supabaseUserId: string, user: User): void {
  if (!FEATURE_FLAG_SESSION_LRU) return;
  if (inMemorySessionCache.size >= MAX_IN_MEMORY_SESSIONS) {
    const oldestKey = inMemorySessionCache.keys().next().value;
    if (oldestKey) inMemorySessionCache.delete(oldestKey);
  }
  inMemorySessionCache.set(supabaseUserId, { user, cachedAt: Date.now() });
}

export function evictInMemoryUserSession(supabaseUserId: string): void {
  inMemorySessionCache.delete(supabaseUserId);
}

import {
  createRemoteJWKSet,
  jwtVerify,
  decodeProtectedHeader,
  errors as joseErrors,
  type JWTVerifyGetKey,
} from 'jose';

let cachedJwks: JWTVerifyGetKey | null = null;
let cachedJwksUrl: string | null = null;

export function getSupabaseJwks(): JWTVerifyGetKey | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;

  const jwksUrl = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  if (cachedJwks && cachedJwksUrl === jwksUrl) {
    return cachedJwks;
  }

  try {
    cachedJwks = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
    cachedJwksUrl = jwksUrl;
    return cachedJwks;
  } catch (err: unknown) {
    logger.warn({
      type: 'context_jwks_init_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function resetJwksCacheForTest(): void {
  cachedJwks = null;
  cachedJwksUrl = null;
}

// -----------------------------------------------------------------------------
// Fast-path Local JWT Verification with Strict Hard-Rejection
// -----------------------------------------------------------------------------
export interface SupabaseJwtPayload extends jwt.JwtPayload {
  sub: string;
  email?: string;
  role?: string;
}

export type LocalJwtVerificationResult =
  | { status: 'VALID'; payload: SupabaseJwtPayload }
  | {
      status: 'HARD_REJECT';
      reason: string;
      rejectionType: 'EXPIRED' | 'SIGNATURE_MISMATCH' | 'MALFORMED';
    }
  | { status: 'FALLBACK_REQUIRED'; reason: string };

/**
 * Fast-path local cryptographic verification of Supabase access tokens:
 * - Asymmetric ES256 / RS256 via cached remote JWKS
 * - Symmetric HS256 via SUPABASE_JWT_SECRET
 *
 * Security & Compliance Invariants:
 * 1. Hard-rejects immediately on signature failure, token expiration, or malformed claims.
 *    Fallback to supabaseAdmin.auth.getUser() is STRICTLY FORBIDDEN to prevent forged tokens.
 * 2. Fallback to Supabase Auth API is permitted ONLY on unknown key IDs during rotation
 *    (JWKSNoMatchingKey) or network fetch degradation.
 */
export async function verifySupabaseTokenLocally(token: string): Promise<LocalJwtVerificationResult> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { status: 'HARD_REJECT', reason: 'MALFORMED_JWT', rejectionType: 'MALFORMED' };
  }

  const alg = header.alg;
  if (!alg) {
    return { status: 'HARD_REJECT', reason: 'MISSING_ALG_HEADER', rejectionType: 'MALFORMED' };
  }

  // 1. Symmetric HS256 tokens (HMAC secret)
  if (alg === 'HS256') {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      return { status: 'FALLBACK_REQUIRED', reason: 'SUPABASE_JWT_SECRET_ABSENT' };
    }

    try {
      const verified = jwt.verify(token, secret, {
        algorithms: ['HS256'],
      }) as SupabaseJwtPayload;

      if (verified && typeof verified === 'object' && typeof verified.sub === 'string') {
        return { status: 'VALID', payload: verified };
      }

      return { status: 'HARD_REJECT', reason: 'MISSING_SUB_CLAIM', rejectionType: 'MALFORMED' };
    } catch (err: any) {
      if (err instanceof jwt.TokenExpiredError || err?.name === 'TokenExpiredError') {
        return {
          status: 'HARD_REJECT',
          reason: err.message || 'jwt expired',
          rejectionType: 'EXPIRED',
        };
      }
      return {
        status: 'HARD_REJECT',
        reason: err?.message || 'JWT_SIGNATURE_VERIFICATION_FAILED',
        rejectionType: 'SIGNATURE_MISMATCH',
      };
    }
  }

  // 2. Asymmetric ES256 / RS256 tokens (Supabase Auth v2 default)
  const jwks = getSupabaseJwks();
  if (!jwks) {
    return { status: 'FALLBACK_REQUIRED', reason: 'SUPABASE_JWKS_NOT_CONFIGURED' };
  }

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const expectedIssuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
    });

    if (payload && typeof payload.sub === 'string') {
      return {
        status: 'VALID',
        payload: {
          sub: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : undefined,
          role: typeof payload.role === 'string' ? payload.role : undefined,
          aud: payload.aud,
          iss: payload.iss,
          exp: payload.exp,
          iat: payload.iat,
          jti: typeof payload.jti === 'string' ? payload.jti : undefined,
        },
      };
    }
    return { status: 'HARD_REJECT', reason: 'MISSING_SUB_CLAIM', rejectionType: 'MALFORMED' };
  } catch (err: any) {
    if (err instanceof joseErrors.JWTExpired || err?.code === 'ERR_JWT_EXPIRED') {
      return {
        status: 'HARD_REJECT',
        reason: err.message || 'jwt expired',
        rejectionType: 'EXPIRED',
      };
    }
    if (err instanceof joseErrors.JWKSNoMatchingKey || err?.code === 'ERR_JWKS_NO_MATCHING_KEY') {
      return {
        status: 'FALLBACK_REQUIRED',
        reason: 'JWKS_NO_MATCHING_KEY_ROTATION',
      };
    }
    if (
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JWTInvalid ||
      err instanceof joseErrors.JWTClaimValidationFailed ||
      err?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
      err?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED'
    ) {
      return {
        status: 'HARD_REJECT',
        reason: err.message || 'JWT_SIGNATURE_VERIFICATION_FAILED',
        rejectionType: 'SIGNATURE_MISMATCH',
      };
    }

    return {
      status: 'FALLBACK_REQUIRED',
      reason: err?.message || 'JWKS_VERIFICATION_ERROR',
    };
  }
}

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
 * High-Performance Auth Flow:
 * 1. Extract Bearer token from Authorization header.
 * 2. If feature flag enabled: verify locally via HS256 JWT verification (<2ms).
 *    Hard-rejects on invalid signature/expiry.
 *    Fallback to supabaseAdmin.auth.getUser() ONLY when secret is absent or alg !== HS256.
 * 3. Check in-process LRU memory cache first.
 * 4. Run token revocation, Redis session cache, and idle checks concurrently via Promise.all.
 * 5. On cache hit, bypass redundant Prisma session queries.
 */
export async function createContext({
  req,
  res,
}: {
  req: FastifyRequest;
  res: FastifyReply;
}): Promise<Context> {
  contextMetrics.totalRequests++;

  const authHeader = req.headers.authorization;
  let user: User | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    try {
      let supabaseUserId: string | null = null;

      if (FEATURE_FLAG_CONTEXT_FAST_PATH) {
        const localCheck = await verifySupabaseTokenLocally(token);
        if (localCheck.status === 'VALID') {
          supabaseUserId = localCheck.payload.sub;
        } else if (localCheck.status === 'HARD_REJECT') {
          contextMetrics.hardRejections++;
          if (localCheck.rejectionType === 'EXPIRED') {
            contextMetrics.expiredTokens++;
            logger.info({
              type: 'context_jwt_token_expired',
              reason: localCheck.reason,
              ip: req.ip,
            });
          } else {
            contextMetrics.signatureMismatches++;
            logger.warn({
              type: 'context_jwt_signature_mismatch',
              reason: localCheck.reason,
              rejectionType: localCheck.rejectionType,
              ip: req.ip,
            });
          }
          throw new Error(`Invalid token: ${localCheck.reason}`);
        } else {
          // Fallback permitted only when secret is missing or algorithm is non-HS256
          contextMetrics.fallbackToGetUser++;
          logger.info({
            type: 'context_fallback_to_supabase_getuser',
            reason: localCheck.reason,
          });
          const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
          if (authError || !authData?.user?.id) {
            throw new Error(authError?.message ?? 'Invalid token');
          }
          supabaseUserId = authData.user.id;
        }
      } else {
        contextMetrics.fallbackToGetUser++;
        const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !authData?.user?.id) {
          throw new Error(authError?.message ?? 'Invalid token');
        }
        supabaseUserId = authData.user.id;
      }

      // Check in-process memory cache
      const memCachedUser = getInMemoryUserSession(supabaseUserId);
      const cacheKey = `user:session:${supabaseUserId}`;

      // Parallelize revocation checks, user cache retrieval, and auxiliary reads
      let isRevoked = false;
      let isBearerRevoked = false;
      let lastSeenVal: string | null = null;
      let storedFingerprint: string | null = null;

      if (memCachedUser) {
        contextMetrics.memoryHits++;
        user = memCachedUser;
        const [revokedCheck, bearerRevokedCheck, lastSeenCheck, fpCheck] = await Promise.all([
          isTokenRevoked(token, supabaseUserId),
          redis.exists(revokedBearerTokenKey(token)).catch(() => 0),
          redis.get<string>(lastSeenKey(memCachedUser.id)).catch(() => null),
          memCachedUser.sessionId
            ? redis.get<string>(`sheriabot:session_fingerprint:${memCachedUser.sessionId}`).catch(() => null)
            : Promise.resolve(null),
        ]);

        isRevoked = revokedCheck;
        isBearerRevoked = bearerRevokedCheck === 1;
        lastSeenVal = lastSeenCheck;
        storedFingerprint = fpCheck;
      } else {
        const [revokedCheck, bearerRevokedCheck, redisUser] = await Promise.all([
          isTokenRevoked(token, supabaseUserId),
          redis.exists(revokedBearerTokenKey(token)).catch(() => 0),
          redis.get<User>(cacheKey).catch((cacheErr: any) => {
            logger.warn({
              type: 'context_cache_parse_error',
              supabaseUserId,
              error: cacheErr.message,
              action: 'falling_through_to_prisma',
            });
            return null;
          }),
        ]);

        isRevoked = revokedCheck;
        isBearerRevoked = bearerRevokedCheck === 1;
        if (redisUser && typeof redisUser === 'object') {
          contextMetrics.redisHits++;
          user = redisUser;
          setInMemoryUserSession(supabaseUserId, redisUser);
        }
      }

      // Enforce token revocation - always checked against distributed Redis
      if (isRevoked || isBearerRevoked) {
        user = null;
        evictInMemoryUserSession(supabaseUserId);
        await redis.del(cacheKey).catch(() => {});
        throw new Error('Token has been revoked');
      }

      // Database fallback on cache miss
      if (!user) {
        contextMetrics.dbMisses++;
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
            passkeys: {
              select: { id: true },
              take: 1,
            },
          },
        });

        if (
          dbUser &&
          dbUser.supabaseAuthId &&
          !dbUser.deletedAt &&
          dbUser.accountStatus === 'active'
        ) {
          let effectiveSession = await prisma.session.findFirst({
            where: { userId: dbUser.id, expiresAt: { gte: new Date() } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, expiresAt: true },
          });

          if (!effectiveSession && appConfig.features.autoCreateSessionOnValidToken) {
            try {
              const rawUa = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
              const forwardedFor = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0]?.trim() : undefined;
              const loginIp = req.ip || forwardedFor || 'Unknown';
              const sessionTtlSeconds = SESSION_CONFIG.ABSOLUTE_TIMEOUT_SECONDS;
              
              const newSession = await prisma.session.create({
                data: {
                  userId: dbUser.id,
                  token: nanoid(64),
                  expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000),
                  device: parseDeviceLabel(rawUa),
                  ipAddress: loginIp,
                  userAgent: rawUa ? rawUa.substring(0, 500) : null,
                },
                select: { id: true, expiresAt: true },
              });
              effectiveSession = newSession;

              const loginNow = Date.now();
              await Promise.all([
                redis.set(lastSeenKey(dbUser.id), String(loginNow), { ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS }),
                redis.set(sessionStartKey(dbUser.id), String(loginNow), { ex: sessionTtlSeconds }),
              ]).catch(() => {});

              if (newSession.id) {
                const fingerprint = createHash('sha256').update(`${req.ip || ''}:${rawUa.substring(0, 500)}`).digest('hex');
                await redis
                  .set(`sheriabot:session_fingerprint:${newSession.id}`, fingerprint, { ex: sessionTtlSeconds })
                  .catch(() => {});
              }

              logger.info({ type: 'context_session_auto_healed', userId: dbUser.id, sessionId: newSession.id });
            } catch (healErr: any) {
              logger.warn({ type: 'context_session_auto_heal_failed', userId: dbUser.id, error: healErr?.message });
            }
          }

          if (!effectiveSession) {
            logger.warn({ type: 'context_no_active_local_session', userId: dbUser.id });
            await redis.del(cacheKey).catch(() => {});
          } else {
            user = {
              id: dbUser.id,
              email: dbUser.email,
              role: dbUser.role,
              organizationId: dbUser.organizationId ?? undefined,
              supabaseAuthId: dbUser.supabaseAuthId,
              mustChangePassword: dbUser.mustChangePassword,
              totpEnabled: dbUser.totpEnabled,
              hasPasskey: (dbUser.passkeys && dbUser.passkeys.length > 0) || false,
              sessionId: effectiveSession.id,
              sessionExpiresAt: effectiveSession.expiresAt.getTime(),
            };

            // Populate both Redis and in-memory caches
            setInMemoryUserSession(supabaseUserId, user);
            await redis.set(cacheKey, JSON.stringify(user), { ex: USER_CACHE_TTL_SECONDS }).catch(() => {});
          }
        }
      }

      if (user) {
        // Enforce session validity
        if (!user.sessionId) {
          logger.warn({ type: 'context_missing_local_session', userId: user.id });
          evictInMemoryUserSession(supabaseUserId);
          await redis.del(cacheKey).catch(() => {});
          user = null;
        }

        // B6: Enforce Session.expiresAt stored in session cache
        if (user?.sessionExpiresAt && Date.now() > user.sessionExpiresAt) {
          logger.warn({
            type: 'context_session_expired',
            userId: user.id,
            expiredAt: new Date(user.sessionExpiresAt).toISOString(),
          });
          evictInMemoryUserSession(supabaseUserId);
          await redis.del(cacheKey).catch(() => {});
          user = null;
        }

        // B3: Idle session timeout (30 min)
        if (user) {
          const idleUserId = user.id;
          const now = Date.now();
          try {
            const rawLastSeen = lastSeenVal !== null
              ? lastSeenVal
              : await redis.get<string>(lastSeenKey(idleUserId));
            const lastSeen = rawLastSeen ? Number(rawLastSeen) : null;

            if (lastSeen !== null && (now - lastSeen) > SESSION_CONFIG.IDLE_TIMEOUT_SECONDS * 1000) {
              logger.warn({
                type: 'context_idle_session_expired',
                userId: idleUserId,
                idleSeconds: Math.floor((now - lastSeen) / 1000),
              });
              evictInMemoryUserSession(user.supabaseAuthId);
              await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
              user = null;
            } else {
              // Slide the idle window asynchronously without blocking
              void redis.set(lastSeenKey(idleUserId), String(now), {
                ex: SESSION_CONFIG.IDLE_TIMEOUT_SECONDS,
              }).catch(() => {});
            }
          } catch (idleErr: unknown) {
            logger.warn({
              type: 'context_idle_check_error',
              userId: idleUserId,
              error: idleErr instanceof Error ? idleErr.message : String(idleErr),
            });
          }
        }

        // B5: Session fingerprint anomaly detection
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
              const storedFp = storedFingerprint !== null
                ? storedFingerprint
                : await redis.get<string>(`sheriabot:session_fingerprint:${user.sessionId}`);

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
                    type: anomalyType,
                    event: anomalyType,
                    userId: user.id,
                    sessionId: user.sessionId,
                    jti,
                    storedFpPrefix: storedFp.substring(0, 8),
                    currentFpPrefix: currentFp.substring(0, 8),
                    timestamp: new Date().toISOString(),
                    mode: effectiveFingerprintMode,
                  });

                  if (effectiveFingerprintMode === 'enforce') {
                    if (jti) {
                      const ttlSeconds = exp
                        ? Math.min(Math.max(exp - Math.floor(Date.now() / 1000), 1), 7200)
                        : 3600;
                      await redis.set(revokedJtiKey(jti), 'session_anomaly', { ex: ttlSeconds })
                        .catch((revErr: unknown) => {
                          logger.error({
                            type: 'session_anomaly_blocklist_write_failed',
                            userId: user!.id,
                            jti,
                            error: revErr instanceof Error ? revErr.message : String(revErr),
                          });
                        });
                    }
                    evictInMemoryUserSession(user.supabaseAuthId);
                    await redis.del(`user:session:${user.supabaseAuthId}`).catch(() => {});
                    user = null;
                  }
                }
              }
            } catch (fpErr: unknown) {
              logger.warn({
                type: 'context_fingerprint_check_error',
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
