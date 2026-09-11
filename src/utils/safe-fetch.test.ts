import { describe, expect, it } from 'vitest';
import { isPrivateIPv4, isPrivateIPv6, validateSafeUrl, SSRFValidationError } from './safe-fetch';

describe('safe-fetch SSRF validation', () => {
  describe('isPrivateIPv4', () => {
    it('detects loopback addresses (127.0.0.0/8)', () => {
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('127.1.2.3')).toBe(true);
    });

    it('detects RFC 1918 private subnets', () => {
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('10.255.255.255')).toBe(true);
      expect(isPrivateIPv4('172.16.0.1')).toBe(true);
      expect(isPrivateIPv4('172.31.255.255')).toBe(true);
      expect(isPrivateIPv4('192.168.1.1')).toBe(true);
      expect(isPrivateIPv4('192.168.0.254')).toBe(true);
    });

    it('detects cloud metadata / link-local addresses (169.254.0.0/16)', () => {
      expect(isPrivateIPv4('169.254.169.254')).toBe(true);
      expect(isPrivateIPv4('169.254.1.1')).toBe(true);
    });

    it('detects carrier-grade NAT (100.64.0.0/10)', () => {
      expect(isPrivateIPv4('100.64.0.1')).toBe(true);
      expect(isPrivateIPv4('100.127.255.255')).toBe(true);
    });

    it('allows public internet IPv4 addresses', () => {
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
      expect(isPrivateIPv4('104.26.10.150')).toBe(false);
    });
  });

  describe('isPrivateIPv6', () => {
    it('detects loopback (::1)', () => {
      expect(isPrivateIPv6('::1')).toBe(true);
      expect(isPrivateIPv6('::')).toBe(true);
    });

    it('detects unique local addresses (fc00::/7)', () => {
      expect(isPrivateIPv6('fc00::1')).toBe(true);
      expect(isPrivateIPv6('fd12:3456:789a::1')).toBe(true);
    });

    it('detects link-local addresses (fe80::/10)', () => {
      expect(isPrivateIPv6('fe80::1')).toBe(true);
    });

    it('detects IPv4-mapped private IPv6 addresses', () => {
      expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
    });
  });

  describe('validateSafeUrl', () => {
    it('rejects non-http/https protocols', async () => {
      await expect(validateSafeUrl('file:///etc/passwd')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('ftp://ftp.example.com')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('gopher://example.com')).rejects.toThrow(SSRFValidationError);
    });

    it('rejects credentials in URL', async () => {
      await expect(validateSafeUrl('https://user:pass@example.com')).rejects.toThrow(SSRFValidationError);
    });

    it('rejects localhost and cloud metadata hostnames', async () => {
      await expect(validateSafeUrl('http://localhost:8080')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('http://127.0.0.1:4000')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('http://instance-data')).rejects.toThrow(SSRFValidationError);
      await expect(validateSafeUrl('http://app.cluster.local')).rejects.toThrow(SSRFValidationError);
    });
  });
});
