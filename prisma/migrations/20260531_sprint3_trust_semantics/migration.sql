-- Sprint 3: classify account lifecycle states used by admin actions.
-- Historical admin deletions anonymized email addresses while leaving User.status = SUSPENDED.
-- Keep true suspensions as accountStatus='suspended'; classify anonymized deletes as 'cancelled'.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "accountStatus" TEXT NOT NULL DEFAULT 'pending';

UPDATE "User"
SET "accountStatus" = 'cancelled',
    "deletedAt" = COALESCE("deletedAt", NOW())
WHERE "email" LIKE 'deleted\_%@sheriabot.internal' ESCAPE '\'
  AND "status" = 'SUSPENDED'
  AND "accountStatus" <> 'cancelled';

UPDATE "User"
SET "accountStatus" = 'suspended'
WHERE "status" = 'SUSPENDED'
  AND "accountStatus" NOT IN ('suspended', 'cancelled');

-- Backfill existing users to 'active' status to prevent them from vanishing from the admin UI
UPDATE "User"
SET "accountStatus" = 'active'
WHERE "accountStatus" IS NULL OR "accountStatus" = 'pending';
