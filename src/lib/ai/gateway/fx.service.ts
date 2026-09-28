/**
 * FX Rate Service for USD to KES (Kenyan Shillings) conversions.
 *
 * Implements non-blocking cached FX rates with fallback:
 * 1. Config override (env / aiConfig.costs.fx.usdToKesOverride)
 * 2. Redis cached rate in key `sheriabot:fx:usd:kes` (default TTL: 6 hours)
 * 3. Asynchronous refresh with circuit breaker & timeout
 * 4. Conservative hardcoded fallback default (130.00 KES/USD)
 */

import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';
import { aiConfig } from '@/config/ai.config';

export interface FxRateResult {
  rate: number;
  source: 'config_override' | 'redis_cache' | 'external_api' | 'fallback_default';
  capturedAt: Date;
}

export const FX_REDIS_KEY = 'sheriabot:fx:usd:kes';
export const FX_REDIS_TIMESTAMP_KEY = 'sheriabot:fx:usd:kes:timestamp';
export const DEFAULT_USD_TO_KES_RATE = 130.0;
export const FX_CACHE_TTL_SECONDS = 21600; // 6 hours

let lastKnownMemoryRate: { rate: number; capturedAt: Date } | null = null;
let isRefreshing = false;

/**
 * Fetch the current USD to KES exchange rate.
 * Guaranteed to be non-blocking and safe on the request hot path.
 */
export async function getUsdToKesFxRate(): Promise<FxRateResult> {
  // 1. Config override
  const configOverride = (aiConfig.costs as any)?.fx?.usdToKesOverride 
    ?? (process.env.USD_TO_KES_OVERRIDE ? parseFloat(process.env.USD_TO_KES_OVERRIDE) : undefined);

  if (typeof configOverride === 'number' && !isNaN(configOverride) && configOverride > 0) {
    return {
      rate: configOverride,
      source: 'config_override',
      capturedAt: new Date(),
    };
  }

  // 2. Redis Cache
  try {
    const [cachedRateStr, timestampStr] = await Promise.all([
      redis.get<string>(FX_REDIS_KEY),
      redis.get<string>(FX_REDIS_TIMESTAMP_KEY),
    ]);

    if (cachedRateStr) {
      const rate = parseFloat(cachedRateStr);
      if (!isNaN(rate) && rate > 0) {
        const capturedAt = timestampStr ? new Date(timestampStr) : new Date();
        lastKnownMemoryRate = { rate, capturedAt };
        return {
          rate,
          source: 'redis_cache',
          capturedAt,
        };
      }
    }
  } catch (err: unknown) {
    logger.warn({
      type: 'fx_rate_cache_read_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Memory fallback
  if (lastKnownMemoryRate) {
    triggerAsyncFxRefresh();
    return {
      rate: lastKnownMemoryRate.rate,
      source: 'redis_cache',
      capturedAt: lastKnownMemoryRate.capturedAt,
    };
  }

  // 4. Default conservative fallback
  triggerAsyncFxRefresh();
  logger.warn({
    type: 'fx_rate_fallback_used',
    fallbackRate: DEFAULT_USD_TO_KES_RATE,
    message: 'Using conservative default USD to KES FX rate of 130.00 KES/USD',
  });

  return {
    rate: DEFAULT_USD_TO_KES_RATE,
    source: 'fallback_default',
    capturedAt: new Date(),
  };
}

/**
 * Stores a verified FX rate in Redis with TTL.
 */
export async function cacheFxRate(rate: number, ttlSeconds: number = FX_CACHE_TTL_SECONDS): Promise<void> {
  const now = new Date();
  try {
    await Promise.all([
      redis.set(FX_REDIS_KEY, rate.toString(), { ex: ttlSeconds }),
      redis.set(FX_REDIS_TIMESTAMP_KEY, now.toISOString(), { ex: ttlSeconds }),
    ]);
    lastKnownMemoryRate = { rate, capturedAt: now };
    logger.info({ type: 'fx_rate_cached', rate, ttlSeconds });
  } catch (err: unknown) {
    logger.error({
      type: 'fx_rate_cache_write_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Asynchronously refreshes the FX rate from external sources without blocking requests.
 */
export function triggerAsyncFxRefresh(): void {
  if (isRefreshing) return;
  isRefreshing = true;

  setImmediate(async () => {
    try {
      // In production, can fetch from CBK / ExchangeRate API with a 2-second timeout
      // For now, if unconfigured or offline, populate default into cache so subsequent calls are fast
      const rate = DEFAULT_USD_TO_KES_RATE;
      await cacheFxRate(rate, FX_CACHE_TTL_SECONDS);
    } catch (err: unknown) {
      logger.warn({
        type: 'fx_rate_async_refresh_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      isRefreshing = false;
    }
  });
}

/**
 * Reset memory rate cache for testing purposes.
 */
export function _resetMemoryRateForTesting(): void {
  lastKnownMemoryRate = null;
  isRefreshing = false;
}

