-- B3: Vault forensic hardening - additive only
-- Apply manually in Supabase SQL Editor
-- All additions are nullable; no backfill required

BEGIN;

-- 1. New enum type
CREATE TYPE "VaultDocumentUploadStatus" AS ENUM (
  'PENDING',
  'UPLOADED',
  'VERIFIED',
  'FAILED',
  'QUARANTINED',
  'DELETED'
);

-- 2. Add nullable columns to VaultDocument
ALTER TABLE "VaultDocument"
  ADD COLUMN "r2Bucket"           TEXT,
  ADD COLUMN "contentHash"        TEXT,
  ADD COLUMN "encryptionKeyId"    TEXT,
  ADD COLUMN "uploadStatus"       "VaultDocumentUploadStatus",
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt"          TIMESTAMP(3);

-- 3. Indexes for common query patterns
-- uploadStatus_idx supports admin/reconciliation queries by lifecycle state.
CREATE INDEX "VaultDocument_uploadStatus_idx"
  ON "VaultDocument" ("uploadStatus");

-- deletedAt_idx keeps active-row queries small and fast.
CREATE INDEX "VaultDocument_deletedAt_idx"
  ON "VaultDocument" ("deletedAt")
  WHERE "deletedAt" IS NULL;

-- retentionExpiresAt_idx supports retention cron scans while excluding most
-- initial rows and already-deleted rows.
CREATE INDEX "VaultDocument_retentionExpiresAt_idx"
  ON "VaultDocument" ("retentionExpiresAt")
  WHERE "retentionExpiresAt" IS NOT NULL AND "deletedAt" IS NULL;

-- organizationId_deletedAt_idx supports org-scoped active document lists.
CREATE INDEX "VaultDocument_organizationId_deletedAt_idx"
  ON "VaultDocument" ("organizationId", "deletedAt")
  WHERE "deletedAt" IS NULL;

COMMIT;
