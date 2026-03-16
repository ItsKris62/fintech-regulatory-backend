import { TRPCError } from '@trpc/server';
import {
  PLAN_ENTITLEMENTS,
  SubscriptionPlan,
  type FeatureKey,
  type PlanEntitlementConfig,
} from '@/config/entitlements.config';

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

const PLAN_DISPLAY_NAMES: Record<SubscriptionPlan, string> = {
  REGULATOR:  'Regulator',
  STARTUP:    'Startup',
  BUSINESS:   'Business',
  ENTERPRISE: 'Enterprise',
};

// ============================================================================
// hasFeature
// ============================================================================

/**
 * Returns true if the given plan grants access to a feature.
 *
 * Rules per value type:
 *  - boolean           → the boolean itself
 *  - QuotaEntitlement  → limit !== 0  (-1 = unlimited = true, 0 = unavailable = false)
 *  - StorageEntitlement→ limitMB !== 0
 *  - ApiAccessEntitlement → false means no access; object means access
 *  - number (maxSeats) → > 0 or unlimited (-1)
 *  - AnalyticsTier     → 'none' means no access
 *  - other strings     → always true (different tiers of the same feature)
 *  - undefined         → false (optional Enterprise-only flags on lower plans)
 */
export function hasFeature(plan: SubscriptionPlan, feature: FeatureKey): boolean {
  const entitlements = PLAN_ENTITLEMENTS[plan];
  const value: PlanEntitlementConfig[typeof feature] = entitlements[feature];

  if (value === undefined) return false;
  if (value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value > 0 || value === -1;
  if (typeof value === 'string') return value !== 'none';

  // Object value — QuotaEntitlement | StorageEntitlement
  if (typeof value === 'object') {
    if ('limitMB' in value) return value.limitMB !== 0;
    if ('limit' in value) return value.limit !== 0;
  }

  return false;
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
export function getLimit(plan: SubscriptionPlan, feature: FeatureKey): number {
  const entitlements = PLAN_ENTITLEMENTS[plan];
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
// requireFeature
// ============================================================================

/**
 * Throws a FORBIDDEN TRPCError if the plan does not grant access to the feature.
 * Use inside tRPC middleware — do NOT use directly in handler logic.
 *
 * @throws TRPCError { code: 'FORBIDDEN' }
 */
export function requireFeature(plan: SubscriptionPlan, feature: FeatureKey): void {
  if (!hasFeature(plan, feature)) {
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

// ============================================================================
// getMinimumPlan
// ============================================================================

/**
 * Returns the lowest plan that grants access to a feature.
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

export function getPlanDisplayName(plan: SubscriptionPlan): string {
  return PLAN_DISPLAY_NAMES[plan];
}

// ============================================================================
// getOrgEntitlements
// ============================================================================

/**
 * Returns the full entitlements config for an org based on its subscription plan.
 *
 * This is the canonical way to look up entitlements from an org object in
 * service-layer code that has direct DB access rather than middleware context.
 * Middlewares use withPlanContext + PLAN_ENTITLEMENTS internally; this helper
 * follows the same pattern but is callable from module/service code.
 */
export function getOrgEntitlements(
  org: { plan: SubscriptionPlan },
): typeof PLAN_ENTITLEMENTS[SubscriptionPlan] {
  return PLAN_ENTITLEMENTS[org.plan];
}
