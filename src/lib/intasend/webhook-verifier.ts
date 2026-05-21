import type { FastifyRequest } from 'fastify';
import type { IntaSendWebhookPayload } from '../../modules/intasend/intasend.types';

export type WebhookVerifyResult =
  | { ok: true; mode: 'challenge' }
  | { ok: false; reason: 'missing_challenge' | 'invalid_challenge' };

export interface WebhookVerifyInput {
  payload: IntaSendWebhookPayload;
  expectedChallenge: string;
}

/**
 * Verifies an IntaSend webhook payload against the configured challenge value.
 *
 * IntaSend support confirmed (2026-05-20) that webhooks use a shared-secret
 * challenge field as the sole cryptographic authenticity mechanism. No HMAC
 * or signature header is provided. Source IPs are restricted (handled at
 * the route level via IP allowlist).
 *
 * See docs/architecture/data-model-invariants.md, "IntaSend webhook
 * authenticity" section.
 */
export function verifyIntaSendWebhook(input: WebhookVerifyInput): WebhookVerifyResult {
  const received = input.payload.challenge;
  if (!received || typeof received !== 'string') {
    return { ok: false, reason: 'missing_challenge' };
  }
  return received === input.expectedChallenge
    ? { ok: true, mode: 'challenge' }
    : { ok: false, reason: 'invalid_challenge' };
}

export function isAllowedIntaSendIp(req: FastifyRequest, allowedIps: readonly string[]): boolean {
  return allowedIps.includes(req.ip);
}

export function parseAllowedIps(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}