-- SheriaBot Phase 1: Dedicated Regulatory Intelligence Persistence & Backend Contract Layer
-- Non-destructive rollback reference SQL.
-- Execute only if required during an emergency deployment rollback.

-- 1. Drop foreign key constraints
ALTER TABLE "RegulatoryAlert" DROP CONSTRAINT IF EXISTS "RegulatoryAlert_primaryRegulatorySourceItemId_fkey";
ALTER TABLE "RegulatorySourceItemEvidence" DROP CONSTRAINT IF EXISTS "RegulatorySourceItemEvidence_snapshotId_fkey";
ALTER TABLE "RegulatorySourceItemEvidence" DROP CONSTRAINT IF EXISTS "RegulatorySourceItemEvidence_sourceItemId_fkey";
ALTER TABLE "RegulatorySourceItem" DROP CONSTRAINT IF EXISTS "RegulatorySourceItem_supersededById_fkey";
ALTER TABLE "RegulatorySourceItem" DROP CONSTRAINT IF EXISTS "RegulatorySourceItem_primarySnapshotId_fkey";
ALTER TABLE "RegulatorySourceItem" DROP CONSTRAINT IF EXISTS "RegulatorySourceItem_sourceId_fkey";
ALTER TABLE "RegulatorySourceSnapshot" DROP CONSTRAINT IF EXISTS "RegulatorySourceSnapshot_sourceId_fkey";

-- 2. Drop columns from RegulatoryAlert
DROP INDEX IF EXISTS "RegulatoryAlert_primaryRegulatorySourceItemId_idx";
DROP INDEX IF EXISTS "RegulatoryAlert_automationDraftKey_key";
ALTER TABLE "RegulatoryAlert" DROP COLUMN IF EXISTS "primaryRegulatorySourceItemId";
ALTER TABLE "RegulatoryAlert" DROP COLUMN IF EXISTS "automationDraftKey";

-- 3. Drop tables
DROP TABLE IF EXISTS "RegulatorySourceItemEvidence";
DROP TABLE IF EXISTS "RegulatorySourceItem";
DROP TABLE IF EXISTS "RegulatorySourceSnapshot";
DROP TABLE IF EXISTS "RegulatorySource";

-- 4. Drop enums
DROP TYPE IF EXISTS "RegulatoryEvidenceRole";
DROP TYPE IF EXISTS "RegulatoryMateriality";
DROP TYPE IF EXISTS "RegulatoryVerificationState";
DROP TYPE IF EXISTS "RegulatoryStage";
DROP TYPE IF EXISTS "RegulatoryInformationType";
DROP TYPE IF EXISTS "RegulatorySourceType";
DROP TYPE IF EXISTS "RegulatoryAuthorityType";
