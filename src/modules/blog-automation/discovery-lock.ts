import { Redis } from '@upstash/redis';

// Default to a 10-minute lock TTL
const LOCK_TTL_SECONDS = 10 * 60;

// Initialize redis only if URL and TOKEN are present.
// Otherwise, we fallback to an in-memory lock for local development.
let redis: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

const localLocks = new Set<string>();

export async function acquireDiscoveryLock(monitorId: string): Promise<boolean> {
  const key = `blog-discovery:monitor:${monitorId}`;
  
  if (redis) {
    try {
      const result = await redis.set(key, 'locked', { nx: true, ex: LOCK_TTL_SECONDS });
      return result === 'OK';
    } catch (error) {
      console.warn(`[Redis Lock] Error acquiring lock for ${monitorId}:`, error);
      return false; // Fail safe
    }
  } else {
    // Local fallback
    if (localLocks.has(key)) return false;
    localLocks.add(key);
    
    // Auto-expire local lock
    setTimeout(() => {
      localLocks.delete(key);
    }, LOCK_TTL_SECONDS * 1000);
    
    return true;
  }
}

export async function releaseDiscoveryLock(monitorId: string): Promise<void> {
  const key = `blog-discovery:monitor:${monitorId}`;
  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      console.warn(`[Redis Lock] Error releasing lock for ${monitorId}:`, error);
    }
  } else {
    localLocks.delete(key);
  }
}
