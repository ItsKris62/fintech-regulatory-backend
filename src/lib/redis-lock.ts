import { randomUUID } from 'node:crypto';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

interface AcquireLockParams {
  key: string;
  ttlSeconds: number;
  context: Record<string, string>;
}

interface LockHandle {
  release: () => Promise<void>;
}

/**
 * Acquires a distributed lock via Redis SET NX EX. Returns a handle with a
 * release() method, or null if the lock is already held.
 *
 * Caller must call release() in a finally block. If the process crashes before
 * release, the lock auto-expires after ttlSeconds.
 *
 * Token-based release: the stored token is compared before DEL to avoid
 * releasing a lock acquired by another process after our TTL expired.
 */
export async function acquireLock(
  params: AcquireLockParams,
): Promise<LockHandle | null> {
  const { key, ttlSeconds, context } = params;
  const token = randomUUID();

  const result = await redis.set(key, token, { ex: ttlSeconds, nx: true });

  if (result === null) {
    logger.info({
      type: 'redis_lock.acquire.contended',
      key,
      ...context,
    });
    return null;
  }

  logger.info({
    type: 'redis_lock.acquired',
    key,
    ttlSeconds,
    ...context,
  });

  return {
    release: async () => {
      try {
        const current = await redis.get<string>(key);
        if (current === token) {
          await redis.del(key);
          logger.info({
            type: 'redis_lock.released',
            key,
            ...context,
          });
        } else {
          logger.warn({
            type: 'redis_lock.release.token_mismatch',
            key,
            ...context,
          });
        }
      } catch (err: unknown) {
        logger.warn({
          type: 'redis_lock.release.failed',
          key,
          error: err instanceof Error ? err.message : String(err),
          ...context,
        });
      }
    },
  };
}
