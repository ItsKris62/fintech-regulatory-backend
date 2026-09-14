-- P0 Lead Ingestion and CRM Foundation Migration
-- Additive and idempotent migration for AI-discovered leads, evidence tracking, and enriched Company/Contact metadata.

-- 1. Create Enums if they do not exist
DO $$ BEGIN CREATE TYPE "CompanyOrigin" AS ENUM ('MANUAL_CRM', 'AI_DISCOVERY', 'PILOT_APPLICATION', 'CONTACT_IMPORT', 'INBOUND_LEAD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LeadStatus" AS ENUM ('UNASSESSED', 'DISCOVERED', 'QUALIFIED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'NURTURE', 'CONVERTED', 'DO_NOT_CONTACT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SalesStage" AS ENUM ('PROSPECT', 'LEAD_QUALIFIED', 'OUTREACH_PENDING', 'CONTACTED', 'ENGAGED', 'MEETING_SCHEDULED', 'DEMO_COMPLETED', 'TRIAL_ACTIVE', 'PILOT_ACTIVE', 'OPPORTUNITY', 'CLOSED_WON', 'CLOSED_LOST', 'DISQUALIFIED', 'UNRESPONSIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "IcpTier" AS ENUM ('UNASSESSED', 'TIER_1_CORE_FINTECH', 'TIER_2_HIGH_EXPOSURE', 'TIER_3_ADJACENT', 'NON_ICP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CompanySizeClass" AS ENUM ('UNKNOWN', 'MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EvidenceVerificationState" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CONFLICTING', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DiscoveryRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Alter Company table
ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "origin" "CompanyOrigin" NOT NULL DEFAULT 'MANUAL_CRM',
  ADD COLUMN IF NOT EXISTS "leadStatus" "LeadStatus" NOT NULL DEFAULT 'UNASSESSED',
  ADD COLUMN IF NOT EXISTS "salesStage" "SalesStage" NOT NULL DEFAULT 'PROSPECT',
  ADD COLUMN IF NOT EXISTS "icpTier" "IcpTier" NOT NULL DEFAULT 'UNASSESSED',
  ADD COLUMN IF NOT EXISTS "leadScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "sizeClass" "CompanySizeClass" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "country" TEXT NOT NULL DEFAULT 'Kenya',
  ADD COLUMN IF NOT EXISTS "regulatoryBody" TEXT,
  ADD COLUMN IF NOT EXISTS "licenceType" TEXT,
  ADD COLUMN IF NOT EXISTS "licenceNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "licenceStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "primarySourceUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "primarySourceAuthority" TEXT,
  ADD COLUMN IF NOT EXISTS "discoveredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "reviewReason" TEXT,
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerId" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);

-- Create Company Foreign Keys and Indexes
DO $$ BEGIN
  ALTER TABLE "Company" ADD CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Company" ADD CONSTRAINT "Company_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Company_leadStatus_idx" ON "Company"("leadStatus");
CREATE INDEX IF NOT EXISTS "Company_icpTier_idx" ON "Company"("icpTier");
CREATE INDEX IF NOT EXISTS "Company_leadScore_idx" ON "Company"("leadScore");
CREATE INDEX IF NOT EXISTS "Company_country_idx" ON "Company"("country");
CREATE INDEX IF NOT EXISTS "Company_ownerId_idx" ON "Company"("ownerId");
CREATE INDEX IF NOT EXISTS "Company_reviewedById_idx" ON "Company"("reviewedById");
CREATE INDEX IF NOT EXISTS "Company_origin_idx" ON "Company"("origin");
CREATE INDEX IF NOT EXISTS "Company_licenceNumber_idx" ON "Company"("licenceNumber");

-- 3. Alter Contact table
ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "salesStage" "SalesStage" NOT NULL DEFAULT 'PROSPECT',
  ADD COLUMN IF NOT EXISTS "linkedinUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "lastContactedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextFollowUpAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Contact_salesStage_idx" ON "Contact"("salesStage");

-- 4. Create DiscoveryRun table
CREATE TABLE IF NOT EXISTS "DiscoveryRun" (
  "id" TEXT NOT NULL,
  "runIdempotencyKey" TEXT NOT NULL,
  "workflowName" TEXT NOT NULL,
  "sourceAuthority" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
  "totalDiscovered" INTEGER NOT NULL DEFAULT 0,
  "totalQualified" INTEGER NOT NULL DEFAULT 0,
  "totalDeduplicated" INTEGER NOT NULL DEFAULT 0,
  "totalRejected" INTEGER NOT NULL DEFAULT 0,
  "totalCreated" INTEGER NOT NULL DEFAULT 0,
  "totalUpdated" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "metadata" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DiscoveryRun_runIdempotencyKey_key" ON "DiscoveryRun"("runIdempotencyKey");
CREATE INDEX IF NOT EXISTS "DiscoveryRun_workflowName_idx" ON "DiscoveryRun"("workflowName");
CREATE INDEX IF NOT EXISTS "DiscoveryRun_sourceAuthority_idx" ON "DiscoveryRun"("sourceAuthority");
CREATE INDEX IF NOT EXISTS "DiscoveryRun_status_idx" ON "DiscoveryRun"("status");
CREATE INDEX IF NOT EXISTS "DiscoveryRun_startedAt_idx" ON "DiscoveryRun"("startedAt");

-- 5. Create DiscoveryEvidence table
CREATE TABLE IF NOT EXISTS "DiscoveryEvidence" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "discoveryRunId" TEXT,
  "field" TEXT NOT NULL,
  "extractedValue" TEXT NOT NULL,
  "normalizedValue" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "sourceUrl" TEXT NOT NULL,
  "sourceAuthority" TEXT,
  "sourceRecordId" TEXT,
  "evidenceSnippet" TEXT,
  "verificationState" "EvidenceVerificationState" NOT NULL DEFAULT 'UNVERIFIED',
  "evidenceHash" TEXT NOT NULL,
  "extractionMethod" TEXT,
  "modelProvider" TEXT,
  "modelName" TEXT,
  "extractorVersion" TEXT,
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryEvidence_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "DiscoveryEvidence" ADD CONSTRAINT "DiscoveryEvidence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DiscoveryEvidence" ADD CONSTRAINT "DiscoveryEvidence_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "DiscoveryEvidence_companyId_evidenceHash_key" ON "DiscoveryEvidence"("companyId", "evidenceHash");
CREATE INDEX IF NOT EXISTS "DiscoveryEvidence_companyId_idx" ON "DiscoveryEvidence"("companyId");
CREATE INDEX IF NOT EXISTS "DiscoveryEvidence_discoveryRunId_idx" ON "DiscoveryEvidence"("discoveryRunId");
CREATE INDEX IF NOT EXISTS "DiscoveryEvidence_sourceUrl_idx" ON "DiscoveryEvidence"("sourceUrl");
CREATE INDEX IF NOT EXISTS "DiscoveryEvidence_field_idx" ON "DiscoveryEvidence"("field");
CREATE INDEX IF NOT EXISTS "DiscoveryEvidence_verificationState_idx" ON "DiscoveryEvidence"("verificationState");

-- 6. Create DiscoveryRunCompany join table
CREATE TABLE IF NOT EXISTS "DiscoveryRunCompany" (
  "id" TEXT NOT NULL,
  "discoveryRunId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "scoreAtRun" INTEGER,
  "icpTierAtRun" "IcpTier",
  "leadStatusAtRun" "LeadStatus",
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscoveryRunCompany_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "DiscoveryRunCompany" ADD CONSTRAINT "DiscoveryRunCompany_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DiscoveryRunCompany" ADD CONSTRAINT "DiscoveryRunCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "DiscoveryRunCompany_discoveryRunId_companyId_key" ON "DiscoveryRunCompany"("discoveryRunId", "companyId");
CREATE INDEX IF NOT EXISTS "DiscoveryRunCompany_discoveryRunId_idx" ON "DiscoveryRunCompany"("discoveryRunId");
CREATE INDEX IF NOT EXISTS "DiscoveryRunCompany_companyId_idx" ON "DiscoveryRunCompany"("companyId");
CREATE INDEX IF NOT EXISTS "DiscoveryRunCompany_action_idx" ON "DiscoveryRunCompany"("action");
