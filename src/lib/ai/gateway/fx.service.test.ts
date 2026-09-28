import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUsdToKesFxRate, cacheFxRate, DEFAULT_USD_TO_KES_RATE, FX_REDIS_KEY, _resetMemoryRateForTesting } from './fx.service';
import { redis } from '@/lib/redis/client';

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('FX Service Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMemoryRateForTesting();
    delete process.env.USD_TO_KES_OVERRIDE;
  });

  it('uses config override when USD_TO_KES_OVERRIDE is provided', async () => {
    process.env.USD_TO_KES_OVERRIDE = '135.50';

    const fx = await getUsdToKesFxRate();
    expect(fx.rate).toBe(135.50);
    expect(fx.source).toBe('config_override');
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('returns cached rate from Redis when available', async () => {
    vi.mocked(redis.get)
      .mockResolvedValueOnce('129.75' as never) // rate
      .mockResolvedValueOnce(new Date('2026-09-28T08:00:00Z').toISOString() as never); // timestamp

    const fx = await getUsdToKesFxRate();
    expect(fx.rate).toBe(129.75);
    expect(fx.source).toBe('redis_cache');
    expect(fx.capturedAt).toEqual(new Date('2026-09-28T08:00:00Z'));
  });

  it('falls back to default conservative rate (130.00) when Redis is empty or throws', async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('Redis connection timeout'));

    const fx = await getUsdToKesFxRate();
    expect(fx.rate).toBe(DEFAULT_USD_TO_KES_RATE);
    expect(fx.source).toBe('fallback_default');
  });

  it('writes verified FX rate to Redis with TTL', async () => {
    await cacheFxRate(132.50, 3600);
    expect(redis.set).toHaveBeenCalledWith(FX_REDIS_KEY, '132.5', { ex: 3600 });
  });
});
