-- Phase 3 Business organization security policy fields.
-- Additive only: existing organizations keep MFA optional until an OWNER/ADMIN enables it.

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "requireMfa" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "mfaPolicyEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mfaPolicyUpdatedBy" TEXT;
