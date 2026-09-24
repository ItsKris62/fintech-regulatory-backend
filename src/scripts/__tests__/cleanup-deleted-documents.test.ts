import { describe, it, expect } from 'vitest';
import { extractR2Key } from '../cleanup-deleted-documents';

describe('extractR2Key', () => {
  it('returns a raw storage key unchanged', () => {
    const rawKey = 'documents/org-1/doc-2/file.pdf';
    expect(extractR2Key(rawKey)).toBe('documents/org-1/doc-2/file.pdf');
  });

  it('extracts path without leading slash from a https:// URL', () => {
    const url = 'https://your-bucket.r2.dev/legal-documents/doc-123.pdf';
    expect(extractR2Key(url)).toBe('legal-documents/doc-123.pdf');
  });

  it('strips query parameters from a full URL', () => {
    const urlWithQuery = 'https://your-bucket.r2.dev/documents/org-1/file.pdf?auth=xyz&expiry=123';
    expect(extractR2Key(urlWithQuery)).toBe('documents/org-1/file.pdf');
  });

  it('strips leading slashes from a path-only string', () => {
    const pathOnly = '/legal-documents/2026/act.pdf';
    expect(extractR2Key(pathOnly)).toBe('legal-documents/2026/act.pdf');
  });

  it('returns null for an empty string', () => {
    expect(extractR2Key('')).toBeNull();
  });

  it('returns null for malformed or root-only strings', () => {
    expect(extractR2Key('http://')).toBeNull();
    expect(extractR2Key('/')).toBeNull();
    expect(extractR2Key('///')).toBeNull();
  });
});
