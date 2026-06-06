CREATE TABLE IF NOT EXISTS "GeneratedPolicySectionVersion" (
  "id" TEXT NOT NULL,
  "generatedPolicyId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "previousContent" JSONB,
  "newContent" JSONB,
  "previousStatus" TEXT,
  "newStatus" TEXT,
  "editedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedPolicySectionVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GeneratedPolicySectionVersion_generatedPolicyId_idx" ON "GeneratedPolicySectionVersion"("generatedPolicyId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicySectionVersion_sectionId_idx" ON "GeneratedPolicySectionVersion"("sectionId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicySectionVersion_editedByUserId_idx" ON "GeneratedPolicySectionVersion"("editedByUserId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicySectionVersion_createdAt_idx" ON "GeneratedPolicySectionVersion"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicySectionVersion_generatedPolicyId_fkey') THEN
    ALTER TABLE "GeneratedPolicySectionVersion"
      ADD CONSTRAINT "GeneratedPolicySectionVersion_generatedPolicyId_fkey"
      FOREIGN KEY ("generatedPolicyId") REFERENCES "GeneratedPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
