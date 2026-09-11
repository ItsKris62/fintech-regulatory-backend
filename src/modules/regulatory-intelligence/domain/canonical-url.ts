/**
 * Canonical URL Normalization Utility
 *
 * Implements a conservative URL normalization strategy for regulatory sources.
 * Strips ONLY known tracking parameters without collapsing distinct document endpoints.
 */

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  'ref',
  'ref_src',
  'ref_url',
]);

/**
 * Normalizes a URL for regulatory evidence deduplication.
 * Throws if the URL is invalid.
 */
export function canonicalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Invalid URL: URL must be a non-empty string.');
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}" could not be parsed.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: "${parsed.protocol}". Expected http or https.`);
  }

  // 1. Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();

  // 2. Remove default ports
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  // 3. Normalize pathname: collapse multi-slashes and remove trailing slash (unless path is '/')
  let pathname = parsed.pathname.replace(/\/+/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  // 4. Strip ONLY known tracking parameters, preserving actual document IDs, queries, and pagination
  const remainingParams = new URLSearchParams();
  const sortedKeys = Array.from(parsed.searchParams.keys()).sort();
  for (const key of sortedKeys) {
    if (!TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
      const values = parsed.searchParams.getAll(key);
      for (const val of values) {
        remainingParams.append(key, val);
      }
    }
  }

  const queryString = remainingParams.toString();
  parsed.search = queryString ? `?${queryString}` : '';

  // 5. Strip fragment
  parsed.hash = '';

  return parsed.toString();
}
