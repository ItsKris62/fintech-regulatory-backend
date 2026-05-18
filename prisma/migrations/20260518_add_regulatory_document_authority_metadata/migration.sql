-- Add authority metadata so draft/consultation/superseded instruments can stay
-- searchable while being clearly distinguished from binding law.
CREATE TYPE "AuthorityStatus" AS ENUM ('DRAFT', 'IN_FORCE', 'SUPERSEDED', 'CONSULTATION');

ALTER TABLE "RegulatoryDocument"
ADD COLUMN "authorityStatus" "AuthorityStatus" NOT NULL DEFAULT 'IN_FORCE',
ADD COLUMN "isBinding" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "RegulatoryDocument_authorityStatus_idx" ON "RegulatoryDocument"("authorityStatus");

UPDATE "RegulatoryDocument"
SET "authorityStatus" = 'DRAFT',
    "isBinding" = false
WHERE title ILIKE '%draft%'
   OR COALESCE(version, '') ILIKE '%draft%';
