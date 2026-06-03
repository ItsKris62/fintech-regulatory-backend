import { SubscriptionPlan } from '@prisma/client';

// ============================================================================
// EffectivePlan -- TypeScript-only union, never persisted to the database.
// FREE_TRIAL is not a Prisma enum value; it exists only at the application layer.
// ============================================================================

export type EffectivePlan = SubscriptionPlan | 'FREE_TRIAL';

export type EffectivePlanSource =
  | 'SUBSCRIPTION'
  | 'FREE_TRIAL'
  | 'GRACE_PERIOD'
  | 'PILOT'
  | 'FALLBACK'
  | 'SUSPENDED';

export type PilotEntitlementProfile =
  | 'PILOT_FULL'
  | 'PILOT_FULL_WITH_POLICY_GENERATION';

export interface PilotPlanState {
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'CONVERTED';
  entitlementProfile: PilotEntitlementProfile;
  expiresAt: string | null;
  extensionCount: number;
}

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
