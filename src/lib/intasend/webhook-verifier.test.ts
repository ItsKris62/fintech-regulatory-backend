import { describe, expect, it } from 'vitest';
import {
  isStrongIntaSendWebhookChallenge,
  verifyIntaSendWebhook,
} from './webhook-verifier';

describe('IntaSend webhook verification', () => {
  it('accepts only the configured challenge value', () => {
    const expectedChallenge = '0123456789abcdef0123456789abcdef';

    expect(
      verifyIntaSendWebhook({
        expectedChallenge,
        payload: {
          invoice_id: 'INV_123',
          state: 'COMPLETE',
          challenge: expectedChallenge,
        },
      }),
    ).toEqual({ ok: true, mode: 'challenge' });

    expect(
      verifyIntaSendWebhook({
        expectedChallenge,
        payload: {
          invoice_id: 'INV_123',
          state: 'COMPLETE',
          challenge: 'wrong-but-same-route-shape',
        },
      }),
    ).toEqual({ ok: false, reason: 'invalid_challenge' });
  });

  it('rejects missing challenge values', () => {
    expect(
      verifyIntaSendWebhook({
        expectedChallenge: '0123456789abcdef0123456789abcdef',
        payload: {
          invoice_id: 'INV_123',
          state: 'COMPLETE',
        },
      }),
    ).toEqual({ ok: false, reason: 'missing_challenge' });
  });

  it('requires production challenge secrets to be long and non-placeholder', () => {
    expect(isStrongIntaSendWebhookChallenge('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isStrongIntaSendWebhookChallenge('short')).toBe(false);
    expect(isStrongIntaSendWebhookChallenge('generate_a_long_random_webhook_challenge')).toBe(false);
  });
});
