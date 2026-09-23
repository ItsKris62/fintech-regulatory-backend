import { createHash } from 'crypto';

/**
 * Session security configuration.
 *
 * IDLE_TIMEOUT_SECONDS   -  Maximum consecutive inactivity before the session
 *   is silently invalidated on the next request. A sliding window: every
 *   authenticated request resets the clock.
 *
 * ABSOLUTE_TIMEOUT_SECONDS  -  Hard cap on how long a session (Supabase JWT +
 *   our Redis last-seen window) can remain live regardless of activity. This
 *   matches Supabase's default access-token lifetime (1 hour) multiplied by 8
 *   to cover a full business day without requiring re-login while still
 *   bounding the exposure window.
 */
export const SESSION_CONFIG = {
  /** 30 minutes of inactivity invalidates the session. */
  IDLE_TIMEOUT_SECONDS: 30 * 60,

  /** 8-hour absolute session cap (independent of inactivity). */
  ABSOLUTE_TIMEOUT_SECONDS: 8 * 60 * 60,
} as const;

/**
 * Redis key for user session cache (anchored on Supabase Auth UUID or DB User ID).
 *
 * Canonical lookup identifier:
 * - tRPC createContext / fast-path uses `user:session:${supabaseUserId}` (JWT `sub`).
 * - Auth handlers write to both `user:session:${supabaseUserId}` and `user:session:${prismaUserId}`
 *   to guarantee instant cache hits regardless of which identifier is presented.
 */
export const userSessionKey = (userId: string) => `user:session:${userId}`;

/** Redis key for the last-activity timestamp of an authenticated user (anchored on DB User ID). */
export const lastSeenKey = (userId: string) => `user:session:last_seen:${userId}`;

/** Redis key for session fingerprint (anchored on Session ID). */
export const sessionFingerprintKey = (sessionId: string) => `user:session:fingerprint:${sessionId}`;

/** Redis key for the absolute session start timestamp (anchored on DB User ID). */
export const sessionStartKey = (userId: string) => `user:session:session_start:${userId}`;

export interface SessionFingerprint {
  uaHash: string;
  ip: string;
}

/**
 * Normalizes and hashes the incoming User-Agent string.
 */
export function hashUserAgent(userAgent: string | undefined): string {
  const normalized = (userAgent ?? '').substring(0, 500);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Builds a structured session fingerprint containing:
 * 1. uaHash: SHA-256 of User-Agent (detects browser/client changes)
 * 2. ip: Initial login IP (used strictly for informational telemetry / anomaly logging)
 *
 * IMPORTANT: Behind Cloudflare Anycast, mobile networks, and multi-cloud proxies,
 * client IP addresses change frequently during active sessions. IP must NEVER
 * be hard-bound or used to revoke JWT tokens.
 */
export function buildSessionFingerprint(ip: string | undefined | null, userAgent: string | undefined): string {
  const uaHash = hashUserAgent(userAgent);
  return JSON.stringify({
    uaHash,
    ip: ip || '',
  });
}

/**
 * Parses a stored session fingerprint string from Redis.
 * Handles both new JSON structure `{ uaHash, ip }` and legacy raw SHA-256 strings gracefully.
 */
export function parseSessionFingerprint(rawFp: string | null | undefined): SessionFingerprint | null {
  if (!rawFp) return null;
  try {
    const parsed = JSON.parse(rawFp);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.uaHash === 'string') {
      return {
        uaHash: parsed.uaHash,
        ip: typeof parsed.ip === 'string' ? parsed.ip : '',
      };
    }
  } catch {
    // If legacy raw sha256 string (64 chars hex) was stored, handle gracefully
    if (typeof rawFp === 'string' && /^[0-9a-fA-F]{64}$/.test(rawFp)) {
      return { uaHash: rawFp, ip: '' };
    }
  }
  return null;
}

