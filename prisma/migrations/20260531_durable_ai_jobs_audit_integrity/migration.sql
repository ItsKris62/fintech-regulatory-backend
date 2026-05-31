-- Sprint 1: Durable execution and audit integrity.

-- Durable AI job queue -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "AiJob" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT NOT NULL,
  "targetEntityType" TEXT NOT NULL,
  "targetEntityId" TEXT NOT NULL,
  "userId" TEXT,
  "organizationId" TEXT,
  "payload" JSONB NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "deadLetteredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiJobEvent" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "message" TEXT,
  "progress" INTEGER,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiJobEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiJob_idempotencyKey_key" ON "AiJob"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AiJob_status_runAfter_idx" ON "AiJob"("status", "runAfter");
CREATE INDEX IF NOT EXISTS "AiJob_targetEntityType_targetEntityId_idx" ON "AiJob"("targetEntityType", "targetEntityId");
CREATE INDEX IF NOT EXISTS "AiJob_organizationId_status_idx" ON "AiJob"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "AiJob_userId_status_idx" ON "AiJob"("userId", "status");
CREATE INDEX IF NOT EXISTS "AiJob_createdAt_idx" ON "AiJob"("createdAt");
CREATE INDEX IF NOT EXISTS "AiJobEvent_jobId_createdAt_idx" ON "AiJobEvent"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiJobEvent_type_idx" ON "AiJobEvent"("type");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiJob_userId_fkey') THEN
    ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiJob_organizationId_fkey') THEN
    ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiJobEvent_jobId_fkey') THEN
    ALTER TABLE "AiJobEvent" ADD CONSTRAINT "AiJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Gap analysis framework snapshots -----------------------------------------
CREATE TABLE IF NOT EXISTS "GapAnalysisFramework" (
  "id" TEXT NOT NULL,
  "gapAnalysisId" TEXT NOT NULL,
  "frameworkId" TEXT,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT,
  "tier" TEXT,
  "sortOrder" INTEGER,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GapAnalysisFramework_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GapAnalysisFramework_gapAnalysisId_slug_key" ON "GapAnalysisFramework"("gapAnalysisId", "slug");
CREATE INDEX IF NOT EXISTS "GapAnalysisFramework_gapAnalysisId_idx" ON "GapAnalysisFramework"("gapAnalysisId");
CREATE INDEX IF NOT EXISTS "GapAnalysisFramework_slug_idx" ON "GapAnalysisFramework"("slug");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GapAnalysisFramework_gapAnalysisId_fkey') THEN
    ALTER TABLE "GapAnalysisFramework" ADD CONSTRAINT "GapAnalysisFramework_gapAnalysisId_fkey" FOREIGN KEY ("gapAnalysisId") REFERENCES "GapAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GapAnalysisFramework_frameworkId_fkey') THEN
    ALTER TABLE "GapAnalysisFramework" ADD CONSTRAINT "GapAnalysisFramework_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "RegulatoryFramework"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill snapshots from historical GapAnalysis.regulatoryFrameworks JSON.
INSERT INTO "GapAnalysisFramework" ("id", "gapAnalysisId", "frameworkId", "slug", "name", "category", "tier", "sortOrder")
SELECT
  'gaf_' || md5(g."id" || ':' || COALESCE(f.slug, framework_name)),
  g."id",
  f."id",
  COALESCE(f.slug, lower(regexp_replace(framework_name, '[^a-zA-Z0-9]+', '-', 'g'))),
  COALESCE(f.name, framework_name),
  f.category,
  f.tier,
  f."sortOrder"
FROM "GapAnalysis" g
CROSS JOIN LATERAL jsonb_array_elements_text(g."regulatoryFrameworks") AS framework_name
LEFT JOIN "RegulatoryFramework" f ON f.name = framework_name OR f.slug = framework_name
ON CONFLICT ("gapAnalysisId", "slug") DO NOTHING;

-- Checklist organization integrity ------------------------------------------
INSERT INTO "Organization" ("id", "name", "type", "organizationType", "subscriptionTier", "subscriptionStatus", "plan", "createdAt", "updatedAt")
VALUES ('legacy_null_org', 'Legacy Unassigned Organization', 'legacy', 'startup', 'starter', 'ACTIVE', 'REGULATOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

UPDATE "Checklist" c
SET "organizationId" = COALESCE(u."organizationId", 'legacy_null_org')
FROM "User" u
WHERE c."userId" = u."id"
  AND c."organizationId" IS NULL;

UPDATE "Checklist"
SET "organizationId" = 'legacy_null_org'
WHERE "organizationId" IS NULL;

ALTER TABLE "Checklist" ALTER COLUMN "organizationId" SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Checklist_organizationId_fkey') THEN
    ALTER TABLE "Checklist" ADD CONSTRAINT "Checklist_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Generated policy audit hardening ------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GeneratedPolicyStatus') THEN
    CREATE TYPE "GeneratedPolicyStatus" AS ENUM (
      'INITIALIZING',
      'OUTLINING',
      'DRAFTING',
      'REVIEWING',
      'COMPLETED',
      'FAILED',
      'ARCHIVED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "GeneratedPolicy" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "policyType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "targetAudience" TEXT,
  "organizationType" TEXT,
  "sourceGapAnalysisId" TEXT,
  "sourceGapId" TEXT,
  "regulatoryFrameworks" TEXT[] NOT NULL,
  "jurisdiction" TEXT NOT NULL DEFAULT 'Kenya',
  "status" "GeneratedPolicyStatus" NOT NULL DEFAULT 'INITIALIZING',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "tableOfContents" JSONB,
  "sections" JSONB,
  "executiveSummary" TEXT,
  "reviewNotes" TEXT,
  "generationMetadata" JSONB,
  "ragGrounded" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "parentId" TEXT,
  "isLatestVersion" BOOLEAN NOT NULL DEFAULT true,
  "lastExportedAt" TIMESTAMP(3),
  "lastExportFormat" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "GeneratedPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GeneratedPolicy_userId_idx" ON "GeneratedPolicy"("userId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicy_organizationId_idx" ON "GeneratedPolicy"("organizationId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicy_status_idx" ON "GeneratedPolicy"("status");
CREATE INDEX IF NOT EXISTS "GeneratedPolicy_policyType_idx" ON "GeneratedPolicy"("policyType");
CREATE INDEX IF NOT EXISTS "GeneratedPolicy_sourceGapAnalysisId_idx" ON "GeneratedPolicy"("sourceGapAnalysisId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicy_deletedAt_idx" ON "GeneratedPolicy"("deletedAt");
CREATE INDEX IF NOT EXISTS "GeneratedPolicy_createdAt_idx" ON "GeneratedPolicy"("createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicy_userId_fkey') THEN
    ALTER TABLE "GeneratedPolicy" ADD CONSTRAINT "GeneratedPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicy_organizationId_fkey') THEN
    ALTER TABLE "GeneratedPolicy" ADD CONSTRAINT "GeneratedPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicy_sourceGapAnalysisId_fkey') THEN
    ALTER TABLE "GeneratedPolicy" ADD CONSTRAINT "GeneratedPolicy_sourceGapAnalysisId_fkey" FOREIGN KEY ("sourceGapAnalysisId") REFERENCES "GapAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicy_parentId_fkey') THEN
    ALTER TABLE "GeneratedPolicy" ADD CONSTRAINT "GeneratedPolicy_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GeneratedPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "GeneratedPolicyCitation" (
  "id" TEXT NOT NULL,
  "generatedPolicyId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "actName" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "subsection" TEXT,
  "textSnippet" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "citationVerified" BOOLEAN,
  "rawSource" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedPolicyCitation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GeneratedPolicyCitation_generatedPolicyId_idx" ON "GeneratedPolicyCitation"("generatedPolicyId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyCitation_sectionId_idx" ON "GeneratedPolicyCitation"("sectionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicyCitation_generatedPolicyId_fkey') THEN
    ALTER TABLE "GeneratedPolicyCitation" ADD CONSTRAINT "GeneratedPolicyCitation_generatedPolicyId_fkey" FOREIGN KEY ("generatedPolicyId") REFERENCES "GeneratedPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "GeneratedPolicySourceSnapshot" (
  "id" TEXT NOT NULL,
  "generatedPolicyId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "slug" TEXT,
  "documentId" TEXT,
  "sourceUrl" TEXT,
  "contentHash" TEXT,
  "excerpt" TEXT,
  "metadata" JSONB,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedPolicySourceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GeneratedPolicyExportLog" (
  "id" TEXT NOT NULL,
  "generatedPolicyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "storageKey" TEXT,
  "filename" TEXT,
  "metadata" JSONB,
  "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedPolicyExportLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GeneratedPolicyGenerationEvent" (
  "id" TEXT NOT NULL,
  "generatedPolicyId" TEXT NOT NULL,
  "jobId" TEXT,
  "stage" TEXT NOT NULL,
  "model" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "costUsd" DOUBLE PRECISION,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedPolicyGenerationEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GeneratedPolicyCitation" ADD COLUMN IF NOT EXISTS "sourceSnapshotId" TEXT;

CREATE INDEX IF NOT EXISTS "GeneratedPolicySourceSnapshot_generatedPolicyId_idx" ON "GeneratedPolicySourceSnapshot"("generatedPolicyId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicySourceSnapshot_documentId_idx" ON "GeneratedPolicySourceSnapshot"("documentId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicySourceSnapshot_contentHash_idx" ON "GeneratedPolicySourceSnapshot"("contentHash");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyExportLog_generatedPolicyId_idx" ON "GeneratedPolicyExportLog"("generatedPolicyId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyExportLog_userId_idx" ON "GeneratedPolicyExportLog"("userId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyExportLog_organizationId_idx" ON "GeneratedPolicyExportLog"("organizationId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyExportLog_exportedAt_idx" ON "GeneratedPolicyExportLog"("exportedAt");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyGenerationEvent_generatedPolicyId_idx" ON "GeneratedPolicyGenerationEvent"("generatedPolicyId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyGenerationEvent_jobId_idx" ON "GeneratedPolicyGenerationEvent"("jobId");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyGenerationEvent_stage_idx" ON "GeneratedPolicyGenerationEvent"("stage");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyGenerationEvent_createdAt_idx" ON "GeneratedPolicyGenerationEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "GeneratedPolicyCitation_sourceSnapshotId_idx" ON "GeneratedPolicyCitation"("sourceSnapshotId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicySourceSnapshot_generatedPolicyId_fkey') THEN
    ALTER TABLE "GeneratedPolicySourceSnapshot" ADD CONSTRAINT "GeneratedPolicySourceSnapshot_generatedPolicyId_fkey" FOREIGN KEY ("generatedPolicyId") REFERENCES "GeneratedPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicyExportLog_generatedPolicyId_fkey') THEN
    ALTER TABLE "GeneratedPolicyExportLog" ADD CONSTRAINT "GeneratedPolicyExportLog_generatedPolicyId_fkey" FOREIGN KEY ("generatedPolicyId") REFERENCES "GeneratedPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicyGenerationEvent_generatedPolicyId_fkey') THEN
    ALTER TABLE "GeneratedPolicyGenerationEvent" ADD CONSTRAINT "GeneratedPolicyGenerationEvent_generatedPolicyId_fkey" FOREIGN KEY ("generatedPolicyId") REFERENCES "GeneratedPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GeneratedPolicyCitation_sourceSnapshotId_fkey') THEN
    ALTER TABLE "GeneratedPolicyCitation" ADD CONSTRAINT "GeneratedPolicyCitation_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "GeneratedPolicySourceSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
