-- AlterTable UsageRecord: Add tenant cost tracking and FX rate fields
ALTER TABLE "UsageRecord" 
  ADD COLUMN IF NOT EXISTS "costUsd" DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "costKes" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "fxRateUsdToKes" DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "fxRateCapturedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pricingVersion" TEXT;

-- CreateIndex: Add composite index for tenant usage queries by period
CREATE INDEX IF NOT EXISTS "UsageRecord_organizationId_periodStart_idx" 
  ON "UsageRecord"("organizationId", "periodStart");

-- AlterTable UsagePeriod: Add cost rollups in USD and KES
ALTER TABLE "UsagePeriod" 
  ADD COLUMN IF NOT EXISTS "costUsd" DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "costKes" DECIMAL(18,4);
