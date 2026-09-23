import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { getClientIp, normalizeIp } from './client-ip';

describe('client-ip utility', () => {
  describe('normalizeIp', () => {
    it('normalizes IPv6-mapped IPv4 addresses (::ffff:127.0.0.1 -> 127.0.0.1)', () => {
      expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(normalizeIp('::ffff:192.168.1.50')).toBe('192.168.1.50');
      expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    });

    it('returns valid public IPv4 addresses as-is', () => {
      expect(normalizeIp('198.51.100.14')).toBe('198.51.100.14');
      expect(normalizeIp('203.0.113.195')).toBe('203.0.113.195');
    });

    it('returns valid IPv6 addresses as-is', () => {
      expect(normalizeIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      );
      expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
      expect(normalizeIp('::1')).toBe('::1');
    });

    it('strips IPv6 zone identifiers', () => {
      expect(normalizeIp('fe80::1ff:fe23:4567:890a%eth0')).toBe('fe80::1ff:fe23:4567:890a');
    });

    it('returns null for empty, undefined, null, or whitespace-only inputs', () => {
      expect(normalizeIp('')).toBeNull();
      expect(normalizeIp('   ')).toBeNull();
      expect(normalizeIp(undefined)).toBeNull();
      expect(normalizeIp(null)).toBeNull();
    });

    it('returns null for "unknown" string', () => {
      expect(normalizeIp('unknown')).toBeNull();
      expect(normalizeIp('UNKNOWN')).toBeNull();
    });

    it('returns null for malformed IP strings', () => {
      expect(normalizeIp('999.999.999.999')).toBeNull();
      expect(normalizeIp('not-an-ip')).toBeNull();
      expect(normalizeIp('192.168.1.1.1')).toBeNull();
      expect(normalizeIp('123.456')).toBeNull();
      expect(normalizeIp('2001:xyz::1')).toBeNull();
    });
  });

  describe('getClientIp', () => {
    it('extracts and normalizes req.ip from Fastify request', () => {
      const mockReq: any = {
        ip: '::ffff:203.0.113.5',
        headers: {},
      };
      expect(getClientIp(mockReq)).toBe('203.0.113.5');
    });

    it('ignores spoofed X-Forwarded-For header when req.ip is not set to it', () => {
      // When Fastify trustProxy is false, Fastify sets req.ip to the socket address (127.0.0.1)
      // and getClientIp extracts req.ip directly without trusting raw X-Forwarded-For
      const mockReq: any = {
        ip: '127.0.0.1',
        headers: {
          'x-forwarded-for': '203.0.113.99, 10.0.0.1',
        },
      };
      expect(getClientIp(mockReq)).toBe('127.0.0.1');
    });

    it('returns null if req is missing or req.ip is invalid', () => {
      expect(getClientIp(null)).toBeNull();
      expect(getClientIp(undefined)).toBeNull();
      expect(getClientIp({ ip: undefined, headers: {} })).toBeNull();
      expect(getClientIp({ ip: 'invalid_ip', headers: {} })).toBeNull();
    });

    it('resolves a real public client IP for CF -> Render -> Fastify when TRUST_PROXY_HOPS=2', async () => {
      const app = Fastify({ trustProxy: 2 });
      let capturedIp: string | null = null;

      app.get('/test-ip', async (req) => {
        capturedIp = getClientIp(req);
        return { ip: capturedIp };
      });

      // Simulation: Client (198.51.100.44) -> Cloudflare (172.70.242.164) -> Render -> Fastify
      await app.inject({
        method: 'GET',
        url: '/test-ip',
        headers: {
          'x-forwarded-for': '198.51.100.44, 172.70.242.164',
        },
      });

      expect(capturedIp).toBe('198.51.100.44');
      await app.close();
    });

    it('resolves a Cloudflare proxy IP when hops are undercounted (TRUST_PROXY_HOPS=1)', async () => {
      const app = Fastify({ trustProxy: 1 });
      let capturedIp: string | null = null;

      app.get('/test-ip', async (req) => {
        capturedIp = getClientIp(req);
        return { ip: capturedIp };
      });

      // Simulation: With hops=1, Fastify only strips 1 hop, landing on Cloudflare's IP
      await app.inject({
        method: 'GET',
        url: '/test-ip',
        headers: {
          'x-forwarded-for': '198.51.100.44, 172.70.242.164',
        },
      });

      expect(capturedIp).toBe('172.70.242.164');
      await app.close();
    });
  });
});

