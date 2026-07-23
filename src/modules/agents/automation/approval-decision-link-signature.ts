import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ApprovalDecisionLinkSignatureInput {
  approvalId: string;
  expiresAtSeconds: number;
}

export interface VerifyApprovalDecisionLinkInput extends ApprovalDecisionLinkSignatureInput {
  signature: string;
  nowSeconds: number;
}

export type ApprovalDecisionLinkVerification =
  | { valid: true }
  | { valid: false; reason: 'invalid_signature' | 'expired' };

/**
 * HMAC-SHA256 over "${approvalId}.${expiresAtSeconds}", hex-encoded - same
 * canonical-string style as signApprovalCallback, but a distinct scheme for a
 * distinct trust boundary (see APPROVAL_DECISION_LINK_SECRET vs
 * AUTOMATION_HMAC_SECRET in app.config.ts). Deliberately signs only the
 * approvalId and the link's own expiry, never the decision - the confirmation
 * page offers both Approve and Reject, so the decision is chosen by which
 * button is clicked, not baked into the emailed link.
 */
export function signApprovalDecisionLink(secret: string, input: ApprovalDecisionLinkSignatureInput): string {
  const canonical = `${input.approvalId}.${input.expiresAtSeconds}`;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Verifies both the HMAC (timing-safe) and the expiry in one call. B3 (GET
 * confirmation page) and B4 (POST decision) both call this independently -
 * B4 does not trust that B3 already validated the token, since it could in
 * principle be hit directly without ever loading B3.
 */
export function verifyApprovalDecisionLink(secret: string, input: VerifyApprovalDecisionLinkInput): ApprovalDecisionLinkVerification {
  const expected = signApprovalDecisionLink(secret, { approvalId: input.approvalId, expiresAtSeconds: input.expiresAtSeconds });

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(input.signature, 'hex');

  // Guard against length mismatch before timingSafeEqual (throws RangeError if sizes differ).
  const signatureValid = expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  if (!signatureValid) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (input.nowSeconds > input.expiresAtSeconds) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true };
}
