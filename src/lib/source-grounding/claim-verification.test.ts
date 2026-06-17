import { describe, it, expect } from 'vitest';
import { extractAnswerClaims, verifyAnswerClaims, AnswerVerificationResult } from './claim-verification';

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
});
