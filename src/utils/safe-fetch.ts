import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SSRFValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFValidationError';
  }
}

/**
 * Checks if an IPv4 address is in a private, loopback, link-local,
 * multicast, reserved, or special-purpose IP range.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // invalid -> fail closed
  }

  const [a, b, c] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 10.0.0.0/8 (RFC 1918 Private)
  if (a === 10) return true;

  // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 169.254.0.0/16 (Link-local / Cloud Metadata)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 (RFC 1918 Private)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;

  // 192.88.99.0/24 (6to4 Relay Anycast)
  if (a === 192 && b === 88 && c === 99) return true;

  // 192.168.0.0/16 (RFC 1918 Private)
  if (a === 192 && b === 168) return true;

  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved for future use / Broadcast: 240.0.0.0 - 255.255.255.255)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, link-local,
 * unique local, multicast, or special-purpose IP range.
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback / Unspecified
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const ipv4MappedMatch = normalized.match(/^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedMatch && ipv4MappedMatch[1]) {
    return isPrivateIPv4(ipv4MappedMatch[1]);
  }
  if (normalized.startsWith('::ffff:')) {
    const rest = normalized.slice(7);
    if (isIP(rest) === 4) {
      return isPrivateIPv4(rest);
    }
  }

  // Unique local addresses (fc00::/7 -> fc00:: to fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // Link-local unicast (fe80::/10 -> fe80:: to febf::)
  if (/^fe[89ab]/i.test(normalized)) return true;

  // Multicast (ff00::/8)
  if (normalized.startsWith('ff')) return true;

  // Documentation (2001:db8::/32)
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0db8:')) return true;

  return false;
}

export function isPrivateIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIPv4(ip);
  }
  if (version === 6) {
    return isPrivateIPv6(ip);
  }
  // If not a recognized IP format, fail-closed
  return true;
}

const FORBIDDEN_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
  '169.254.169.254',
]);

const FORBIDDEN_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.internal.net',
  '.cluster.local',
];

/**
 * Validates a URL and resolves its hostname to guarantee it does not
 * point to private, loopback, or cloud-metadata IPs.
 */
export async function validateSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SSRFValidationError(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFValidationError(`Disallowed protocol "${parsed.protocol}". Only HTTP and HTTPS are permitted.`);
  }

  if (parsed.username || parsed.password) {
    throw new SSRFValidationError('Credentials in URL are not permitted.');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (FORBIDDEN_HOSTNAMES.has(hostname) || FORBIDDEN_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new SSRFValidationError(`Access to host "${hostname}" is blocked for security.`);
  }

  // If hostname is an IP literal
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new SSRFValidationError(`Access to private/internal IP "${hostname}" is blocked.`);
    }
    return parsed;
  }

  // Resolve hostname and verify ALL resolved addresses
  try {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new SSRFValidationError(`Could not resolve hostname "${hostname}".`);
    }

    for (const addr of addresses) {
      if (isPrivateIP(addr.address)) {
        throw new SSRFValidationError(
          `Resolved IP "${addr.address}" for host "${hostname}" is a private or reserved address.`
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof SSRFValidationError) throw err;
    throw new SSRFValidationError(
      `DNS lookup failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return parsed;
}

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Fetches an external URL safely with:
 * 1. Protocol checking (HTTP/HTTPS only)
 * 2. DNS resolution check against private/RFC1918/link-local/cloud-metadata subnets
 * 3. Manual redirect following with re-validation on every redirect hop
 * 4. Connect/request timeout
 * 5. Maximum response size enforcement
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    headers: initHeaders,
    ...fetchRest
  } = options;

  let currentUrl = rawUrl;
  let redirectsCount = 0;

  while (redirectsCount <= maxRedirects) {
    // Validate current hop
    await validateSafeUrl(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        ...fetchRest,
        headers: {
          'User-Agent': 'SheriaBot-Automation/1.0',
          ...initHeaders,
        },
        redirect: 'manual', // handle redirects manually to re-validate destination
        signal: controller.signal,
      });

      // Handle redirect status codes (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new SSRFValidationError(`Redirect status ${response.status} missing Location header.`);
        }

        // Resolve relative redirect against current URL
        const nextUrl = new URL(location, currentUrl).toString();
        redirectsCount++;

        if (redirectsCount > maxRedirects) {
          throw new SSRFValidationError(`Exceeded maximum redirects (${maxRedirects}).`);
        }

        currentUrl = nextUrl;
        continue;
      }

      // Check Content-Length if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > maxResponseBytes) {
          throw new SSRFValidationError(
            `Response size ${contentLength} bytes exceeds limit of ${maxResponseBytes} bytes.`
          );
        }
      }

      // Buffer and enforce max size
      let textCache: string | null = null;
      const readText = async (): Promise<string> => {
        if (textCache !== null) return textCache;
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
          throw new SSRFValidationError(`Response body exceeds size limit of ${maxResponseBytes} bytes.`);
        }
        textCache = text;
        return text;
      };

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: currentUrl,
        text: readText,
        json: async <T = unknown>(): Promise<T> => {
          const t = await readText();
          return JSON.parse(t) as T;
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new SSRFValidationError(`Exceeded maximum redirects (${maxRedirects}).`);
}
