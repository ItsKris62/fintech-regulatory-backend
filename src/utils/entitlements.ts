import { TRPCError } from '@trpc/server';
import { SubscriptionPlan } from '@prisma/client';
import type { EffectivePlan } from '@/types/plan.types';
import {
  PLAN_ENTITLEMENTS,
  PILOT_ENTITLEMENT_PROFILES,
  type FeatureKey,
  type PlanEntitlementConfig,
} from '@/config/entitlements.config';
import type { PilotEntitlementProfile } from '@/types/plan.types';

// ============================================================================
// Internal helpers
// ============================================================================

/** Ordered from least to most permissive (the paid upgrade path). */
const PLAN_ORDER: SubscriptionPlan[] = [
  SubscriptionPlan.REGULATOR,
  SubscriptionPlan.STARTUP,
  SubscriptionPlan.BUSINESS,
  SubscriptionPlan.ENTERPRISE,
];

const PLAN_DISPLAY_NAMES: Record<EffectivePlan, string> = {
  REGULATOR:  'Regulator',
  STARTUP:    'Startup',
  BUSINESS:   'Business',
  ENTERPRISE: 'Enterprise',
  FREE_TRIAL: 'Free Trial',
};

// ============================================================================
// hasFeature
// ============================================================================

function hasFeatureFromEntitlements(
  entitlements: PlanEntitlementConfig,
  feature: FeatureKey,
): boolean {
  const value: PlanEntitlementConfig[typeof feature] = entitlements[feature];

  if (value === undefined) return false;
  if (value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value > 0 || value === -1;
  if (typeof value === 'string') return value !== 'none';

  // Object value -- QuotaEntitlement | StorageEntitlement
  if (typeof value === 'object') {
    if ('limitMB' in value) return value.limitMB !== 0;
    if ('limit' in value) return value.limit !== 0;
  }

  return false;
}

/**
 * Returns true if the given plan grants access to a feature.
 *
 * Rules per value type:
 *  - boolean           -> the boolean itself
 *  - QuotaEntitlement  -> limit !== 0  (-1 = unlimited = true, 0 = unavailable = false)
 *  - StorageEntitlement-> limitMB !== 0
 *  - ApiAccessEntitlement -> false means no access; object means access
 *  - number (maxSeats) -> > 0 or unlimited (-1)
 *  - AnalyticsTier     -> 'none' means no access
 *  - other strings     -> always true (different tiers of the same feature)
 *  - undefined         -> false (optional Enterprise-only flags on lower plans)
 */
export function hasFeature(plan: EffectivePlan, feature: FeatureKey): boolean {
  return hasFeatureFromEntitlements(PLAN_ENTITLEMENTS[plan], feature);
}

// ============================================================================
// getLimit
// ============================================================================

/**
 * Returns the numeric limit for a metered feature.
 *
 * -1  = unlimited
 *  0  = feature not available on this plan
 *  n  = cap per period
 *
 * For non-metered boolean features returns 1 (available) or 0 (unavailable).
 * For maxSeats returns the seat count directly.
 */
export function getLimit(plan: EffectivePlan, feature: FeatureKey): number {
  return getLimitFromEntitlements(PLAN_ENTITLEMENTS[plan], feature);
}

export function getLimitFromEntitlements(
  entitlements: PlanEntitlementConfig,
  feature: FeatureKey,
): number {
  const value: PlanEntitlementConfig[typeof feature] = entitlements[feature];

  if (value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === 'number') return value;  // maxSeats
  if (typeof value === 'string') return value !== 'none' ? 1 : 0;

  if (typeof value === 'object') {
    if ('limitMB' in value) return value.limitMB;
    if ('limit' in value) return value.limit;
  }

  return 0;
}

// ============================================================================
// getQuota
// ============================================================================

/**
 * Returns both the numeric limit and billing period for a metered feature.
 * Used by checkUsageLimit middleware to construct the correct Redis key
 * (monthly vs. lifetime) and surface the right error message.
 *
 * Falls back to { limit: 0, period: 'month' } for non-quota features.
 */
export function getQuota(
  plan: EffectivePlan,
  feature: FeatureKey,
): { limit: number; period: 'month' | 'lifetime' } {
  return getQuotaFromEntitlements(PLAN_ENTITLEMENTS[plan], feature);
}

export function getQuotaFromEntitlements(
  entitlements: PlanEntitlementConfig,
  feature: FeatureKey,
): { limit: number; period: 'month' | 'lifetime' } {
  const value: PlanEntitlementConfig[typeof feature] = entitlements[feature];

  if (typeof value === 'object' && value !== null && 'limit' in value) {
    const q = value as { limit: number; period: 'month' | 'lifetime' };
    return { limit: q.limit, period: q.period };
  }

  // Non-quota feature: treat as unavailable with monthly placeholder period.
  return { limit: typeof value === 'boolean' ? (value ? -1 : 0) : 0, period: 'month' };
}

// ============================================================================
// requireFeature
// ============================================================================

/**
 * Throws a FORBIDDEN TRPCError if the plan does not grant access to the feature.
 * Use inside tRPC middleware -- do NOT use directly in handler logic.
 *
 * @throws TRPCError { code: 'FORBIDDEN' }
 */
export function requireFeature(plan: EffectivePlan, feature: FeatureKey): void {
  requireEntitlementFeature(PLAN_ENTITLEMENTS[plan], feature);
}

export function requireEntitlementFeature(
  entitlements: PlanEntitlementConfig,
  feature: FeatureKey,
): void {
  if (!hasFeatureFromEntitlements(entitlements, feature)) {
    const minimumPlan = getMinimumPlan(feature);
    const requiredPlanName = minimumPlan
      ? PLAN_DISPLAY_NAMES[minimumPlan]
      : 'Enterprise';

    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This feature requires the ${requiredPlanName} plan or higher. Please upgrade your subscription.`,
    });
  }
}

export function getPilotEntitlements(
  profile: PilotEntitlementProfile,
): PlanEntitlementConfig {
  return PILOT_ENTITLEMENT_PROFILES[profile] ?? PILOT_ENTITLEMENT_PROFILES.PILOT_FULL;
}

// ============================================================================
// getMinimumPlan
// ============================================================================

/**
 * Returns the lowest SubscriptionPlan that grants access to a feature.
 * Only considers purchasable DB plans (not FREE_TRIAL).
 * Returns null if no plan provides the feature (should not happen in practice).
 */
export function getMinimumPlan(feature: FeatureKey): SubscriptionPlan | null {
  for (const plan of PLAN_ORDER) {
    if (hasFeature(plan, feature)) return plan;
  }
  return null;
}

// ============================================================================
// getPlanDisplayName
// ============================================================================

export function getPlanDisplayName(plan: EffectivePlan): string {
  return PLAN_DISPLAY_NAMES[plan];
}

// ============================================================================
// getOrgEntitlements
// ============================================================================

/**
 * Returns the full entitlements config for an org based on its subscription plan.
 *
 * Accepts SubscriptionPlan (not EffectivePlan) because orgs always have a
 * DB-persisted plan. Use PLAN_ENTITLEMENTS[effectivePlan] directly when working
 * with an already-resolved EffectivePlan from middleware context.
 */
export function getOrgEntitlements(
  org: { plan: SubscriptionPlan },
): PlanEntitlementConfig {
  return PLAN_ENTITLEMENTS[org.plan];
}
