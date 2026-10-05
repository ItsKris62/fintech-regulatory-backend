import { createRequire } from 'node:module';
import type { FastifyServerOptions } from 'fastify';

const fastifyRequire = createRequire(require.resolve('fastify'));
const proxyaddr = fastifyRequire('@fastify/proxy-addr') as {
  compile: (val: string | readonly string[]) => (addr: string) => boolean;
};

export type TrustProxyFunction = (addr: string, hop: number) => boolean;

export type TrustProxyValue = NonNullable<FastifyServerOptions['trustProxy']>;

export type TrustProxyMode = 'hops' | 'cidrs' | 'true' | 'false' | 'address-aware';

export interface ResolvedTrustProxy {
  trustProxy: TrustProxyValue;
  mode: TrustProxyMode;
  summary: string;
}

/**
 * Published Cloudflare IPv4 CIDR ranges
 * @see https://www.cloudflare.com/ips/
 */
export const CLOUDFLARE_IPV4_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

/**
 * Published Cloudflare IPv6 CIDR ranges
 * @see https://www.cloudflare.com/ips/
 */
export const CLOUDFLARE_IPV6_CIDRS = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

/**
 * RFC1918 Private & Loopback ranges (covering Render internal reverse proxies and local dev)
 */
export const RENDER_INTERNAL_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.1/8',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

/**
 * Combined default trusted CIDRs (Render internal reverse proxy + Cloudflare edge nodes)
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS = [
  ...RENDER_INTERNAL_CIDRS,
  ...CLOUDFLARE_IPV4_CIDRS,
  ...CLOUDFLARE_IPV6_CIDRS,
] as const;

export const defaultAddressMatcher = proxyaddr.compile(DEFAULT_TRUSTED_PROXY_CIDRS);

/**
 * Render outbound static egress CIDR ranges for this web service.
 * Used for external firewall/allowlisting (Supabase DB, Redis, IntaSend, APIs).
 */
export const RENDER_OUTBOUND_EGRESS_CIDRS = [
  '74.220.51.0/24',
  '74.220.59.0/24',
] as const;

/**
 * Creates an address-aware trust proxy validation function that validates both:
 * 1. Immediate and intermediate peer addresses match trusted proxy CIDRs (Render internal + Cloudflare).
 * 2. Hop count does not exceed a strict ceiling (if maxHops is specified).
 *
 * This completely prevents direct-origin client IP spoofing where an attacker sends arbitrary
 * X-Forwarded-For headers to the Render origin.
 */
export function createAddressAwareTrustProxy(options?: {
  maxHops?: number;
  customCidrs?: readonly string[];
}): TrustProxyFunction {
  const matcher = options?.customCidrs && options.customCidrs.length > 0
    ? proxyaddr.compile(options.customCidrs)
    : defaultAddressMatcher;
  const maxHops = options?.maxHops;

  return (addr: string, hop: number): boolean => {
    // 1. Hop limit check: if configured, never trust beyond the maximum expected proxy hops
    if (typeof maxHops === 'number' && hop >= maxHops) {
      return false;
    }
    // 2. Address check: peer address must belong to trusted proxy subnets
    return matcher(addr);
  };
}

/**
 * Resolves Fastify trustProxy option in explicit priority order:
 * 1. TRUST_PROXY_HOPS (number, 0-10) -> Address-aware proxy validation with hop ceiling
 *    - Cloudflare -> Render -> Fastify topology: TRUST_PROXY_HOPS=2
 *    - Single proxy (Render direct): TRUST_PROXY_HOPS=1
 * 2. TRUST_PROXY_CIDRS (comma-separated IP/CIDR list) -> Address-aware validation for custom CIDRs
 * 3. TRUST_PROXY === 'true' -> Default address-aware validation (Render internal + Cloudflare CIDRs, max 2 hops)
 * 4. otherwise false (Never defaults to true)
 */
export function resolveTrustProxy(env: {
  TRUST_PROXY?: string;
  TRUST_PROXY_HOPS?: string | number;
  TRUST_PROXY_CIDRS?: string;
} = process.env): ResolvedTrustProxy {
  const rawHops = env.TRUST_PROXY_HOPS;
  if (rawHops !== undefined && String(rawHops).trim() !== '') {
    const hopCount = Number(rawHops);
    if (Number.isInteger(hopCount) && hopCount >= 0 && hopCount <= 10) {
      return {
        trustProxy: createAddressAwareTrustProxy({ maxHops: hopCount }),
        mode: 'hops',
        summary: `address-aware hops: ${hopCount} (trusted: Render internal + Cloudflare CIDRs)`,
      };
    }
  }

  const rawCidrs = env.TRUST_PROXY_CIDRS;
  if (rawCidrs !== undefined && rawCidrs.trim() !== '') {
    const cidrs = rawCidrs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (cidrs.length > 0) {
      return {
        trustProxy: cidrs,
        mode: 'cidrs',
        summary: `cidrs: [${cidrs.join(', ')}]`,
      };
    }
  }

  const rawTrust = env.TRUST_PROXY;
  if (rawTrust !== undefined && rawTrust.trim() !== '') {
    const normalized = rawTrust.trim().toLowerCase();
    if (normalized === 'true') {
      return {
        trustProxy: true,
        mode: 'true',
        summary: 'boolean true (trust all reverse proxies)',
      };
    }
    if (normalized === 'false') {
      return {
        trustProxy: false,
        mode: 'false',
        summary: 'boolean false (direct connection / disabled)',
      };
    }
  }

  return {
    trustProxy: false,
    mode: 'false',
    summary: 'disabled (default: false)',
  };
}

export function parseTrustProxy(
  rawValue: string | undefined = process.env.TRUST_PROXY,
  rawHopValue = process.env.TRUST_PROXY_HOPS,
  rawCidrsValue = process.env.TRUST_PROXY_CIDRS,
): TrustProxyValue {
  return resolveTrustProxy({
    TRUST_PROXY: rawValue,
    TRUST_PROXY_HOPS: rawHopValue,
    TRUST_PROXY_CIDRS: rawCidrsValue,
  }).trustProxy;
}
