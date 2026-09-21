import { redis } from '@/lib/redis/client';

export const PASSKEY_RATE_LIMITS = {
  registrationOptions: { max: 10, windowSec: 3600 }, // per userId
  registrationVerify: { max: 10, windowSec: 3600 }, // per userId
  authOptions: { max: 30, windowSec: 900 }, // per IP
  authVerify: { max: 5, windowSec: 300 }, // per challenge (single-use)
} as const;

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
}

/**
 * Atomic sliding-counter rate limiter using Redis INCR + EXPIRE.
 */
export async function checkRateLimit(params: CheckRateLimitParams): Promise<CheckRateLimitResult> {
  const { key, max, windowSec } = params;

  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }

    const allowed = current <= max;
    const remaining = Math.max(0, max - current);

    return { allowed, remaining };
  } catch (error) {
    // If Redis fails, fail closed for security
    return { allowed: false, remaining: 0 };
  }
}
