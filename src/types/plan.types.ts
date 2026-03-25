import { SubscriptionPlan } from '@prisma/client';

// ============================================================================
// EffectivePlan -- TypeScript-only union, never persisted to the database.
// FREE_TRIAL is not a Prisma enum value; it exists only at the application layer.
// ============================================================================

export type EffectivePlan = SubscriptionPlan | 'FREE_TRIAL';

// ============================================================================
// Trial limits -- hard caps applied per-trial-lifetime (not monthly).
// ============================================================================

export const FREE_TRIAL_LIMITS = {
  complianceQueries: 25,
  gapAnalyses:       5,
  checklists:        5,
  vaultUploads:      10,
  totalTokensUsed:   500_000,
} as const;

export type TrialFeature = keyof typeof FREE_TRIAL_LIMITS;
