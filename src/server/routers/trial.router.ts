import { z } from 'zod';
import { router, protectedProcedure } from '../trpc/trpc';
import { activateTrial, getTrialStatus } from '@/modules/trial';

/**
 * Trial Router
 *
 * Routes:
 *  - trial.activate -- one-time mutation to activate the 7-day free trial
 *  - trial.status   -- query to get current trial state and usage
 */
export const trialRouter = router({
  /**
   * Activate the free trial for the authenticated user.
   *
   * One-time only. Returns CONFLICT if the trial has already been used
   * (whether active or expired). Does not require an organization.
   *
   * @protected -- requires isAuthenticated
   */
  activate: protectedProcedure
    .input(z.void())
    .mutation(async ({ ctx }) => {
      return activateTrial(ctx.user.id);
    }),

  /**
   * Get the current trial status for the authenticated user.
   *
   * Returns isEligible, isActive, usage counters, and limits.
   * Used by the frontend PlanProvider to drive the trial CTA and status banner.
   *
   * @protected -- requires isAuthenticated
   */
  status: protectedProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      return getTrialStatus(ctx.user.id);
    }),
});
