import { PLAN_ORDER, PLANS, type PlanConfig } from '@/config/plans.config';
import { loadSystemConfig, updateSystemConfigSnapshot } from '@/lib/system-config';
import type {
  BillingPlanCatalog,
  BillingPlanCatalogEntry,
  BillingPlanCatalogUpdateInput,
  BillingPlanOverride,
  BillingPlanOverrides,
  SelfServeBillingPlan,
  SubscriptionPlan,
} from '@/modules/admin/admin.types';

export const SELF_SERVE_BILLING_PLAN_IDS = ['STARTUP', 'BUSINESS'] as const satisfies readonly SelfServeBillingPlan[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function clonePlan(plan: PlanConfig): PlanConfig {
  return {
    ...plan,
    price: { ...plan.price },
    cta: { ...plan.cta },
    features: plan.features.map((feature) => ({ ...feature })),
    entitlements: { ...plan.entitlements },
    stripe: plan.stripe ? { ...plan.stripe } : null,
  };
}

function compactOverride(planId: SelfServeBillingPlan, candidate: BillingPlanOverride): BillingPlanOverride | undefined {
  const basePlan = PLANS[planId];
  const next: BillingPlanOverride = {};

  if (candidate.price) {
    const price: BillingPlanOverride['price'] = {};
    if (candidate.price.monthly !== undefined && candidate.price.monthly !== basePlan.price.monthly) price.monthly = candidate.price.monthly;
    if (candidate.price.yearly !== undefined && candidate.price.yearly !== basePlan.price.yearly) price.yearly = candidate.price.yearly;
    if (Object.keys(price).length > 0) next.price = price;
  }

  if (candidate.trialDays !== undefined && candidate.trialDays !== basePlan.trialDays) next.trialDays = candidate.trialDays;

  if (candidate.stripe) {
    const stripe: NonNullable<BillingPlanOverride['stripe']> = {};
    if (candidate.stripe.monthlyPriceId !== undefined && candidate.stripe.monthlyPriceId !== (basePlan.stripe?.monthlyPriceId ?? null)) stripe.monthlyPriceId = candidate.stripe.monthlyPriceId;
    if (candidate.stripe.yearlyPriceId !== undefined && candidate.stripe.yearlyPriceId !== (basePlan.stripe?.yearlyPriceId ?? null)) stripe.yearlyPriceId = candidate.stripe.yearlyPriceId;
    if (Object.keys(stripe).length > 0) next.stripe = stripe;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function sanitizeBillingPlanOverrides(raw: unknown): BillingPlanOverrides {
  if (!isRecord(raw)) return {};
  const normalized: BillingPlanOverrides = {};

  for (const planId of SELF_SERVE_BILLING_PLAN_IDS) {
    const entry = raw[planId];
    if (!isRecord(entry)) continue;

    const override: BillingPlanOverride = {};
    const price = isRecord(entry.price) ? entry.price : null;
    const stripe = isRecord(entry.stripe) ? entry.stripe : null;

    if (price) {
      const monthly = toNullableNumber(price.monthly);
      const yearly = toNullableNumber(price.yearly);
      if (monthly !== undefined || yearly !== undefined) {
        override.price = {};
        if (monthly !== undefined) override.price.monthly = monthly;
        if (yearly !== undefined) override.price.yearly = yearly;
      }
    }

    const trialDays = toNullableNumber(entry.trialDays);
    if (typeof trialDays === 'number') override.trialDays = Math.round(trialDays);

    if (stripe) {
      const monthlyPriceId = toNullableString(stripe.monthlyPriceId);
      const yearlyPriceId = toNullableString(stripe.yearlyPriceId);
      if (monthlyPriceId !== undefined || yearlyPriceId !== undefined) {
        override.stripe = {};
        if (monthlyPriceId !== undefined) override.stripe.monthlyPriceId = monthlyPriceId;
        if (yearlyPriceId !== undefined) override.stripe.yearlyPriceId = yearlyPriceId;
      }
    }

    const compacted = compactOverride(planId, override);
    if (compacted) normalized[planId] = compacted;
  }

  return normalized;
}

function mergePlan(planId: SubscriptionPlan, overrides: BillingPlanOverrides): BillingPlanCatalogEntry {
  const basePlan = clonePlan(PLANS[planId]);
  const override = overrides[planId];
  const stripe = basePlan.stripe ? { ...basePlan.stripe } : null;

  if (override?.price) {
    if (override.price.monthly !== undefined) basePlan.price.monthly = override.price.monthly;
    if (override.price.yearly !== undefined) basePlan.price.yearly = override.price.yearly;
  }
  if (override?.trialDays !== undefined) basePlan.trialDays = override.trialDays;
  if (stripe && override?.stripe) {
    // BillingPlanStripeOverride fields are `string | null | undefined`.
    // The `!== null` guard narrows to `string`, which is what PlanConfig.stripe requires.
    // A null override ID means "no override  -  keep the base plan's ID unchanged."
    if (override.stripe.monthlyPriceId !== undefined && override.stripe.monthlyPriceId !== null) {
      stripe.monthlyPriceId = override.stripe.monthlyPriceId;
    }
    if (override.stripe.yearlyPriceId !== undefined && override.stripe.yearlyPriceId !== null) {
      stripe.yearlyPriceId = override.stripe.yearlyPriceId;
    }
  }

  const editable = SELF_SERVE_BILLING_PLAN_IDS.includes(planId as SelfServeBillingPlan);
  return { id: basePlan.id as SubscriptionPlan, name: basePlan.name, tagline: basePlan.tagline, badge: basePlan.badge, popular: basePlan.popular, trialDays: basePlan.trialDays, editable, supportsMpesa: editable, supportsStripe: stripe !== null, price: { ...basePlan.price }, stripe, features: basePlan.features };
}

export function buildBillingPlanCatalog(overrides: BillingPlanOverrides = {}): BillingPlanCatalog {
  return { plans: PLAN_ORDER.map((planId) => mergePlan(planId as SubscriptionPlan, overrides)), managedPlanIds: [...SELF_SERVE_BILLING_PLAN_IDS] };
}

export async function getBillingPlanCatalog(): Promise<BillingPlanCatalog> {
  const config = await loadSystemConfig({ syncDefinitions: true });
  return buildBillingPlanCatalog(sanitizeBillingPlanOverrides(config.billingPlanOverrides));
}

export async function getRuntimePlan(planId: SubscriptionPlan): Promise<BillingPlanCatalogEntry> {
  const catalog = await getBillingPlanCatalog();
  const match = catalog.plans.find((plan) => plan.id === planId);
  if (!match) throw new Error(`Unsupported billing plan: ${planId}`);
  return match;
}

export async function getRuntimePriceToPlanMap(): Promise<Record<string, SelfServeBillingPlan>> {
  const catalog = await getBillingPlanCatalog();
  return catalog.plans.reduce<Record<string, SelfServeBillingPlan>>((acc, plan) => {
    if (!SELF_SERVE_BILLING_PLAN_IDS.includes(plan.id as SelfServeBillingPlan) || !plan.stripe) return acc;
    if (plan.stripe.monthlyPriceId) acc[plan.stripe.monthlyPriceId] = plan.id as SelfServeBillingPlan;
    if (plan.stripe.yearlyPriceId) acc[plan.stripe.yearlyPriceId] = plan.id as SelfServeBillingPlan;
    return acc;
  }, {});
}

export async function updateBillingPlanCatalog(input: BillingPlanCatalogUpdateInput, updatedBy?: string): Promise<BillingPlanCatalog> {
  const currentConfig = await loadSystemConfig({ syncDefinitions: true });
  const nextOverrides = { ...sanitizeBillingPlanOverrides(currentConfig.billingPlanOverrides) } as BillingPlanOverrides;

  for (const plan of input.plans) {
    const compacted = compactOverride(plan.id, {
      price: { monthly: plan.price.monthly, yearly: plan.price.yearly },
      trialDays: plan.trialDays,
      stripe: { monthlyPriceId: plan.stripe.monthlyPriceId, yearlyPriceId: plan.stripe.yearlyPriceId },
    });

    if (compacted) nextOverrides[plan.id] = compacted;
    else delete nextOverrides[plan.id];
  }

  const updatedConfig = await updateSystemConfigSnapshot({ billingPlanOverrides: nextOverrides }, updatedBy);
  return buildBillingPlanCatalog(sanitizeBillingPlanOverrides(updatedConfig.billingPlanOverrides));
}

export function resolvePlanPriceForInterval(plan: BillingPlanCatalogEntry, interval: 'monthly' | 'yearly'): number | null {
  if (interval === 'yearly' && plan.price.yearly !== null) return plan.price.yearly;
  return plan.price.monthly;
}

