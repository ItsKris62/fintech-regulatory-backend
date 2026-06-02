-- Additive pilot onboarding and access-control fields.
-- Do not reset data; existing pilot fields remain as compatibility fields.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "temporaryPasswordExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "temporaryPasswordIssuedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "temporaryPasswordUsedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "temporaryPasswordCreatedByAdminId" TEXT,
  ADD COLUMN IF NOT EXISTS "temporaryPasswordDeliveryStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "temporaryPasswordVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pilotAccessStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "pilotFirstExtensionGrantedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pilotSecondExtensionGrantedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pilotExtensionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pilotCreatedByAdminId" TEXT,
  ADD COLUMN IF NOT EXISTS "pilotLastExtendedByAdminId" TEXT;

CREATE INDEX IF NOT EXISTS "User_mustChangePassword_idx" ON "User"("mustChangePassword");
CREATE INDEX IF NOT EXISTS "User_pilotAccessStatus_idx" ON "User"("pilotAccessStatus");
