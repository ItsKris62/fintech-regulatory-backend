-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "mfaPolicyFirstEnabledAt" TIMESTAMP(3);

-- Backfill
UPDATE "Organization"
SET "mfaPolicyFirstEnabledAt" = "mfaPolicyEnabledAt"
WHERE "mfaPolicyEnabledAt" IS NOT NULL AND "mfaPolicyFirstEnabledAt" IS NULL;
