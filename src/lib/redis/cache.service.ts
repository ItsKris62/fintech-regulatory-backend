import { redis } from './client';
import { redisConfig, getTTL } from '@/config/redis.config';
import { logger, logPerformance } from '@/utils/logger';

/**
 * High-level cache service with typed methods
 * Handles JSON serialization and cache-aside pattern
 */
export class CacheService {
  /**
   * Get cached value with automatic JSON parsing
   * @param key Cache key
   * @returns Parsed value or null
   */
  async get<T>(key: string): Promise<T | null> {
    const startTime = Date.now();

    try {
      const cached = await redis.get(key);

      if (!cached) {
        logPerformance('cache_miss', startTime, { key });
        return null;
      }

      const parsed = JSON.parse(cached) as T;
      logPerformance('cache_hit', startTime, { key });
      
      return parsed;
    } catch (error: any) {
      logger.error({
        type: 'cache_get_error',
        key,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Set cached value with automatic JSON serialization
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time to live in seconds (optional)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      
      if (ttl) {
        await redis.setex(key, ttl, serialized);
      } else {
        await redis.set(key, serialized);
      }

      logger.debug({
        type: 'cache_set',
        key,
        ttl: ttl || 'none',
      });
    } catch (error: any) {
      logger.error({
        type: 'cache_set_error',
        key,
        error: error.message,
      });
    }
  }

  /**
   * Delete cached value
   * @param key Cache key
   */
  async delete(key: string): Promise<void> {
    try {
      await redis.del(key);
      
      logger.debug({
        type: 'cache_delete',
        key,
      });
    } catch (error: any) {
      logger.error({
        type: 'cache_delete_error',
        key,
        error: error.message,
      });
    }
  }

  /**
   * Invalidate cache by pattern
   * Deletes all keys matching the pattern
   * @param pattern Key pattern (e.g., "user:*")
   */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const keys = await redis.keys(pattern);
      
      if (keys.length === 0) {
        return 0;
      }

      const deleted = await redis.del(...keys);
      
      logger.info({
        type: 'cache_pattern_invalidated',
        pattern,
        deleted,
      });

      return deleted;
    } catch (error: any) {
      logger.error({
        type: 'cache_invalidate_pattern_error',
        pattern,
        error: error.message,
      });
      return 0;
    }
  }

  /**
   * Check if key exists in cache
   * @param key Cache key
   * @returns true if exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await redis.exists(key);
      return result === 1;
    } catch (error: any) {
      logger.error({
        type: 'cache_exists_error',
        key,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Get remaining TTL for cached key
   * @param key Cache key
   * @returns TTL in seconds, -1 if no expiry, -2 if key doesn't exist
   */
  async getTTL(key: string): Promise<number> {
    try {
      return await redis.ttl(key);
    } catch (error: any) {
      logger.error({
        type: 'cache_ttl_error',
        key,
        error: error.message,
      });
      return -2;
    }
  }

  /**
   * Extend TTL for existing key
   * @param key Cache key
   * @param seconds Additional seconds
   */
  async extendTTL(key: string, seconds: number): Promise<boolean> {
    try {
      const result = await redis.expire(key, seconds);
      return result === 1;
    } catch (error: any) {
      logger.error({
        type: 'cache_extend_ttl_error',
        key,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Cache-aside pattern: Get from cache or fetch from source
   * If not in cache, fetches from source, caches it, then returns
   * 
   * @param key Cache key
   * @param fetchFn Function to fetch data if not cached
   * @param ttl Time to live in seconds (optional)
   * @returns Cached or fetched value
   * 
   * @example
   * const user = await cache.getOrSet(
   *   'user:123',
   *   async () => await prisma.user.findUnique({ where: { id: '123' } }),
   *   3600
   * );
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const startTime = Date.now();

    try {
      // Try to get from cache first
      const cached = await this.get<T>(key);

      if (cached !== null) {
        logPerformance('cache_hit_getOrSet', startTime, { key });
        return cached;
      }

      // Cache miss - fetch from source
      logger.debug({
        type: 'cache_miss_fetching',
        key,
      });

      const data = await fetchFn();

      // Cache the fetched data
      await this.set(key, data, ttl);

      logPerformance('cache_miss_getOrSet', startTime, { key });

      return data;
    } catch (error: any) {
      logger.error({
        type: 'cache_getOrSet_error',
        key,
        error: error.message,
      });
      
      // On error, try to fetch directly (bypass cache)
      return await fetchFn();
    }
  }

  /**
   * Get multiple cached values at once
   * @param keys Array of cache keys
   * @returns Map of key to value
   */
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();

    if (keys.length === 0) {
      return result;
    }

    try {
      const values = await redis.mget(...keys);

      keys.forEach((key, index) => {
        const value = values[index];
        
        if (value) {
          try {
            result.set(key, JSON.parse(value) as T);
          } catch (error) {
            logger.error({
              type: 'cache_parse_error',
              key,
            });
          }
        }
      });

      return result;
    } catch (error: any) {
      logger.error({
        type: 'cache_getMany_error',
        keys,
        error: error.message,
      });
      return result;
    }
  }

  /**
   * Set multiple cached values at once
   * @param entries Map of key to value
   * @param ttl Time to live in seconds (applies to all)
   */
  async setMany<T>(entries: Map<string, T>, ttl?: number): Promise<void> {
    if (entries.size === 0) {
      return;
    }

    try {
      const pipeline = redis.pipeline();

      entries.forEach((value, key) => {
        const serialized = JSON.stringify(value);
        
        if (ttl) {
          pipeline.setex(key, ttl, serialized);
        } else {
          pipeline.set(key, serialized);
        }
      });

      await pipeline.exec();

      logger.debug({
        type: 'cache_setMany',
        count: entries.size,
        ttl: ttl || 'none',
      });
    } catch (error: any) {
      logger.error({
        type: 'cache_setMany_error',
        count: entries.size,
        error: error.message,
      });
    }
  }

  /**
   * Delete multiple cached values at once
   * @param keys Array of cache keys
   */
  async deleteMany(keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    try {
      const deleted = await redis.del(...keys);
      
      logger.debug({
        type: 'cache_deleteMany',
        count: deleted,
      });

      return deleted;
    } catch (error: any) {
      logger.error({
        type: 'cache_deleteMany_error',
        keys,
        error: error.message,
      });
      return 0;
    }
  }

  /**
   * Increment counter in cache
   * @param key Cache key
   * @param amount Amount to increment (default: 1)
   * @returns New value
   */
  async increment(key: string, amount: number = 1): Promise<number> {
    try {
      return await redis.incrby(key, amount);
    } catch (error: any) {
      logger.error({
        type: 'cache_increment_error',
        key,
        error: error.message,
      });
      return 0;
    }
  }

  /**
   * Decrement counter in cache
   * @param key Cache key
   * @param amount Amount to decrement (default: 1)
   * @returns New value
   */
  async decrement(key: string, amount: number = 1): Promise<number> {
    try {
      return await redis.decrby(key, amount);
    } catch (error: any) {
      logger.error({
        type: 'cache_decrement_error',
        key,
        error: error.message,
      });
      return 0;
    }
  }

  /**
   * Wrap a function with caching
   * Returns a cached version of the function that automatically caches results
   * 
   * @param fn Function to wrap
   * @param keyGenerator Function to generate cache key from arguments
   * @param ttl Time to live in seconds
   * @returns Wrapped function
   * 
   * @example
   * const getCachedUser = cache.wrap(
   *   (userId: string) => prisma.user.findUnique({ where: { id: userId } }),
   *   (userId) => `user:${userId}`,
   *   3600
   * );
   */
  wrap<TArgs extends any[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    keyGenerator: (...args: TArgs) => string,
    ttl?: number
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      const key = keyGenerator(...args);
      
      return this.getOrSet(
        key,
        () => fn(...args),
        ttl
      );
    };
  }

  /**
   * Clear all cache (use with caution!)
   * Only works in non-production environments
   */
  async clear(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === 'production') {
        logger.warn('Refusing to clear all cache in production');
        return false;
      }

      await redis.flushdb();
      logger.warn('All cache cleared');
      
      return true;
    } catch (error: any) {
      logger.error({
        type: 'cache_clear_error',
        error: error.message,
      });
      return false;
    }
  }
}

/**
 * Export singleton cache service instance
 */
export const cache = new CacheService();

/**
 * Specific cache helpers with predefined TTLs
 */

/**
 * Cache user data
 */
export const userCache = {
  get: (userId: string) => 
    cache.get(`${redisConfig.keyPrefixes.user}${userId}`),
  
  set: (userId: string, user: any) => 
    cache.set(`${redisConfig.keyPrefixes.user}${userId}`, user, getTTL('user')),
  
  delete: (userId: string) => 
    cache.delete(`${redisConfig.keyPrefixes.user}${userId}`),
};

/**
 * Cache policy data
 */
export const policyCache = {
  get: (policyId: string) => 
    cache.get(`${redisConfig.keyPrefixes.policy}${policyId}`),
  
  set: (policyId: string, policy: any) => 
    cache.set(`${redisConfig.keyPrefixes.policy}${policyId}`, policy, getTTL('policy')),
  
  delete: (policyId: string) => 
    cache.delete(`${redisConfig.keyPrefixes.policy}${policyId}`),
};

/**
 * Cache compliance query results
 */
export const complianceCache = {
  get: (queryId: string) => 
    cache.get(`${redisConfig.keyPrefixes.compliance}${queryId}`),
  
  set: (queryId: string, result: any) => 
    cache.set(
      `${redisConfig.keyPrefixes.compliance}${queryId}`,
      result,
      getTTL('complianceQuery')
    ),
  
  delete: (queryId: string) => 
    cache.delete(`${redisConfig.keyPrefixes.compliance}${queryId}`),
};

/**
 * Cache RAG search results
 */
export const ragCache = {
  get: (queryHash: string) => 
    cache.get(`${redisConfig.keyPrefixes.rag}${queryHash}`),
  
  set: (queryHash: string, results: any) => 
    cache.set(`${redisConfig.keyPrefixes.rag}${queryHash}`, results, getTTL('ragResults')),
  
  delete: (queryHash: string) => 
    cache.delete(`${redisConfig.keyPrefixes.rag}${queryHash}`),
};

/**
 * Cache session data
 */
export const sessionCache = {
  get: (sessionId: string) => 
    cache.get(`${redisConfig.keyPrefixes.session}${sessionId}`),
  
  set: (sessionId: string, session: any) => 
    cache.set(
      `${redisConfig.keyPrefixes.session}${sessionId}`,
      session,
      getTTL('session')
    ),
  
  delete: (sessionId: string) => 
    cache.delete(`${redisConfig.keyPrefixes.session}${sessionId}`),
};