import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAuthOptionsRateLimitKey,
  checkRateLimit,
  checkAuthOptionsRateLimit,
  getAuthOptionsRateLimits,
} from './webauthn-rate-limit';

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    incr: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
}));

describe('webauthn-rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WEBAUTHN_AUTH_OPTS_RATE_LIMIT_MAX;
    delete process.env.WEBAUTHN_AUTH_OPTS_RATE_LIMIT_WINDOW_SECONDS;
  });

  describe('buildAuthOptionsRateLimitKey', () => {
    it('returns a key containing the real IP when valid IPv4 is provided', () => {
      const key = buildAuthOptionsRateLimitKey({ ip: '198.51.100.25' });
      expect(key).toBe('sheriabot:passkey:rl:auth_opts:198.51.100.25');
    });

    it('returns a key containing the real IP when valid IPv6 is provided', () => {
      const key = buildAuthOptionsRateLimitKey({ ip: '2001:db8::1' });
      expect(key).toBe('sheriabot:passkey:rl:auth_opts:2001:db8::1');
    });

    it('includes stable session hash when sessionIdentifier is provided', () => {
      const key1 = buildAuthOptionsRateLimitKey({
        ip: '198.51.100.25',
        sessionIdentifier: 'user_session_abc123',
      });
      const key2 = buildAuthOptionsRateLimitKey({
        ip: '198.51.100.25',
        sessionIdentifier: 'user_session_abc123',
      });
      const key3 = buildAuthOptionsRateLimitKey({
        ip: '198.51.100.25',
        sessionIdentifier: 'different_session_xyz',
      });

      expect(key1).toMatch(/^sheriabot:passkey:rl:auth_opts:198\.51\.100\.25:[a-f0-9]{16}$/);
      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });

    it('returns null for missing, null, undefined, or unknown IP', () => {
      expect(buildAuthOptionsRateLimitKey({ ip: null })).toBeNull();
      expect(buildAuthOptionsRateLimitKey({ ip: undefined })).toBeNull();
      expect(buildAuthOptionsRateLimitKey({ ip: '' })).toBeNull();
      expect(buildAuthOptionsRateLimitKey({ ip: 'unknown' })).toBeNull();
      expect(buildAuthOptionsRateLimitKey({ ip: 'invalid.ip.format' })).toBeNull();
    });
  });

  describe('getAuthOptionsRateLimits', () => {
    it('uses default values (30 max, 900s window) when env vars are not set', () => {
      const limits = getAuthOptionsRateLimits();
      expect(limits.max).toBe(30);
      expect(limits.windowSec).toBe(900);
    });

    it('uses configured values when env vars are set', () => {
      process.env.WEBAUTHN_AUTH_OPTS_RATE_LIMIT_MAX = '50';
      process.env.WEBAUTHN_AUTH_OPTS_RATE_LIMIT_WINDOW_SECONDS = '1200';

      const limits = getAuthOptionsRateLimits();
      expect(limits.max).toBe(50);
      expect(limits.windowSec).toBe(1200);
    });
  });

  describe('checkRateLimit', () => {
    it('allows requests within max threshold and sets expire on first increment', async () => {
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);

      const res = await checkRateLimit({
        key: 'test_key',
        max: 30,
        windowSec: 900,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(29);
      expect(mockRedis.incr).toHaveBeenCalledWith('test_key');
      expect(mockRedis.expire).toHaveBeenCalledWith('test_key', 900);
    });

    it('blocks requests exceeding max threshold', async () => {
      mockRedis.incr.mockResolvedValue(31);

      const res = await checkRateLimit({
        key: 'test_key',
        max: 30,
        windowSec: 900,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('fails closed when Redis throws an error', async () => {
      mockRedis.incr.mockRejectedValue(new Error('Redis connection down'));

      const res = await checkRateLimit({
        key: 'test_key',
        max: 30,
        windowSec: 900,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });
  });

  describe('checkAuthOptionsRateLimit', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('fails closed in production when IP is missing or invalid', async () => {
      process.env.NODE_ENV = 'production';

      const res = await checkAuthOptionsRateLimit({ ip: null });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('allows with warning in development/test when IP is missing', async () => {
      process.env.NODE_ENV = 'test';

      const res = await checkAuthOptionsRateLimit({ ip: null });
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(30);
    });

    it('rate limits against the real IP when provided', async () => {
      mockRedis.incr.mockResolvedValue(5);

      const res = await checkAuthOptionsRateLimit({ ip: '198.51.100.42' });
      expect(mockRedis.incr).toHaveBeenCalledWith('sheriabot:passkey:rl:auth_opts:198.51.100.42');
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(25);
    });
  });
});
