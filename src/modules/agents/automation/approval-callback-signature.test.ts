import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signApprovalCallback } from './approval-callback-signature';

describe('signApprovalCallback', () => {
  it('produces the exact canonical string n8n verifies: "${approvalId}.${decision}.${timestamp}"', () => {
    const signature = signApprovalCallback('test-secret', {
      approvalId: 'appr_123',
      decision: 'approved',
      timestampSeconds: 1700000000,
    });

    // Independently recomputed with node:crypto to prove the canonical
    // string/field order, not just that the function is internally consistent.
    const expected = createHmac('sha256', 'test-secret').update('appr_123.approved.1700000000').digest('hex');
    expect(signature).toBe(expected);
  });

  it('produces different signatures for approved vs rejected on the same approvalId/timestamp', () => {
    const base = { approvalId: 'appr_1', timestampSeconds: 1700000000 };
    const approved = signApprovalCallback('secret', { ...base, decision: 'approved' });
    const rejected = signApprovalCallback('secret', { ...base, decision: 'rejected' });
    expect(approved).not.toBe(rejected);
  });

  it('is deterministic for identical inputs', () => {
    const input = { approvalId: 'appr_1', decision: 'approved' as const, timestampSeconds: 1700000000 };
    expect(signApprovalCallback('secret', input)).toBe(signApprovalCallback('secret', input));
  });
});
