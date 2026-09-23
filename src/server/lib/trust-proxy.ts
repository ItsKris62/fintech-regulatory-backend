import type { FastifyServerOptions } from 'fastify';

export type TrustProxyValue = NonNullable<FastifyServerOptions['trustProxy']>;

export type TrustProxyMode = 'hops' | 'cidrs' | 'true' | 'false';

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
 * RFC1918 Private & Loopback ranges (covering Render internal reverse proxies)
 */
export const RENDER_INTERNAL_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.1',
] as const;

/**
 * Render outbound static egress CIDR ranges for this web service.
 * Used for external firewall/allowlisting (Supabase DB, Redis, IntaSend, APIs).
 */
export const RENDER_OUTBOUND_EGRESS_CIDRS = [
  '74.220.51.0/24',
  '74.220.59.0/24',
] as const;

/**
 * Resolves Fastify trustProxy option in explicit priority order:
 * 1. TRUST_PROXY_HOPS (number, 0-10)
 *    - Cloudflare -> Render -> Fastify topology: TRUST_PROXY_HOPS=2
 *    - Single proxy (Render direct): TRUST_PROXY_HOPS=1
 * 2. TRUST_PROXY_CIDRS (comma-separated IP/CIDR list -> string[])
 * 3. TRUST_PROXY === 'true' -> true
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
        trustProxy: hopCount,
        mode: 'hops',
        summary: `hops: ${hopCount}`,
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
