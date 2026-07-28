-- SheriaBot Pack 1 (Editorial Intelligence) — Foundation A.
-- Additive only. Apply manually (per this project's convention — no `prisma migrate`),
-- then run `prisma generate` to sync the client.
--
-- Pre-migration (MANDATORY, do not skip): run the orphan-detection query below
-- against the target database and null any orphaned sourceItemId values BEFORE
-- applying this file. See docs/editorial-intelligence/phase-b-foundations.md
-- Foundation A for full detail.
--
--   SELECT rs.id, rs."sourceItemId", rs."createdAt"
--   FROM "RegulatorySignal" rs
--   LEFT JOIN "BlogSourceItem" bsi ON bsi.id = rs."sourceItemId"
--   WHERE rs."sourceItemId" IS NOT NULL AND bsi.id IS NULL;
--
-- If the query above returns any rows, null those specific sourceItemId values
-- before applying this migration (the ADD CONSTRAINT below will otherwise fail).
--
-- sourceItemId's type and nullability are unchanged (String?) — this migration
-- only adds referential integrity and an index.

DO $$ BEGIN
  ALTER TABLE "RegulatorySignal"
    ADD CONSTRAINT "RegulatorySignal_sourceItemId_fkey"
    FOREIGN KEY ("sourceItemId") REFERENCES "BlogSourceItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "RegulatorySignal_sourceItemId_idx" ON "RegulatorySignal"("sourceItemId");

-- Rollback:
-- ALTER TABLE "RegulatorySignal" DROP CONSTRAINT IF EXISTS "RegulatorySignal_sourceItemId_fkey";
-- DROP INDEX IF EXISTS "RegulatorySignal_sourceItemId_idx";
