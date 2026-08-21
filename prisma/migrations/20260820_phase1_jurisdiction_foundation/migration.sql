-- Phase 1: Jurisdiction foundation, evidence provenance, and retrieval isolation.
-- Prepared migration only. Do not apply to production until the reindex runbook has passed.

ALTER TABLE "ComplianceQuery"
  ADD COLUMN "mode" TEXT,
  ADD COLUMN "jurisdictions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "primaryJurisdiction" TEXT,
  ADD COLUMN "jurisdictionSource" TEXT,
  ADD COLUMN "corpusVersionSnapshot" JSONB;

ALTER TABLE "ComplianceQueryRun"
  ADD COLUMN "jurisdictions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "primaryJurisdiction" TEXT,
  ADD COLUMN "jurisdictionSource" TEXT,
  ADD COLUMN "corpusVersionSnapshot" JSONB,
  ADD COLUMN "retrievalVersion" TEXT,
  ADD COLUMN "retrievedVectorIds" JSONB;

ALTER TABLE "RegulatoryDocument"
  ADD COLUMN "jurisdictionCode" TEXT;

ALTER TABLE "RegulatoryDocumentChunk"
  ADD COLUMN "jurisdictionCode" TEXT;

UPDATE "RegulatoryDocument"
SET "jurisdictionCode" = CASE
  WHEN lower(trim("jurisdiction")) = 'kenya' THEN 'KE'
  WHEN lower(trim("jurisdiction")) = 'rwanda' THEN 'RW'
  WHEN lower(trim("jurisdiction")) = 'malawi' THEN 'MW'
  WHEN lower(trim("jurisdiction")) = 'nigeria' THEN 'NG'
  ELSE NULL
END;

UPDATE "RegulatoryDocumentChunk" c
SET "jurisdictionCode" = d."jurisdictionCode"
FROM "RegulatoryDocument" d
WHERE c."documentId" = d."id"
  AND d."jurisdictionCode" IS NOT NULL;

CREATE TABLE "JurisdictionCorpusVersion" (
  "id" TEXT NOT NULL,
  "jurisdictionCode" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JurisdictionCorpusVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JurisdictionCorpusVersion_jurisdictionCode_key"
  ON "JurisdictionCorpusVersion"("jurisdictionCode");
CREATE INDEX "JurisdictionCorpusVersion_jurisdictionCode_idx"
  ON "JurisdictionCorpusVersion"("jurisdictionCode");
CREATE INDEX "JurisdictionCorpusVersion_updatedAt_idx"
  ON "JurisdictionCorpusVersion"("updatedAt");

INSERT INTO "JurisdictionCorpusVersion"
  ("id", "jurisdictionCode", "version", "reason", "createdAt", "updatedAt")
VALUES
  (concat('jcv_', lower('KE')), 'KE', 1, 'phase1_initial_foundation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (concat('jcv_', lower('RW')), 'RW', 1, 'phase1_initial_foundation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (concat('jcv_', lower('MW')), 'MW', 1, 'phase1_initial_foundation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (concat('jcv_', lower('NG')), 'NG', 1, 'phase1_initial_foundation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("jurisdictionCode") DO NOTHING;

CREATE INDEX "ComplianceQuery_primaryJurisdiction_idx"
  ON "ComplianceQuery"("primaryJurisdiction");
CREATE INDEX "ComplianceQuery_mode_idx"
  ON "ComplianceQuery"("mode");
CREATE INDEX "ComplianceQueryRun_primaryJurisdiction_idx"
  ON "ComplianceQueryRun"("primaryJurisdiction");
CREATE INDEX "ComplianceQueryRun_retrievalVersion_idx"
  ON "ComplianceQueryRun"("retrievalVersion");
CREATE INDEX "RegulatoryDocument_jurisdictionCode_idx"
  ON "RegulatoryDocument"("jurisdictionCode");
CREATE INDEX "RegulatoryDocumentChunk_jurisdictionCode_idx"
  ON "RegulatoryDocumentChunk"("jurisdictionCode");

-- Required pre-production checks:
-- 1. SELECT jurisdiction, count(*) FROM "RegulatoryDocument" WHERE "jurisdictionCode" IS NULL GROUP BY jurisdiction;
-- 2. EU and International must remain NULL until product/legal policy defines how supplemental sources are used.
-- 3. Reindex/upsert Pinecone metadata so active country vectors expose jurisdictionCode, vector id, chunk id, title, and contentHash.
