-- ============================================================================
-- Rollback: Remove M-Pesa Subscription Lifecycle fields from Organization
-- Purpose:   Roll back changes introduced in B1 migration.
-- Batch:     B1 (Database Schema additions)
-- ============================================================================

-- Drop index
DROP INDEX IF EXISTS "idx_org_mpesa_renewal_due";

-- Remove fields from Organization
ALTER TABLE "Organization"
  DROP COLUMN IF EXISTS "mpesaFailedRenewalAttempts",
  DROP COLUMN IF EXISTS "mpesaLastRenewalAttemptAt",
  DROP COLUMN IF EXISTS "mpesaNextRenewalRetryAt",
  DROP COLUMN IF EXISTS "mpesaCancelledByUserAt",
  DROP COLUMN IF EXISTS "subscriptionCycleEnd";
