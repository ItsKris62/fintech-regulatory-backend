import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Same in-memory fake of the Upstash sorted-set operations used by
 * rate-limiter.automation.test.ts - proves the six n8n scheduler-trigger
 * buckets actually reject the (max+1)th request within their configured
 * window, and stay independent of each other and of the agent-auth bucket.
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

describe('scheduler-trigger rate-limit buckets reject the (max+1)th request', () => {
  beforeEach(() => {
    fakeRedis.reset();
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock++);
  });

  afterEach(() => vi.restoreAllMocks());

  it('rejects past AGENT_TRIGGER_RATE_LIMIT_MAX, independent of the shared agent-auth bucket', async () => {
    const identifier = 'agent-trigger-regIntel-runScan-test-identifier';
    const { rateLimitMax, rateLimitWindowSeconds } = appConfig.agents.trigger;

    for (let i = 0; i < rateLimitMax; i++) {
      const result = await rateLimiter.check(identifier, 'agent-trigger-regIntel-runScan', rateLimitMax, rateLimitWindowSeconds);
      expect(result.allowed).toBe(true);
    }

    const overLimit = await rateLimiter.check(identifier, 'agent-trigger-regIntel-runScan', rateLimitMax, rateLimitWindowSeconds);
    expect(overLimit.allowed).toBe(false);

    const authBucket = await rateLimiter.check(identifier, 'agent-auth', 20, 60);
    expect(authBucket.allowed).toBe(true);
  });

  it('keeps each of the six trigger buckets independent for the same identifier', async () => {
    const identifier = 'agent-trigger-shared-identifier';
    const { rateLimitMax, rateLimitWindowSeconds } = appConfig.agents.trigger;

    for (let i = 0; i < rateLimitMax; i++) {
      await rateLimiter.check(identifier, 'agent-trigger-marketing-runDrafting', rateLimitMax, rateLimitWindowSeconds);
    }
    const marketingOverLimit = await rateLimiter.check(identifier, 'agent-trigger-marketing-runDrafting', rateLimitMax, rateLimitWindowSeconds);
    expect(marketingOverLimit.allowed).toBe(false);

    const salesStillAllowed = await rateLimiter.check(identifier, 'agent-trigger-sales-runDrafting', rateLimitMax, rateLimitWindowSeconds);
    expect(salesStillAllowed.allowed).toBe(true);
  });
});
