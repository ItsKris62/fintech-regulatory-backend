import { describe, expect, it } from 'vitest';
import { buildPageAwareText, chunkPageAwareLegalText } from './v2-chunking';

describe('v2 legal chunking', () => {
  it('preserves page ranges when reliable page breaks are present', () => {
    const pageAware = buildPageAwareText(
      'SECTION 1\nController duties apply.\fSECTION 2\nProcessor duties apply.',
      { sourceType: 'pdf', pageBreaksReliable: true },
    );

    const chunks = chunkPageAwareLegalText({
      documentId: 'doc-1',
      pageAwareText: pageAware,
      maxChunkSize: 2000,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].metadata.pageStart).toBe(1);
    expect(chunks[0].metadata.pageEnd).toBe(1);
    expect(chunks[1].metadata.pageStart).toBe(2);
    expect(chunks[1].metadata.pageEnd).toBe(2);
    expect(chunks[0].metadata.indexVersion).toBe('v2');
  });

  it('extracts section, clause, and schedule labels where detectable', () => {
    const pageAware = buildPageAwareText(
      'SCHEDULE 1\nForms.\nCLAUSE 4.2\nSecurity controls.\nRegulation 7\nReporting.',
      { sourceType: 'txt', pageBreaksReliable: false },
    );

    const chunks = chunkPageAwareLegalText({
      documentId: 'doc-2',
      pageAwareText: pageAware,
      maxChunkSize: 2000,
    });

    expect(chunks.some((chunk) => chunk.metadata.scheduleNumber === '1')).toBe(true);
    expect(chunks.some((chunk) => chunk.metadata.clauseNumber === '4.2')).toBe(true);
    expect(chunks.some((chunk) => chunk.metadata.sectionNumber === '7')).toBe(true);
  });

  it('does not pretend DOCX/TXT page metadata exists', () => {
    const pageAware = buildPageAwareText('SECTION 1\nNo page information here.', {
      sourceType: 'docx',
      pageBreaksReliable: false,
    });

    const [chunk] = chunkPageAwareLegalText({
      documentId: 'doc-3',
      pageAwareText: pageAware,
    });

    expect(chunk.metadata.pageMetadataReliable).toBe(false);
    expect(chunk.metadata.pageStart).toBeNull();
    expect(chunk.metadata.pageEnd).toBeNull();
  });

  it('generates stable provision IDs and content hashes', () => {
    const pageAware = buildPageAwareText('SECTION 9\nA stable duty.', {
      sourceType: 'txt',
      pageBreaksReliable: false,
    });

    const first = chunkPageAwareLegalText({ documentId: 'doc-4', pageAwareText: pageAware });
    const second = chunkPageAwareLegalText({ documentId: 'doc-4', pageAwareText: pageAware });

    expect(first[0].metadata.provisionId).toBe(second[0].metadata.provisionId);
    expect(first[0].metadata.contentHash).toBe(second[0].metadata.contentHash);
    expect(first[0].metadata.contentHash).toHaveLength(64);
  });

  it('falls back safely when legal structure is weak', () => {
    const pageAware = buildPageAwareText('A paragraph with no obvious legal heading.', {
      sourceType: 'txt',
      pageBreaksReliable: false,
    });

    const [chunk] = chunkPageAwareLegalText({ documentId: 'doc-5', pageAwareText: pageAware });

    expect(chunk.text).toContain('paragraph');
    expect(chunk.metadata.fallbackReason).toBe('no_detectable_legal_structure');
  });
});
