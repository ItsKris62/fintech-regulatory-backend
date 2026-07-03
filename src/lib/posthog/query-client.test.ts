import { describe, expect, it, vi } from 'vitest';
import { PostHogQueryClient } from './query-client';

describe('PostHogQueryClient', () => {
  it('returns unavailable without a network call when not configured', async () => {
    const fetchImpl = vi.fn();
    const client = new PostHogQueryClient({ fetchImpl, configProvider: () => ({}) });

    const result = await client.runHogQLQuery('SELECT 1');

    expect(result).toEqual({ available: false, reason: 'posthog_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs a read-only HogQL query and returns raw result rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [['org-1', 5], ['org-2', 2]] }),
    });
    const client = new PostHogQueryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ personalApiKey: 'phx_key', host: 'https://us.posthog.com', projectId: '204451' }),
    });

    const result = await client.runHogQLQuery('SELECT organizationId, count() FROM events GROUP BY organizationId', { window: 7 });

    expect(result).toEqual({ available: true, results: [['org-1', 5], ['org-2', 2]] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.posthog.com/api/projects/204451/query');
    const body = JSON.parse(init.body as string);
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.query).not.toMatch(/INSERT|UPDATE|DELETE|capture/i);
  });

  it('degrades gracefully on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = new PostHogQueryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ personalApiKey: 'phx_key', host: 'https://us.posthog.com', projectId: '204451' }),
    });

    const result = await client.runHogQLQuery('SELECT 1');

    expect(result).toEqual({ available: false, reason: 'posthog_http_500' });
  });

  it('degrades gracefully when the request throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const client = new PostHogQueryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ personalApiKey: 'phx_key', host: 'https://us.posthog.com', projectId: '204451' }),
    });

    const result = await client.runHogQLQuery('SELECT 1');

    expect(result).toEqual({ available: false, reason: 'posthog_request_failed' });
  });
});
