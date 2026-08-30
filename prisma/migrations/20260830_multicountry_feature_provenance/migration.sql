ALTER TABLE "Checklist"
  ADD COLUMN "jurisdictionCode" TEXT,
  ADD COLUMN "citations" JSONB,
  ADD COLUMN "evidenceProvenance" JSONB;

ALTER TABLE "GapAnalysis"
  ADD COLUMN "jurisdictionCode" TEXT,
  ADD COLUMN "citations" JSONB,
  ADD COLUMN "evidenceProvenance" JSONB;

ALTER TABLE "CustomFramework"
  ADD COLUMN "citations" JSONB,
  ADD COLUMN "evidenceProvenance" JSONB,
  ADD COLUMN "generationMetadata" JSONB;

ALTER TABLE "CustomFrameworkControl"
  ADD COLUMN "sourceChunkId" TEXT,
  ADD COLUMN "citation" JSONB;

CREATE INDEX "Checklist_jurisdictionCode_idx" ON "Checklist"("jurisdictionCode");
CREATE INDEX "GapAnalysis_jurisdictionCode_idx" ON "GapAnalysis"("jurisdictionCode");
CREATE INDEX "CustomFramework_jurisdiction_idx" ON "CustomFramework"("jurisdiction");
