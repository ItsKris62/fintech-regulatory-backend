-- Migration: 20261007120000_phase1_jurisdiction_dashboard
-- Description: Additive schema for jurisdiction-first compliance dashboard.
-- Operational safety:
--   - Metadata-only schema change on supported PostgreSQL versions, but lock acquisition may wait behind concurrent transactions.
--   - Sets statement and lock timeouts to fail deployment cleanly if locks cannot be acquired safely.
--   - Zero destructive operations. Zero column drops. Zero row deletions.

SET lock_timeout = '5s';
SET statement_timeout = '10s';

-- 1. Additive columns on ComplianceItem
ALTER TABLE "ComplianceItem"
  ADD COLUMN IF NOT EXISTS "requirementKey" TEXT,
  ADD COLUMN IF NOT EXISTS "jurisdictionCode" TEXT,
  ADD COLUMN IF NOT EXISTS "assessedAt" TIMESTAMP(3);

-- 2. Additive columns on ComplianceScoreSnapshot
ALTER TABLE "ComplianceScoreSnapshot"
  ADD COLUMN IF NOT EXISTS "jurisdictionCode" TEXT;

-- 3. Composite indexes for jurisdiction scoping
CREATE INDEX IF NOT EXISTS "ComplianceItem_organizationId_jurisdictionCode_idx"
  ON "ComplianceItem"("organizationId", "jurisdictionCode");

CREATE INDEX IF NOT EXISTS "ComplianceScoreSnapshot_organizationId_jurisdictionCode_calculatedAt_idx"
  ON "ComplianceScoreSnapshot"("organizationId", "jurisdictionCode", "calculatedAt");

-- 4. Unique constraint on (organizationId, requirementKey)
-- Note: In PostgreSQL, UNIQUE constraints allow multiple NULL values. Unkeyed legacy rows do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "ComplianceItem_organizationId_requirementKey_key"
  ON "ComplianceItem"("organizationId", "requirementKey");
