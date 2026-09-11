-- SheriaBot Phase 1: Dedicated Regulatory Intelligence Persistence & Backend Contract Layer
-- Strictly additive migration.
-- Applied manually (per repository convention) or via migration tooling, followed by `prisma generate`.

-- 1. Create Enums if not exist
DO $$ BEGIN
  CREATE TYPE "RegulatoryAuthorityType" AS ENUM ('PRIMARY_OFFICIAL', 'AUTHORITATIVE', 'SECONDARY_VERIFIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RegulatorySourceType" AS ENUM ('WEBSITE', 'FEED_RSS', 'GAZETTE_FEED', 'API', 'PORTAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RegulatoryInformationType" AS ENUM (
    'DRAFT_REGULATION',
    'CIRCULAR',
    'CONSULTATION',
    'NOTICE',
    'GAZETTE_NOTICE',
    'GUIDANCE',
    'DIRECTIVE',
    'LEGISLATIVE_UPDATE',
    'POLICY_UPDATE',
    'ENFORCEMENT',
    'LICENSING_UPDATE',
    'OFFICIAL_ANNOUNCEMENT',
    'MARKET_DEVELOPMENT',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RegulatoryStage" AS ENUM (
    'DRAFT',
    'PROPOSED',
    'CONSULTATION',
    'ANNOUNCED',
    'ISSUED',
    'GAZETTED',
    'EFFECTIVE',
    'DEVELOPING',
    'SUPERSEDED',
    'WITHDRAWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RegulatoryVerificationState" AS ENUM (
    'UNVERIFIED',
    'SOURCE_VERIFIED',
    'FACT_VERIFIED',
    'REQUIRES_REVIEW',
    'DISPUTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RegulatoryMateriality" AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RegulatoryEvidenceRole" AS ENUM (
    'PRIMARY',
    'SUPPORTING',
    'UPDATE',
    'SUPERSEDING'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Create Table: RegulatorySource
CREATE TABLE IF NOT EXISTS "RegulatorySource" (
  "id" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "jurisdictionCode" TEXT NOT NULL DEFAULT 'KE',
  "regulatoryBody" TEXT NOT NULL,
  "authorityType" "RegulatoryAuthorityType" NOT NULL DEFAULT 'PRIMARY_OFFICIAL',
  "sourceType" "RegulatorySourceType" NOT NULL DEFAULT 'WEBSITE',
  "baseUrl" TEXT NOT NULL,
  "fetchUrl" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastCheckedAt" TIMESTAMP(3),
  "lastSuccessfulFetchAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastFailureReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegulatorySource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RegulatorySource_sourceKey_key" ON "RegulatorySource"("sourceKey");
CREATE INDEX IF NOT EXISTS "RegulatorySource_jurisdictionCode_idx" ON "RegulatorySource"("jurisdictionCode");
CREATE INDEX IF NOT EXISTS "RegulatorySource_regulatoryBody_idx" ON "RegulatorySource"("regulatoryBody");
CREATE INDEX IF NOT EXISTS "RegulatorySource_authorityType_idx" ON "RegulatorySource"("authorityType");
CREATE INDEX IF NOT EXISTS "RegulatorySource_isActive_idx" ON "RegulatorySource"("isActive");

-- 3. Create Table: RegulatorySourceSnapshot
CREATE TABLE IF NOT EXISTS "RegulatorySourceSnapshot" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "canonicalUrl" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "hashVersion" INTEGER NOT NULL DEFAULT 1,
  "normalizationVersion" INTEGER NOT NULL DEFAULT 1,
  "contentLength" INTEGER NOT NULL DEFAULT 0,
  "httpStatus" INTEGER,
  "contentType" TEXT,
  "etag" TEXT,
  "lastModified" TEXT,
  "rawText" TEXT,
  "rawPayload" TEXT,
  "rawStorageKey" TEXT,
  "title" TEXT,
  "metadata" JSONB,
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegulatorySourceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RegulatorySourceSnapshot_sourceId_canonicalUrl_contentHash_key" ON "RegulatorySourceSnapshot"("sourceId", "canonicalUrl", "contentHash");
CREATE INDEX IF NOT EXISTS "RegulatorySourceSnapshot_sourceId_idx" ON "RegulatorySourceSnapshot"("sourceId");
CREATE INDEX IF NOT EXISTS "RegulatorySourceSnapshot_canonicalUrl_idx" ON "RegulatorySourceSnapshot"("canonicalUrl");
CREATE INDEX IF NOT EXISTS "RegulatorySourceSnapshot_contentHash_idx" ON "RegulatorySourceSnapshot"("contentHash");
CREATE INDEX IF NOT EXISTS "RegulatorySourceSnapshot_retrievedAt_idx" ON "RegulatorySourceSnapshot"("retrievedAt");

-- 4. Create Table: RegulatorySourceItem
CREATE TABLE IF NOT EXISTS "RegulatorySourceItem" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "primarySnapshotId" TEXT,
  "jurisdictionCode" TEXT NOT NULL DEFAULT 'KE',
  "regulator" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "officialTitle" TEXT,
  "summary" TEXT NOT NULL,
  "informationType" "RegulatoryInformationType" NOT NULL DEFAULT 'NOTICE',
  "regulatoryStage" "RegulatoryStage" NOT NULL DEFAULT 'ISSUED',
  "verificationState" "RegulatoryVerificationState" NOT NULL DEFAULT 'UNVERIFIED',
  "materiality" "RegulatoryMateriality" NOT NULL DEFAULT 'MEDIUM',
  "relevanceScore" DOUBLE PRECISION,
  "publicationDate" TIMESTAMP(3),
  "effectiveDate" TIMESTAMP(3),
  "consultationDeadline" TIMESTAMP(3),
  "complianceDeadline" TIMESTAMP(3),
  "affectedSectors" JSONB NOT NULL DEFAULT '[]',
  "affectedEntityTypes" JSONB NOT NULL DEFAULT '[]',
  "topics" JSONB NOT NULL DEFAULT '[]',
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededById" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegulatorySourceItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RegulatorySourceItem_dedupeKey_key" ON "RegulatorySourceItem"("dedupeKey");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_jurisdictionCode_idx" ON "RegulatorySourceItem"("jurisdictionCode");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_regulator_idx" ON "RegulatorySourceItem"("regulator");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_informationType_idx" ON "RegulatorySourceItem"("informationType");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_regulatoryStage_idx" ON "RegulatorySourceItem"("regulatoryStage");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_verificationState_idx" ON "RegulatorySourceItem"("verificationState");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_materiality_idx" ON "RegulatorySourceItem"("materiality");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_publicationDate_idx" ON "RegulatorySourceItem"("publicationDate");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_effectiveDate_idx" ON "RegulatorySourceItem"("effectiveDate");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItem_createdAt_idx" ON "RegulatorySourceItem"("createdAt");

-- 5. Create Table: RegulatorySourceItemEvidence
CREATE TABLE IF NOT EXISTS "RegulatorySourceItemEvidence" (
  "id" TEXT NOT NULL,
  "sourceItemId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "role" "RegulatoryEvidenceRole" NOT NULL DEFAULT 'SUPPORTING',
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegulatorySourceItemEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RegulatorySourceItemEvidence_sourceItemId_snapshotId_key" ON "RegulatorySourceItemEvidence"("sourceItemId", "snapshotId");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItemEvidence_sourceItemId_idx" ON "RegulatorySourceItemEvidence"("sourceItemId");
CREATE INDEX IF NOT EXISTS "RegulatorySourceItemEvidence_snapshotId_idx" ON "RegulatorySourceItemEvidence"("snapshotId");

-- 6. Extend RegulatoryAlert with nullable primaryRegulatorySourceItemId and automationDraftKey
ALTER TABLE "RegulatoryAlert"
  ADD COLUMN IF NOT EXISTS "primaryRegulatorySourceItemId" TEXT,
  ADD COLUMN IF NOT EXISTS "automationDraftKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "RegulatoryAlert_automationDraftKey_key" ON "RegulatoryAlert"("automationDraftKey");
CREATE INDEX IF NOT EXISTS "RegulatoryAlert_primaryRegulatorySourceItemId_idx" ON "RegulatoryAlert"("primaryRegulatorySourceItemId");

-- 7. Add Foreign Key Constraints (safely using DO blocks)
DO $$ BEGIN
  ALTER TABLE "RegulatorySourceSnapshot"
    ADD CONSTRAINT "RegulatorySourceSnapshot_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "RegulatorySource"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RegulatorySourceItem"
    ADD CONSTRAINT "RegulatorySourceItem_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "RegulatorySource"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RegulatorySourceItem"
    ADD CONSTRAINT "RegulatorySourceItem_primarySnapshotId_fkey"
    FOREIGN KEY ("primarySnapshotId") REFERENCES "RegulatorySourceSnapshot"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RegulatorySourceItem"
    ADD CONSTRAINT "RegulatorySourceItem_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "RegulatorySourceItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RegulatorySourceItemEvidence"
    ADD CONSTRAINT "RegulatorySourceItemEvidence_sourceItemId_fkey"
    FOREIGN KEY ("sourceItemId") REFERENCES "RegulatorySourceItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RegulatorySourceItemEvidence"
    ADD CONSTRAINT "RegulatorySourceItemEvidence_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "RegulatorySourceSnapshot"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "RegulatoryAlert"
    ADD CONSTRAINT "RegulatoryAlert_primaryRegulatorySourceItemId_fkey"
    FOREIGN KEY ("primaryRegulatorySourceItemId") REFERENCES "RegulatorySourceItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
