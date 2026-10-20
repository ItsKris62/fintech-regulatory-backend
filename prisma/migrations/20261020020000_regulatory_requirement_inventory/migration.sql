CREATE TABLE "RegulatoryRequirementInventory" (
  "id" TEXT NOT NULL, "jurisdictionCode" TEXT NOT NULL, "frameworkSlug" TEXT NOT NULL,
  "version" TEXT NOT NULL, "completeness" TEXT NOT NULL DEFAULT 'UNKNOWN', "reviewCriteria" TEXT,
  "reviewedAt" TIMESTAMP(3), "reviewedBy" TEXT, "sourceManifestChecksum" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegulatoryRequirementInventory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegulatoryRequirementInventory_jurisdictionCode_frameworkSlug_version_key" ON "RegulatoryRequirementInventory"("jurisdictionCode", "frameworkSlug", "version");
CREATE INDEX "RegulatoryRequirementInventory_jurisdictionCode_frameworkSlug_completeness_idx" ON "RegulatoryRequirementInventory"("jurisdictionCode", "frameworkSlug", "completeness");
CREATE TABLE "RegulatoryRequirement" (
  "id" TEXT NOT NULL, "inventoryId" TEXT NOT NULL, "stableKey" TEXT NOT NULL, "sourceDocumentId" TEXT NOT NULL,
  "sourceVersionId" TEXT, "provisionReference" TEXT NOT NULL, "statement" TEXT NOT NULL, "legalStatus" TEXT NOT NULL,
  "applicabilityRules" JSONB, "category" TEXT, "requiredControl" TEXT, "approvalStatus" TEXT NOT NULL DEFAULT 'CANDIDATE',
  "reviewedAt" TIMESTAMP(3), "reviewedBy" TEXT, "contentChecksum" TEXT, "supersededById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegulatoryRequirement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RegulatoryRequirement_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "RegulatoryRequirementInventory"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RegulatoryRequirement_stableKey_key" ON "RegulatoryRequirement"("stableKey");
CREATE INDEX "RegulatoryRequirement_inventoryId_approvalStatus_idx" ON "RegulatoryRequirement"("inventoryId", "approvalStatus");
CREATE INDEX "RegulatoryRequirement_sourceDocumentId_sourceVersionId_idx" ON "RegulatoryRequirement"("sourceDocumentId", "sourceVersionId");
