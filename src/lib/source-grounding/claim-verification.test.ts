import { describe, it, expect } from 'vitest';
import { extractAnswerClaims, verifyAnswerClaims, AnswerVerificationResult } from './claim-verification';
import type { SearchResult } from '@/lib/rag/rag.service';

function fixtureChunk(input: Partial<SearchResult> & Pick<SearchResult, 'chunkText'>): SearchResult {
  return {
    vectorId: input.vectorId ?? 'fixture-vector',
    chunkId: input.chunkId ?? 'fixture-chunk',
    documentId: input.documentId ?? 'fixture-doc',
    documentTitle: input.documentTitle ?? 'Fixture Document',
    chunkText: input.chunkText,
    jurisdictionCode: input.jurisdictionCode,
    section: input.section,
    sectionNumber: input.sectionNumber,
    score: input.score ?? 0.95,
    rank: input.rank ?? 1,
  };
}

const keDataProtection = fixtureChunk({
  jurisdictionCode: 'KE',
  documentTitle: 'Data Protection Act, 2019',
  section: 'Section 25',
  chunkText: 'A data controller or data processor shall ensure that personal data is processed lawfully, fairly and in a transparent manner. Personal data shall be collected for explicit, specified and legitimate purposes.',
});

const rwPaymentLicensing = fixtureChunk({
  jurisdictionCode: 'RW',
  documentTitle: 'Law Governing the Payment System',
  section: 'Article 16',
  chunkText: 'A person wishing to carry on business in providing payment services must be licensed in respect of the type of payment service applied for in writing. The National Bank determines the procedure for and the form of license application.',
});

const mwDataTransfer = fixtureChunk({
  jurisdictionCode: 'MW',
  documentTitle: 'Data Protection Act, 2024',
  section: 'Section 39(2)',
  chunkText: 'A data controller or data processor shall keep a record of the basis for any transfer of personal data from Malawi to another country or international organisation.',
});

const keDeadline = fixtureChunk({
  jurisdictionCode: 'KE',
  documentTitle: 'Financial Reporting Centre Guidance',
  section: 'Suspicious transaction reporting',
  chunkText: 'A reporting institution must submit a suspicious transaction report to the Financial Reporting Centre within 7 days after forming the suspicion.',
});

describe('claim-verification guardrails', () => {
  it('extracts legal obligations requiring citation', () => {
    const claims = extractAnswerClaims('A PSP must register with the Central Bank within 30 days.');
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].claimType).toBe('deadline');
    expect(claims[0].requiresCitation).toBe(true);
    expect(claims[0].status).toBe('unsupported'); // Initially unsupported
  });

  it('verifies claims against accepted chunks only', () => {
    const answer = 'A PSP must register with the Central Bank within 30 days.';
    const acceptedChunks = [
      { chunkText: 'Any PSP must register with the Central Bank within 30 days.' } as any
    ];
    
    const result: AnswerVerificationResult = verifyAnswerClaims(answer, acceptedChunks);
    expect(result.verdict).toBe('PASS');
    expect(result.unsupportedClaims.length).toBe(0);
    expect(result.supportedClaims.length).toBeGreaterThan(0);
  });

  it('fails verification when accepted chunks do not support the claim', () => {
    const answer = 'A PSP must register with the Central Bank within 30 days.';
    const acceptedChunks = [
      { chunkText: 'A PSP should submit an annual report.' } as any
    ];
    
    const result: AnswerVerificationResult = verifyAnswerClaims(answer, acceptedChunks);
    expect(result.verdict).toBe('FAIL');
    expect(result.unsupportedClaims.length).toBeGreaterThan(0);
    expect(result.supportedClaims.length).toBe(0);
  });

  it('segments markdown answers without merging headings, bullets, and citation lists into one claim', () => {
    const claims = extractAnswerClaims(`
## Direct Answer

A payment service provider must obtain a license from the National Bank before commencing business.

## Key Obligations

- A payment service provider must apply for the license in writing.
- The National Bank determines the license application form.

## Referenced Documents and Sections

- Law Governing the Payment System, Article 16.
`);

    expect(claims.map((claim) => claim.claimText)).toEqual([
      'A payment service provider must obtain a license from the National Bank before commencing business.',
      'A payment service provider must apply for the license in writing.',
      'The National Bank determines the license application form.',
    ]);
    expect(claims.every((claim) => claim.requiresCitation)).toBe(true);
  });

  it('uses document title and section metadata when scoring support', () => {
    const result = verifyAnswerClaims(
      'A payment service provider must obtain a license under the Law Governing the Payment System, Article 16.',
      [
        {
          documentTitle: 'Law Governing the Payment System',
          section: 'Article 16',
          chunkText: 'A person who intends to carry on business of providing payment services applies in writing to the National Bank.',
        } as any,
      ],
    );

    expect(result.verdict).toBe('PASS');
    expect(result.supportedClaims).toHaveLength(1);
  });

  it('supports direct legal wording from KE evidence', () => {
    const result = verifyAnswerClaims(
      'A data controller shall ensure that personal data is processed lawfully, fairly and transparently.',
      [keDataProtection],
    );

    expect(result.verdict).toBe('PASS');
    expect(result.supportedClaims).toHaveLength(1);
  });

  it('supports faithful paraphrases from Rwanda payment evidence', () => {
    const result = verifyAnswerClaims(
      'In Rwanda, anyone carrying on payment services must obtain the appropriate payment service license in writing.',
      [rwPaymentLicensing],
    );

    expect(result.verdict).toBe('PASS');
    expect(result.unsupportedClaims).toHaveLength(0);
  });

  it('supports actor-scoped paraphrases without broadening the actor', () => {
    const result = verifyAnswerClaims(
      'In Malawi, data controllers and data processors must keep records explaining the basis for cross-border personal data transfers.',
      [mwDataTransfer],
    );

    expect(result.verdict).toBe('PASS');
    expect(result.supportedClaims).toHaveLength(1);
  });

  it('supports deadlines when the number matches the evidence', () => {
    const result = verifyAnswerClaims(
      'A reporting institution must submit a suspicious transaction report to the Financial Reporting Centre within 7 days.',
      [keDeadline],
    );

    expect(result.verdict).toBe('PASS');
    expect(result.unsupportedClaims).toHaveLength(0);
  });

  it('rejects deadlines when the number differs from the evidence', () => {
    const result = verifyAnswerClaims(
      'A reporting institution must submit a suspicious transaction report to the Financial Reporting Centre within 30 days.',
      [keDeadline],
    );

    expect(result.verdict).toBe('FAIL');
    expect(result.unsupportedClaims).toHaveLength(1);
  });

  it('rejects wrong-country evidence for an explicit jurisdiction claim', () => {
    const result = verifyAnswerClaims(
      'Under Kenyan law, payment service providers must obtain a license from the Central Bank of Kenya before commencing business.',
      [rwPaymentLicensing],
    );

    expect(result.verdict).toBe('FAIL');
    expect(result.supportedClaims).toHaveLength(0);
  });

  it('rejects broad claims made from narrow actor evidence', () => {
    const result = verifyAnswerClaims(
      'In Malawi, every fintech company must keep records for every category of customer data processing activity.',
      [mwDataTransfer],
    );

    expect(result.verdict).toBe('FAIL');
    expect(result.supportedClaims).toHaveLength(0);
  });

  it('segments markdown list answers and ignores source-list sections', () => {
    const claims = extractAnswerClaims(`
## Direct Answer

In Rwanda, a person providing payment services must be licensed.

## Key Obligations

- The application must be made in writing.
- The National Bank determines the application form.

## Referenced Documents and Sections

- Law Governing the Payment System, Article 16.
- Regulation Governing Payment Services Providers.
`);

    expect(claims.map((claim) => claim.claimText)).toEqual([
      'In Rwanda, a person providing payment services must be licensed.',
      'The application must be made in writing.',
      'The National Bank determines the application form.',
    ]);
  });

  it('returns partial when an answer mixes supported and unsupported legal claims', () => {
    const result = verifyAnswerClaims(
      [
        'In Rwanda, a person providing payment services must be licensed.',
        'The provider must also maintain minimum capital of RWF 10 billion.',
      ].join(' '),
      [rwPaymentLicensing],
    );

    expect(result.verdict).toBe('PARTIAL');
    expect(result.supportedClaims).toHaveLength(1);
    expect(result.unsupportedClaims).toHaveLength(1);
  });
});
