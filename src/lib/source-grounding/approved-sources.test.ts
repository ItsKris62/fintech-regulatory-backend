import { describe, expect, it } from 'vitest';
import {
  buildSourceDocumentVersionId,
  isPriorityRegulatoryDocument,
  matchApprovedSourceId,
} from './approved-sources';

describe('approved source helpers', () => {
  it('identifies priority Kenyan fintech documents', () => {
    expect(isPriorityRegulatoryDocument({ title: 'Data Protection Act', category: 'DATA_PROTECTION' })).toBe(true);
    expect(isPriorityRegulatoryDocument({ title: 'Office lease template', category: 'GENERAL' })).toBe(false);
  });

  it('matches documents to known approved source IDs from existing labels', () => {
    expect(matchApprovedSourceId({ source: 'Central Bank of Kenya', title: 'National Payment System Regulations' })).toBe('ke-central-bank-of-kenya');
    expect(matchApprovedSourceId({ source: 'ODPC', title: 'Data Protection Guidance' })).toBe('ke-office-data-protection-commissioner');
    expect(matchApprovedSourceId({ source: 'Financial Reporting Centre', title: 'AML guidance' })).toBe('ke-financial-reporting-centre');
  });

  it('builds stable source document version IDs from existing metadata', () => {
    const first = buildSourceDocumentVersionId({
      regulatoryDocumentId: 'doc-1',
      officialUrl: 'HTTPS://KENYALAW.ORG/example/#section',
      checksumSha256: 'abc',
      versionLabel: '2024',
    });
    const second = buildSourceDocumentVersionId({
      regulatoryDocumentId: 'doc-1',
      officialUrl: 'https://kenyalaw.org/example/',
      checksumSha256: 'abc',
      versionLabel: '2024',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^sdv_doc-1_/);
  });
});
