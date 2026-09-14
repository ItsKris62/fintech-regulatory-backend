import { describe, it, expect } from 'vitest';
import {
  normalizeDomain,
  normalizeCompanyName,
  normalizeLicenceNumber,
} from './company-dedup.service';

describe('Company Deduplication & Normalization (P0)', () => {
  describe('normalizeDomain', () => {
    it('normalizes URLs and messy domains to canonical lowercase hostnames', () => {
      expect(normalizeDomain('https://www.branch.co.ke/about?ref=cbk')).toBe('branch.co.ke');
      expect(normalizeDomain('http://tala.co/careers/')).toBe('tala.co');
      expect(normalizeDomain('WWW.PAYSTACK.COM:443/')).toBe('paystack.com');
      expect(normalizeDomain('contact@zenka.co.ke')).toBe('zenka.co.ke');
    });

    it('rejects public generic email providers from auto-domain creation', () => {
      expect(normalizeDomain('user@gmail.com')).toBeNull();
      expect(normalizeDomain('ceo@yahoo.com')).toBeNull();
      expect(normalizeDomain('outlook.com')).toBeNull();
      expect(normalizeDomain('proton.me')).toBeNull();
    });

    it('returns null for empty or invalid strings', () => {
      expect(normalizeDomain('')).toBeNull();
      expect(normalizeDomain(null)).toBeNull();
      expect(normalizeDomain('invalid')).toBeNull();
    });
  });

  describe('normalizeCompanyName', () => {
    it('strips common corporate suffixes and punctuation for matching', () => {
      expect(normalizeCompanyName('Branch International Limited')).toBe('branch international');
      expect(normalizeCompanyName('Tala Kenya Ltd.')).toBe('tala kenya');
      expect(normalizeCompanyName('M-Kopa Payments, LLC')).toBe('m kopa payments');
      expect(normalizeCompanyName('Watu Credit PLC (Kenya)')).toBe('watu credit kenya');
    });
  });

  describe('normalizeLicenceNumber', () => {
    it('standardizes regulatory licence codes', () => {
      expect(normalizeLicenceNumber('cbk / dcp - 001')).toBe('CBKDCP001');
      expect(normalizeLicenceNumber('CMA/RE-042/2024')).toBe('CMARE0422024');
    });
  });
});
