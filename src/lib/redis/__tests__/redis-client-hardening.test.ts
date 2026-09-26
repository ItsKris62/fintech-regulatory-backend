import { describe, it, expect, vi } from 'vitest';
import { redis } from '../client';

describe('F-13: Upstash Redis client hardening', () => {
  it('exported redis client aborts hanging responses and does not hang indefinitely', async () => {
    const hangingFetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((resolve, reject) => {
        if (init?.signal) {
          if (init.signal.aborted) {
            return reject(new Error('Aborted'));
          }
          init.signal.addEventListener('abort', () => {
            reject(new Error('Request aborted by signal timeout'));
          });
        }
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch;

    const start = Date.now();
    try {
      // Race against a safety timer of 3500ms. Hardened client must abort before that (configured at <= 3000ms).
      // Unhardened client has no signal and will hang indefinitely.
      const clientCall = redis.get('hanging_test_key');
      const safetyTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('FAILED_REDIS_CLIENT_HUNG_INDEFINITELY')), 3500),
      );

      await Promise.race([clientCall, safetyTimeout]);
      expect.fail('Should have aborted');
    } catch (err: any) {
      const elapsed = Date.now() - start;
      expect(err.message).not.toBe('FAILED_REDIS_CLIENT_HUNG_INDEFINITELY');
      expect(elapsed).toBeLessThan(3500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
