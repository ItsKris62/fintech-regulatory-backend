import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

interface StoredEntry {
  expiresAt: number;
}

/**
 * In-memory fake modeling exactly the SET key val NX EX contract: the
 * existence-check and the write happen in one synchronous pass with no
 * await between them, the same way Redis executes SET NX EX as a single
 * indivisible server-side command regardless of client transport. This is
 * what actually closes the old GET-then-SET race - not anything special
 * about this mock - and mirrors the real, already-in-production usage of the
 * identical NX/EX contract in acquireLock() (src/lib/redis-lock.ts).
 *
 * What this mock cannot prove: that Upstash's HTTP transport genuinely
 * forwards each SET NX EX to the same single-threaded Redis command
 * executor in production. That guarantee is a property of Redis itself
 * (one command at a time), independent of HTTP vs TCP dispatch, and this
 * codebase already depends on it elsewhere (redis-lock.ts's distributed
 * lock would be unsafe otherwise) - it is not something a mocked unit test
 * can independently verify.
 */
const store = vi.hoisted(() => new Map<string, StoredEntry>());

function fakeSet(key: string, opts: { ex: number; nx?: boolean }): 'OK' | null {
  const now = Date.now();
  const existing = store.get(key);
  const isLive = !!existing && existing.expiresAt > now;
  if (opts.nx && isLive) return null;
  store.set(key, { expiresAt: now + opts.ex * 1000 });
  return 'OK';
}

vi.mock('./client', () => ({
  redis: {
    set: vi.fn((key: string, _value: string, opts: { ex: number; nx?: boolean }) =>
      Promise.resolve(fakeSet(key, opts)),
    ),
  },
}));

import { notificationDedupe } from './dedupe';

describe('notificationDedupe', () => {
  beforeEach(() => {
    store.clear();
  });

  it('(a) returns true for a fresh dedupeKey', async () => {
    await expect(notificationDedupe('fresh-key', 60)).resolves.toBe(true);
  });

  it('(b) returns false for an immediate second call with the same key', async () => {
    await notificationDedupe('repeat-key', 60);
    await expect(notificationDedupe('repeat-key', 60)).resolves.toBe(false);
  });

  describe('once ttlSeconds has elapsed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('(c) returns true again - clock advanced, no real sleep', async () => {
      await expect(notificationDedupe('ttl-key', 60)).resolves.toBe(true);
      vi.setSystemTime(new Date('2026-07-22T12:01:01.000Z')); // 61s later, past the 60s TTL
      await expect(notificationDedupe('ttl-key', 60)).resolves.toBe(true);
    });
  });

  it('(d) exactly one of N concurrent first-calls on the same fresh key resolves true - the race is closed, not merely documented', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => notificationDedupe('concurrent-key', 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
