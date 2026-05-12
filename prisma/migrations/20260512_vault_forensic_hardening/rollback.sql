-- B3 rollback - only run if B3 + B4 must be fully unwound
-- Drops the six added columns, four indexes, and the enum type
-- WARNING: irreversible loss of any data in new columns

BEGIN;

DROP INDEX IF EXISTS "VaultDocument_uploadStatus_idx";
DROP INDEX IF EXISTS "VaultDocument_deletedAt_idx";
DROP INDEX IF EXISTS "VaultDocument_retentionExpiresAt_idx";
DROP INDEX IF EXISTS "VaultDocument_organizationId_deletedAt_idx";

ALTER TABLE "VaultDocument"
  DROP COLUMN IF EXISTS "deletedAt",
  DROP COLUMN IF EXISTS "retentionExpiresAt",
  DROP COLUMN IF EXISTS "uploadStatus",
  DROP COLUMN IF EXISTS "encryptionKeyId",
  DROP COLUMN IF EXISTS "contentHash",
  DROP COLUMN IF EXISTS "r2Bucket";

DROP TYPE IF EXISTS "VaultDocumentUploadStatus";

COMMIT;
