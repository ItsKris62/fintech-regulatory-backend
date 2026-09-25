import { PrismaClient, Prisma } from '@prisma/client';
import { databaseConfig, getRetryDelay } from '@/config/database.config';
import { appConfig } from '@/config/app.config';
import { logger, logDatabaseQuery } from '@/utils/logger';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg'

/**
 * Extended Prisma Client with custom types
 */
declare global {
  var prisma: ExtendedPrismaClient | undefined;
}

/**
 * Models that support soft delete via deletedAt column
 */
const SOFT_DELETE_MODELS = ['User', 'Policy', 'LegalDocument'] as const;
type SoftDeleteModel = (typeof SOFT_DELETE_MODELS)[number];

export function isSoftDeleteModel(model?: string): model is SoftDeleteModel {
  return SOFT_DELETE_MODELS.includes(model as SoftDeleteModel);
}

/**
 * Get Prisma log configuration based on environment
 */
function getLogConfig(): (Prisma.LogLevel | Prisma.LogDefinition)[] {
  if (appConfig.isDevelopment) {
    return [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ];
  }

  if (databaseConfig.logging.slowQueries) {
    return [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ];
  }

  return [{ emit: 'event', level: 'error' }];
}

/**
 * Create base Prisma Client then extend with query middleware.
 *
 * Prisma v7 removed $use()  -  all middleware is now done via $extends().
 * The datasource URL is read from prisma.config.ts / schema.prisma
 * (no more `datasources` constructor property).
 */
function createPrismaClient() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=10000',
  });

  // Guard against managed Postgres / PgBouncer poolers that strip startup parameter options
  pool.on('connect', (client) => {
    client.query('SET statement_timeout = 15000; SET idle_in_transaction_session_timeout = 10000;').catch((err) => {
      logger.warn({ type: 'pg_pool_session_timeout_init_failed', error: err?.message });
    });
  });

  const adapter = new PrismaPg(pool);

  const base = new PrismaClient({
  adapter,
  log: getLogConfig(),
  errorFormat: 'pretty',
});

  // --- Event listeners (still supported in v7) ---
  if (databaseConfig.logging.queries) {
    base.$on('query' as never, (e: any) => {
      logger.debug({
        type: 'prisma_query',
        query: e.query,
        params: e.params,
        duration: e.duration,
      });
    });
  }

  if (databaseConfig.logging.errors) {
    base.$on('error' as never, (e: any) => {
      logger.error({
        type: 'prisma_error',
        message: e.message,
        target: e.target,
      });
    });
  }

  base.$on('warn' as never, (e: any) => {
    logger.warn({
      type: 'prisma_warning',
      message: e.message,
    });
  });

  // --- Extensions replace $use() middleware ---
  const extended = base.$extends({
    query: {
      $allModels: {
        // Query performance tracking
        async $allOperations({ model, operation, args, query }) {
          const startTime = Date.now();
          const result = await query(args);
          const duration = Date.now() - startTime;

          logDatabaseQuery(operation, model ?? 'unknown', duration, {
            args: databaseConfig.logging.queries ? '[query args enabled]' : undefined,
          });

          return result;
        },
      },

      // Soft delete: intercept delete -> update with deletedAt
      user: {
        async delete({ args, query: _query }) {
          return (base.user as any).update({
            ...args,
            data: { deletedAt: new Date() } as any,
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.user.updateMany({
            ...args,
            data: { deletedAt: new Date() } as any,
          });
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: (args.where as any)?.deletedAt ?? null } as any;
          return query(args);
        },
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: (args.where as any)?.deletedAt ?? null } as any;
          return query(args);
        },
        async findUnique({ args, query }) {
          return query(args);
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: (args.where as any)?.deletedAt ?? null } as any;
          return query(args);
        },
      },

      legalDocument: {
        async delete({ args, query: _query }) {
          return (base.legalDocument as any).update({
            ...args,
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.legalDocument.updateMany({
            ...args,
            data: { deletedAt: new Date() },
          });
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findUnique({ args, query }) {
          return query(args);
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
      },

      policy: {
        async delete({ args, query: _query }) {
          return base.policy.update({
            ...args,
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.policy.updateMany({
            ...args,
            data: { deletedAt: new Date() },
          });
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findUnique({ args, query }) {
          return query(args);
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
      },
    },
  });

  return extended;
}

/** Type of the extended client */
type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * Singleton Prisma Client
 * Reuses connection in development (hot reload)
 */
export const prisma = global.prisma || createPrismaClient();

if (appConfig.isDevelopment) {
  global.prisma = prisma;
}

/**
 * Connect to database with retry logic
 */
export async function connectDatabase(maxRetries: number = 5): Promise<void> {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      attempt++;
      logger.info(`Attempting database connection (attempt ${attempt}/${maxRetries})...`);

      await prisma.$connect();

      logger.info('Database connected successfully');
      return;
    } catch (error: any) {
      logger.error({
        type: 'db_connection_error',
        attempt,
        error: error.message,
      });

      if (attempt >= maxRetries) {
        logger.error('Failed to connect to database after maximum retries');
        throw new Error('Database connection failed');
      }

      const delay = getRetryDelay(attempt);
      logger.info(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Disconnect from database  -  called during graceful shutdown
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Database disconnected');
  } catch (error: any) {
    logger.error({
      type: 'db_disconnect_error',
      error: error.message,
    });
  }
}

/**
 * Check database health
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1 as health`;
    return true;
  } catch (error) {
    logger.error({
      type: 'db_health_check_failed',
      error,
    });
    return false;
  }
}

/**
 * Get database connection stats.
 * Prisma v7 removed $metrics  -  we use a connectivity check instead.
 */
export async function getDatabaseStats(): Promise<{
  connected: boolean;
  poolSize: number;
}> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      connected: true,
      poolSize: databaseConfig.pool.connectionLimit,
    };
  } catch {
    return {
      connected: false,
      poolSize: 0,
    };
  }
}

/**
 * Transaction helper with automatic retry on serialization errors
 */
export async function transaction<T>(
  callback: (tx: Omit<ExtendedPrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      attempt++;
      return await prisma.$transaction(async (tx) => {
        return await callback(tx as any);
      });
    } catch (error: any) {
      const retryableCodes = ['P2034', 'P2028'];

      if (retryableCodes.includes(error.code) && attempt < maxRetries) {
        const delay = getRetryDelay(attempt);
        logger.warn({
          type: 'transaction_retry',
          attempt,
          error: error.message,
          retryIn: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw new Error('Transaction failed after maximum retries');
}

/**
 * Batch operation helper  -  splits large operations to avoid timeouts
 */
export async function batchOperation<T, R>(
  items: T[],
  batchSize: number,
  callback: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await callback(batch);
    results.push(...batchResults);

    logger.debug({
      type: 'batch_operation_progress',
      processed: Math.min(i + batchSize, items.length),
      total: items.length,
    });
  }

  return results;
}

/**
 * Soft delete helper (manual  -  bypasses middleware)
 */
export async function softDelete(
  model: keyof typeof prisma,
  where: any
): Promise<number> {
  const result = await (prisma[model] as any).updateMany({
    where,
    data: { deletedAt: new Date() },
  });

  return result.count;
}

/**
 * Restore soft deleted records
 */
export async function restoreSoftDeleted(
  model: keyof typeof prisma,
  where: any
): Promise<number> {
  const result = await (prisma[model] as any).updateMany({
    where: {
      ...where,
      deletedAt: { not: null },
    },
    data: { deletedAt: null },
  });

  return result.count;
}

/**
 * Count records with optional filters
 */
export async function countRecords(
  model: keyof typeof prisma,
  where?: any
): Promise<number> {
  return await (prisma[model] as any).count({ where });
}

/**
 * Paginated query helper
 */
export async function findPaginated<T>(
  model: keyof typeof prisma,
  page: number = 1,
  limit: number = 10,
  where?: any,
  orderBy?: any,
  include?: any
): Promise<{ data: T[]; total: number; page: number; pages: number }> {
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    (prisma[model] as any).findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include,
    }),
    (prisma[model] as any).count({ where }),
  ]);

  return {
    data,
    total,
    page,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Clean up on shutdown
 */
process.on('beforeExit', async () => {
  await disconnectDatabase();
});

/**
 * Executes a transaction with an explicit elevated statement_timeout (via SET LOCAL).
 * Used for legitimate long-running admin or cron batch jobs (e.g. reconciliation)
 * without raising the global pool-level statement_timeout.
 *
 * NOTE ON $executeRawUnsafe:
 * PostgreSQL grammar strictly prohibits prepared-statement parameter placeholders ($1)
 * for SET/SET LOCAL configuration commands (e.g. `SET LOCAL statement_timeout = $1` results in syntax error 42601).
 * Therefore, raw string construction is required. SQL injection is completely prevented by validating
 * that timeoutMs is a finite number and clamping it to a strictly bounded integer [1000ms, 300000ms].
 */
export async function withElevatedStatementTimeout<T>(
  timeoutMs: number,
  callback: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.floor(Math.max(1000, Math.min(timeoutMs, 300000)))
    : 15000;

  if (!Number.isFinite(timeoutMs) || timeoutMs !== boundedTimeoutMs) {
    logger.warn({
      type: 'elevated_statement_timeout_clamped',
      requestedTimeoutMs: timeoutMs,
      clampedTimeoutMs: boundedTimeoutMs,
    });
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${boundedTimeoutMs}`);
    return callback(tx);
  });
}

// Export types
export type { ExtendedPrismaClient };
export type TransactionClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;
