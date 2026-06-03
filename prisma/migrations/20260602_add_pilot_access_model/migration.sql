-- Phase B: first-class pilot access model.
-- Additive only. Legacy User pilot columns remain for compatibility.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PilotAccessStatus') THEN
    CREATE TYPE "PilotAccessStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'CONVERTED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PilotAccess" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "status" "PilotAccessStatus" NOT NULL DEFAULT 'ACTIVE',
  "entitlementProfile" TEXT NOT NULL DEFAULT 'PILOT_FULL',
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "extensionCount" INTEGER NOT NULL DEFAULT 0,
  "createdByAdminId" TEXT,
  "lastExtendedByAdminId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedByAdminId" TEXT,
  "convertedAt" TIMESTAMP(3),
  "convertedPlan" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PilotAccess_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PilotAccess_userId_fkey'
  ) THEN
    ALTER TABLE "PilotAccess"
      ADD CONSTRAINT "PilotAccess_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PilotAccess_organizationId_fkey'
  ) THEN
    ALTER TABLE "PilotAccess"
      ADD CONSTRAINT "PilotAccess_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PilotAccess_userId_idx" ON "PilotAccess"("userId");
CREATE INDEX IF NOT EXISTS "PilotAccess_organizationId_idx" ON "PilotAccess"("organizationId");
CREATE INDEX IF NOT EXISTS "PilotAccess_status_idx" ON "PilotAccess"("status");
CREATE INDEX IF NOT EXISTS "PilotAccess_expiresAt_idx" ON "PilotAccess"("expiresAt");
CREATE INDEX IF NOT EXISTS "PilotAccess_userId_organizationId_status_idx"
  ON "PilotAccess"("userId", "organizationId", "status");

-- Preserve history while enforcing only one currently ACTIVE pilot overlay
-- for a given user/org pair.
CREATE UNIQUE INDEX IF NOT EXISTS "PilotAccess_one_active_per_user_org_idx"
  ON "PilotAccess"("userId", "organizationId")
  WHERE "status" = 'ACTIVE';
