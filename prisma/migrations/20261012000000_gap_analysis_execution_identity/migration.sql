-- Batch 7: durable, tenant-scoped semantic execution identity.
-- Nullable fields preserve historical analyses; new rows receive the identity in application code.
ALTER TABLE "GapAnalysis"
  ADD COLUMN IF NOT EXISTS "documentChecksum" TEXT,
  ADD COLUMN IF NOT EXISTS "executionIdentity" TEXT,
  ADD COLUMN IF NOT EXISTS "executionIdentityMetadata" JSONB;

-- Replace the original broad reservation if an early Batch 7 build reached a
-- non-production database. It incorrectly blocked retryable historical rows.
DROP INDEX IF EXISTS "GapAnalysis_executionIdentity_key";

CREATE UNIQUE INDEX IF NOT EXISTS "GapAnalysis_active_executionIdentity_key"
  ON "GapAnalysis"("executionIdentity")
  WHERE "executionIdentity" IS NOT NULL
    AND "deletedAt" IS NULL
    AND "status" IN ('UPLOADING', 'QUEUED', 'RUNNING', 'RETRYING', 'ANALYZING', 'COMPLETING', 'COMPLETED');

CREATE INDEX IF NOT EXISTS "GapAnalysis_documentChecksum_idx"
  ON "GapAnalysis"("documentChecksum");
