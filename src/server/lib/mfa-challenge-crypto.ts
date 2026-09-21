import crypto from 'node:crypto';

export type MfaDecryptFailureReason = 'format_invalid' | 'auth_tag_mismatch' | 'key_rotated' | 'unknown';

export class MfaChallengeDecryptError extends Error {
  public readonly reason: MfaDecryptFailureReason;

  constructor(reason: MfaDecryptFailureReason, message?: string) {
    super(message || `MFA challenge decryption failed: ${reason}`);
    this.name = 'MfaChallengeDecryptError';
    this.reason = reason;
  }
}

export interface MfaChallengePayload {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

const DEFAULT_DEV_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function getEncryptionKey(): Buffer {
  const envKey = process.env.MFA_CHALLENGE_ENCRYPTION_KEY?.trim();
  const rawKey = envKey || (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? '' : DEFAULT_DEV_KEY);

  if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new MfaChallengeDecryptError(
      'key_rotated',
      'Invalid or missing MFA_CHALLENGE_ENCRYPTION_KEY (must be 64 hex characters).',
    );
  }

  return Buffer.from(rawKey, 'hex');
}

/**
 * Encrypts an MFA session challenge payload into a four-segment format:
 * `<userId>.<iv_b64url>.<authTag_b64url>.<ciphertext_b64url>`
 */
export function encryptMfaChallenge(payload: {
  userId: string;
  accessToken: string;
  refreshToken: string;
}): string {
  if (!payload.userId || typeof payload.userId !== 'string') {
    throw new Error('userId is required for MFA challenge encryption');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify({
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    payload.userId,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts an MFA session challenge string.
 * Expects `<userId>.<iv_b64url>.<authTag_b64url>.<ciphertext_b64url>`
 */
export function decryptMfaChallenge(blob: string): MfaChallengePayload {
  if (!blob || typeof blob !== 'string') {
    throw new MfaChallengeDecryptError('format_invalid', 'Challenge blob is empty or non-string');
  }

  const parts = blob.split('.');
  if (parts.length !== 4) {
    throw new MfaChallengeDecryptError('format_invalid', `Expected 4 dot-separated parts, received ${parts.length}`);
  }

  const [userId, ivB64, authTagB64, ciphertextB64] = parts;
  if (!userId || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new MfaChallengeDecryptError('format_invalid', 'One or more challenge segments are empty');
  }

  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;

  try {
    iv = Buffer.from(ivB64, 'base64url');
    authTag = Buffer.from(authTagB64, 'base64url');
    ciphertext = Buffer.from(ciphertextB64, 'base64url');
  } catch {
    throw new MfaChallengeDecryptError('format_invalid', 'Failed to decode base64url challenge segments');
  }

  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new MfaChallengeDecryptError('format_invalid', 'Invalid segment lengths (IV must be 12B, Tag must be 16B)');
  }

  let key: Buffer;
  try {
    key = getEncryptionKey();
  } catch (err) {
    if (err instanceof MfaChallengeDecryptError) {
      throw err;
    }
    throw new MfaChallengeDecryptError('key_rotated', 'Failed to resolve encryption key');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const parsed = JSON.parse(decrypted.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.accessToken !== 'string') {
      throw new MfaChallengeDecryptError('format_invalid', 'Decrypted payload is missing expected token fields');
    }

    return {
      userId,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
    };
  } catch (err: any) {
    if (err instanceof MfaChallengeDecryptError) {
      throw err;
    }
    // GCM authentication failure in OpenSSL throws 'Unsupported state or unable to authenticate data'
    throw new MfaChallengeDecryptError('auth_tag_mismatch', err?.message || 'Authentication tag mismatch');
  }
}
