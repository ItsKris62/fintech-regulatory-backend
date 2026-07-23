import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, { value: string; expiresAt: number | null }>());

const fakeRedis = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      store.delete(key);
      return null;
    }
    return JSON.parse(entry.value);
  }),
  set: vi.fn(async (key: string, value: string, opts?: { ex?: number }) => {
    store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : null });
    return 'OK';
  }),
}));

vi.mock('@/lib/redis/client', () => ({ redis: fakeRedis }));

import { SentryQueryService } from './sentry-query.service';

describe('SentryQueryService', () => {
  beforeEach(() => {
    store.clear();
    fakeRedis.get.mockClear();
    fakeRedis.set.mockClear();
  });

  it('reports unavailable without a network call when Sentry is not configured', async () => {
    const fetchImpl = vi.fn();
    const service = new SentryQueryService({
      fetchImpl,
      configProvider: () => ({}),
    });

    const result = await service.checkCriticalIssues();

    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a critical issue when an unresolved fatal/error-level issue exists', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { level: 'error', status: 'unresolved', count: '12' },
        { level: 'warning', status: 'unresolved', count: '3' },
      ],
    });
    const service = new SentryQueryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ apiToken: 'token', org: 'veriwoks', project: 'sheriabot-backend' }),
    });

    const result = await service.checkCriticalIssues();

    expect(result).toEqual({ hasCriticalIssue: true, dataAvailable: true });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/veriwoks/sheriabot-backend/issues/');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('reports a confirmed-clean check when no unresolved fatal/error issues exist', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ level: 'warning', status: 'unresolved', count: '3' }],
    });
    const service = new SentryQueryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ apiToken: 'token', org: 'veriwoks', project: 'sheriabot-backend' }),
    });

    const result = await service.checkCriticalIssues();

    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: true });
  });

  it('does not treat a resolved fatal issue as critical', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ level: 'fatal', status: 'resolved', count: '1' }],
    });
    const service = new SentryQueryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ apiToken: 'token', org: 'veriwoks', project: 'sheriabot-backend' }),
    });

    const result = await service.checkCriticalIssues();

    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: true });
  });

  it('degrades to dataAvailable: false, not a fabricated clean result, on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const service = new SentryQueryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ apiToken: 'bad-token', org: 'veriwoks', project: 'sheriabot-backend' }),
    });

    const result = await service.checkCriticalIssues();

    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: false });
  });

  it('degrades to dataAvailable: false on a timeout/network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const service = new SentryQueryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ apiToken: 'token', org: 'veriwoks', project: 'sheriabot-backend' }),
    });

    const result = await service.checkCriticalIssues();

    expect(result).toEqual({ hasCriticalIssue: false, dataAvailable: false });
  });

  it('does not re-call Sentry on a cache hit within the TTL window', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ level: 'error', status: 'unresolved', count: '1' }],
    });
    const service = new SentryQueryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ apiToken: 'token', org: 'veriwoks', project: 'sheriabot-backend' }),
    });

    const first = await service.checkCriticalIssues();
    const second = await service.checkCriticalIssues();

    expect(first).toEqual({ hasCriticalIssue: true, dataAvailable: true });
    expect(second).toEqual({ hasCriticalIssue: true, dataAvailable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
