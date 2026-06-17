import { describe, expect, it } from 'vitest';
import {
  deriveSourceLifecycleStatus,
  buildPreferredActiveSourceFilter,
  generateContentHash,
  generateProvisionId,
  isOfficialUrlAllowed,
  mapV1DocumentToV2Metadata,
  normalizeOfficialUrl,
  omitNullishMetadata,
  prepareV2ChunkMetadata,
} from './source-metadata';

describe('source metadata utilities', () => {
  it('generates stable content hashes from normalized text', () => {
    expect(generateContentHash('  Legal text  ')).toBe(generateContentHash('Legal text'));
    expect(generateContentHash('Legal text')).not.toBe(generateContentHash('Different text'));
  });

  it('generates stable deterministic provision ids', () => {
    const input = {
      documentId: 'doc-1',
      chunkIndex: 2,
      pageStart: 4,
      pageEnd: 5,
      sectionNumber: '25',
      clauseNumber: '1',
      headingPath: ['Part IV', 'Rights of data subject'],
    };

    expect(generateProvisionId(input)).toBe(generateProvisionId(input));
    expect(generateProvisionId(input)).not.toBe(generateProvisionId({ ...input, clauseNumber: '2' }));
  });

  it('normalizes official URLs without inventing missing data', () => {
    expect(normalizeOfficialUrl(' HTTPS://Example.COM//path/#fragment ')).toBe('https://example.com/path');
    expect(normalizeOfficialUrl('not a url')).toBeNull();
  });

  it('validates official URLs against approved domains', () => {
    expect(isOfficialUrlAllowed('https://www.centralbank.go.ke/uploads/doc.pdf', {
      baseUrl: 'https://centralbank.go.ke',
      allowedDomains: ['centralbank.go.ke'],
    })).toBe(true);

    expect(isOfficialUrlAllowed('https://example.com/doc.pdf', {
      baseUrl: 'https://centralbank.go.ke',
      allowedDomains: ['centralbank.go.ke'],
    })).toBe(false);
  });

  it('derives lifecycle status from existing v1 fields', () => {
    expect(deriveSourceLifecycleStatus({
      documentStatus: 'ACTIVE',
      authorityStatus: 'IN_FORCE',
      isBinding: true,
    })).toEqual({ corpusStatus: 'ACTIVE', isCurrent: true, isBinding: true });

    expect(deriveSourceLifecycleStatus({
      documentStatus: 'ACTIVE',
      authorityStatus: 'SUPERSEDED',
      isBinding: true,
    }).corpusStatus).toBe('SUPERSEDED');

    expect(deriveSourceLifecycleStatus({
      authorityStatus: 'DRAFT',
    })).toEqual({ corpusStatus: 'DRAFT', isCurrent: false, isBinding: false });
  });

  it('maps v1 document metadata into v2-compatible fields', () => {
    const mapped = mapV1DocumentToV2Metadata({
      id: 'doc-1',
      checksum: 'abc',
      version: '2024',
      authorityStatus: 'IN_FORCE',
      isBinding: true,
      status: 'ACTIVE',
    });

    expect(mapped.indexVersion).toBe('v1');
    expect(mapped.documentChecksum).toBe('abc');
    expect(mapped.versionLabel).toBe('2024');
    expect(mapped.corpusStatus).toBe('ACTIVE');
  });

  it('prepares v2 chunk metadata without fabricating page data', () => {
    const metadata = prepareV2ChunkMetadata({
      documentId: 'doc-1',
      chunkIndex: 0,
      content: 'Section 25 text',
      provisionAnchor: { sectionNumber: '25' },
      sourceVersion: { sourceDocumentVersionId: 'sv-1', officialUrl: 'https://example.com/doc.pdf' },
    });

    expect(metadata.indexVersion).toBe('v2');
    expect(metadata.contentHash).toHaveLength(64);
    expect(metadata.provisionId).toHaveLength(32);
    expect(metadata.pageStart).toBeNull();
    expect(metadata.sourceDocumentVersionId).toBe('sv-1');
  });

  it('omits nullish vector metadata fields', () => {
    expect(omitNullishMetadata({ a: 'x', b: null, c: undefined, d: 0 })).toEqual({ a: 'x', d: 0 });
  });

  it('builds v1-compatible active source filters', () => {
    const filter = buildPreferredActiveSourceFilter({
      jurisdiction: 'Kenya',
      baseFilter: { frameworkSlug: 'data-protection' },
    });

    expect(filter).toMatchObject({
      $and: [
        { frameworkSlug: 'data-protection' },
        { $or: [{ jurisdiction: { $eq: 'Kenya' } }, { jurisdiction: { $exists: false } }] },
        { $or: [{ corpusStatus: { $eq: 'ACTIVE' } }, { corpusStatus: { $exists: false } }] },
        { $or: [{ authorityStatus: { $eq: 'IN_FORCE' } }, { authorityStatus: { $exists: false } }] },
      ],
    });
  });
});
