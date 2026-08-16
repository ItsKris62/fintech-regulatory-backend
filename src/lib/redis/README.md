# Redis Setup

This directory contains the Redis client and services for SheriaBot, including caching, rate limiting, and pub/sub for real-time notifications.

## 📁 Structure

```
redis/
├── client.ts          # Redis client singleton with basic operations
├── cache.service.ts   # High-level cache service with typed methods
├── rate-limiter.ts    # Rate limiting service with sliding window
├── pubsub.ts          # Pub/Sub for real-time notifications
└── README.md          # This file
```

## 🚀 Getting Started

### 1. Environment Setup

Ensure your `.env` file has the correct Upstash Redis REST credentials:

```bash
# Upstash Redis (production on Render)
UPSTASH_REDIS_REST_URL="https://your-database.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-upstash-redis-rest-token"

# Local development can leave Upstash unset if Redis-dependent features are not being tested.
```

### 2. Test Connection

```bash
tsx scripts/test-redis.ts
```

This runs 10 comprehensive tests including cache operations, rate limiting, and pub/sub.

## 📚 Usage Examples

### Basic Cache Operations

```typescript
import { cache } from '@/lib/redis/cache.service';

// Set value with TTL
await cache.set('user:123', { name: 'John', email: 'john@example.com' }, 3600);

// Get value
const user = await cache.get<User>('user:123');

// Delete value
await cache.delete('user:123');

// Check if exists
const exists = await cache.exists('user:123');
```

### Cache-Aside Pattern

```typescript
import { cache } from '@/lib/redis/cache.service';
import { prisma } from '@/lib/prisma/client';

// Automatically fetches from database if not cached
const user = await cache.getOrSet(
  'user:123',
  async () => {
    return await prisma.user.findUnique({ where: { id: '123' } });
  },
  3600 // Cache for 1 hour
);
```

### Function Wrapping

```typescript
import { cache } from '@/lib/redis/cache.service';

// Wrap any function with automatic caching
const getCachedUser = cache.wrap(
  async (userId: string) => {
    return await prisma.user.findUnique({ where: { id: userId } });
  },
  (userId) => `user:${userId}`,
  3600
);

// Use like normal function - results are cached automatically
const user = await getCachedUser('123');
```

### Predefined Cache Helpers

```typescript
import { userCache, policyCache, complianceCache } from '@/lib/redis/cache.service';

// User cache (1 hour TTL)
await userCache.set('123', user);
const cachedUser = await userCache.get('123');
await userCache.delete('123');

// Policy cache (1 hour TTL)
await policyCache.set('policy-456', policy);

// Compliance query cache (24 hours TTL)
await complianceCache.set('query-789', result);
```

### Rate Limiting

```typescript
import { rateLimiter, authRateLimiter, apiRateLimiter } from '@/lib/redis/rate-limiter';

// Check rate limit
const result = await rateLimiter.check(
  'user:123',        // identifier (user ID, IP, etc.)
  'api',             // action being limited
  100,               // max requests
  900                // window in seconds (15 minutes)
);

if (!result.allowed) {
  console.log(`Rate limit exceeded. Try again in ${result.retryAfter} seconds`);
  return;
}

console.log(`Remaining requests: ${result.remaining}`);

// Predefined rate limiters
// Login: 5 attempts per 15 minutes
await authRateLimiter.login('user@example.com');

// API: 100 requests per 15 minutes
await apiRateLimiter.default('user:123');

// Policy generation: 10 per hour (expensive operation)
await apiRateLimiter.policyGeneration('user:123');

// Compliance query: 50 per hour
await apiRateLimiter.complianceQuery('user:123');
```

### Rate Limiting with Error Throwing

```typescript
import { rateLimiter } from '@/lib/redis/rate-limiter';

// Automatically throws TooManyRequestsError if exceeded
try {
  await rateLimiter.checkOrThrow('user:123', 'api', 100, 900);
  // Continue with request
} catch (error) {
  // Handle rate limit error
  // Error includes retryAfter for proper HTTP response
}
```

### Real-Time Notifications

```typescript
import { notificationPubSub } from '@/lib/redis/pubsub';

// Publish notification to user
await notificationPubSub.publish('user:123', {
  type: 'POLICY_READY',
  userId: '123',
  data: {
    policyId: 'policy-456',
    title: 'Digital Lending Framework',
  },
});

// Subscribe to user notifications (for SSE)
const unsubscribe = await notificationPubSub.subscribe(
  'user:123',
  (event) => {
    console.log('Notification received:', event);
    // Send via SSE to frontend
  }
);

// Unsubscribe when done
await unsubscribe();
```

### Policy Generation Progress

```typescript
import { policyProgressPubSub } from '@/lib/redis/pubsub';

// In policy generation service
async function generatePolicy(policyId: string) {
  // Notify: Started
  await policyProgressPubSub.started(policyId);

  // Retrieve relevant laws
  await policyProgressPubSub.analyzing(policyId);
  const laws = await retrieveLaws();

  // Generate policy
  await policyProgressPubSub.generating(policyId);
  const policy = await generatePolicyContent(laws);

  // Create checklist
  await policyProgressPubSub.checklist(policyId);
  const checklist = await createChecklist(policy);

  // Notify: Complete
  await policyProgressPubSub.complete(policyId, { policyId });
}

// In frontend/SSE handler
const unsubscribe = await policyProgressPubSub.subscribe(
  'policy-456',
  (event) => {
    console.log(`Progress: ${event.progress}% - ${event.message}`);
    // Update UI progress bar
  }
);
```

### Pattern Operations

```typescript
import { cache } from '@/lib/redis/cache.service';

// Invalidate all user caches
await cache.invalidatePattern('user:*');

// Invalidate organization caches
await cache.invalidatePattern('org:*');

// Invalidate specific user's policies
await cache.invalidatePattern('policy:user:123:*');
```

### Counter Operations

```typescript
import { cache } from '@/lib/redis/cache.service';

// Increment counter
const views = await cache.increment('policy:456:views', 1);

// Decrement inventory
const remaining = await cache.decrement('licenses:available', 1);

// Get current count
const count = await cache.get<number>('policy:456:views');
```

### Batch Operations

```typescript
import { cache } from '@/lib/redis/cache.service';

// Get multiple values at once
const userIds = ['123', '456', '789'];
const keys = userIds.map(id => `user:${id}`);
const users = await cache.getMany<User>(keys);

// Set multiple values at once
const entries = new Map<string, User>();
entries.set('user:123', user1);
entries.set('user:456', user2);
entries.set('user:789', user3);
await cache.setMany(entries, 3600);

// Delete multiple values
await cache.deleteMany(['user:123', 'user:456', 'user:789']);
```

## 🔧 Advanced Usage

### Custom Pub/Sub Channels

```typescript
import { pubsub } from '@/lib/redis/pubsub';

// Define custom event type
type CustomEvent = {
  type: string;
  data: any;
  timestamp: number;
};

// Subscribe to custom channel
const unsubscribe = await pubsub.subscribe<CustomEvent>(
  'custom:channel',
  (event) => {
    console.log('Event received:', event);
  }
);

// Publish to custom channel
await pubsub.publish('custom:channel', {
  type: 'CUSTOM_EVENT',
  data: { message: 'Hello' },
  timestamp: Date.now(),
});

// Clean up
await unsubscribe();
```

### Distributed Locking (if needed)

```typescript
import { redis } from '@/lib/redis/client';

// Acquire lock
const lockKey = 'lock:document:123';
const lockValue = 'unique-request-id';
const acquired = await redis.set(lockKey, lockValue, 'EX', 30, 'NX');

if (!acquired) {
  throw new Error('Could not acquire lock');
}

try {
  // Do work while holding lock
  await processDocument('123');
} finally {
  // Release lock (only if we still own it)
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, 1, lockKey, lockValue);
}
```

### Session Management

```typescript
import { sessionCache } from '@/lib/redis/cache.service';

// Store session (30 days TTL)
await sessionCache.set('session-abc123', {
  userId: '123',
  email: 'user@example.com',
  createdAt: new Date(),
});

// Get session
const session = await sessionCache.get('session-abc123');

// Delete session (logout)
await sessionCache.delete('session-abc123');
```

## 🐛 Troubleshooting

### Connection Issues

If Redis connection fails:

1. Check `UPSTASH_REDIS_REST_URL` is correct
2. Check `UPSTASH_REDIS_REST_TOKEN` is current
3. Verify the Upstash database is reachable from Render
4. Check Render service logs for Redis client errors

### Memory Issues

Monitor Redis memory usage:

```typescript
import { getRedisStats } from '@/lib/redis/client';

const stats = await getRedisStats();
console.log(`Memory used: ${stats.usedMemory}`);
```

If memory is full:
- Increase the Upstash Redis plan
- Set shorter TTLs
- Use `cache.invalidatePattern()` to clear old data

### Slow Operations

Check operation duration:

```typescript
import { logPerformance } from '@/utils/logger';

const startTime = Date.now();
await cache.set('key', 'value');
logPerformance('redis_set', startTime);
```

If slow:
- Check Redis latency: `redis-cli --latency`
- Monitor connection pool
- Consider using pipelining for bulk operations

## 📊 Monitoring

### Get Redis Statistics

```typescript
import { getRedisStats, checkRedisHealth } from '@/lib/redis/client';

// Health check
const healthy = await checkRedisHealth();

// Detailed stats
const stats = await getRedisStats();
console.log({
  connected: stats.connected,
  memory: stats.usedMemory,
  clients: stats.connectedClients,
  commands: stats.totalCommandsProcessed,
});
```

### Cache Hit Rate

Track cache performance:

```typescript
let hits = 0;
let misses = 0;

const value = await cache.get('key');
if (value !== null) {
  hits++;
} else {
  misses++;
}

const hitRate = (hits / (hits + misses)) * 100;
console.log(`Cache hit rate: ${hitRate.toFixed(2)}%`);
```

## 🚀 Best Practices

1. **Always set TTLs** - Prevents memory bloat
2. **Use cache helpers** - Predefined TTLs and key prefixes
3. **Invalidate on updates** - Keep cache fresh
4. **Rate limit expensive operations** - Protect your API
5. **Use pub/sub for real-time** - Better than polling
6. **Monitor memory usage** - Upstash plans have request and storage limits
7. **Handle errors gracefully** - Fail open on cache errors

## 📚 Documentation

- [Redis Documentation](https://redis.io/documentation)
- [ioredis Documentation](https://github.com/redis/ioredis)
- [Upstash Redis Documentation](https://upstash.com/docs/redis)
