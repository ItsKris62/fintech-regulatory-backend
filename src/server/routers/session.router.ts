/**
 * Session Router
 *
 * Provides a lightweight heartbeat procedure that frontend idle-timeout logic
 * can call when the user clicks "Stay Logged In".
 *
 * The only purpose of the heartbeat is to hit a protectedProcedure so that
 * context.ts slides the `sheriabot:last_seen:{userId}` Redis window forward,
 * keeping the backend session alive in sync with the frontend timer reset.
 */

import { router, protectedProcedure } from '../trpc/trpc';

export const sessionRouter = router({
  /**
   * Heartbeat  -  authenticated no-op.
   *
   * Reaching this procedure means the request passed through isAuthenticated,
   * which already updates last_seen in context.ts for every authenticated
   * request. No additional logic needed here.
   *
   * Called by useIdleTimeout.resetTimer() when the user clicks "Stay Logged In".
   */
  heartbeat: protectedProcedure.mutation(() => {
    return { ok: true as const };
  }),
});
