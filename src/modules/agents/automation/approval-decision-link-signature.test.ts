import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signApprovalDecisionLink, verifyApprovalDecisionLink } from './approval-decision-link-signature';

describe('signApprovalDecisionLink', () => {
  it('produces the exact canonical string: "${approvalId}.${expiresAtSeconds}"', () => {
    const signature = signApprovalDecisionLink('test-secret', {
      approvalId: 'appr_123',
      expiresAtSeconds: 1700000000,
    });

    const expected = createHmac('sha256', 'test-secret').update('appr_123.1700000000').digest('hex');
    expect(signature).toBe(expected);
  });

  it('is deterministic for identical inputs', () => {
    const input = { approvalId: 'appr_1', expiresAtSeconds: 1700000000 };
    expect(signApprovalDecisionLink('secret', input)).toBe(signApprovalDecisionLink('secret', input));
  });

  it('produces different signatures for different approvalIds', () => {
    const a = signApprovalDecisionLink('secret', { approvalId: 'appr_1', expiresAtSeconds: 1700000000 });
    const b = signApprovalDecisionLink('secret', { approvalId: 'appr_2', expiresAtSeconds: 1700000000 });
    expect(a).not.toBe(b);
  });
});

describe('verifyApprovalDecisionLink', () => {
  const SECRET = 'test-secret';

  it('accepts a valid, non-expired token', () => {
    const signature = signApprovalDecisionLink(SECRET, { approvalId: 'appr_1', expiresAtSeconds: 1700003600 });
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700003600,
      signature,
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: true });
  });

  it('accepts a token at the exact expiry boundary (nowSeconds === expiresAtSeconds)', () => {
    const signature = signApprovalDecisionLink(SECRET, { approvalId: 'appr_1', expiresAtSeconds: 1700000000 });
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700000000,
      signature,
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: true });
  });

  it('rejects an expired token with reason "expired"', () => {
    const signature = signApprovalDecisionLink(SECRET, { approvalId: 'appr_1', expiresAtSeconds: 1700000000 });
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700000000,
      signature,
      nowSeconds: 1700000001,
    });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a tampered signature with reason "invalid_signature"', () => {
    const signature = signApprovalDecisionLink(SECRET, { approvalId: 'appr_1', expiresAtSeconds: 1700003600 });
    const tampered = signature.slice(0, -2) + (signature.endsWith('ff') ? '00' : 'ff');
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700003600,
      signature: tampered,
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects a signature computed with the wrong secret', () => {
    const signature = signApprovalDecisionLink('a-different-secret', { approvalId: 'appr_1', expiresAtSeconds: 1700003600 });
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700003600,
      signature,
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects a signature valid for a different approvalId', () => {
    const signature = signApprovalDecisionLink(SECRET, { approvalId: 'appr_other', expiresAtSeconds: 1700003600 });
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700003600,
      signature,
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects a signature valid for a different expiresAtSeconds (does not silently extend TTL)', () => {
    const signature = signApprovalDecisionLink(SECRET, { approvalId: 'appr_1', expiresAtSeconds: 1700003600 });
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 9999999999,
      signature,
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('does not throw on a malformed (non-hex or wrong-length) signature', () => {
    const result = verifyApprovalDecisionLink(SECRET, {
      approvalId: 'appr_1',
      expiresAtSeconds: 1700003600,
      signature: 'not-hex-at-all',
      nowSeconds: 1700000000,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });
});
