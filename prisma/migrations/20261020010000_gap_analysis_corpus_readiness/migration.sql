-- Human-reviewed, version-bound readiness attestations for new Gap Analysis submissions.
-- No rows are seeded: an absent approval must fail closed.
CREATE TABLE "GapAnalysisCorpusReadinessSnapshot" (
    "id" TEXT NOT NULL,
    "jurisdictionCode" TEXT NOT NULL,
    "frameworkSlug" TEXT NOT NULL,
    "corpusVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "manifestChecksum" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GapAnalysisCorpusReadinessSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GapCorpusReady_scope_version_key"
ON "GapAnalysisCorpusReadinessSnapshot"("jurisdictionCode", "frameworkSlug", "corpusVersion");
CREATE INDEX "GapCorpusReady_scope_status_idx"
ON "GapAnalysisCorpusReadinessSnapshot"("jurisdictionCode", "frameworkSlug", "status");
CREATE INDEX "GapCorpusReady_updatedAt_idx"
ON "GapAnalysisCorpusReadinessSnapshot"("updatedAt");
