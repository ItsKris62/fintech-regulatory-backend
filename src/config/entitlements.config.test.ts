import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PILOT_ENTITLEMENT_PROFILES, PLAN_ENTITLEMENTS } from './entitlements.config';
import { getLimitFromEntitlements, getQuota, getQuotaFromEntitlements } from '@/utils/entitlements';

describe('regulator checklist quota', () => {
  it('allows one checklist generation per month and keeps history outside the quota window', () => {
    const quota = getQuota(SubscriptionPlan.REGULATOR, 'checklistGenerations');

    expect(PLAN_ENTITLEMENTS.REGULATOR.checklistGenerations).toEqual({
      limit: 1,
      period: 'month',
    });
    expect(quota).toEqual({ limit: 1, period: 'month' });
  });

  it('maps checklist generation billing to the regulator quota-backed feature', () => {
    expect(BillingMetric.CHECKLIST_GENERATIONS).toBe('CHECKLIST_GENERATIONS');
    expect(PLAN_ENTITLEMENTS.REGULATOR.checklistGenerations.limit).toBe(1);
  });
});

describe('pilot entitlement profiles', () => {
  it('grants active pilot access to requested product features', () => {
    const pilot = PILOT_ENTITLEMENT_PROFILES.PILOT_FULL;

    expect(getQuotaFromEntitlements(pilot, 'complianceQueries').limit).toBe(-1);
    expect(getQuotaFromEntitlements(pilot, 'checklistGenerations').limit).toBe(-1);
    expect(getQuotaFromEntitlements(pilot, 'gapAnalysis').limit).not.toBe(0);
    expect(getLimitFromEntitlements(pilot, 'documentRepository')).not.toBe(0);
    expect(pilot.regulatoryDashboard).toBe(true);
  });

  it('does not include policy generation unless explicitly enabled', () => {
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL.policyGeneration).toBe(false);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL_WITH_POLICY_GENERATION.policyGeneration).toBe(true);
  });

  it('keeps non-pilot startup gap analysis behavior unchanged', () => {
    expect(PLAN_ENTITLEMENTS.STARTUP.gapAnalysis).toEqual({ limit: 0, period: 'month' });
  });
});
