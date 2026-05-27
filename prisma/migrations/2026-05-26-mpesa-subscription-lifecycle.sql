-- ============================================================================
-- Migration: Add M-Pesa Subscription Lifecycle fields to Organization
-- Purpose:   Supports rolling 30-day cycle end tracking, renewal retries,
--            failed attempt counting, and user-initiated cancellation.
-- Batch:     B1 (Database Schema additions)
-- ============================================================================

-- Add fields to Organization
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "mpesaFailedRenewalAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaLastRenewalAttemptAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS "mpesaNextRenewalRetryAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS "mpesaCancelledByUserAt" TIMESTAMP(3) WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS "subscriptionCycleEnd" TIMESTAMP(3) WITHOUT TIME ZONE;

-- Create index for renewal cron polling (efficient querying)
CREATE INDEX IF NOT EXISTS "idx_org_mpesa_renewal_due"
  ON "Organization" ("subscriptionStatus", "mpesaNextRenewalRetryAt")
  WHERE "mpesaNextRenewalRetryAt" IS NOT NULL;

-- Backfill: sync subscriptionCycleEnd with mpesaNextPaymentDueDate for existing M-Pesa accounts
UPDATE "Organization"
SET "subscriptionCycleEnd" = "mpesaNextPaymentDueDate"
WHERE "preferredPaymentMethod" = 'MPESA'::"PaymentProvider" 
  AND "mpesaNextPaymentDueDate" IS NOT NULL;
