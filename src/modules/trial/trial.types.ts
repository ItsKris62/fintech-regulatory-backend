import { z } from 'zod';
import { FREE_TRIAL_LIMITS } from '@/types/plan.types';

// ============================================================================
// Trial usage -- stored as JSON on User.freeTrialUsage
// ============================================================================

export const TrialUsageSchema = z.object({
  complianceQueries: z.number().int().min(0),
  gapAnalyses:       z.number().int().min(0),
  checklists:        z.number().int().min(0),
  vaultUploads:      z.number().int().min(0),
  totalTokensUsed:   z.number().int().min(0),
});

export type TrialUsage = z.infer<typeof TrialUsageSchema>;

export const EMPTY_TRIAL_USAGE: TrialUsage = {
  complianceQueries: 0,
  gapAnalyses:       0,
  checklists:        0,
  vaultUploads:      0,
  totalTokensUsed:   0,
};

// ============================================================================
// Trial status -- returned by trial.status tRPC procedure
// ============================================================================

export interface TrialStatus {
  /** User has never activated a trial. */
  isEligible: boolean;
  /** Trial is currently active (activated and not yet expired). */
  isActive: boolean;
  /** User has activated a trial at some point (whether active or expired). */
  hasUsedTrial: boolean;
  /** When the trial expires. Null if never activated. */
  expiresAt: Date | null;
  /** Calendar days remaining, rounded down. Null if not active. */
  daysRemaining: number | null;
  /** Current usage counters. Null if never activated. */
  usage: TrialUsage | null;
  /** Hard caps for each feature. Always present for UI rendering. */
  limits: typeof FREE_TRIAL_LIMITS;
}

// ============================================================================
// Lightweight trial context -- attached to tRPC ctx when plan === 'FREE_TRIAL'
// ============================================================================

export interface TrialContextState {
  isActive: boolean;
  daysRemaining: number | null;
}
