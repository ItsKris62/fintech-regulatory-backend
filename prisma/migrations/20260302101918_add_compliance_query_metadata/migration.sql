-- AlterTable
ALTER TABLE "ComplianceQuery" ADD COLUMN     "citations" JSONB,
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "processingTimeMs" INTEGER,
ADD COLUMN     "recommendations" JSONB,
ADD COLUMN     "regulatoryAreas" TEXT[],
ADD COLUMN     "response" TEXT;

-- CreateIndex
CREATE INDEX "ComplianceQuery_organizationId_idx" ON "ComplianceQuery"("organizationId");

-- CreateIndex
CREATE INDEX "ComplianceQuery_status_idx" ON "ComplianceQuery"("status");
