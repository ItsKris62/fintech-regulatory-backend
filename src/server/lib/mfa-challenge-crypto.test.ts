import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  encryptMfaChallenge,
  decryptMfaChallenge,
  MfaChallengeDecryptError,
} from './mfa-challenge-crypto';

describe('MFA Challenge Crypto Module (AES-256-GCM)', () => {
  const originalEnv = process.env.MFA_CHALLENGE_ENCRYPTION_KEY;
  const testKeyA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const testKeyB = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  beforeEach(() => {
    process.env.MFA_CHALLENGE_ENCRYPTION_KEY = testKeyA;
  });

  afterEach(() => {
    process.env.MFA_CHALLENGE_ENCRYPTION_KEY = originalEnv;
  });

  it('performs full round-trip: encrypt -> decrypt -> original payload', () => {
    const payload = {
      userId: 'usr-12345',
      accessToken: 'sb-access-token-xyz-987',
      refreshToken: 'sb-refresh-token-abc-123',
    };

    const encrypted = encryptMfaChallenge(payload);
    expect(encrypted).toContain('usr-12345.');
    expect(encrypted.split('.')).toHaveLength(4);

    const decrypted = decryptMfaChallenge(encrypted);
    expect(decrypted).toEqual(payload);
  });

  it('detects tampering: flipping ciphertext bytes throws auth_tag_mismatch', () => {
    const payload = {
      userId: 'usr-tamper',
      accessToken: 'token-to-tamper',
      refreshToken: 'refresh-to-tamper',
    };

    const encrypted = encryptMfaChallenge(payload);
    const parts = encrypted.split('.');
    // Tamper with ciphertext by appending/modifying characters
    const tamperedCiphertext = parts[3].slice(0, -2) + 'AA';
    const tamperedBlob = `${parts[0]}.${parts[1]}.${parts[2]}.${tamperedCiphertext}`;

    expect(() => decryptMfaChallenge(tamperedBlob)).toThrow(MfaChallengeDecryptError);
    try {
      decryptMfaChallenge(tamperedBlob);
    } catch (err: any) {
      expect(err).toBeInstanceOf(MfaChallengeDecryptError);
      expect(err.reason).toBe('auth_tag_mismatch');
    }
  });

  it('detects key rotation / wrong key and fails authentication tag check', () => {
    const payload = {
      userId: 'usr-rotate',
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
    };

    process.env.MFA_CHALLENGE_ENCRYPTION_KEY = testKeyA;
    const encrypted = encryptMfaChallenge(payload);

    // Switch to different key
    process.env.MFA_CHALLENGE_ENCRYPTION_KEY = testKeyB;

    expect(() => decryptMfaChallenge(encrypted)).toThrow(MfaChallengeDecryptError);
    try {
      decryptMfaChallenge(encrypted);
    } catch (err: any) {
      expect(err).toBeInstanceOf(MfaChallengeDecryptError);
      expect(err.reason).toBe('auth_tag_mismatch');
    }
  });

  it('throws format_invalid on malformed, incomplete, or corrupted blobs', () => {
    expect(() => decryptMfaChallenge('')).toThrow(MfaChallengeDecryptError);
    expect(() => decryptMfaChallenge('invalid')).toThrow(MfaChallengeDecryptError);
    expect(() => decryptMfaChallenge('part1.part2.part3')).toThrow(MfaChallengeDecryptError);

    try {
      decryptMfaChallenge('usr.shortIv.shortTag.ciphertext');
    } catch (err: any) {
      expect(err).toBeInstanceOf(MfaChallengeDecryptError);
      expect(err.reason).toBe('format_invalid');
    }
  });

  it('generates unique 96-bit IVs on every call (never reuses IV)', () => {
    const payload = {
      userId: 'usr-iv-check',
      accessToken: 'identical-access-token',
      refreshToken: 'identical-refresh-token',
    };

    const enc1 = encryptMfaChallenge(payload);
    const enc2 = encryptMfaChallenge(payload);

    expect(enc1).not.toBe(enc2);
    const iv1 = enc1.split('.')[1];
    const iv2 = enc2.split('.')[1];
    expect(iv1).not.toBe(iv2);
  });
});
