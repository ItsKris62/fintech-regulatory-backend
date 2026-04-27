import { appConfig } from './app.config';

/**
 * Redis configuration for caching and session management
 * Optimized for Upstash Redis (HTTP/REST-based)
 */
export const redisConfig = {
  /**
   * Upstash Redis connection configuration (HTTP-based, no persistent TCP pool)
   */
  connection: {
    restUrl: appConfig.redis.restUrl,
    restToken: appConfig.redis.restToken,

    // Retry strategy for HTTP requests
    retry: {
      maxAttempts: 5,
      initialDelay: 500, // ms
      maxDelay: 5000, // ms
      multiplier: 2,
    },
  },

  /**
   * TTL (Time To Live) defaults for different cache types
   * All values in seconds
   */
  ttl: {
    // Session data (30 days)
    session: 30 * 24 * 60 * 60,

    // User cache (1 hour)
    user: 60 * 60,

    // Policy cache (1 hour)
    policy: 60 * 60,

    // Compliance query cache (24 hours)
    complianceQuery: 24 * 60 * 60,

    // RAG search results (1 hour)
    ragResults: 60 * 60,

    // Email verification tokens (1 hour)
    emailToken: 60 * 60,

    // Password reset tokens (1 hour)
    resetToken: 60 * 60,

    // Rate limit counters (15 minutes)
    rateLimit: 15 * 60,

    // API response cache (5 minutes)
    apiResponse: 5 * 60,

    // File upload metadata (24 hours)
    uploadMetadata: 24 * 60 * 60,

    // Notification cache (10 minutes)
    notification: 10 * 60,

    // Analytics cache (1 hour)
    analytics: 60 * 60,

    // Default TTL (1 hour)
    default: 60 * 60,
  },

  /**
   * Cache key prefixes for organization
   * Helps prevent key collisions and enables bulk deletion
   */
  keyPrefixes: {
    session: 'session:',
    user: 'user:',
    policy: 'policy:',
    compliance: 'compliance:',
    rag: 'rag:',
    token: 'token:',
    rateLimit: 'ratelimit:',
    cache: 'cache:',
    queue: 'queue:',
    lock: 'lock:',
    notification: 'notification:',
    analytics: 'analytics:',
    pubsub: 'pubsub:',
  },

  /**
   * Pub/Sub channel names
   * Used for real-time notifications and SSE
   */
  channels: {
    notifications: 'notifications:',
    policyProgress: 'policy:progress:',
    checklistProgress: 'checklist:progress:',
    systemEvents: 'system:events',
    userEvents: 'user:events:',
    alertUser: 'alerts:user:',
  },

  /**
   * Queue configuration for background jobs
   */
  queues: {
    email: {
      name: 'email-queue',
      concurrency: 5,
      maxAttempts: 3,
    },
    documentProcessing: {
      name: 'document-processing-queue',
      concurrency: 2,
      maxAttempts: 3,
    },
    policyGeneration: {
      name: 'policy-generation-queue',
      concurrency: 3,
      maxAttempts: 2,
    },
    indexing: {
      name: 'indexing-queue',
      concurrency: 2,
      maxAttempts: 3,
    },
  },

  /**
   * Rate limiting configuration
   */
  rateLimiting: {
    // Default rate limit window (seconds)
    defaultWindow: 60,

    // Sliding window algorithm
    slidingWindow: true,

    // Block duration after limit exceeded (seconds)
    blockDuration: 900, // 15 minutes

    // Rate limit tiers
    tiers: {
      auth: {
        login: { max: 5, window: 900 }, // 5 per 15 min
        register: { max: 3, window: 3600 }, // 3 per hour
        resetPassword: { max: 3, window: 3600 }, // 3 per hour
      },
      api: {
        default: { max: 100, window: 900 }, // 100 per 15 min
        policyGeneration: { max: 10, window: 3600 }, // 10 per hour
        complianceQuery: { max: 50, window: 3600 }, // 50 per hour
        upload: { max: 20, window: 3600 }, // 20 per hour
      },
      global: {
        max: 1000,
        window: 60,
      },
    },
  },

  /**
   * Distributed lock configuration
   * For preventing race conditions in distributed system
   */
  locks: {
    // Default lock TTL (seconds)
    defaultTTL: 30,

    // Retry configuration for lock acquisition
    retry: {
      maxAttempts: 3,
      delay: 100, // ms
    },

    // Lock types
    types: {
      documentProcessing: { ttl: 300 }, // 5 minutes
      policyGeneration: { ttl: 300 }, // 5 minutes
      userUpdate: { ttl: 10 }, // 10 seconds
    },
  },

  /**
   * Memory management
   */
  memory: {
    // Maximum memory usage (MB) before eviction
    maxMemory: 100,

    // Eviction policy
    // 'allkeys-lru': Evict any key, LRU (Least Recently Used)
    // 'volatile-lru': Evict keys with TTL, LRU
    evictionPolicy: 'allkeys-lru',

    // Warning threshold (percentage of max memory)
    warningThreshold: 80,
  },

  /**
   * Persistence configuration
   */
  persistence: {
    // Enable persistence
    enabled: appConfig.isProduction,

    // RDB snapshot configuration
    snapshot: {
      enabled: appConfig.isProduction,
      interval: 3600, // seconds (1 hour)
    },

    // AOF (Append-Only File) configuration
    aof: {
      enabled: appConfig.isProduction,
      fsync: 'everysec', // 'always' | 'everysec' | 'no'
    },
  },

  /**
   * Logging configuration
   */
  logging: {
    // Log all commands in development
    logCommands: appConfig.isDevelopment,

    // Log connection events
    logConnections: true,

    // Log errors always
    logErrors: true,

    // Log slow commands (> threshold ms)
    logSlowCommands: true,
    slowCommandThreshold: 100, // ms
  },
} as const;

/**
 * Build full cache key with prefix
 * @param prefix Key prefix
 * @param identifier Unique identifier
 * @returns Full cache key
 */
export function buildCacheKey(prefix: string, identifier: string | number): string {
  return `${prefix}${identifier}`;
}

/**
 * Build session key for user
 * @param sessionId Session ID
 * @returns Session cache key
 */
export function getSessionKey(sessionId: string): string {
  return buildCacheKey(redisConfig.keyPrefixes.session, sessionId);
}

/**
 * Build user cache key
 * @param userId User ID
 * @returns User cache key
 */
export function getUserKey(userId: string): string {
  return buildCacheKey(redisConfig.keyPrefixes.user, userId);
}

/**
 * Build policy cache key
 * @param policyId Policy ID or query hash
 * @returns Policy cache key
 */
export function getPolicyKey(policyId: string): string {
  return buildCacheKey(redisConfig.keyPrefixes.policy, policyId);
}

/**
 * Build rate limit key
 * @param identifier User ID, IP, or other identifier
 * @param action Action being rate limited
 * @returns Rate limit key
 */
export function getRateLimitKey(identifier: string, action: string): string {
  return buildCacheKey(redisConfig.keyPrefixes.rateLimit, `${identifier}:${action}`);
}

/**
 * Build notification channel for user
 * @param userId User ID
 * @returns Pub/Sub channel name
 */
export function getNotificationChannel(userId: string): string {
  return `${redisConfig.channels.notifications}${userId}`;
}

/**
 * Build policy progress channel
 * @param policyId Policy ID
 * @returns Pub/Sub channel name
 */
export function getPolicyProgressChannel(policyId: string): string {
  return `${redisConfig.channels.policyProgress}${policyId}`;
}

/**
 * Build checklist progress channel
 * @param checklistId Checklist ID
 * @returns Pub/Sub channel name
 */
export function getChecklistProgressChannel(checklistId: string): string {
  return `${redisConfig.channels.checklistProgress}${checklistId}`;
}

/**
 * Build alert SSE channel for a user
 * @param userId User ID
 * @returns Pub/Sub channel name
 */
export function getAlertChannel(userId: string): string {
  return `${redisConfig.channels.alertUser}${userId}`;
}

/**
 * Get TTL for cache type
 * @param cacheType Type of cached data
 * @returns TTL in seconds
 */
export function getTTL(cacheType: keyof typeof redisConfig.ttl): number {
  return redisConfig.ttl[cacheType] || redisConfig.ttl.default;
}

/**
 * Calculate retry delay for Redis connection
 * @param attemptNumber Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 */
export function getRetryDelay(attemptNumber: number): number {
  const { initialDelay, maxDelay, multiplier } = redisConfig.connection.retry;

  const delay = initialDelay * Math.pow(multiplier, attemptNumber - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Export type
 */
export type RedisConfig = typeof redisConfig;