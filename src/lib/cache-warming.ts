import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

/**
 * Startup cache warming.
 * Pre-loads frequently accessed data from the database into Redis.
 * Failures are logged but never block application startup.
 */

async function warmFeatureFlags(): Promise<number> {
  try {
    const flags = await prisma.featureFlag.findMany();

    for (const flag of flags) {
      await redis.set(
        `feature_flag:${flag.name}`,
        JSON.stringify({
          enabled: flag.enabled,
          description: flag.description,
        })
      );
    }

    return flags.length;
  } catch (err) {
    logger.warn(
      { type: 'cache_warming', target: 'feature_flags', error: (err as Error).message },
      'Failed to warm feature flags'
    );
    return 0;
  }
}

async function warmSystemConfigs(): Promise<number> {
  try {
    const configs = await prisma.systemConfig.findMany();

    for (const config of configs) {
      await redis.set(
        `system_config:${config.key}`,
        JSON.stringify({ value: config.value, description: config.description })
      );
    }

    return configs.length;
  } catch (err) {
    logger.warn(
      { type: 'cache_warming', target: 'system_configs', error: (err as Error).message },
      'Failed to warm system configs'
    );
    return 0;
  }
}

/**
 * Run all cache warming tasks.
 * Call after database and Redis are connected.
 */
export async function warmCaches(): Promise<void> {
  const start = Date.now();

  logger.info({ type: 'cache_warming' }, 'Starting cache warming...');

  const [flagCount, configCount] = await Promise.all([
    warmFeatureFlags(),
    warmSystemConfigs(),
  ]);

  const duration = Date.now() - start;

  logger.info(
    {
      type: 'cache_warming',
      featureFlags: flagCount,
      systemConfigs: configCount,
      durationMs: duration,
    },
    `Cache warming complete in ${duration}ms  -  ${flagCount} flags, ${configCount} configs`
  );
}
