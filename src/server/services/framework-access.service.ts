import { SubscriptionPlan } from '@prisma/client';
import type { EffectivePlan } from '@/types/plan.types';

export const FRAMEWORK_TIER_LEVEL: Record<string, number> = {
  FREE: 1,
  STARTER: 1,
  GROWTH: 2,
  STARTUP: 1,
  BUSINESS: 2,
  ENTERPRISE: 3,
};

export const PLAN_FRAMEWORK_LEVEL: Record<EffectivePlan, number> = {
  [SubscriptionPlan.FREE]: 1,
  [SubscriptionPlan.STARTER]: 1,
  [SubscriptionPlan.GROWTH]: 2,
  [SubscriptionPlan.BUSINESS]: 2,
  [SubscriptionPlan.ENTERPRISE]: 3,
  [SubscriptionPlan.REGULATOR]: 1,
  [SubscriptionPlan.STARTUP]: 1,
  FREE_TRIAL: 1,
};

export function getFrameworkAccessLevel(plan: EffectivePlan): number {
  return PLAN_FRAMEWORK_LEVEL[plan] ?? 0;
}

export function canAccessFrameworkTier(plan: EffectivePlan, frameworkTier: string | null | undefined): boolean {
  return getFrameworkAccessLevel(plan) >= (FRAMEWORK_TIER_LEVEL[frameworkTier ?? 'STARTUP'] ?? 1);
}

export function allowedFrameworkTiersForPlan(plan: EffectivePlan): string[] {
  const level = getFrameworkAccessLevel(plan);
  return Object.entries(FRAMEWORK_TIER_LEVEL)
    .filter(([, tierLevel]) => tierLevel <= level)
    .map(([tier]) => tier);
}
