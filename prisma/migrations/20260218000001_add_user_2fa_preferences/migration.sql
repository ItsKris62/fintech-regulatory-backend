-- =============================================================================
-- BASELINE MIGRATION — DO NOT RE-RUN
-- =============================================================================
-- These columns were applied directly to the database via `prisma db push`
-- (bypassing the migration system). They ALREADY EXIST in the production DB.
--
-- This file exists solely to reconcile the Prisma migration history with the
-- actual database state so that future `migrate dev` / `migrate deploy` commands
-- work without drift warnings.
--
-- To register it without re-running the SQL, use:
--   pnpm prisma migrate resolve --applied 20260218000001_add_user_2fa_preferences
-- =============================================================================

-- AlterTable: Add TOTP (2FA) and user preferences fields to User
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "preferences" JSONB;
