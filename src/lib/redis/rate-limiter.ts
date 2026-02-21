import { redis } from './client';
import { redisConfig, getRateLimitKey } from '@/config/redis.config';
import { logger } from '@/utils/logger';
import { TooManyRequestsError } from '@/utils/error';

/**
 * Rate limit result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  max: number;
  window: number; // seconds
  identifier: string;
  action: string;
}

/**
 * Rate limiter service using sliding window algorithm
 * More accurate than fixed window, prevents bursts at window boundaries
 */
export class RateLimiter {
  /**
   * Check if request is allowed under rate limit
   * Uses sliding window algorithm with sorted sets
   * 
   * @param identifier User ID, IP address, or other identifier
   * @param action Action being rate limited (e.g., 'login', 'api')
   * @param max Maximum requests allowed
   * @param windowSeconds Time window in seconds
   * @returns Rate limit result
   */
  async check(
    identifier: string,
    action: string,
    max: number,
    windowSeconds: number
  ): Promise<RateLimitResult> {
    const key = getRateLimitKey(identifier, action);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    try {
      // Use Redis pipeline for atomic operations
      const pipeline = redis.pipeline();

      // 1. Remove old entries outside the window
      pipeline.zremrangebyscore(key, 0, windowStart);

      // 2. Count requests in current window
      pipeline.zcard(key);

      // 3. Add current request timestamp
      pipeline.zadd(key, now, `${now}`);

      // 4. Set expiration on key
      pipeline.expire(key, windowSeconds);

      const results = await pipeline.exec();

      // Extract count from results (second operation)
      const count = (results?.[1]?.[1] as number) || 0;

      const allowed = count < max;
      const remaining = Math.max(0, max - count - 1);

      // Calculate reset time
      const oldestTimestamp = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const oldestTime = oldestTimestamp.length > 1 
        ? parseInt(oldestTimestamp[1]) 
        : now;
      const resetAt = new Date(oldestTime + windowSeconds * 1000);

      const result: RateLimitResult = {
        allowed,
        remaining,
        resetAt,
      };

      if (!allowed) {
        const retryAfter = Math.ceil((resetAt.getTime() - now) / 1000);
        result.retryAfter = retryAfter;

        logger.warn({
          type: 'rate_limit_exceeded',
          identifier,
          action,
          count,
          max,
          retryAfter,
        });
      }

      return result;
    } catch (error: any) {
      logger.error({
        type: 'rate_limit_check_error',
        identifier,
        action,
        error: error.message,
      });

      // On error, allow request (fail open)
      return {
        allowed: true,
        remaining: max,
        resetAt: new Date(now + windowSeconds * 1000),
      };
    }
  }

  /**
   * Check and throw error if rate limit exceeded
   * Convenience method for middleware
   */
  async checkOrThrow(
    identifier: string,
    action: string,
    max: number,
    windowSeconds: number
  ): Promise<void> {
    const result = await this.check(identifier, action, max, windowSeconds);

    if (!result.allowed) {
      throw new TooManyRequestsError(
        `Rate limit exceeded. Try again in ${result.retryAfter} seconds`,
        result.retryAfter
      );
    }
  }

  /**
   * Get remaining requests for identifier
   */
  async getRemaining(
    identifier: string,
    action: string,
    max: number,
    windowSeconds: number
  ): Promise<number> {
    const key = getRateLimitKey(identifier, action);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    try {
      // Remove old entries and count
      await redis.zremrangebyscore(key, 0, windowStart);
      const count = await redis.zcard(key);

      return Math.max(0, max - count);
    } catch (error: any) {
      logger.error({
        type: 'rate_limit_remaining_error',
        identifier,
        action,
        error: error.message,
      });
      return max;
    }
  }

  /**
   * Reset rate limit for identifier
   * Useful for testing or after manual review
   */
  async reset(identifier: string, action: string): Promise<void> {
    const key = getRateLimitKey(identifier, action);

    try {
      await redis.del(key);
      
      logger.info({
        type: 'rate_limit_reset',
        identifier,
        action,
      });
    } catch (error: any) {
      logger.error({
        type: 'rate_limit_reset_error',
        identifier,
        action,
        error: error.message,
      });
    }
  }

  /**
   * Block identifier temporarily
   * Used for security incidents or abuse
   */
  async block(
    identifier: string,
    action: string,
    durationSeconds: number
  ): Promise<void> {
    const blockKey = `${getRateLimitKey(identifier, action)}:blocked`;

    try {
      await redis.setex(blockKey, durationSeconds, '1');
      
      logger.warn({
        type: 'rate_limit_blocked',
        identifier,
        action,
        duration: durationSeconds,
      });
    } catch (error: any) {
      logger.error({
        type: 'rate_limit_block_error',
        identifier,
        action,
        error: error.message,
      });
    }
  }

  /**
   * Check if identifier is blocked
   */
  async isBlocked(identifier: string, action: string): Promise<boolean> {
    const blockKey = `${getRateLimitKey(identifier, action)}:blocked`;

    try {
      const blocked = await redis.exists(blockKey);
      return blocked === 1;
    } catch (error: any) {
      logger.error({
        type: 'rate_limit_isBlocked_error',
        identifier,
        action,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Unblock identifier
   */
  async unblock(identifier: string, action: string): Promise<void> {
    const blockKey = `${getRateLimitKey(identifier, action)}:blocked`;

    try {
      await redis.del(blockKey);
      
      logger.info({
        type: 'rate_limit_unblocked',
        identifier,
        action,
      });
    } catch (error: any) {
      logger.error({
        type: 'rate_limit_unblock_error',
        identifier,
        action,
        error: error.message,
      });
    }
  }
}

/**
 * Export singleton rate limiter instance
 */
export const rateLimiter = new RateLimiter();

/**
 * Predefined rate limiters for common actions
 */

/**
 * Authentication rate limiting
 */
export const authRateLimiter = {
  /**
   * Login attempts
   * 5 attempts per 15 minutes per IP/email
   */
  login: async (identifier: string) => {
    const config = redisConfig.rateLimiting.tiers.auth.login;
    return rateLimiter.check(identifier, 'login', config.max, config.window);
  },

  /**
   * Registration attempts
   * 3 attempts per hour per IP
   */
  register: async (identifier: string) => {
    const config = redisConfig.rateLimiting.tiers.auth.register;
    return rateLimiter.check(identifier, 'register', config.max, config.window);
  },

  /**
   * Password reset attempts
   * 3 attempts per hour per email
   */
  resetPassword: async (identifier: string) => {
    const config = redisConfig.rateLimiting.tiers.auth.resetPassword;
    return rateLimiter.check(identifier, 'reset-password', config.max, config.window);
  },
};

/**
 * API rate limiting
 */
export const apiRateLimiter = {
  /**
   * Default API rate limit
   * 100 requests per 15 minutes per user
   */
  default: async (userId: string) => {
    const config = redisConfig.rateLimiting.tiers.api.default;
    return rateLimiter.check(userId, 'api', config.max, config.window);
  },

  /**
   * Policy generation rate limit
   * 10 generations per hour per user (expensive operation)
   */
  policyGeneration: async (userId: string) => {
    const config = redisConfig.rateLimiting.tiers.api.policyGeneration;
    return rateLimiter.check(userId, 'policy-generation', config.max, config.window);
  },

  /**
   * Compliance query rate limit
   * 50 queries per hour per user
   */
  complianceQuery: async (userId: string) => {
    const config = redisConfig.rateLimiting.tiers.api.complianceQuery;
    return rateLimiter.check(userId, 'compliance-query', config.max, config.window);
  },

  /**
   * Document upload rate limit
   * 20 uploads per hour per user
   */
  upload: async (userId: string) => {
    const config = redisConfig.rateLimiting.tiers.api.upload;
    return rateLimiter.check(userId, 'upload', config.max, config.window);
  },
};

/**
 * Global rate limiting (across all users)
 */
export const globalRateLimiter = {
  /**
   * Global API rate limit
   * 1000 requests per minute across all users
   */
  check: async () => {
    const config = redisConfig.rateLimiting.tiers.global;
    return rateLimiter.check('global', 'api', config.max, config.window);
  },
};

/**
 * Rate limit middleware helper
 * Returns rate limit headers for HTTP responses
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.remaining.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.resetAt.toISOString(),
    ...(result.retryAfter && {
      'Retry-After': result.retryAfter.toString(),
    }),
  };
}

/**
 * Sliding window counter implementation (alternative simpler approach)
 * Uses simple counter with expiration
 */
export class SimpleRateLimiter {
  async check(
    identifier: string,
    action: string,
    max: number,
    windowSeconds: number
  ): Promise<RateLimitResult> {
    const key = getRateLimitKey(identifier, action);

    try {
      // Increment counter
      const count = await redis.incr(key);

      // Set expiration on first request
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      const allowed = count <= max;
      const remaining = Math.max(0, max - count);

      // Get TTL for reset time
      const ttl = await redis.ttl(key);
      const resetAt = new Date(Date.now() + ttl * 1000);

      const result: RateLimitResult = {
        allowed,
        remaining,
        resetAt,
      };

      if (!allowed) {
        result.retryAfter = ttl;
      }

      return result;
    } catch (error: any) {
      logger.error({
        type: 'simple_rate_limit_error',
        identifier,
        action,
        error: error.message,
      });

      // Fail open
      return {
        allowed: true,
        remaining: max,
        resetAt: new Date(Date.now() + windowSeconds * 1000),
      };
    }
  }
}

export const simpleRateLimiter = new SimpleRateLimiter();