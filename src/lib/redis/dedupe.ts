import { redis } from './client';

/**
 * Atomic check-and-set dedup gate via a single SET key val NX EX ttl. Returns
 * true only for the caller that actually claims dedupeKey (the SET succeeded,
 * i.e. the key did not already exist); every other caller within ttlSeconds -
 * concurrent or subsequent - gets false. A prior GET-then-SET version of this
 * check (still see acquireLock in redis-lock.ts for the same NX/EX contract
 * used for distributed locking) had a race window between the two round
 * trips; collapsing both into one atomic command removes that window.
 */
export async function notificationDedupe(dedupeKey: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(dedupeKey, '1', { ex: ttlSeconds, nx: true });
  return result === 'OK';
}
