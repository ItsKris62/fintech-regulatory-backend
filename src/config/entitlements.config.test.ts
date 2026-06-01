import { BillingMetric, SubscriptionPlan } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PLAN_ENTITLEMENTS } from './entitlements.config';
import { getQuota } from '@/utils/entitlements';

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
