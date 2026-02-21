import { prisma, connectDatabase, disconnectDatabase } from '@/lib/prisma/client';
import { redis, disconnectRedis, checkRedisHealth } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export interface ConnectionStatus {
  database: boolean;
  redis: boolean;
  overall: 'ok' | 'degraded' | 'down';
}

/**
 * Centralized connection lifecycle manager.
 * Connects / disconnects all external services and reports aggregate health.
 */
class ConnectionManager {
  private started = false;

  /**
   * Connect to all external services.
   * Throws if the database cannot be reached (critical).
   * Redis failure degrades but does not block startup.
   */
  async connectAll(): Promise<ConnectionStatus> {
    if (this.started) {
      logger.warn({ type: 'connection_manager' }, 'connectAll called more than once');
    }

    const status: ConnectionStatus = { database: false, redis: false, overall: 'down' };

    // Database — critical, must succeed
    try {
      await connectDatabase(5);
      status.database = true;
      logger.info({ type: 'connection_manager' }, 'Database connected');
    } catch (err) {
      logger.error(
        { type: 'connection_manager', service: 'database', error: (err as Error).message },
        'Database connection failed — aborting startup'
      );
      throw err;
    }

    // Redis — important but not blocking
    try {
      await redis.ping();
      status.redis = true;
      logger.info({ type: 'connection_manager' }, 'Redis connected');
    } catch (err) {
      logger.warn(
        { type: 'connection_manager', service: 'redis', error: (err as Error).message },
        'Redis connection failed — running in degraded mode'
      );
    }

    status.overall = status.database && status.redis ? 'ok' : status.database ? 'degraded' : 'down';
    this.started = true;

    logger.info(
      { type: 'connection_manager', status },
      `All connections established — status: ${status.overall}`
    );

    return status;
  }

  /**
   * Gracefully disconnect from all services.
   * Call from shutdown handler.
   */
  async disconnectAll(): Promise<void> {
    logger.info({ type: 'connection_manager' }, 'Disconnecting all services...');

    const results = await Promise.allSettled([
      disconnectDatabase(),
      disconnectRedis(),
    ]);

    for (const [i, result] of results.entries()) {
      const service = ['database', 'redis'][i];
      if (result.status === 'rejected') {
        logger.error(
          { type: 'connection_manager', service, error: (result.reason as Error).message },
          `Failed to disconnect ${service}`
        );
      }
    }

    this.started = false;
    logger.info({ type: 'connection_manager' }, 'All services disconnected');
  }

  /**
   * Probe current health of each service (used by health check endpoints).
   */
  async healthCheck(): Promise<ConnectionStatus> {
    const status: ConnectionStatus = { database: false, redis: false, overall: 'down' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      status.database = true;
    } catch {
      // database unreachable
    }

    try {
      status.redis = await checkRedisHealth();
    } catch {
      // redis unreachable
    }

    status.overall =
      status.database && status.redis ? 'ok' : status.database ? 'degraded' : 'down';

    return status;
  }
}

export const connectionManager = new ConnectionManager();
export { ConnectionManager };
