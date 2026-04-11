import { describe, expect, it } from 'vitest';
import { PLANS } from '@/config/plans.config';
import { buildBillingPlanCatalog, sanitizeBillingPlanOverrides } from './runtime-billing-plans';

describe('runtime billing plan catalog', () => {
  it('applies persisted overrides for self-serve plans only', () => {
    const catalog = buildBillingPlanCatalog(
      sanitizeBillingPlanOverrides({
        STARTUP: {
          price: { monthly: 31000, yearly: 320000 },
          trialDays: 21,
          stripe: { monthlyPriceId: 'price_startup_new', yearlyPriceId: 'price_startup_yearly' },
        },
        ENTERPRISE: { price: { monthly: 1000 } },
      })
    );

    const startup = catalog.plans.find((plan) => plan.id === 'STARTUP');
    const enterprise = catalog.plans.find((plan) => plan.id === 'ENTERPRISE');

    expect(startup?.price.monthly).toBe(31000);
    expect(startup?.price.yearly).toBe(320000);
    expect(startup?.trialDays).toBe(21);
    expect(startup?.stripe?.monthlyPriceId).toBe('price_startup_new');
    expect(enterprise?.editable).toBe(false);
    expect(enterprise?.price.monthly).toBeNull();
  });

  it('drops invalid persisted override values instead of corrupting the catalog', () => {
    const catalog = buildBillingPlanCatalog(
      sanitizeBillingPlanOverrides({
        STARTUP: {
          price: { monthly: 'abc' },
          trialDays: -5,
          stripe: { monthlyPriceId: '   ' },
        },
      })
    );

    const startup = catalog.plans.find((plan) => plan.id === 'STARTUP');

    expect(startup?.price.monthly).toBe(25000);
    expect(startup?.trialDays).toBe(14);
    expect(startup?.stripe?.monthlyPriceId).toBe(PLANS.STARTUP.stripe?.monthlyPriceId);
  });
});

