import { describe, expect, it, vi } from 'vitest';
import { AutomationSourcesService } from './sources.service';

const NOW = new Date('2026-07-22T12:00:00.000Z');

describe('AutomationSourcesService.getSources', () => {
  it('maps publisher -> regulator and filters by valid jurisdictions only', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 's1', url: 'https://cbk.go.ke/notice', title: 'CBK Notice', summary: 'Summary', publicationDate: NOW, jurisdiction: 'KE', publisher: 'Central Bank of Kenya' },
    ]);
    const service = new AutomationSourcesService({ prisma: { blogSourceItem: { findMany } } as never, now: () => NOW });

    const result = await service.getSources({ jurisdictions: 'KE' });

    expect(result).toEqual({
      sources: [{ id: 's1', url: 'https://cbk.go.ke/notice', title: 'CBK Notice', summary: 'Summary', publicationDate: NOW.toISOString(), jurisdiction: 'KE', regulator: 'Central Bank of Kenya' }],
    });
  });

  it('returns an empty list, without querying, when every requested jurisdiction is invalid', async () => {
    const findMany = vi.fn();
    const service = new AutomationSourcesService({ prisma: { blogSourceItem: { findMany } } as never, now: () => NOW });

    const result = await service.getSources({ jurisdictions: 'Kenya' }); // free-text, not a valid BlogJurisdiction enum value
    expect(result).toEqual({ sources: [] });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('AutomationSourcesService.fetchSource', () => {
  it('rejects an invalid jurisdiction before attempting to fetch', async () => {
    const fetchImpl = vi.fn();
    const service = new AutomationSourcesService({ fetchImpl, now: () => NOW });
    await expect(service.fetchSource({ url: 'https://example.com', sourceId: 's1', jurisdiction: 'Kenya' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches, strips HTML, and returns a stable content hash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body><p>Hello   world</p></body></html>') });
    const service = new AutomationSourcesService({ fetchImpl, now: () => NOW });

    const result = await service.fetchSource({ url: 'https://example.com', sourceId: 's1', jurisdiction: 'KE' });

    expect(result.normalizedContent).toBe('Hello world');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceId).toBe('s1');
    expect(result.fetchedAt).toBe(NOW.toISOString());
  });

  it('throws BAD_GATEWAY on a non-2xx response rather than returning empty content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const service = new AutomationSourcesService({ fetchImpl, now: () => NOW });
    await expect(service.fetchSource({ url: 'https://example.com', sourceId: 's1', jurisdiction: 'KE' })).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });
});

describe('AutomationSourcesService.dedupeSource', () => {
  it('reports isNew:true when no row exists for that contentHash+jurisdiction pair', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new AutomationSourcesService({ prisma: { blogSourceItem: { findFirst } } as never, now: () => NOW });

    const result = await service.dedupeSource({ contentHash: 'abc123', jurisdiction: 'KE' });
    expect(result).toEqual({ isNew: true });
    expect(findFirst).toHaveBeenCalledWith({ where: { contentHash: 'abc123', jurisdiction: 'KE' }, select: { id: true } });
  });

  it('reports isNew:false when a matching row exists in that jurisdiction', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'existing' });
    const service = new AutomationSourcesService({ prisma: { blogSourceItem: { findFirst } } as never, now: () => NOW });

    const result = await service.dedupeSource({ contentHash: 'abc123', jurisdiction: 'KE' });
    expect(result).toEqual({ isNew: false });
  });

  it('rejects an invalid jurisdiction', async () => {
    const service = new AutomationSourcesService({ now: () => NOW });
    await expect(service.dedupeSource({ contentHash: 'abc123', jurisdiction: 'Kenya' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
