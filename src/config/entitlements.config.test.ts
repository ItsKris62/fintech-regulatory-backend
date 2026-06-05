import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PILOT_ENTITLEMENT_PROFILES, PLAN_ENTITLEMENTS } from './entitlements.config';
import { getLimitFromEntitlements, getQuota, getQuotaFromEntitlements, hasFeature } from '@/utils/entitlements';

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
    expect(pilot.benchmarkDocuments).toBe(true);
    expect(pilot.customFrameworks).toBe(false);
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

describe('plan entitlement normalization', () => {
  it('sets Business max seats to six total seats', () => {
    expect(PLAN_ENTITLEMENTS.BUSINESS.maxSeats).toBe(6);
    expect(getLimitFromEntitlements(PLAN_ENTITLEMENTS.BUSINESS, 'maxSeats')).toBe(6);
  });

  it('gates full compliance calendar to Business and Enterprise paid tiers', () => {
    expect(PLAN_ENTITLEMENTS.STARTUP.complianceCalendar).toBe(false);
    expect(hasFeature(SubscriptionPlan.STARTUP, 'complianceCalendar')).toBe(false);
    expect(hasFeature(SubscriptionPlan.BUSINESS, 'complianceCalendar')).toBe(true);
    expect(hasFeature(SubscriptionPlan.ENTERPRISE, 'complianceCalendar')).toBe(true);
  });

  it('resolves benchmark document entitlement by plan and pilot profile', () => {
    expect(PLAN_ENTITLEMENTS.STARTUP.benchmarkDocuments).toBe(false);
    expect(PLAN_ENTITLEMENTS.BUSINESS.benchmarkDocuments).toBe(true);
    expect(PLAN_ENTITLEMENTS.ENTERPRISE.benchmarkDocuments).toBe(true);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL.benchmarkDocuments).toBe(true);
  });

  it('resolves custom framework entitlement by plan and pilot profile', () => {
    expect(PLAN_ENTITLEMENTS.STARTUP.customFrameworks).toBe(false);
    expect(PLAN_ENTITLEMENTS.BUSINESS.customFrameworks).toBe(false);
    expect(PLAN_ENTITLEMENTS.ENTERPRISE.customFrameworks).toBe(true);
    expect(PILOT_ENTITLEMENT_PROFILES.PILOT_FULL.customFrameworks).toBe(false);
  });

  it('treats zero-limit quota objects as blocked', () => {
    expect(hasFeature(SubscriptionPlan.STARTUP, 'gapAnalysis')).toBe(false);
    expect(getQuota(SubscriptionPlan.STARTUP, 'gapAnalysis')).toEqual({ limit: 0, period: 'month' });
  });

  it('keeps the frontend plan helper aligned on zero-limit feature blocking', () => {
    const frontendPlanContext = readFileSync(
      resolve(__dirname, '../../../fintech-regulatory-platform/lib/plan-context.tsx'),
      'utf8',
    );

    expect(frontendPlanContext).toContain('function resolveHasFeature');
    expect(frontendPlanContext).toContain('if ("limit" in val)');
    expect(frontendPlanContext).toContain('limit !== 0');
  });
});
