-- Migration: 20260912180000_batch1_pricing_jurisdiction_upgrade
-- Description: Batch 1 Pricing, Entitlements, Organization Country Capture & Multi-Country Jurisdictions
-- Type: Strictly Additive & Non-Destructive

-- 1. Extend SubscriptionPlan enum with canonical tiers (FREE, STARTER, GROWTH)
-- Preserves existing values (REGULATOR, STARTUP, BUSINESS, ENTERPRISE) without alteration.
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'FREE';
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'STARTER';
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'GROWTH';

-- 2. Add enabledJurisdictions and needsCountryConfirmation to Organization table
ALTER TABLE "Organization" 
  ADD COLUMN IF NOT EXISTS "enabledJurisdictions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "needsCountryConfirmation" BOOLEAN DEFAULT FALSE;

-- 3. Add index for country confirmation filtering and queries
CREATE INDEX IF NOT EXISTS "Organization_needsCountryConfirmation_idx" ON "Organization"("needsCountryConfirmation");
