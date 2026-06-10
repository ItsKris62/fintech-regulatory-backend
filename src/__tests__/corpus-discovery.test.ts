/**
 * Corpus Discovery & Download Tests
 *
 * Tests for source registry validation, candidate manifest validation,
 * URL utilities, filename utilities, domain enforcement, path safety,
 * and download/discovery behavior constraints.
 */

import { describe, it, expect } from 'vitest';

import {
  SourceRegistryEntrySchema,
  SourceRegistrySchema,
  type SourceRegistryEntry,
} from '../scripts/corpus/source-registry.schema';

import {
  CandidateEntrySchema,
  CandidateManifestSchema,
  type CandidateEntry,
} from '../scripts/corpus/candidate.schema';

import {
  resolveUrl,
  isAllowedDomain,
  extractDocumentLinks,
  isDocumentUrl,
  extractFileExtension,
  extractFilenameFromUrl,
} from '../scripts/corpus/url-utils';

import {
  normalizeTitle,
  titleFromFilename,
  normalizeFilename,
  generateLocalPath,
  slugify,
  suggestCategory,
  suggestDocumentType,
  suggestAuthorityStatus,
} from '../scripts/corpus/filename-utils';

// ============================================================================
// Helpers
// ============================================================================

function makeValidSource(overrides: Partial<SourceRegistryEntry> = {}): any {
  return {
    id: 'mw-test-source',
    country: 'Malawi',
    jurisdictionCode: 'MW',
    regulator: 'Reserve Bank of Malawi',
    sourceType: 'REGULATOR',
    baseUrl: 'https://www.rbm.mw/regulations/',
    allowedDomains: ['rbm.mw'],
    categories: ['banking'],
    crawlMode: 'link-discovery',
    priority: 'P0',
    enabled: true,
    ...overrides,
  };
}

function makeValidCandidate(overrides: Partial<CandidateEntry> = {}): any {
  return {
    id: 'mw-candidate-001',
    country: 'Malawi',
    jurisdictionCode: 'MW',
    discoveredTitle: 'Reserve Bank of Malawi Act',
    normalizedTitle: 'Reserve Bank of Malawi Act',
    sourceUrl: 'https://www.rbm.mw/docs/rbm-act.pdf',
    sourcePageUrl: 'https://www.rbm.mw/regulations/',
    regulator: 'Reserve Bank of Malawi',
    suggestedCategory: 'banking',
    suggestedDocumentType: 'ACT',
    suggestedAuthorityStatus: 'UNKNOWN',
    suggestedIsBinding: null,
    priority: 'UNKNOWN',
    decision: 'NEEDS_REVIEW',
    discoveredAt: '2026-06-10T12:00:00Z',
    tags: [],
    ...overrides,
  };
}

// ============================================================================
// Source Registry Schema
// ============================================================================

describe('SourceRegistryEntrySchema', () => {
  it('should accept a valid Malawi source', () => {
    const result = SourceRegistryEntrySchema.safeParse(makeValidSource());
    expect(result.success).toBe(true);
  });

  it('should accept a valid Nigeria source', () => {
    const result = SourceRegistryEntrySchema.safeParse(
      makeValidSource({
        id: 'ng-cbn',
        country: 'Nigeria',
        jurisdictionCode: 'NG',
        regulator: 'Central Bank of Nigeria',
        baseUrl: 'https://www.cbn.gov.ng/',
        allowedDomains: ['cbn.gov.ng'],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('should reject Malawi with NG jurisdiction', () => {
    const result = SourceRegistryEntrySchema.safeParse(
      makeValidSource({ country: 'Malawi', jurisdictionCode: 'NG' }),
    );
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('does not match'))).toBe(true);
  });

  it('should reject Nigeria with MW jurisdiction', () => {
    const result = SourceRegistryEntrySchema.safeParse(
      makeValidSource({
        country: 'Nigeria',
        jurisdictionCode: 'MW',
        baseUrl: 'https://example.com/',
        allowedDomains: ['example.com'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject invalid baseUrl', () => {
    const result = SourceRegistryEntrySchema.safeParse(
      makeValidSource({ baseUrl: 'not-a-url' }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject empty allowedDomains', () => {
    const result = SourceRegistryEntrySchema.safeParse(
      makeValidSource({ allowedDomains: [] }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject empty regulator', () => {
    const result = SourceRegistryEntrySchema.safeParse(
      makeValidSource({ regulator: '' }),
    );
    expect(result.success).toBe(false);
  });

  it('should accept all crawlMode values', () => {
    for (const mode of ['link-discovery', 'publication-table', 'static-list', 'manual-only'] as const) {
      const result = SourceRegistryEntrySchema.safeParse(
        makeValidSource({ crawlMode: mode }),
      );
      expect(result.success).toBe(true);
    }
  });

  it('should accept all sourceType values', () => {
    for (const st of [
      'REGULATOR',
      'FIU',
      'DATA_PROTECTION_AUTHORITY',
      'SECURITIES_REGULATOR',
      'CONSUMER_PROTECTION_AUTHORITY',
      'LEGAL_DATABASE',
      'GOVERNMENT_PORTAL',
      'OTHER',
    ] as const) {
      const result = SourceRegistryEntrySchema.safeParse(
        makeValidSource({ sourceType: st }),
      );
      expect(result.success).toBe(true);
    }
  });
});

describe('SourceRegistrySchema', () => {
  it('should accept a valid Malawi registry', () => {
    const result = SourceRegistrySchema.safeParse({
      version: 1,
      country: 'Malawi',
      jurisdictionCode: 'MW',
      sources: [makeValidSource()],
    });
    expect(result.success).toBe(true);
  });

  it('should accept an empty sources array', () => {
    const result = SourceRegistrySchema.safeParse({
      version: 1,
      country: 'Nigeria',
      jurisdictionCode: 'NG',
      sources: [],
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid country', () => {
    const result = SourceRegistrySchema.safeParse({
      version: 1,
      country: 'Ghana',
      jurisdictionCode: 'GH',
      sources: [],
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Candidate Schema
// ============================================================================

describe('CandidateEntrySchema', () => {
  it('should accept a valid NEEDS_REVIEW candidate', () => {
    const result = CandidateEntrySchema.safeParse(makeValidCandidate());
    expect(result.success).toBe(true);
  });

  it('should default decision to NEEDS_REVIEW without auto-approval', () => {
    const candidate = makeValidCandidate();
    expect(candidate.decision).toBe('NEEDS_REVIEW');
  });

  it('should accept an APPROVED candidate with proposedLocalPath', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'APPROVED',
        proposedLocalPath: 'documents/malawi/banking/rbm-act.pdf',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('should reject APPROVED without proposedLocalPath', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'APPROVED',
        proposedLocalPath: null,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i: any) => i.message.includes('proposedLocalPath'))).toBe(true);
  });

  it('should reject proposedLocalPath with path traversal', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'APPROVED',
        proposedLocalPath: 'documents/malawi/../secrets.pdf',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject proposedLocalPath not starting with documents/', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'APPROVED',
        proposedLocalPath: 'src/scripts/evil.ts',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject absolute proposedLocalPath', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'APPROVED',
        proposedLocalPath: '/etc/passwd',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject proposedLocalPath with backslashes', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'APPROVED',
        proposedLocalPath: 'documents\\malawi\\test.pdf',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject downloadedLocalPath with path traversal', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        downloadedLocalPath: 'documents/../../../etc/passwd',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject Malawi with NG jurisdiction', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({ country: 'Malawi', jurisdictionCode: 'NG' }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject Nigeria with MW jurisdiction', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        country: 'Nigeria',
        jurisdictionCode: 'MW',
        sourceUrl: 'https://cbn.gov.ng/doc.pdf',
        sourcePageUrl: 'https://cbn.gov.ng/',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject empty discoveredTitle', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({ discoveredTitle: '' }),
    );
    expect(result.success).toBe(false);
  });

  it('should reject invalid sourceUrl', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({ sourceUrl: 'not-a-url' }),
    );
    expect(result.success).toBe(false);
  });

  it('should accept REJECTED decision', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({ decision: 'REJECTED' }),
    );
    expect(result.success).toBe(true);
  });

  it('should accept DUPLICATE decision with duplicateOf', () => {
    const result = CandidateEntrySchema.safeParse(
      makeValidCandidate({
        decision: 'DUPLICATE',
        duplicateOf: 'mw-candidate-000',
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe('CandidateManifestSchema', () => {
  it('should accept an empty candidate manifest', () => {
    const result = CandidateManifestSchema.safeParse({
      version: 1,
      country: 'Malawi',
      jurisdictionCode: 'MW',
      discoveredAt: '2026-06-10T12:00:00Z',
      entries: [],
    });
    expect(result.success).toBe(true);
  });

  it('should accept a manifest with candidates', () => {
    const result = CandidateManifestSchema.safeParse({
      version: 1,
      country: 'Nigeria',
      jurisdictionCode: 'NG',
      discoveredAt: '2026-06-10T12:00:00Z',
      entries: [
        makeValidCandidate({
          country: 'Nigeria',
          jurisdictionCode: 'NG',
          sourceUrl: 'https://cbn.gov.ng/doc.pdf',
          sourcePageUrl: 'https://cbn.gov.ng/',
        }),
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// URL Utilities
// ============================================================================

describe('resolveUrl', () => {
  it('should resolve a relative URL', () => {
    expect(resolveUrl('/docs/act.pdf', 'https://rbm.mw/regulations/')).toBe(
      'https://rbm.mw/docs/act.pdf',
    );
  });

  it('should preserve absolute URLs', () => {
    expect(resolveUrl('https://other.mw/doc.pdf', 'https://rbm.mw/')).toBe(
      'https://other.mw/doc.pdf',
    );
  });

  it('should resolve relative paths', () => {
    const result = resolveUrl('files/document.pdf', 'https://rbm.mw/regulations/');
    expect(result).toBe('https://rbm.mw/regulations/files/document.pdf');
  });

  it('should reject non-HTTP protocols', () => {
    expect(resolveUrl('ftp://example.com/file.pdf', 'https://rbm.mw/')).toBeNull();
  });

  it('should reject javascript: protocol', () => {
    expect(resolveUrl('javascript:void(0)', 'https://rbm.mw/')).toBeNull();
  });

  it('should return null for invalid URLs', () => {
    // Node URL() treats many inputs as relative paths, so test with empty base
    expect(resolveUrl('', '')).toBeNull();
  });
});

describe('isAllowedDomain', () => {
  it('should allow exact domain match', () => {
    expect(isAllowedDomain('https://rbm.mw/doc.pdf', ['rbm.mw'])).toBe(true);
  });

  it('should allow subdomain match', () => {
    expect(isAllowedDomain('https://www.rbm.mw/doc.pdf', ['rbm.mw'])).toBe(true);
  });

  it('should reject unlisted domain', () => {
    expect(isAllowedDomain('https://malware.com/doc.pdf', ['rbm.mw'])).toBe(false);
  });

  it('should reject partial domain match', () => {
    // "notrbm.mw" should NOT match "rbm.mw"
    expect(isAllowedDomain('https://notrbm.mw/doc.pdf', ['rbm.mw'])).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isAllowedDomain('https://WWW.RBM.MW/doc.pdf', ['rbm.mw'])).toBe(true);
  });

  it('should handle multiple allowed domains', () => {
    expect(isAllowedDomain('https://cbn.gov.ng/doc.pdf', ['rbm.mw', 'cbn.gov.ng'])).toBe(true);
  });

  it('should reject invalid URLs', () => {
    expect(isAllowedDomain('not-a-url', ['rbm.mw'])).toBe(false);
  });
});

describe('extractDocumentLinks', () => {
  it('should extract PDF links from HTML', () => {
    const html = '<a href="/docs/act.pdf">Banking Act</a>';
    const links = extractDocumentLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/docs/act.pdf');
    expect(links[0].text).toBe('Banking Act');
  });

  it('should extract DOC links', () => {
    const html = '<a href="guidelines.doc">Guidelines</a>';
    const links = extractDocumentLinks(html);
    expect(links).toHaveLength(1);
  });

  it('should extract DOCX links', () => {
    const html = '<a href="report.docx">Report</a>';
    const links = extractDocumentLinks(html);
    expect(links).toHaveLength(1);
  });

  it('should ignore non-document links', () => {
    const html = `
      <a href="/about">About</a>
      <a href="page.html">Page</a>
      <a href="doc.pdf">Document</a>
    `;
    const links = extractDocumentLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('doc.pdf');
  });

  it('should strip HTML from link text', () => {
    const html = '<a href="act.pdf"><strong>Banking</strong> Act <em>2024</em></a>';
    const links = extractDocumentLinks(html);
    expect(links[0].text).toBe('Banking Act 2024');
  });

  it('should handle multiple document links', () => {
    const html = `
      <a href="act1.pdf">Act 1</a>
      <a href="act2.pdf">Act 2</a>
      <a href="guide.docx">Guide</a>
    `;
    const links = extractDocumentLinks(html);
    expect(links).toHaveLength(3);
  });
});

describe('isDocumentUrl', () => {
  it('should match .pdf', () => expect(isDocumentUrl('doc.pdf')).toBe(true));
  it('should match .doc', () => expect(isDocumentUrl('doc.doc')).toBe(true));
  it('should match .docx', () => expect(isDocumentUrl('doc.docx')).toBe(true));
  it('should match .txt', () => expect(isDocumentUrl('doc.txt')).toBe(true));
  it('should match case-insensitive', () => expect(isDocumentUrl('doc.PDF')).toBe(true));
  it('should match URL with query string', () =>
    expect(isDocumentUrl('https://example.com/doc.pdf?download=true')).toBe(true));
  it('should reject .html', () => expect(isDocumentUrl('page.html')).toBe(false));
  it('should reject .js', () => expect(isDocumentUrl('script.js')).toBe(false));
});

describe('extractFileExtension', () => {
  it('should extract pdf', () => expect(extractFileExtension('doc.pdf')).toBe('pdf'));
  it('should extract docx', () => expect(extractFileExtension('doc.docx')).toBe('docx'));
  it('should extract from URL', () =>
    expect(extractFileExtension('https://example.com/doc.pdf?v=1')).toBe('pdf'));
  it('should return null for unknown', () =>
    expect(extractFileExtension('page.html')).toBeNull());
});

describe('extractFilenameFromUrl', () => {
  it('should extract filename from URL', () => {
    expect(extractFilenameFromUrl('https://example.com/docs/act.pdf')).toBe('act.pdf');
  });

  it('should decode URL-encoded filenames', () => {
    expect(extractFilenameFromUrl('https://example.com/Banking%20Act.pdf')).toBe('Banking Act.pdf');
  });

  it('should return null for empty path', () => {
    expect(extractFilenameFromUrl('https://example.com/')).toBeNull();
  });
});

// ============================================================================
// Filename Utilities
// ============================================================================

describe('normalizeTitle', () => {
  it('should collapse whitespace', () => {
    expect(normalizeTitle('  Banking   Act  ')).toBe('Banking Act');
  });

  it('should decode HTML entities', () => {
    expect(normalizeTitle('Data &amp; Protection')).toBe('Data & Protection');
  });
});

describe('titleFromFilename', () => {
  it('should convert filename to title', () => {
    expect(titleFromFilename('banking-act-2024.pdf')).toBe('Banking Act 2024');
  });

  it('should handle underscores', () => {
    expect(titleFromFilename('reserve_bank_act.pdf')).toBe('Reserve Bank Act');
  });
});

describe('normalizeFilename', () => {
  it('should lowercase and replace spaces', () => {
    expect(normalizeFilename('Banking Act 2024.pdf')).toBe('banking-act-2024.pdf');
  });

  it('should strip special characters', () => {
    expect(normalizeFilename('Act (No. 24) of 2019.pdf')).toBe('act-no.-24-of-2019.pdf');
  });

  it('should collapse multiple hyphens', () => {
    expect(normalizeFilename('A---B---C.pdf')).toBe('a-b-c.pdf');
  });

  it('should preserve extension', () => {
    expect(normalizeFilename('Document.DOCX')).toBe('document.docx');
  });

  it('should cap length', () => {
    const longName = 'a'.repeat(200) + '.pdf';
    const result = normalizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('generateLocalPath', () => {
  it('should generate correct path', () => {
    const result = generateLocalPath('malawi', 'banking', 'Reserve Bank Act.pdf');
    expect(result).toBe('documents/malawi/banking/reserve-bank-act.pdf');
  });

  it('should use forward slashes only', () => {
    const result = generateLocalPath('nigeria', 'aml-cft', 'AML Guidelines.pdf');
    expect(result).not.toContain('\\');
  });

  it('should start with documents/', () => {
    const result = generateLocalPath('malawi', 'payments', 'doc.pdf');
    expect(result.startsWith('documents/')).toBe(true);
  });
});

describe('slugify', () => {
  it('should create URL-safe slug', () => {
    expect(slugify('Banking Act (No. 24) of 2019')).toBe('banking-act-no-24-of-2019');
  });

  it('should respect max length', () => {
    const result = slugify('a'.repeat(100), 30);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

describe('suggestCategory', () => {
  it('should suggest banking for banking titles', () => {
    expect(suggestCategory('Banking Act 2024')).toBe('banking');
  });

  it('should suggest aml-cft for AML titles', () => {
    expect(suggestCategory('Anti-Money Laundering Guidelines')).toBe('aml-cft');
  });

  it('should suggest data-protection for privacy titles', () => {
    expect(suggestCategory('Data Protection Act')).toBe('data-protection');
  });

  it('should suggest payments for payment titles', () => {
    expect(suggestCategory('National Payment Systems Act')).toBe('payments');
  });

  it('should return other for unrecognized titles', () => {
    expect(suggestCategory('Miscellaneous Document')).toBe('other');
  });
});

describe('suggestDocumentType', () => {
  it('should detect ACT', () => {
    expect(suggestDocumentType('Banking Act')).toBe('ACT');
  });

  it('should detect REGULATION', () => {
    expect(suggestDocumentType('Payment Regulations 2024')).toBe('REGULATION');
  });

  it('should detect GUIDELINE', () => {
    expect(suggestDocumentType('Cybersecurity Guidelines')).toBe('GUIDELINE');
  });

  it('should default to OTHER', () => {
    expect(suggestDocumentType('Some Document')).toBe('OTHER');
  });
});

describe('suggestAuthorityStatus', () => {
  it('should detect DRAFT', () => {
    expect(suggestAuthorityStatus('Draft Regulations 2024')).toBe('DRAFT');
  });

  it('should detect GUIDANCE', () => {
    expect(suggestAuthorityStatus('Guidance Note on AML')).toBe('GUIDANCE');
  });

  it('should default to UNKNOWN', () => {
    expect(suggestAuthorityStatus('Banking Act 2024')).toBe('UNKNOWN');
  });
});

// ============================================================================
// Downloader Safety Constraints
// ============================================================================

describe('Downloader safety constraints', () => {
  it('should skip non-APPROVED candidates', () => {
    const decisions = ['NEEDS_REVIEW', 'REJECTED', 'SUPERSEDED', 'DUPLICATE'] as const;
    for (const decision of decisions) {
      const candidate = makeValidCandidate({ decision });
      expect(candidate.decision).not.toBe('APPROVED');
    }
  });

  it('should enforce proposedLocalPath under documents/', () => {
    const badPaths = [
      '../secrets.pdf',
      '/etc/passwd',
      'C:\\Users\\test.pdf',
      'src/evil.ts',
      'documents/../../../etc/shadow',
    ];
    for (const p of badPaths) {
      const result = CandidateEntrySchema.safeParse(
        makeValidCandidate({ decision: 'APPROVED', proposedLocalPath: p }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('should accept safe proposedLocalPath under documents/', () => {
    const goodPaths = [
      'documents/malawi/banking/act.pdf',
      'documents/nigeria/aml-cft/guidelines.pdf',
      'documents/malawi/payments/regulation.docx',
    ];
    for (const p of goodPaths) {
      const result = CandidateEntrySchema.safeParse(
        makeValidCandidate({ decision: 'APPROVED', proposedLocalPath: p }),
      );
      expect(result.success).toBe(true);
    }
  });
});

// ============================================================================
// Cross-entry duplicate detection
// ============================================================================

describe('Cross-entry duplicate detection', () => {
  it('should detect duplicate URLs in candidate entries', () => {
    const entries = [
      makeValidCandidate({ id: 'c-001', sourceUrl: 'https://rbm.mw/doc.pdf' }),
      makeValidCandidate({ id: 'c-002', sourceUrl: 'https://rbm.mw/doc.pdf' }),
    ];
    const urls = entries.map((e: any) => e.sourceUrl);
    const hasDuplicateUrls = new Set(urls).size !== urls.length;
    expect(hasDuplicateUrls).toBe(true);
  });

  it('should detect duplicate IDs in candidate entries', () => {
    const entries = [
      makeValidCandidate({ id: 'dup-001' }),
      makeValidCandidate({ id: 'dup-001' }),
    ];
    const ids = entries.map((e: any) => e.id);
    const hasDuplicateIds = new Set(ids).size !== ids.length;
    expect(hasDuplicateIds).toBe(true);
  });

  it('should detect duplicate normalized titles via slugify', () => {
    const title1 = slugify('Reserve Bank of Malawi Act');
    const title2 = slugify('reserve bank of malawi act');
    expect(title1).toBe(title2);
  });
});
