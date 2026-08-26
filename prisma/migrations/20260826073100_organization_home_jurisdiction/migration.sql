-- Transitional rollout: existing organizations must be explicitly classified
-- by an administrator or trusted backfill process before regulatory RAG access.
ALTER TABLE "Organization"
  ADD COLUMN "homeJurisdictionCode" TEXT;

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_homeJurisdictionCode_check"
  CHECK ("homeJurisdictionCode" IS NULL OR "homeJurisdictionCode" IN ('KE', 'RW', 'MW', 'NG'));

CREATE INDEX "Organization_homeJurisdictionCode_idx"
  ON "Organization"("homeJurisdictionCode");
