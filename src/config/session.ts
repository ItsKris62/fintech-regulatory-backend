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

/** Redis key for user session cache (anchored on DB User ID). */
export const userSessionKey = (userId: string) => `user:session:${userId}`;

/** Redis key for the last-activity timestamp of an authenticated user (anchored on DB User ID). */
export const lastSeenKey = (userId: string) => `user:session:last_seen:${userId}`;

/** Redis key for session fingerprint (anchored on Session ID). */
export const sessionFingerprintKey = (sessionId: string) => `user:session:fingerprint:${sessionId}`;

/** Redis key for the absolute session start timestamp (anchored on DB User ID). */
export const sessionStartKey = (userId: string) => `user:session:session_start:${userId}`;
