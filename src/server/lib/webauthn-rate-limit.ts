import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export function getAuthOptionsRateLimits() {
  const max = Number(process.env.WEBAUTHN_AUTH_OPTS_RATE_LIMIT_MAX) || 30;
  const windowSec = Number(process.env.WEBAUTHN_AUTH_OPTS_RATE_LIMIT_WINDOW_SECONDS) || 900;
  return { max, windowSec };
}

export const PASSKEY_RATE_LIMITS = {
  registrationOptions: { max: 10, windowSec: 3600 }, // per userId
  registrationVerify: { max: 10, windowSec: 3600 }, // per userId
  get authOptions() {
    return getAuthOptionsRateLimits();
  },
  authVerify: { max: 5, windowSec: 300 }, // per challenge (single-use)
};

export const PASSKEY_REDIS_KEYS = {
  regOptionsRateLimit: (userId: string) => `sheriabot:passkey:rl:reg_opts:${userId}`,
  regVerifyRateLimit: (userId: string) => `sheriabot:passkey:rl:reg_verify:${userId}`,
  authOptionsRateLimit: (ip: string) => `sheriabot:passkey:rl:auth_opts:${ip}`,
  authVerifyRateLimit: (challengeId: string) => `sheriabot:passkey:rl:auth_verify:${challengeId}`,
  regChallenge: (userId: string) => `sheriabot:passkey:reg_challenge:${userId}`,
  authChallenge: (challengeId: string) => `sheriabot:passkey:auth_challenge:${challengeId}`,
} as const;

export interface CheckRateLimitParams {
  key: string;
  max: number;
  windowSec: number;
}

export interface CheckRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Builds a rate limit key for passkey authentication options.
 * - If IP is valid: returns 'sheriabot:passkey:rl:auth_opts:<ip>'
 * - If sessionIdentifier is provided: appends truncated SHA-256 hash to reduce NAT collateral
 * - If IP is null or invalid: returns null (fail closed)
 */
export function buildAuthOptionsRateLimitKey(params: {
  ip: string | null | undefined;
  sessionIdentifier?: string | null;
}): string | null {
  const { ip, sessionIdentifier } = params;
  if (!ip || typeof ip !== 'string') return null;

  const trimmed = ip.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;

  const ipVer = isIP(trimmed);
  if (ipVer !== 4 && ipVer !== 6) return null;

  let key = `sheriabot:passkey:rl:auth_opts:${trimmed}`;
  if (sessionIdentifier && typeof sessionIdentifier === 'string' && sessionIdentifier.trim()) {
    const sessionHash = createHash('sha256')
      .update(sessionIdentifier.trim())
      .digest('hex')
      .slice(0, 16);
    key = `${key}:${sessionHash}`;
  }

  return key;
}

/**
 * Atomic sliding-counter rate limiter using Redis INCR + EXPIRE.
 */
export async function checkRateLimit(params: CheckRateLimitParams): Promise<CheckRateLimitResult> {
  const { key, max, windowSec } = params;
  const resetAt = Math.floor(Date.now() / 1000) + windowSec;

  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    const allowed = current <= max;
    const remaining = Math.max(0, max - current);

    return { allowed, remaining, resetAt };
  } catch (error) {
    logger.error({
      type: 'redis_rate_limit_error',
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    // If Redis fails, fail closed for security
    return { allowed: false, remaining: 0, resetAt };
  }
}

/**
 * Rate limiter specifically for passkey authentication options with safe IP/session keying.
 */
export async function checkAuthOptionsRateLimit(params: {
  ip: string | null | undefined;
  sessionIdentifier?: string | null;
}): Promise<CheckRateLimitResult> {
  const { max, windowSec } = getAuthOptionsRateLimits();
  const resetAt = Math.floor(Date.now() / 1000) + windowSec;
  const key = buildAuthOptionsRateLimitKey(params);

  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn({
        type: 'auth_options_rate_limit_missing_ip_denied',
        message: 'Missing or invalid client IP in production; failing closed.',
      });
      return { allowed: false, remaining: 0, resetAt };
    }
    logger.warn({
      type: 'auth_options_rate_limit_missing_ip_non_prod_allowed',
      message: 'Missing or invalid client IP in non-production environment; allowed with warning.',
    });
    return { allowed: true, remaining: max, resetAt };
  }

  return checkRateLimit({
    key,
    max,
    windowSec,
  });
}
