import Redis, { RedisOptions } from 'ioredis';
import { redisConfig, getRetryDelay } from '@/config/redis.config';
import { appConfig } from '@/config/app.config';
import { logger } from '@/utils/logger';

/**
 * Extended global type for Redis singleton
 */
declare global {
  var redis: Redis | undefined;
}

/**
 * Create Redis client with Railway-optimized configuration
 */
function createRedisClient(): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: redisConfig.connection.options.maxRetriesPerRequest,
    enableReadyCheck: redisConfig.connection.options.enableReadyCheck,
    lazyConnect: redisConfig.connection.options.lazyConnect,
    enableOfflineQueue: redisConfig.connection.options.enableOfflineQueue,
    connectTimeout: redisConfig.connection.options.connectTimeout,
    commandTimeout: redisConfig.connection.options.commandTimeout,
    keepAlive: redisConfig.connection.options.keepAlive,
    retryStrategy: (times: number) => {
      if (times > redisConfig.connection.retry.maxAttempts) {
        logger.error('Redis max retry attempts reached');
        return null; // Stop retrying
      }
      
      const delay = getRetryDelay(times);
      logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms`);
      return delay;
    },
  };

  const client = new Redis(redisConfig.connection.url, options);

  // Event handlers
  client.on('connect', () => {
    logger.info('Redis connecting...');
  });

  client.on('ready', () => {
    logger.info('✅ Redis connected and ready');
  });

  client.on('error', (error: Error) => {
    logger.error({
      type: 'redis_error',
      error: error.message,
    }, 'Redis connection error');
  });

  client.on('close', () => {
    logger.warn('Redis connection closed');
  });

  client.on('reconnecting', (delay: number) => {
    logger.info(`Redis reconnecting in ${delay}ms`);
  });

  client.on('end', () => {
    logger.info('Redis connection ended');
  });

  return client;
}

/**
 * Singleton Redis client
 * Reuses connection in development (hot reload)
 */
export const redis = global.redis || createRedisClient();

if (appConfig.isDevelopment) {
  global.redis = redis;
}

/**
 * Connect to Redis with retry logic
 */
export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
    logger.info('Redis connected successfully');
  } catch (error: any) {
    logger.error({
      type: 'redis_connection_error',
      error: error.message,
    }, 'Failed to connect to Redis');
    throw error;
  }
}

/**
 * Disconnect from Redis
 * Called during graceful shutdown
 */
export async function disconnectRedis(): Promise<void> {
  try {
    await redis.quit();
    logger.info('Redis disconnected');
  } catch (error: any) {
    logger.error({
      type: 'redis_disconnect_error',
      error: error.message,
    });
  }
}

/**
 * Check Redis health
 * @returns true if Redis is accessible
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch (error) {
    logger.error({
      type: 'redis_health_check_failed',
      error,
    });
    return false;
  }
}

/**
 * Get Redis connection stats
 */
export async function getRedisStats(): Promise<{
  connected: boolean;
  usedMemory: string;
  connectedClients: number;
  totalCommandsProcessed: number;
}> {
  try {
    const info = await redis.info('stats');
    const memory = await redis.info('memory');
    
    // Parse info strings
    const parseInfo = (infoString: string) => {
      const lines = infoString.split('\r\n');
      const data: Record<string, string> = {};
      
      lines.forEach(line => {
        if (line && !line.startsWith('#')) {
          const [key, value] = line.split(':');
          if (key && value) {
            data[key] = value;
          }
        }
      });
      
      return data;
    };

    const statsData = parseInfo(info);
    const memoryData = parseInfo(memory);

    return {
      connected: true,
      usedMemory: memoryData.used_memory_human || '0B',
      connectedClients: parseInt(statsData.connected_clients || '0'),
      totalCommandsProcessed: parseInt(statsData.total_commands_processed || '0'),
    };
  } catch (error) {
    return {
      connected: false,
      usedMemory: '0B',
      connectedClients: 0,
      totalCommandsProcessed: 0,
    };
  }
}

/**
 * Basic Redis operations with error handling
 */

/**
 * Get value from Redis
 * @param key Cache key
 * @returns Value or null
 */
export async function get(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch (error: any) {
    logger.error({
      type: 'redis_get_error',
      key,
      error: error.message,
    });
    return null;
  }
}

/**
 * Set value in Redis
 * @param key Cache key
 * @param value Value to store
 * @param ttl Time to live in seconds (optional)
 */
export async function set(
  key: string,
  value: string,
  ttl?: number
): Promise<boolean> {
  try {
    if (ttl) {
      await redis.setex(key, ttl, value);
    } else {
      await redis.set(key, value);
    }
    return true;
  } catch (error: any) {
    logger.error({
      type: 'redis_set_error',
      key,
      error: error.message,
    });
    return false;
  }
}

/**
 * Delete key from Redis
 * @param key Cache key
 * @returns true if deleted
 */
export async function del(key: string): Promise<boolean> {
  try {
    const result = await redis.del(key);
    return result > 0;
  } catch (error: any) {
    logger.error({
      type: 'redis_del_error',
      key,
      error: error.message,
    });
    return false;
  }
}

/**
 * Check if key exists
 * @param key Cache key
 * @returns true if exists
 */
export async function exists(key: string): Promise<boolean> {
  try {
    const result = await redis.exists(key);
    return result === 1;
  } catch (error: any) {
    logger.error({
      type: 'redis_exists_error',
      key,
      error: error.message,
    });
    return false;
  }
}

/**
 * Set expiration on key
 * @param key Cache key
 * @param seconds TTL in seconds
 * @returns true if successful
 */
export async function expire(key: string, seconds: number): Promise<boolean> {
  try {
    const result = await redis.expire(key, seconds);
    return result === 1;
  } catch (error: any) {
    logger.error({
      type: 'redis_expire_error',
      key,
      error: error.message,
    });
    return false;
  }
}

/**
 * Get remaining TTL for key
 * @param key Cache key
 * @returns TTL in seconds, -1 if no expiry, -2 if key doesn't exist
 */
export async function ttl(key: string): Promise<number> {
  try {
    return await redis.ttl(key);
  } catch (error: any) {
    logger.error({
      type: 'redis_ttl_error',
      key,
      error: error.message,
    });
    return -2;
  }
}

/**
 * Get keys matching pattern
 * @param pattern Key pattern (e.g., "user:*")
 * @returns Array of matching keys
 */
export async function keys(pattern: string): Promise<string[]> {
  try {
    return await redis.keys(pattern);
  } catch (error: any) {
    logger.error({
      type: 'redis_keys_error',
      pattern,
      error: error.message,
    });
    return [];
  }
}

/**
 * Delete all keys matching pattern
 * @param pattern Key pattern
 * @returns Number of keys deleted
 */
export async function deletePattern(pattern: string): Promise<number> {
  try {
    const matchingKeys = await keys(pattern);
    
    if (matchingKeys.length === 0) {
      return 0;
    }

    const result = await redis.del(...matchingKeys);
    logger.info({
      type: 'redis_pattern_delete',
      pattern,
      deleted: result,
    });
    
    return result;
  } catch (error: any) {
    logger.error({
      type: 'redis_delete_pattern_error',
      pattern,
      error: error.message,
    });
    return 0;
  }
}

/**
 * Increment counter
 * @param key Cache key
 * @param amount Amount to increment (default: 1)
 * @returns New value
 */
export async function increment(key: string, amount: number = 1): Promise<number> {
  try {
    return await redis.incrby(key, amount);
  } catch (error: any) {
    logger.error({
      type: 'redis_increment_error',
      key,
      error: error.message,
    });
    return 0;
  }
}

/**
 * Decrement counter
 * @param key Cache key
 * @param amount Amount to decrement (default: 1)
 * @returns New value
 */
export async function decrement(key: string, amount: number = 1): Promise<number> {
  try {
    return await redis.decrby(key, amount);
  } catch (error: any) {
    logger.error({
      type: 'redis_decrement_error',
      key,
      error: error.message,
    });
    return 0;
  }
}

/**
 * Hash operations
 */

/**
 * Set hash field
 * @param key Hash key
 * @param field Field name
 * @param value Field value
 */
export async function hset(
  key: string,
  field: string,
  value: string
): Promise<boolean> {
  try {
    await redis.hset(key, field, value);
    return true;
  } catch (error: any) {
    logger.error({
      type: 'redis_hset_error',
      key,
      field,
      error: error.message,
    });
    return false;
  }
}

/**
 * Get hash field
 * @param key Hash key
 * @param field Field name
 * @returns Field value or null
 */
export async function hget(key: string, field: string): Promise<string | null> {
  try {
    return await redis.hget(key, field);
  } catch (error: any) {
    logger.error({
      type: 'redis_hget_error',
      key,
      field,
      error: error.message,
    });
    return null;
  }
}

/**
 * Get all hash fields
 * @param key Hash key
 * @returns Object with all fields
 */
export async function hgetall(key: string): Promise<Record<string, string>> {
  try {
    return await redis.hgetall(key);
  } catch (error: any) {
    logger.error({
      type: 'redis_hgetall_error',
      key,
      error: error.message,
    });
    return {};
  }
}

/**
 * Delete hash field
 * @param key Hash key
 * @param field Field name
 * @returns true if deleted
 */
export async function hdel(key: string, field: string): Promise<boolean> {
  try {
    const result = await redis.hdel(key, field);
    return result > 0;
  } catch (error: any) {
    logger.error({
      type: 'redis_hdel_error',
      key,
      field,
      error: error.message,
    });
    return false;
  }
}

/**
 * List operations
 */

/**
 * Push to list (left/head)
 * @param key List key
 * @param values Values to push
 * @returns Length of list after push
 */
export async function lpush(key: string, ...values: string[]): Promise<number> {
  try {
    return await redis.lpush(key, ...values);
  } catch (error: any) {
    logger.error({
      type: 'redis_lpush_error',
      key,
      error: error.message,
    });
    return 0;
  }
}

/**
 * Push to list (right/tail)
 * @param key List key
 * @param values Values to push
 * @returns Length of list after push
 */
export async function rpush(key: string, ...values: string[]): Promise<number> {
  try {
    return await redis.rpush(key, ...values);
  } catch (error: any) {
    logger.error({
      type: 'redis_rpush_error',
      key,
      error: error.message,
    });
    return 0;
  }
}

/**
 * Pop from list (left/head)
 * @param key List key
 * @returns Popped value or null
 */
export async function lpop(key: string): Promise<string | null> {
  try {
    return await redis.lpop(key);
  } catch (error: any) {
    logger.error({
      type: 'redis_lpop_error',
      key,
      error: error.message,
    });
    return null;
  }
}

/**
 * Get list range
 * @param key List key
 * @param start Start index
 * @param stop Stop index
 * @returns Array of values
 */
export async function lrange(
  key: string,
  start: number,
  stop: number
): Promise<string[]> {
  try {
    return await redis.lrange(key, start, stop);
  } catch (error: any) {
    logger.error({
      type: 'redis_lrange_error',
      key,
      error: error.message,
    });
    return [];
  }
}

/**
 * Set operations
 */

/**
 * Add member to set
 * @param key Set key
 * @param members Members to add
 * @returns Number of members added
 */
export async function sadd(key: string, ...members: string[]): Promise<number> {
  try {
    return await redis.sadd(key, ...members);
  } catch (error: any) {
    logger.error({
      type: 'redis_sadd_error',
      key,
      error: error.message,
    });
    return 0;
  }
}

/**
 * Get all members of set
 * @param key Set key
 * @returns Array of members
 */
export async function smembers(key: string): Promise<string[]> {
  try {
    return await redis.smembers(key);
  } catch (error: any) {
    logger.error({
      type: 'redis_smembers_error',
      key,
      error: error.message,
    });
    return [];
  }
}

/**
 * Check if member is in set
 * @param key Set key
 * @param member Member to check
 * @returns true if member exists
 */
export async function sismember(key: string, member: string): Promise<boolean> {
  try {
    const result = await redis.sismember(key, member);
    return result === 1;
  } catch (error: any) {
    logger.error({
      type: 'redis_sismember_error',
      key,
      member,
      error: error.message,
    });
    return false;
  }
}

/**
 * Flush all keys (use with caution!)
 */
export async function flushAll(): Promise<boolean> {
  try {
    if (appConfig.isProduction) {
      logger.warn('Refusing to flush Redis in production');
      return false;
    }
    
    await redis.flushall();
    logger.warn('Redis flushed - all keys deleted');
    return true;
  } catch (error: any) {
    logger.error({
      type: 'redis_flush_error',
      error: error.message,
    });
    return false;
  }
}

/**
 * Clean up on shutdown
 */
process.on('beforeExit', async () => {
  await disconnectRedis();
});

// Export Redis instance for direct use
export { redis as redisClient };
export type { Redis };