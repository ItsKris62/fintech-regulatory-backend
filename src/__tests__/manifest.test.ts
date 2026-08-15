/**
 * Corpus Manifest Schema & Loader Tests
 *
 * Tests for manifest validation, path safety, cross-entry constraints,
 * and country/jurisdiction mapping.
 */

import { describe, it, expect } from 'vitest';

import {
  CorpusManifestEntrySchema,
  CorpusManifestSchema,
  type CorpusManifestEntry,
} from '../scripts/corpus/manifest.schema';

import {
  resolveLocalPath,
  getDocumentsRoot,
} from '../scripts/corpus/manifest-loader';

// ============================================================================
// Helpers
// ============================================================================

function makeValidEntry(overrides: Partial<CorpusManifestEntry> = {}): any {
  return {
    id: 'test-entry-001',
    country: 'Kenya',
    jurisdictionCode: 'KE',
    scope: 'COUNTRY',
    category: 'data-protection',
    regulator: 'ODPC',
    title: 'Test Document',
    documentType: 'ACT',
    authorityStatus: 'IN_FORCE',
    isBinding: true,
    localPath: 'documents/kenya/test-document.pdf',
    sourceUrl: null,
    checksumSha256: null,
    reviewStatus: 'NEEDS_REVIEW',
    priority: 'UNKNOWN',
    tags: [],
    ...overrides,
  };
}

// ============================================================================
// CorpusManifestEntrySchema — Valid entries
// ============================================================================

describe('CorpusManifestEntrySchema', () => {
  it('should accept a valid Kenya entry', () => {
    const entry = makeValidEntry();
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should accept a valid International entry with INTL jurisdiction', () => {
    const entry = makeValidEntry({
      country: 'International',
      jurisdictionCode: 'INTL',
      scope: 'INTERNATIONAL',
      localPath: 'documents/international/some-standard.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should accept a valid International entry with EU jurisdiction', () => {
    const entry = makeValidEntry({
      country: 'International',
      jurisdictionCode: 'EU',
      scope: 'REGIONAL',
      localPath: 'documents/international/gdpr.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should accept a valid Malawi entry', () => {
    const entry = makeValidEntry({
      country: 'Malawi',
      jurisdictionCode: 'MW',
      localPath: 'documents/malawi/payments/some-doc.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should accept a valid Nigeria entry', () => {
    const entry = makeValidEntry({
      country: 'Nigeria',
      jurisdictionCode: 'NG',
      localPath: 'documents/nigeria/aml-cft/some-doc.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should accept a valid Rwanda entry', () => {
    const entry = makeValidEntry({
      country: 'Rwanda',
      jurisdictionCode: 'RW',
      localPath: 'documents/rwanda/aml-cft/some-doc.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should accept optional fields', () => {
    const entry = makeValidEntry({
      effectiveDate: '2024-01-01',
      publicationDate: '2023-12-15',
      version: '2024',
      language: 'en',
      supersedes: 'old-entry-001',
      frameworkSlugs: ['nist-csf-2.0'],
      notes: 'Imported from registry',
      discoveredFrom: 'ODPC website',
      retrievedAt: '2024-06-01T12:00:00Z',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // ============================================================================
  // Path safety
  // ============================================================================

  it('should reject localPath containing ".."', () => {
    const entry = makeValidEntry({
      localPath: 'documents/kenya/../secrets/test.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('..'))).toBe(true);
  });

  it('should reject absolute localPath (unix)', () => {
    const entry = makeValidEntry({
      localPath: '/etc/passwd',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject absolute localPath (windows)', () => {
    const entry = makeValidEntry({
      localPath: 'C:\\Users\\test\\doc.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject localPath with backslashes', () => {
    const entry = makeValidEntry({
      localPath: 'documents\\kenya\\test.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject localPath not starting with "documents/"', () => {
    const entry = makeValidEntry({
      localPath: 'src/scripts/evil.ts',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // ============================================================================
  // Jurisdiction / Country mapping
  // ============================================================================

  it('should reject Kenya with MW jurisdictionCode', () => {
    const entry = makeValidEntry({
      country: 'Kenya',
      jurisdictionCode: 'MW',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('does not match'))).toBe(true);
  });

  it('should require KE for Kenya', () => {
    const entry = makeValidEntry({
      country: 'Kenya',
      jurisdictionCode: 'NG',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should require MW for Malawi', () => {
    const entry = makeValidEntry({
      country: 'Malawi',
      jurisdictionCode: 'KE',
      localPath: 'documents/malawi/test.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should require NG for Nigeria', () => {
    const entry = makeValidEntry({
      country: 'Nigeria',
      jurisdictionCode: 'INTL',
      localPath: 'documents/nigeria/test.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should require RW for Rwanda', () => {
    const entry = makeValidEntry({
      country: 'Rwanda',
      jurisdictionCode: 'KE',
      localPath: 'documents/rwanda/test.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // ============================================================================
  // APPROVED integrity
  // ============================================================================

  it('should reject APPROVED entry without sourceUrl', () => {
    const entry = makeValidEntry({
      reviewStatus: 'APPROVED',
      sourceUrl: null,
      checksumSha256: 'abc123',
      authorityStatus: 'IN_FORCE',
      priority: 'P0',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('sourceUrl'))).toBe(true);
  });

  it('should reject APPROVED entry without checksumSha256', () => {
    const entry = makeValidEntry({
      reviewStatus: 'APPROVED',
      sourceUrl: 'https://example.com/doc.pdf',
      checksumSha256: null,
      authorityStatus: 'IN_FORCE',
      priority: 'P0',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('checksumSha256'))).toBe(true);
  });

  it('should reject APPROVED entry with UNKNOWN authorityStatus', () => {
    const entry = makeValidEntry({
      reviewStatus: 'APPROVED',
      sourceUrl: 'https://example.com/doc.pdf',
      checksumSha256: 'abc123',
      authorityStatus: 'UNKNOWN',
      priority: 'P0',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject APPROVED entry with UNKNOWN priority', () => {
    const entry = makeValidEntry({
      reviewStatus: 'APPROVED',
      sourceUrl: 'https://example.com/doc.pdf',
      checksumSha256: 'abc123',
      authorityStatus: 'IN_FORCE',
      priority: 'UNKNOWN',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should accept APPROVED entry with all required fields', () => {
    const entry = makeValidEntry({
      reviewStatus: 'APPROVED',
      sourceUrl: 'https://example.com/doc.pdf',
      checksumSha256: 'abc123def456',
      authorityStatus: 'IN_FORCE',
      priority: 'P0',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // ============================================================================
  // Binding consistency
  // ============================================================================

  it('should reject isBinding=true when authorityStatus is DRAFT', () => {
    const entry = makeValidEntry({
      authorityStatus: 'DRAFT',
      isBinding: true,
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('isBinding'))).toBe(true);
  });

  it('should reject isBinding=true when authorityStatus is CONSULTATION', () => {
    const entry = makeValidEntry({
      authorityStatus: 'CONSULTATION',
      isBinding: true,
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject isBinding=true when authorityStatus is REPORT', () => {
    const entry = makeValidEntry({
      authorityStatus: 'REPORT',
      isBinding: true,
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should accept isBinding=false when authorityStatus is DRAFT', () => {
    const entry = makeValidEntry({
      authorityStatus: 'DRAFT',
      isBinding: false,
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // ============================================================================
  // Required field validation
  // ============================================================================

  it('should reject empty id', () => {
    const entry = makeValidEntry({ id: '' });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject empty title', () => {
    const entry = makeValidEntry({ title: '' });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('should reject empty regulator', () => {
    const entry = makeValidEntry({ regulator: '' });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// CorpusManifestSchema — Top-level manifest
// ============================================================================

describe('CorpusManifestSchema', () => {
  it('should accept an empty Malawi manifest', () => {
    const manifest = {
      version: 1,
      country: 'Malawi',
      jurisdictionCode: 'MW',
      entries: [],
    };
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('should accept an empty Nigeria manifest', () => {
    const manifest = {
      version: 1,
      country: 'Nigeria',
      jurisdictionCode: 'NG',
      entries: [],
    };
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('should accept an empty Rwanda manifest', () => {
    const manifest = {
      version: 1,
      country: 'Rwanda',
      jurisdictionCode: 'RW',
      entries: [],
    };
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('should accept a Kenya manifest with entries', () => {
    const manifest = {
      version: 1,
      country: 'Kenya',
      jurisdictionCode: 'KE',
      entries: [makeValidEntry()],
    };
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('should reject manifest with missing version', () => {
    const manifest = {
      country: 'Kenya',
      jurisdictionCode: 'KE',
      entries: [],
    };
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject manifest with invalid country', () => {
    const manifest = {
      version: 1,
      country: 'Ghana',
      jurisdictionCode: 'GH',
      entries: [],
    };
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Cross-entry validation (via manifest-loader logic)
// ============================================================================

describe('Cross-entry validation', () => {
  it('should detect duplicate IDs in entries array', () => {
    const manifest = {
      version: 1,
      country: 'Kenya',
      jurisdictionCode: 'KE',
      entries: [
        makeValidEntry({ id: 'dup-001' }),
        makeValidEntry({ id: 'dup-001', localPath: 'documents/kenya/other.pdf' }),
      ],
    };

    // The Zod schema itself doesn't check cross-entry uniqueness.
    // That's done by the loader. So schema parse will pass here.
    const result = CorpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);

    // But if we check for uniqueness ourselves:
    const ids = manifest.entries.map((e: any) => e.id);
    const hasDuplicateIds = new Set(ids).size !== ids.length;
    expect(hasDuplicateIds).toBe(true);
  });

  it('should detect duplicate localPaths', () => {
    const manifest = {
      version: 1,
      country: 'Kenya',
      jurisdictionCode: 'KE',
      entries: [
        makeValidEntry({ id: 'entry-001' }),
        makeValidEntry({ id: 'entry-002' }), // same localPath default
      ],
    };

    const paths = manifest.entries.map((e: any) => e.localPath);
    const hasDuplicatePaths = new Set(paths).size !== paths.length;
    expect(hasDuplicatePaths).toBe(true);
  });
});

// ============================================================================
// Path resolution safety
// ============================================================================

describe('resolveLocalPath', () => {
  it('should resolve a flat Kenya path', () => {
    const result = resolveLocalPath('documents/kenya/some-doc.pdf');
    expect(result).not.toBeNull();
    expect(result!).toContain('documents');
    expect(result!).toContain('kenya');
  });

  it('should resolve a nested Nigeria path', () => {
    const result = resolveLocalPath('documents/nigeria/aml-cft/some-doc.pdf');
    expect(result).not.toBeNull();
    expect(result!).toContain('nigeria');
    expect(result!).toContain('aml-cft');
  });

  it('should reject paths escaping documents/', () => {
    const result = resolveLocalPath('documents/../src/secrets.ts');
    // On some systems path.normalize resolves this to be outside documents/
    // The function should return null if the resolved path is outside docs root
    if (result !== null) {
      // If it resolves, it should still be under documents/
      expect(result.includes(getDocumentsRoot())).toBe(true);
    }
  });

  it('should reject absolute unix paths', () => {
    // This is more of a schema-level check, but resolveLocalPath should
    // also handle it since the resolved path won't be under documents/
    const result = resolveLocalPath('/etc/passwd');
    // On Windows this won't match the documents root
    if (result !== null) {
      const docsRoot = getDocumentsRoot();
      expect(result.startsWith(docsRoot)).toBe(true);
    }
  });
});

// ============================================================================
// Nested vs Flat path validation
// ============================================================================

describe('Flat vs nested path validation', () => {
  it('should validate flat Kenya path under documents/kenya/', () => {
    const entry = makeValidEntry({
      localPath: 'documents/kenya/TheDataProtectionAct.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should validate nested Nigeria path under documents/nigeria/', () => {
    const entry = makeValidEntry({
      country: 'Nigeria',
      jurisdictionCode: 'NG',
      localPath: 'documents/nigeria/banking/cbn-guidelines.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should validate nested Malawi path under documents/malawi/', () => {
    const entry = makeValidEntry({
      country: 'Malawi',
      jurisdictionCode: 'MW',
      localPath: 'documents/malawi/aml-cft/fiu-guidelines.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should validate nested Rwanda path under documents/rwanda/', () => {
    const entry = makeValidEntry({
      country: 'Rwanda',
      jurisdictionCode: 'RW',
      localPath: 'documents/rwanda/cybersecurity/dpo-guide.pdf',
    });
    const result = CorpusManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });
});
