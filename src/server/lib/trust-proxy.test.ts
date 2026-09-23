import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from './trust-proxy';

describe('resolveTrustProxy configuration', () => {
  it('1. priority 1: resolves TRUST_PROXY_HOPS as number when valid integer 0-10 is provided', () => {
    const res1 = resolveTrustProxy({
      TRUST_PROXY_HOPS: '1',
      TRUST_PROXY_CIDRS: '10.0.0.0/8',
      TRUST_PROXY: 'true',
    });
    expect(res1.mode).toBe('hops');
    expect(res1.trustProxy).toBe(1);

    const res0 = resolveTrustProxy({
      TRUST_PROXY_HOPS: 0,
    });
    expect(res0.mode).toBe('hops');
    expect(res0.trustProxy).toBe(0);

    const res10 = resolveTrustProxy({
      TRUST_PROXY_HOPS: '10',
    });
    expect(res10.mode).toBe('hops');
    expect(res10.trustProxy).toBe(10);
  });

  it('2. priority 2: resolves TRUST_PROXY_CIDRS as string array when TRUST_PROXY_HOPS is unset', () => {
    const res = resolveTrustProxy({
      TRUST_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.0/12, 192.168.1.1',
      TRUST_PROXY: 'true',
    });
    expect(res.mode).toBe('cidrs');
    expect(res.trustProxy).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.1.1']);
  });

  it('3. priority 3: resolves TRUST_PROXY="true" to boolean true when hops and cidrs are unset', () => {
    const res = resolveTrustProxy({
      TRUST_PROXY: 'true',
    });
    expect(res.mode).toBe('true');
    expect(res.trustProxy).toBe(true);
  });

  it('4. resolves TRUST_PROXY="false" to boolean false', () => {
    const res = resolveTrustProxy({
      TRUST_PROXY: 'false',
    });
    expect(res.mode).toBe('false');
    expect(res.trustProxy).toBe(false);
  });

  it('5. defaults to boolean false when no proxy trust variables are provided', () => {
    const res = resolveTrustProxy({});
    expect(res.mode).toBe('false');
    expect(res.trustProxy).toBe(false);
  });

  it('6. ignores invalid/out-of-range hops and falls through safely', () => {
    const res = resolveTrustProxy({
      TRUST_PROXY_HOPS: '99',
      TRUST_PROXY_CIDRS: '10.0.0.0/8',
    });
    expect(res.mode).toBe('cidrs');
    expect(res.trustProxy).toEqual(['10.0.0.0/8']);
  });
});
