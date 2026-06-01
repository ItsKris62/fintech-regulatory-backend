-- Sprint 3: classify account lifecycle states used by admin actions.
-- Historical admin deletions anonymized email addresses while leaving User.status = SUSPENDED.
-- Keep true suspensions as accountStatus='suspended'; classify anonymized deletes as 'cancelled'.

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
