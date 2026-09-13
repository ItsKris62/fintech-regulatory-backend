-- Rollback Migration: 2026-09-12-batch1-pricing-jurisdiction-upgrade.rollback.sql
-- Description: Rollback script for Batch 1 additive changes

DROP INDEX IF EXISTS "Organization_needsCountryConfirmation_idx";

ALTER TABLE "Organization"
  DROP COLUMN IF EXISTS "enabledJurisdictions",
  DROP COLUMN IF EXISTS "needsCountryConfirmation";

-- Note: PostgreSQL ENUM values cannot be directly removed via DROP VALUE.
-- They remain dormant in the database type without causing runtime errors.
