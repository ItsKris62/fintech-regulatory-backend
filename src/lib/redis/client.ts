import { Redis } from '@upstash/redis';
import { logger } from '@/utils/logger';

/**
 * Upstash Redis client (HTTP-based, serverless-friendly).
 * Replaces the previous ioredis TCP client.
 *
 * Key API differences from ioredis:
 *  - setex(key, ttl, val)  => set(key, val, { ex: ttl })
 *  - zadd(key, score, mem) => zadd(key, { score, member: mem })
 *  - No connection lifecycle (connect / quit / events) -- HTTP per call
 */
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function connectRedis(): Promise<void> {
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error(`Redis ping returned unexpected: ${pong}`);
  logger.info('Upstash Redis connected (HTTP)');
}

export async function disconnectRedis(): Promise<void> {
  logger.info('Upstash Redis client released (HTTP -- no persistent connection)');
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch (error) {
    logger.error({ type: 'redis_health_check_failed', error });
    return false;
  }
}

export async function getRedisStats(): Promise<{
  connected: boolean;
  usedMemory: string;
  connectedClients: number;
  totalCommandsProcessed: number;
}> {
  try {
    await redis.ping();
    return { connected: true, usedMemory: 'n/a (Upstash managed)', connectedClients: 1, totalCommandsProcessed: 0 };
  } catch {
    return { connected: false, usedMemory: '0B', connectedClients: 0, totalCommandsProcessed: 0 };
  }
}

export async function get(key: string): Promise<string | null> {
  try {
    const val = await redis.get<string>(key);
    return val ?? null;
  } catch (error: any) {
    logger.error({ type: 'redis_get_error', key, error: error.message });
    return null;
  }
}

export async function set(key: string, value: string, ttl?: number): Promise<boolean> {
  try {
    if (ttl) { await redis.set(key, value, { ex: ttl }); } else { await redis.set(key, value); }
    return true;
  } catch (error: any) {
    logger.error({ type: 'redis_set_error', key, error: error.message });
    return false;
  }
}

export async function del(key: string): Promise<boolean> {
  try { return (await redis.del(key)) > 0; }
  catch (error: any) { logger.error({ type: 'redis_del_error', key, error: error.message }); return false; }
}

export async function exists(key: string): Promise<boolean> {
  try { return (await redis.exists(key)) === 1; }
  catch (error: any) { logger.error({ type: 'redis_exists_error', key, error: error.message }); return false; }
}

export async function expire(key: string, seconds: number): Promise<boolean> {
  try { return (await redis.expire(key, seconds)) === 1; }
  catch (error: any) { logger.error({ type: 'redis_expire_error', key, error: error.message }); return false; }
}

export async function ttl(key: string): Promise<number> {
  try { return await redis.ttl(key); }
  catch (error: any) { logger.error({ type: 'redis_ttl_error', key, error: error.message }); return -2; }
}

export async function keys(pattern: string): Promise<string[]> {
  try { return await redis.keys(pattern); }
  catch (error: any) { logger.error({ type: 'redis_keys_error', pattern, error: error.message }); return []; }
}

export async function deletePattern(pattern: string): Promise<number> {
  try {
    const matchingKeys = await keys(pattern);
    if (matchingKeys.length === 0) return 0;
    const result = await redis.del(...matchingKeys);
    logger.info({ type: 'redis_pattern_delete', pattern, deleted: result });
    return result;
  } catch (error: any) {
    logger.error({ type: 'redis_delete_pattern_error', pattern, error: error.message });
    return 0;
  }
}

export async function increment(key: string, amount: number = 1): Promise<number> {
  try { return await redis.incrby(key, amount); }
  catch (error: any) { logger.error({ type: 'redis_increment_error', key, error: error.message }); return 0; }
}

export async function decrement(key: string, amount: number = 1): Promise<number> {
  try { return await redis.decrby(key, amount); }
  catch (error: any) { logger.error({ type: 'redis_decrement_error', key, error: error.message }); return 0; }
}

export async function hset(key: string, field: string, value: string): Promise<boolean> {
  try { await redis.hset(key, { [field]: value }); return true; }
  catch (error: any) { logger.error({ type: 'redis_hset_error', key, field, error: error.message }); return false; }
}

export async function hget(key: string, field: string): Promise<string | null> {
  try { return (await redis.hget<string>(key, field)) ?? null; }
  catch (error: any) { logger.error({ type: 'redis_hget_error', key, field, error: error.message }); return null; }
}

export async function hgetall(key: string): Promise<Record<string, string>> {
  try { return (await redis.hgetall(key)) ?? {}; }
  catch (error: any) { logger.error({ type: 'redis_hgetall_error', key, error: error.message }); return {}; }
}

export async function hdel(key: string, field: string): Promise<boolean> {
  try { return (await redis.hdel(key, field)) > 0; }
  catch (error: any) { logger.error({ type: 'redis_hdel_error', key, field, error: error.message }); return false; }
}

export async function lpush(key: string, ...values: string[]): Promise<number> {
  try { return await redis.lpush(key, ...values); }
  catch (error: any) { logger.error({ type: 'redis_lpush_error', key, error: error.message }); return 0; }
}

export async function rpush(key: string, ...values: string[]): Promise<number> {
  try { return await redis.rpush(key, ...values); }
  catch (error: any) { logger.error({ type: 'redis_rpush_error', key, error: error.message }); return 0; }
}

export async function lpop(key: string): Promise<string | null> {
  try { return (await redis.lpop<string>(key)) ?? null; }
  catch (error: any) { logger.error({ type: 'redis_lpop_error', key, error: error.message }); return null; }
}

export async function lrange(key: string, start: number, stop: number): Promise<string[]> {
  try { return await redis.lrange<string>(key, start, stop); }
  catch (error: any) { logger.error({ type: 'redis_lrange_error', key, error: error.message }); return []; }
}

export async function sadd(key: string, ...members: string[]): Promise<number> {
  try {
    if (members.length === 0) return 0;
    return await redis.sadd(key, ...(members as [string, ...string[]]));
  }
  catch (error: any) { logger.error({ type: 'redis_sadd_error', key, error: error.message }); return 0; }
}

export async function smembers(key: string): Promise<string[]> {
  try { return await redis.smembers(key); }
  catch (error: any) { logger.error({ type: 'redis_smembers_error', key, error: error.message }); return []; }
}

export async function sismember(key: string, member: string): Promise<boolean> {
  try { return (await redis.sismember(key, member)) === 1; }
  catch (error: any) { logger.error({ type: 'redis_sismember_error', key, member, error: error.message }); return false; }
}

export async function flushAll(): Promise<boolean> {
  try {
    if (process.env.NODE_ENV === 'production') { logger.warn('Refusing to flush Redis in production'); return false; }
    await redis.flushdb();
    logger.warn('Redis flushed -- all keys deleted');
    return true;
  } catch (error: any) {
    logger.error({ type: 'redis_flush_error', error: error.message });
    return false;
  }
}

export { redis as redisClient };
export type { Redis };
