DROP INDEX IF EXISTS "GapAnalysis_active_executionIdentity_key";
DROP INDEX IF EXISTS "GapAnalysis_documentChecksum_idx";
ALTER TABLE "GapAnalysis"
  DROP COLUMN IF EXISTS "executionIdentityMetadata",
  DROP COLUMN IF EXISTS "executionIdentity",
  DROP COLUMN IF EXISTS "documentChecksum";
