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

/** Redis key for the last-activity timestamp of an authenticated user. */
export const lastSeenKey = (userId: string) => `sheriabot:last_seen:${userId}`;

/** Redis key for the absolute session start timestamp. */
export const sessionStartKey = (userId: string) => `sheriabot:session_start:${userId}`;
