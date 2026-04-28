import * as crypto from 'node:crypto';
import { appConfig } from '@/config/app.config';
import { InternalServerError } from '@/utils/error';

export interface SignedToken {
  /** Send this in the URL */
  publicToken: string;
  /** Store this in the DB */
  tokenHash: string;
}

/**
 * Generate a tamper-evident signed token for pilot invitation and unsubscribe URLs.
 *
 * Format: `<random32hex>.<hmac32hex>` (65 chars total)
 * - `publicToken` — embed in the URL: `https://app.sheriabot.com/pilot/apply/<publicToken>`
 * - `tokenHash`   — store in `PilotInvitation.tokenHash`; never send to the client
 *
 * @example
 * const { publicToken, tokenHash } = generateSignedToken();
 * await prisma.pilotInvitation.create({ data: { tokenHash, ... } });
 * // Send email with: `${appConfig.marketing.appPublicUrl}/pilot/apply/${publicToken}`
 */
export function generateSignedToken(): SignedToken {
  if (!appConfig.marketing.tokenHmacSecret) {
    throw new InternalServerError('Token signing secret is not configured');
  }

  const randomPart = crypto.randomBytes(16).toString('hex'); // 32 hex chars, 128-bit entropy

  const hmacPart = crypto
    .createHmac('sha256', appConfig.marketing.tokenHmacSecret)
    .update(randomPart)
    .digest('hex')
    .slice(0, 32); // truncate to 32 hex chars

  const publicToken = `${randomPart}.${hmacPart}`; // 65 chars total
  const tokenHash = crypto.createHash('sha256').update(randomPart).digest('hex'); // 64 hex chars

  return { publicToken, tokenHash };
}

export interface VerifyResult {
  valid: boolean;
  /** Present only when valid; use this to look up the DB row */
  tokenHash?: string;
  reason?: 'malformed' | 'invalid_signature';
}

/**
 * Verify a signed token received from a URL parameter.
 *
 * Verification flow:
 * 1. Receive `publicToken` from request URL
 * 2. Call `verifySignedToken(publicToken)`
 * 3. If `result.valid`, look up `PilotInvitation` by `result.tokenHash`
 * 4. Check expiry and status on the DB row
 *
 * @example
 * const result = verifySignedToken(ctx.params.token);
 * if (!result.valid) throw new BadRequestError(`Invalid token: ${result.reason}`);
 * const invite = await prisma.pilotInvitation.findUnique({ where: { tokenHash: result.tokenHash } });
 *
 * Uses constant-time comparison to prevent timing attacks.
 * Never throws for invalid tokens — always returns a `VerifyResult`.
 */
export function verifySignedToken(publicToken: string): VerifyResult {
  if (!appConfig.marketing.tokenHmacSecret) {
    throw new InternalServerError('Token signing secret is not configured');
  }

  const parts = publicToken.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const [randomPart, hmacPart] = parts;
  const hexPattern = /^[a-f0-9]{32}$/;

  if (!hexPattern.test(randomPart) || !hexPattern.test(hmacPart)) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = crypto
    .createHmac('sha256', appConfig.marketing.tokenHmacSecret)
    .update(randomPart)
    .digest('hex')
    .slice(0, 32);

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(hmacPart, 'hex');

  // Guard against length mismatch before timingSafeEqual (throws RangeError if sizes differ)
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const tokenHash = crypto.createHash('sha256').update(randomPart).digest('hex');
  return { valid: true, tokenHash };
}
