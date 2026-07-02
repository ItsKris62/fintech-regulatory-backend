import { describe, expect, it, vi } from 'vitest';
import { SalesEngagementLookupService } from './engagement-lookup.service';

describe('SalesEngagementLookupService', () => {
  it('returns unavailable without a network call when there is no contact email', async () => {
    const fetchImpl = vi.fn();
    const service = new SalesEngagementLookupService({
      fetchImpl,
      configProvider: () => ({ personalApiKey: 'key', host: 'https://us.posthog.com', projectId: '1' }),
    });

    const result = await service.lookup('org-1', null);

    expect(result).toEqual({ available: false, reason: 'no_contact_email' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns unavailable without a network call when PostHog is not configured', async () => {
    const fetchImpl = vi.fn();
    const service = new SalesEngagementLookupService({
      fetchImpl,
      configProvider: () => ({}),
    });

    const result = await service.lookup('org-1', 'jane@acme.test');

    expect(result).toEqual({ available: false, reason: 'posthog_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('queries the HogQL query API read-only and parses the result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [['2026-06-30T12:00:00.000Z', 4]] }),
    });
    const service = new SalesEngagementLookupService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ personalApiKey: 'phx_test_key', host: 'https://us.posthog.com', projectId: '204451' }),
    });

    const result = await service.lookup('org-1', 'jane@acme.test');

    expect(result).toEqual({ available: true, lastSeenAt: '2026-06-30T12:00:00.000Z', eventCount7d: 4 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.posthog.com/api/projects/204451/query');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer phx_test_key' });
    const body = JSON.parse(init.body as string);
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.values.email).toBe('jane@acme.test');
    expect(body.query.query).not.toMatch(/INSERT|UPDATE|DELETE|capture/i);
  });

  it('degrades gracefully on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const service = new SalesEngagementLookupService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ personalApiKey: 'phx_test_key', host: 'https://us.posthog.com', projectId: '204451' }),
    });

    const result = await service.lookup('org-1', 'jane@acme.test');

    expect(result).toEqual({ available: false, reason: 'posthog_http_401' });
  });

  it('degrades gracefully when the request throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const service = new SalesEngagementLookupService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configProvider: () => ({ personalApiKey: 'phx_test_key', host: 'https://us.posthog.com', projectId: '204451' }),
    });

    const result = await service.lookup('org-1', 'jane@acme.test');

    expect(result).toEqual({ available: false, reason: 'posthog_request_failed' });
  });
});
