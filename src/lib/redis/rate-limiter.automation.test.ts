import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory fake of the Upstash sorted-set operations RateLimiter.check()
 * pipelines (zremrangebyscore, zcard, zadd, expire, then a standalone
 * zrange). Proves the automation-log / automation-generate buckets actually
 * reject the (max+1)th request within their configured window  -  not just
 * that appConfig exposes the numbers and the router references them.
 */
const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, Map<string, number>>();

  function zremrangebyscore(key: string, min: number, max: number): number {
    const set = store.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of [...set.entries()]) {
      if (score >= min && score <= max) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  }

  return {
    reset: () => store.clear(),
    pipeline: () => {
      const ops: Array<() => unknown> = [];
      const chain = {
        zremrangebyscore(key: string, min: number, max: number) {
          ops.push(() => zremrangebyscore(key, min, max));
          return chain;
        },
        zcard(key: string) {
          ops.push(() => store.get(key)?.size ?? 0);
          return chain;
        },
        zadd(key: string, entry: { score: number; member: string }) {
          ops.push(() => {
            if (!store.has(key)) store.set(key, new Map());
            store.get(key)!.set(entry.member, entry.score);
            return 1;
          });
          return chain;
        },
        expire() {
          ops.push(() => 1);
          return chain;
        },
        exec: async () => ops.map((op) => op()),
      };
      return chain;
    },
    zrange: async (key: string) => {
      const set = store.get(key);
      if (!set || set.size === 0) return [];
      const [member, score] = [...set.entries()].sort((a, b) => a[1] - b[1])[0];
      return [{ member, score }];
    },
  };
});

vi.mock('./client', () => ({ redis: fakeRedis }));

import { rateLimiter } from './rate-limiter';
import { appConfig } from '@/config/app.config';

describe('automation rate-limit buckets reject the (max+1)th request', () => {
  beforeEach(() => {
    fakeRedis.reset();
    // RateLimiter.check() members its sliding-window ZADD entry by
    // `${Date.now()}`. A synchronous in-memory test loop can otherwise call
    // Date.now() many times within the same millisecond, colliding on the
    // same member (exactly like a real ZADD with a duplicate member would)
    // and never growing the window. Force a distinct millisecond per call.
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock++);
  });

  afterEach(() => vi.restoreAllMocks());

  it('rejects past AUTOMATION_LOG_RATE_LIMIT_MAX, independent of the shared agent-auth bucket', async () => {
    const identifier = 'automation-log-test-identifier';
    const { logRateLimitMax, logRateLimitWindowSeconds } = appConfig.agents.automation;

    for (let i = 0; i < logRateLimitMax; i++) {
      const result = await rateLimiter.check(identifier, 'automation-log', logRateLimitMax, logRateLimitWindowSeconds);
      expect(result.allowed).toBe(true);
    }

    const overLimit = await rateLimiter.check(identifier, 'automation-log', logRateLimitMax, logRateLimitWindowSeconds);
    expect(overLimit.allowed).toBe(false);

    // Same identifier, unrelated bucket (the shared credential-verification
    // rate limit in requireAgentCapability): must not be affected by the
    // automation-log bucket being exhausted.
    const authBucket = await rateLimiter.check(identifier, 'agent-auth', 20, 60);
    expect(authBucket.allowed).toBe(true);
  });

  it('rejects past AUTOMATION_GENERATE_RATE_LIMIT_MAX, using its own configured window', async () => {
    const identifier = 'automation-generate-test-identifier';
    const { generateRateLimitMax, generateRateLimitWindowSeconds } = appConfig.agents.automation;

    for (let i = 0; i < generateRateLimitMax; i++) {
      const result = await rateLimiter.check(identifier, 'automation-generate', generateRateLimitMax, generateRateLimitWindowSeconds);
      expect(result.allowed).toBe(true);
    }

    const overLimit = await rateLimiter.check(identifier, 'automation-generate', generateRateLimitMax, generateRateLimitWindowSeconds);
    expect(overLimit.allowed).toBe(false);
  });

  it('keeps the log and generate buckets independent for the same identifier', async () => {
    const identifier = 'automation-shared-identifier';
    const { logRateLimitMax, logRateLimitWindowSeconds } = appConfig.agents.automation;

    for (let i = 0; i < logRateLimitMax; i++) {
      await rateLimiter.check(identifier, 'automation-log', logRateLimitMax, logRateLimitWindowSeconds);
    }
    const logOverLimit = await rateLimiter.check(identifier, 'automation-log', logRateLimitMax, logRateLimitWindowSeconds);
    expect(logOverLimit.allowed).toBe(false);

    const { generateRateLimitMax, generateRateLimitWindowSeconds } = appConfig.agents.automation;
    const generateStillAllowed = await rateLimiter.check(identifier, 'automation-generate', generateRateLimitMax, generateRateLimitWindowSeconds);
    expect(generateStillAllowed.allowed).toBe(true);
  });
});
