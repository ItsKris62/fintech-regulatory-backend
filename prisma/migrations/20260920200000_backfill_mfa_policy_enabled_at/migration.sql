-- Backfill mfaPolicyEnabledAt for organizations where requireMfa is enabled but mfaPolicyEnabledAt was null.
UPDATE "Organization"
SET "mfaPolicyEnabledAt" = NOW()
WHERE "requireMfa" = true AND "mfaPolicyEnabledAt" IS NULL;
