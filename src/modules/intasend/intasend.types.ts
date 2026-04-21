/**
 * IntaSend / M-Pesa type definitions.
 *
 * The intasend-node SDK types all payloads as `any`. These interfaces wrap
 * the SDK so the rest of the codebase can remain strictly typed.
 */

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface STKPushInput {
  /** M-Pesa phone number  -  must already be normalised to 254XXXXXXXXX */
  phoneNumber: string;
  /** Amount in KES (whole number  -  NOT cents) */
  amount: number;
  /** Short reference shown to the customer on the STK prompt */
  accountReference: string;
  /** Human-readable narrative / description */
  narrative: string;
}

export interface STKPushResponse {
  /** IntaSend invoice ID  -  used to poll for status */
  invoiceId: string;
  /** Initial state  -  always 'PENDING' immediately after initiation */
  state: IntaSendPaymentState;
  /** Raw response from IntaSend (stored in Payment.metadata) */
  raw: Record<string, unknown>;
}

export interface PaymentStatusResponse {
  invoiceId: string;
  state: IntaSendPaymentState;
  /** Provider-assigned transaction ID (e.g. Safaricom mpesa_reference) */
  providerRef: string | null;
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Webhook payload
// ---------------------------------------------------------------------------

/**
 * Shape of the POST body IntaSend sends to /api/webhooks/intasend.
 *
 * IntaSend does not sign webhook payloads with HMAC. Security is achieved by
 * re-calling collection.status(invoice_id) to confirm the reported state
 * directly from IntaSend's API before acting on it.
 */
export interface IntaSendWebhookPayload {
  invoice_id: string;
  state: string;          // 'COMPLETE' | 'FAILED' | 'PENDING'
  failed_reason?: string;
  failed_code?: string;
  meta?: Record<string, unknown>;
  /** Present when the webhook is a challenge/verification request */
  challenge?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

export type IntaSendPaymentState = 'PENDING' | 'COMPLETE' | 'FAILED';

/**
 * Normalise the raw IntaSend state string to our typed union.
 * Treats any unrecognised value as 'PENDING' (safe fallback).
 */
export function normaliseIntaSendState(raw: string): IntaSendPaymentState {
  const upper = raw?.toUpperCase?.() ?? '';
  if (upper === 'COMPLETE') return 'COMPLETE';
  if (upper === 'FAILED') return 'FAILED';
  return 'PENDING';
}
