import { describe, expect, it } from 'vitest';
import { PLANS } from '@/config/plans.config';
import { buildBillingPlanCatalog, sanitizeBillingPlanOverrides } from './runtime-billing-plans';

describe('runtime billing plan catalog', () => {
  it('applies persisted overrides for self-serve plans only', () => {
    const catalog = buildBillingPlanCatalog(
      sanitizeBillingPlanOverrides({
        STARTER: {
          price: { monthly: 31000, yearly: 320000 },
          trialDays: 21,
          stripe: { monthlyPriceId: 'price_starter_new', yearlyPriceId: 'price_starter_yearly' },
        },
        ENTERPRISE: { price: { monthly: 1000 } },
      })
    );

    const starter = catalog.plans.find((plan) => plan.id === 'STARTER');
    const enterprise = catalog.plans.find((plan) => plan.id === 'ENTERPRISE');

    expect(starter?.price.monthly).toBe(31000);
    expect(starter?.price.yearly).toBe(320000);
    expect(starter?.trialDays).toBe(21);
    expect(starter?.stripe?.monthlyPriceId).toBe('price_starter_new');
    expect(enterprise?.editable).toBe(false);
    expect(enterprise?.price.monthly).toBeNull();
  });

  it('drops invalid persisted override values instead of corrupting the catalog', () => {
    const catalog = buildBillingPlanCatalog(
      sanitizeBillingPlanOverrides({
        STARTER: {
          price: { monthly: 'abc' },
          trialDays: -5,
          stripe: { monthlyPriceId: '   ' },
        },
      })
    );

    const starter = catalog.plans.find((plan) => plan.id === 'STARTER');

    expect(starter?.price.monthly).toBe(PLANS.STARTER.price.monthly);
    expect(starter?.price.yearly).toBe(PLANS.STARTER.price.yearly);
    expect(starter?.trialDays).toBe(14);
    expect(starter?.stripe?.monthlyPriceId).toBe(PLANS.STARTER.stripe?.monthlyPriceId);
  });
});
