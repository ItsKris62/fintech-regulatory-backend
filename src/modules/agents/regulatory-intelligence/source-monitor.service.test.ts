import { describe, expect, it, vi } from 'vitest';
import { SourceMonitorService } from './source-monitor.service';
import type { RawRegulatorySourceItem } from './types';

function rateLimiter() {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

describe('SourceMonitorService', () => {
  it('registers only verified sources and does not activate manual sources marked verified', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'monitor-1' });
    const service = new SourceMonitorService({
      prisma: {
        blogSourceMonitor: { upsert, findMany: vi.fn().mockResolvedValue([]) },
        blogSourceItem: { findMany: vi.fn().mockResolvedValue([]) },
      },
      discoveryRunner: vi.fn(),
      fetchRobots: vi.fn().mockResolvedValue(null),
      rateLimiterFactory: () => rateLimiter() as unknown as import('@/lib/ai/rate-limiter').AIRateLimiter,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    await service.ensureVerifiedMonitors('run-1');

    const serializedCalls = JSON.stringify(upsert.mock.calls);
    expect(serializedCalls).toContain('Central Bank of Kenya');
    expect(serializedCalls).not.toContain('Malawi Legal Source / Gazette');
    expect(serializedCalls).not.toContain('Nigeria Official Legal/Gazette');
    expect(upsert.mock.calls.some((call) => JSON.stringify(call).includes('"monitoringMethod":"MANUAL"') && JSON.stringify(call).includes('"isActive":false'))).toBe(true);
  });

  it('checks robots and delegates HTML discovery to blog automation after per-domain rate limiting', async () => {
    const limiter = rateLimiter();
    const discoveryRunner = vi.fn().mockResolvedValue({ status: 'SUCCESS', itemsFound: 1, itemsCreated: 1, duplicateCount: 0, failureCount: 0, errorMessage: null });
    const row: RawRegulatorySourceItem = {
      id: 'item-1',
      monitorId: 'monitor-1',
      title: 'CBK Notice',
      url: 'https://www.centralbank.go.ke/notice',
      normalizedUrl: 'https://www.centralbank.go.ke/notice',
      summary: 'A regulatory notice',
      jurisdiction: 'KE',
      authorityType: 'CENTRAL_BANK',
      sourceType: 'OFFICIAL',
      publicationDate: null,
      discoveredAt: new Date('2026-07-02T00:00:00.000Z'),
      contentHash: 'hash-1',
      rawContentHash: null,
      monitorName: 'Central Bank of Kenya',
    };

    const service = new SourceMonitorService({
      prisma: {
        blogSourceMonitor: {
          upsert: vi.fn().mockResolvedValue({ id: 'monitor-1' }),
          findMany: vi.fn().mockResolvedValue([{ id: 'monitor-1', name: 'Central Bank of Kenya', baseUrl: 'https://www.centralbank.go.ke', feedUrl: null, monitoringMethod: 'HTML_LISTING', maxItemsPerRun: 20, fetchTimeoutMs: 15000 }]),
        },
        blogSourceItem: {
          findMany: vi.fn().mockResolvedValue([{ ...row, monitor: { name: row.monitorName } }]),
        },
      },
      discoveryRunner,
      fetchRobots: vi.fn().mockResolvedValue('User-agent: *\nAllow: /'),
      rateLimiterFactory: () => limiter as unknown as import('@/lib/ai/rate-limiter').AIRateLimiter,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const result = await service.scanSources('run-1');

    expect(limiter.acquire).toHaveBeenCalledOnce();
    expect(limiter.release).toHaveBeenCalledOnce();
    expect(discoveryRunner).toHaveBeenCalledWith(expect.objectContaining({ monitorId: 'monitor-1', triggeredBy: 'SYSTEM' }));
    expect(result.items).toHaveLength(1);
    expect(result.unverifiedSourceGaps).toHaveLength(4);
  });
});