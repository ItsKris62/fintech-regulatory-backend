CREATE TABLE "GapAnalysisObjectDeletion" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GapAnalysisObjectDeletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GapAnalysisObjectDeletion_analysisId_objectKey_key" ON "GapAnalysisObjectDeletion"("analysisId", "objectKey");
CREATE INDEX "GapAnalysisObjectDeletion_status_runAfter_idx" ON "GapAnalysisObjectDeletion"("status", "runAfter");
CREATE INDEX "GapAnalysisObjectDeletion_organizationId_status_idx" ON "GapAnalysisObjectDeletion"("organizationId", "status");
CREATE INDEX "GapAnalysisObjectDeletion_analysisId_idx" ON "GapAnalysisObjectDeletion"("analysisId");
ALTER TABLE "GapAnalysisObjectDeletion" ADD CONSTRAINT "GapAnalysisObjectDeletion_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "GapAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
