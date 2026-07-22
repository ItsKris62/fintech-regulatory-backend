import { createHmac } from 'node:crypto';

export interface ApprovalCallbackSignatureInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  timestampSeconds: number;
}

/**
 * HMAC-SHA256 over "${approvalId}.${decision}.${timestamp}", hex-encoded.
 * Must match n8n's verification exactly (field order, dot separator, unix
 * seconds) - this scheme is already implemented and tested on the n8n side.
 */
export function signApprovalCallback(secret: string, input: ApprovalCallbackSignatureInput): string {
  const canonical = `${input.approvalId}.${input.decision}.${input.timestampSeconds}`;
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
