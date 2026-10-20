import { describe, it, expect } from 'vitest';
import {
  FRAMEWORK_METADATA_REGISTRY,
  getFrameworkMetadata,
  isFrameworkApplicableToJurisdiction,
  validateFrameworkApplicability,
} from './framework-metadata.config';

describe('Framework Metadata & Applicability Registry', () => {
  it('registers all 53 canonical frameworks with explicit scope', () => {
    const keys = Object.keys(FRAMEWORK_METADATA_REGISTRY);
    expect(keys.length).toBe(53);

    for (const key of keys) {
      const meta = FRAMEWORK_METADATA_REGISTRY[key];
      expect(meta.slug).toBe(key);
      expect(['DOMESTIC', 'INTERNATIONAL', 'CROSS_BORDER']).toContain(meta.scope);
      if (meta.scope === 'DOMESTIC') {
        expect(meta.jurisdictions.length).toBeGreaterThan(0);
      }
    }
  });

  it('classifies international standards with scope INTERNATIONAL', () => {
    const internationalSlugs = [
      'iso-27001',
      'pci-dss',
      'fatf-recommendations',
      'soc2-type-ii',
      'swift-csp',
      'basel-iii',
      'gdpr',
    ];

    for (const slug of internationalSlugs) {
      const meta = getFrameworkMetadata(slug);
      expect(meta).not.toBeNull();
      expect(meta?.scope).toBe('INTERNATIONAL');
      // Applicable to all supported jurisdictions
      expect(isFrameworkApplicableToJurisdiction(slug, 'KE')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction(slug, 'RW')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction(slug, 'MW')).toBe(true);
      expect(isFrameworkApplicableToJurisdiction(slug, 'NG')).toBe(true);
    }
  });

  it('classifies Kenya domestic legislation with scope DOMESTIC and jurisdictions ["KE"]', () => {
    const kenyanSlugs = [
      'dpa-2019',
      'cbk-prudential',
      'nps-2011',
      'pocamla',
      'dcpr-2022',
      'cma-act',
    ];

    for (const slug of kenyanSlugs) {
      const meta = getFrameworkMetadata(slug);
      expect(meta).not.toBeNull();
      expect(meta?.scope).toBe('DOMESTIC');
      expect(meta?.jurisdictions).toEqual(['KE']);

      // Allowed for Kenya
      expect(isFrameworkApplicableToJurisdiction(slug, 'KE')).toBe(true);

      // FORBIDDEN for Rwanda, Malawi, Nigeria
      expect(isFrameworkApplicableToJurisdiction(slug, 'RW')).toBe(false);
      expect(isFrameworkApplicableToJurisdiction(slug, 'MW')).toBe(false);
      expect(isFrameworkApplicableToJurisdiction(slug, 'NG')).toBe(false);
    }
  });

  it('validates framework applicability and detects incompatible frameworks', () => {
    const kenyaSelection = ['dpa-2019', 'cbk-prudential', 'iso-27001'];
    const kenyaValidation = validateFrameworkApplicability(kenyaSelection, 'KE');
    expect(kenyaValidation.valid).toBe(true);
    expect(kenyaValidation.incompatibleSlugs).toEqual([]);

    // For Rwanda, dpa-2019 and cbk-prudential are incompatible, but iso-27001 is compatible
    const rwandaValidation = validateFrameworkApplicability(kenyaSelection, 'RW');
    expect(rwandaValidation.valid).toBe(false);
    expect(rwandaValidation.incompatibleSlugs).toEqual(['dpa-2019', 'cbk-prudential']);
  });
});
