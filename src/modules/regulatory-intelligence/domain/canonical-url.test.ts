import { describe, it, expect } from 'vitest';
import { canonicalizeUrl } from './canonical-url';

describe('canonicalizeUrl', () => {
  it('normalizes hostname casing and strips trailing slashes', () => {
    const raw = 'HTTPS://WWW.CENTRALBANK.GO.KE/circulars/2026/';
    const result = canonicalizeUrl(raw);
    expect(result).toBe('https://www.centralbank.go.ke/circulars/2026');
  });

  it('preserves root path slash', () => {
    const raw = 'https://www.centralbank.go.ke/';
    const result = canonicalizeUrl(raw);
    expect(result).toBe('https://www.centralbank.go.ke/');
  });

  it('strips known marketing tracking parameters (utm_*, fbclid, etc.)', () => {
    const raw = 'https://www.odpc.go.ke/guidelines?utm_source=twitter&utm_medium=social&docId=ODPC-2026-01&fbclid=xyz123';
    const result = canonicalizeUrl(raw);
    expect(result).toBe('https://www.odpc.go.ke/guidelines?docId=ODPC-2026-01');
  });

  it('preserves genuine document query parameters and sorts them deterministically', () => {
    const raw = 'https://www.cma.or.ke/notices?year=2026&category=fintech&id=42';
    const result = canonicalizeUrl(raw);
    expect(result).toBe('https://www.cma.or.ke/notices?category=fintech&id=42&year=2026');
  });

  it('removes URL fragments', () => {
    const raw = 'https://www.cma.or.ke/policy.pdf#page=4';
    const result = canonicalizeUrl(raw);
    expect(result).toBe('https://www.cma.or.ke/policy.pdf');
  });

  it('removes default ports 80 and 443', () => {
    expect(canonicalizeUrl('http://example.com:80/path')).toBe('http://example.com/path');
    expect(canonicalizeUrl('https://example.com:443/path')).toBe('https://example.com/path');
    expect(canonicalizeUrl('http://example.com:8080/path')).toBe('http://example.com:8080/path');
  });

  it('collapses multi-slashes in pathname', () => {
    const raw = 'https://example.com//docs///regulations//2026';
    const result = canonicalizeUrl(raw);
    expect(result).toBe('https://example.com/docs/regulations/2026');
  });

  it('throws on invalid or non-http(s) URLs', () => {
    expect(() => canonicalizeUrl('')).toThrow();
    expect(() => canonicalizeUrl('not a url')).toThrow();
    expect(() => canonicalizeUrl('ftp://example.com/file')).toThrow(/Unsupported URL protocol/);
  });
});
