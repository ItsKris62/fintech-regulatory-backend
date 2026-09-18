import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getNestedValue,
  extractItemsFromPayload,
  resolveItemUrl,
  extractApiConfig,
  parseApiFeed,
  type ApiMonitorConfig,
} from './api-parser';

describe('api-parser', () => {
  describe('getNestedValue', () => {
    it('retrieves flat property', () => {
      expect(getNestedValue({ title: 'Circular 1' }, 'title')).toBe('Circular 1');
    });

    it('retrieves nested dot-notation property', () => {
      const obj = { data: { nested: { title: 'Nested Title' } } };
      expect(getNestedValue(obj, 'data.nested.title')).toBe('Nested Title');
    });

    it('returns undefined for non-existent path', () => {
      const obj = { data: { other: 123 } };
      expect(getNestedValue(obj, 'data.nested.title')).toBeUndefined();
    });

    it('handles null/undefined gracefully', () => {
      expect(getNestedValue(null, 'data.title')).toBeUndefined();
      expect(getNestedValue(undefined, 'data.title')).toBeUndefined();
      expect(getNestedValue({ data: null }, 'data.title')).toBeUndefined();
    });
  });

  describe('extractItemsFromPayload', () => {
    it('returns payload directly if it is an array', () => {
      const items = [{ id: 1 }, { id: 2 }];
      expect(extractItemsFromPayload(items)).toEqual(items);
    });

    it('extracts array from specified dot-notation itemsPath', () => {
      const payload = {
        status: 'success',
        result: {
          items: [{ title: 'Doc 1' }, { title: 'Doc 2' }],
        },
      };
      expect(extractItemsFromPayload(payload, 'result.items')).toEqual([
        { title: 'Doc 1' },
        { title: 'Doc 2' },
      ]);
    });

    it('falls back to data/items/results if itemsPath is not found or empty', () => {
      const payloadWithData = { data: [{ title: 'Item 1' }] };
      expect(extractItemsFromPayload(payloadWithData, 'data')).toEqual([{ title: 'Item 1' }]);

      const payloadWithResults = { results: [{ title: 'Item 2' }] };
      expect(extractItemsFromPayload(payloadWithResults)).toEqual([{ title: 'Item 2' }]);
    });

    it('returns empty array for invalid payloads', () => {
      expect(extractItemsFromPayload(null)).toEqual([]);
      expect(extractItemsFromPayload({})).toEqual([]);
      expect(extractItemsFromPayload({ data: 'not an array' })).toEqual([]);
    });
  });

  describe('resolveItemUrl', () => {
    it('preserves absolute URLs', () => {
      expect(resolveItemUrl('https://example.com/circulars/123', 'https://api.example.com/v1')).toBe(
        'https://example.com/circulars/123'
      );
    });

    it('resolves relative URLs against endpoint origin/base', () => {
      expect(resolveItemUrl('/circulars/123', 'https://api.example.com/v1/items')).toBe(
        'https://api.example.com/circulars/123'
      );
      expect(resolveItemUrl('doc/123', 'https://api.example.com/v1/items/')).toBe(
        'https://api.example.com/v1/items/doc/123'
      );
    });

    it('returns null for empty or invalid URLs', () => {
      expect(resolveItemUrl('', 'https://example.com')).toBeNull();
      expect(resolveItemUrl('   ', 'https://example.com')).toBeNull();
    });
  });

  describe('extractApiConfig', () => {
    it('parses valid ApiMonitorConfig from monitor notes JSON', () => {
      const config: ApiMonitorConfig = {
        endpoint: 'https://api.centralbank.go.ke/v1/updates',
        headers: { Authorization: 'Bearer token123' },
        itemsPath: 'response.docs',
        fieldMapping: {
          title: 'headline',
          url: 'doc_url',
          publicationDate: 'published_at',
          content: 'body',
        },
      };

      const monitor = {
        notes: JSON.stringify({ notes: 'My notes', apiConfig: config }),
        baseUrl: 'https://api.centralbank.go.ke',
      };

      const extracted = extractApiConfig(monitor);
      expect(extracted).toEqual(config);
    });

    it('constructs fallback config if notes has no apiConfig but feedUrl exists', () => {
      const monitor = {
        notes: 'Regular note string',
        feedUrl: 'https://api.centralbank.go.ke/v1/news',
        baseUrl: 'https://centralbank.go.ke',
      };

      const extracted = extractApiConfig(monitor);
      expect(extracted).toEqual({
        endpoint: 'https://api.centralbank.go.ke/v1/news',
        itemsPath: 'data',
        fieldMapping: {
          title: 'title',
          url: 'url',
          publicationDate: 'publicationDate',
          content: 'content',
        },
      });
    });
  });

  describe('parseApiFeed', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('fetches and normalizes items from a JSON API with nested payload', async () => {
      const mockPayload = {
        status: 'OK',
        data: {
          records: [
            {
              item_title: 'CBK Circular No 1 of 2026',
              item_link: '/circulars/2026-01',
              item_date: '2026-02-15T10:00:00Z',
              item_body: 'Guidelines on digital credit providers.',
            },
            {
              item_title: 'CBK Circular No 2 of 2026',
              item_link: 'https://other-domain.com/circulars/2026-02',
              item_date: '2026-03-01T08:30:00Z',
              item_body: 'Capital requirements updates.',
            },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as any);

      const config: ApiMonitorConfig = {
        endpoint: 'https://api.centralbank.go.ke/v1/feed',
        headers: { 'X-Custom-Auth': 'secret' },
        itemsPath: 'data.records',
        fieldMapping: {
          title: 'item_title',
          url: 'item_link',
          publicationDate: 'item_date',
          content: 'item_body',
        },
      };

      const items = await parseApiFeed(config, 10, 5000);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.centralbank.go.ke/v1/feed',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Custom-Auth': 'secret',
            'User-Agent': 'SheriaBot-Regulatory-Monitor/1.0',
          }),
        })
      );

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        title: 'CBK Circular No 1 of 2026',
        url: 'https://api.centralbank.go.ke/circulars/2026-01',
        publicationDate: new Date('2026-02-15T10:00:00Z'),
        summary: 'Guidelines on digital credit providers.',
      });
      expect(items[1]).toEqual({
        title: 'CBK Circular No 2 of 2026',
        url: 'https://other-domain.com/circulars/2026-02',
        publicationDate: new Date('2026-03-01T08:30:00Z'),
        summary: 'Capital requirements updates.',
      });
    });

    it('falls back to current date when publicationDate is missing or invalid', async () => {
      const mockPayload = {
        data: [
          {
            title: 'Undated Circular',
            url: 'https://example.com/doc-1',
            date: 'invalid-date',
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as any);

      const config: ApiMonitorConfig = {
        endpoint: 'https://example.com/api',
        itemsPath: 'data',
        fieldMapping: {
          title: 'title',
          url: 'url',
          publicationDate: 'date',
        },
      };

      const items = await parseApiFeed(config, 5, 5000);
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Undated Circular');
      expect(items[0].publicationDate).toBeInstanceOf(Date);
      expect(isNaN(items[0].publicationDate!.getTime())).toBe(false);
    });

    it('enforces maxItems limit and skips malformed records without title or url', async () => {
      const mockPayload = {
        data: [
          { title: 'Doc 1', url: 'https://example.com/1' },
          { title: '', url: 'https://example.com/no-title' },
          { title: 'No URL' },
          { title: 'Doc 2', url: 'https://example.com/2' },
          { title: 'Doc 3', url: 'https://example.com/3' },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as any);

      const config: ApiMonitorConfig = {
        endpoint: 'https://example.com/api',
        itemsPath: 'data',
        fieldMapping: {
          title: 'title',
          url: 'url',
          publicationDate: 'publicationDate',
        },
      };

      const items = await parseApiFeed(config, 2, 5000);
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.title)).toEqual(['Doc 1', 'Doc 2']);
    });

    it('throws error when API response is not ok', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      } as any);

      const config: ApiMonitorConfig = {
        endpoint: 'https://example.com/api',
        itemsPath: 'data',
        fieldMapping: {
          title: 'title',
          url: 'url',
          publicationDate: 'pubDate',
        },
      };

      await expect(parseApiFeed(config, 10, 5000)).rejects.toThrow(
        'API fetch failed with HTTP 403: Forbidden'
      );
    });
  });
});
