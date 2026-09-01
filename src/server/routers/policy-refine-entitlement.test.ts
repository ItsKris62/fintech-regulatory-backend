import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SubscriptionPlan } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PLAN_ENTITLEMENTS, PILOT_ENTITLEMENT_PROFILES } from '@/config/entitlements.config';
import { hasFeature } from '@/utils/entitlements';

function local(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
}

describe('policy refinement entitlement & enforcement', () => {
  const policyRouter = local('policy.router.ts');

  it('binds policy.refine to canonical plan-context and policyGeneration feature gating', () => {
    expect(policyRouter).toContain('refine: orgMemberProcedure');
    expect(policyRouter).toContain("rateLimited('policyRefinement')");
    expect(policyRouter).toContain('withPlanContext');
    expect(policyRouter).toContain("requirePlanFeature('policyGeneration')");
  });

  it('checks DPA Section 34 restriction and jurisdiction entitlement during policy refinement', () => {
    expect(policyRouter).toContain("isProcessingPermitted(ctx.user.id, 'POLICY_GENERATION')");
    expect(policyRouter).toContain('resolveJurisdictionEntitlement({');
    expect(policyRouter).toContain("route: 'trpc.policy.refine'");
  });

  it('checks and increments policy generation usage limit atomically on AI completion', () => {
    expect(policyRouter).toContain('const usagePatch = await resolveUsageLimit(ctx, BillingMetric.POLICY_GENERATIONS, { deferIncrement: true });');
    expect(policyRouter).toContain('await usagePatch.incrementUsage?.();');
  });

  it('verifies that policyGeneration is disabled for REGULATOR, STARTUP, BUSINESS, and FREE_TRIAL', () => {
    expect(hasFeature(SubscriptionPlan.REGULATOR, 'policyGeneration')).toBe(false);
    expect(hasFeature(SubscriptionPlan.STARTUP, 'policyGeneration')).toBe(false);
    expect(hasFeature(SubscriptionPlan.BUSINESS, 'policyGeneration')).toBe(false);
    expect(PLAN_ENTITLEMENTS.REGULATOR.policyGeneration).toBe(false);
    expect(PLAN_ENTITLEMENTS.STARTUP.policyGeneration).toBe(false);
    expect(PLAN_ENTITLEMENTS.BUSINESS.policyGeneration).toBe(false);
    expect(PLAN_ENTITLEMENTS.FREE_TRIAL.policyGeneration).toBe(false);
  });

  it('verifies that policyGeneration is enabled for ENTERPRISE and PILOT_FULL_WITH_POLICY_GENERATION', () => {
    expect(hasFeature(SubscriptionPlan.ENTERPRISE, 'policyGeneration')).toBe(true);
    expect(PLAN_ENTITLEMENTS.ENTERPRISE.policyGeneration).toBe(true);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL_WITH_POLICY_GENERATION.policyGeneration).toBe(true);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL.policyGeneration).toBe(false);
  });
});
