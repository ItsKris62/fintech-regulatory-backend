DROP INDEX IF EXISTS "Organization_homeJurisdictionCode_idx";

ALTER TABLE "Organization"
  DROP CONSTRAINT IF EXISTS "Organization_homeJurisdictionCode_check";

ALTER TABLE "Organization"
  DROP COLUMN IF EXISTS "homeJurisdictionCode";
