import { describe, expect, it } from 'vitest';
import {
  getIntaSendWebhookClientIp,
  isAllowedIntaSendIp,
  isStrongIntaSendWebhookChallenge,
  parseTrustedProxyHops,
  verifyIntaSendWebhook,
} from './webhook-verifier';

function req(ip: string, forwarded?: string) {
  return {
    ip,
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  } as any;
}

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

  it('accepts direct IntaSend IPs and rejects direct unknown IPs', () => {
    expect(isAllowedIntaSendIp(req('68.183.180.25'), ['68.183.180.25'], 0)).toBe(true);
    expect(isAllowedIntaSendIp(req('203.0.113.9'), ['68.183.180.25'], 0)).toBe(false);
  });

  it('derives the client IP from the configured trusted proxy hop', () => {
    expect(getIntaSendWebhookClientIp(req('10.0.0.9', '203.0.113.7, 68.183.180.25'), 1)).toBe('68.183.180.25');
    expect(getIntaSendWebhookClientIp(req('10.0.0.9', '68.183.180.25, 203.0.113.7'), 1)).toBe('203.0.113.7');
  });

  it('does not let forged forwarded headers bypass allowlisting when proxy trust is disabled', () => {
    const forged = req('203.0.113.9', '68.183.180.25');
    expect(getIntaSendWebhookClientIp(forged, 0)).toBe('203.0.113.9');
    expect(isAllowedIntaSendIp(forged, ['68.183.180.25'], 0)).toBe(false);
  });

  it('parses trusted proxy hops conservatively', () => {
    expect(parseTrustedProxyHops('1')).toBe(1);
    expect(parseTrustedProxyHops('0')).toBe(0);
    expect(parseTrustedProxyHops('true')).toBe(0);
    expect(parseTrustedProxyHops(undefined)).toBe(0);
  });
});
