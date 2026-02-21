import { appConfig } from './app.config';

/**
 * Database configuration for Prisma
 * Optimized for Railway PostgreSQL deployment
 */
export const databaseConfig = {
  /**
   * Database connection URL
   */
  url: appConfig.database.url,

  /**
   * Connection pool settings for Railway
   * Railway free tier has connection limits, so we optimize pool size
   */
  pool: {
    // Maximum number of connections in the pool
    // Railway free tier: keep this low (5-10)
    connectionLimit: 5,

    // Timeout for acquiring connection from pool (seconds)
    poolTimeout: 20,

    // Idle timeout - close idle connections after this time (seconds)
    idleTimeout: 30,

    // Connection timeout (seconds)
    connectionTimeout: 10,
  },

  /**
   * Query logging configuration
   * Enable detailed logging in development for debugging
   */
  logging: {
    // Log all queries in development
    queries: appConfig.isDevelopment,

    // Log slow queries (> 1 second) in production
    slowQueries: appConfig.isProduction,
    slowQueryThreshold: 1000, // milliseconds

    // Log errors always
    errors: true,
  },

  /**
   * Retry logic for connection failures
   * Useful for handling temporary network issues
   */
  retry: {
    // Number of retry attempts
    maxRetries: 3,

    // Initial delay between retries (ms)
    initialDelay: 1000,

    // Maximum delay between retries (ms)
    maxDelay: 5000,

    // Exponential backoff multiplier
    backoffMultiplier: 2,
  },

  /**
   * Migration settings
   */
  migrations: {
    // Auto-apply migrations in development
    autoApply: appConfig.isDevelopment,

    // Migration table name
    tableName: '_prisma_migrations',
  },

  /**
   * Performance optimizations
   */
  performance: {
    // Enable connection pooling
    pooling: true,

    // Enable query batching (experimental)
    batching: false,

    // Enable statement caching
    statementCaching: true,
  },
} as const;

/**
 * Generate Prisma datasource URL with connection pool parameters
 * Adds connection pool settings as query parameters
 */
export function getDatasourceUrl(): string {
  const url = new URL(appConfig.database.url);

  // Add connection pool parameters
  url.searchParams.set('connection_limit', databaseConfig.pool.connectionLimit.toString());
  url.searchParams.set('pool_timeout', databaseConfig.pool.poolTimeout.toString());

  // Add statement caching for better performance
  if (databaseConfig.performance.statementCaching) {
    url.searchParams.set('statement_cache_size', '100');
  }

  return url.toString();
}

/**
 * Get retry delay with exponential backoff
 * @param attemptNumber Current attempt number (1-indexed)
 * @returns Delay in milliseconds
 */
export function getRetryDelay(attemptNumber: number): number {
  const { initialDelay, maxDelay, backoffMultiplier } = databaseConfig.retry;

  const delay = initialDelay * Math.pow(backoffMultiplier, attemptNumber - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Database health check query
 * Simple query to verify database connectivity
 */
export const healthCheckQuery = 'SELECT 1 as health';

/**
 * Export type
 */
export type DatabaseConfig = typeof databaseConfig;