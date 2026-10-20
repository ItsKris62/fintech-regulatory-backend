CREATE TABLE "GapAnalysisUsageLedger" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'GAP_ANALYSES',
    "units" INTEGER NOT NULL,
    "counterKey" TEXT,
    "reservationKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "failureClass" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GapAnalysisUsageLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GapAnalysisUsageLedger_analysisId_key" ON "GapAnalysisUsageLedger"("analysisId");
CREATE UNIQUE INDEX "GapAnalysisUsageLedger_reservationKey_key" ON "GapAnalysisUsageLedger"("reservationKey");
CREATE INDEX "GapAnalysisUsageLedger_organizationId_state_idx" ON "GapAnalysisUsageLedger"("organizationId", "state");
CREATE INDEX "GapAnalysisUsageLedger_state_updatedAt_idx" ON "GapAnalysisUsageLedger"("state", "updatedAt");
ALTER TABLE "GapAnalysisUsageLedger" ADD CONSTRAINT "GapAnalysisUsageLedger_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "GapAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GapAnalysis" ADD COLUMN "failureClass" TEXT;
