import { DiscoveredItem } from './rss-parser';
import { apiMonitorConfigSchema, type ApiMonitorConfig } from '@/server/schemas/blog-automation.schema';

export { type ApiMonitorConfig };

/**
 * Safely traverses an object given a dot-notation path (e.g. 'data.items' or 'results').
 */
export function getNestedValue(obj: any, path: string): any {
  if (obj === null || obj === undefined || !path) return undefined;
  const parts = path.split('.').filter(Boolean);
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Extracts an array of items from a JSON API payload using dot-notation itemsPath.
 */
export function extractItemsFromPayload(payload: any, itemsPath?: string): any[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const path = itemsPath?.trim();
  if (path && path !== '.' && path !== '') {
    const extracted = getNestedValue(payload, path);
    if (Array.isArray(extracted)) {
      return extracted;
    }
  }

  // Fallbacks if itemsPath wasn't specified or didn't yield an array
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.records)) return payload.records;

  return [];
}

/**
 * Resolves a raw URL against an API endpoint origin/base.
 */
export function resolveItemUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    const resolved = new URL(trimmed, baseUrl);
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Extracts and validates ApiMonitorConfig stored in monitor.notes or constructs fallback.
 */
export function extractApiConfig(monitor: {
  notes?: string | null;
  feedUrl?: string | null;
  baseUrl?: string;
}): ApiMonitorConfig | null {
  if (monitor.notes) {
    try {
      const parsed = JSON.parse(monitor.notes);
      if (parsed && typeof parsed === 'object') {
        if (parsed.apiConfig) {
          const res = apiMonitorConfigSchema.safeParse(parsed.apiConfig);
          if (res.success) return res.data;
        }
        const res = apiMonitorConfigSchema.safeParse(parsed);
        if (res.success) return res.data;
      }
    } catch {
      // notes is raw non-JSON text, ignore
    }
  }

  // If feedUrl or baseUrl is provided, construct fallback config
  const fallbackEndpoint = monitor.feedUrl || monitor.baseUrl;
  if (fallbackEndpoint) {
    try {
      const parsed = apiMonitorConfigSchema.safeParse({
        endpoint: fallbackEndpoint,
        itemsPath: 'data',
        fieldMapping: {
          title: 'title',
          url: 'url',
          publicationDate: 'publicationDate',
          content: 'content',
        },
      });
      if (parsed.success) return parsed.data;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Ingests and normalizes items from a REST/JSON API endpoint.
 */
export async function parseApiFeed(
  config: ApiMonitorConfig,
  maxItems: number = 20,
  timeoutMs: number = 15000
): Promise<DiscoveredItem[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'SheriaBot-Regulatory-Monitor/1.0',
      Accept: 'application/json, text/plain, */*',
      ...(config.headers || {}),
    };

    const response = await fetch(config.endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`API fetch failed with HTTP ${response.status}: ${response.statusText}`);
    }

    const payload = await response.json();
    const rawRecords = extractItemsFromPayload(payload, config.itemsPath);

    const items: DiscoveredItem[] = [];
    const seenUrls = new Set<string>();

    for (const record of rawRecords) {
      if (items.length >= maxItems) break;
      if (!record || typeof record !== 'object') continue;

      const rawTitle = getNestedValue(record, config.fieldMapping.title);
      const rawUrl = getNestedValue(record, config.fieldMapping.url);
      const rawDate = getNestedValue(record, config.fieldMapping.publicationDate);
      const rawContent = config.fieldMapping.content
        ? getNestedValue(record, config.fieldMapping.content)
        : undefined;

      if (!rawTitle || !rawUrl) continue;

      const title = String(rawTitle).trim();
      if (!title) continue;

      const resolvedUrl = resolveItemUrl(String(rawUrl), config.endpoint);
      if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;

      seenUrls.add(resolvedUrl);

      let publicationDate: Date | undefined;
      if (rawDate) {
        const parsed = new Date(rawDate);
        if (!isNaN(parsed.getTime())) {
          publicationDate = parsed;
        }
      }
      if (!publicationDate) {
        publicationDate = new Date();
      }

      const summary = rawContent !== undefined && rawContent !== null
        ? (typeof rawContent === 'object' ? JSON.stringify(rawContent) : String(rawContent).trim())
        : undefined;

      items.push({
        title,
        url: resolvedUrl,
        publicationDate,
        summary,
      });
    }

    return items;
  } finally {
    clearTimeout(timeoutId);
  }
}
