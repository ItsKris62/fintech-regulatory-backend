import type { FastifyServerOptions } from 'fastify';

export type TrustProxyValue = NonNullable<FastifyServerOptions['trustProxy']>;

export type TrustProxyMode = 'hops' | 'cidrs' | 'true' | 'false';

export interface ResolvedTrustProxy {
  trustProxy: TrustProxyValue;
  mode: TrustProxyMode;
  summary: string;
}

/**
 * Resolves Fastify trustProxy option in explicit priority order:
 * 1. TRUST_PROXY_HOPS (number, 0-10)
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
