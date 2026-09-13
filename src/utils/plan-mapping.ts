import { SubscriptionPlan } from '@prisma/client';

/**
 * Maps legacy `subscriptionTier` string values (and the current admin-written
 * SubscriptionPlan enum strings) to the canonical `SubscriptionPlan` enum.
 */
export function subscriptionTierToPlan(tier: string): SubscriptionPlan | null {
  if (!tier) return null;
  const upper = tier.trim().toUpperCase();

  // Exact enum match first
  if (upper in SubscriptionPlan) {
    return SubscriptionPlan[upper as keyof typeof SubscriptionPlan];
  }

  switch (upper) {
    case 'FREE':
      return SubscriptionPlan.FREE;
    case 'STARTER':
      return SubscriptionPlan.STARTER;
    case 'GROWTH':
      return SubscriptionPlan.GROWTH;
    case 'STARTUP':
      return SubscriptionPlan.STARTUP;
    case 'REGULATOR':
      return SubscriptionPlan.REGULATOR;
    case 'PROFESSIONAL':
    case 'BUSINESS':
      return SubscriptionPlan.BUSINESS;
    case 'ENTERPRISE':
    case 'CUSTOM':
      return SubscriptionPlan.ENTERPRISE;
    default:
      return null;
  }
}

/**
 * Same as `subscriptionTierToPlan` but falls back to `SubscriptionPlan.FREE`
 * when the tier string is unrecognised.
 */
export function subscriptionTierToPlanOrFree(tier: string): SubscriptionPlan {
  return subscriptionTierToPlan(tier) ?? SubscriptionPlan.FREE;
}
