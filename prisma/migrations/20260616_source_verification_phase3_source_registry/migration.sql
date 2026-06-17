-- Source Verification Phase 3: source registry, source versioning, and v2 chunk metadata groundwork.
-- This migration is additive and preserves existing v1 corpus rows.

CREATE TYPE "ApprovedSourceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEPRECATED');
CREATE TYPE "SourceDocumentVersionStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'ARCHIVED', 'DRAFT', 'CONSULTATION');

CREATE TABLE "ApprovedSource" (
  "id" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "authorityName" TEXT NOT NULL,
  "authorityType" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "allowedDomains" JSONB,
  "status" "ApprovedSourceStatus" NOT NULL DEFAULT 'ACTIVE',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ApprovedSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SourceDocumentVersion" (
  "id" TEXT NOT NULL,
  "regulatoryDocumentId" TEXT NOT NULL,
  "approvedSourceId" TEXT,
  "officialUrl" TEXT NOT NULL,
  "publicationDate" TIMESTAMP(3),
  "retrievedAt" TIMESTAMP(3),
  "effectiveDate" TIMESTAMP(3),
  "effectiveEndDate" TIMESTAMP(3),
  "versionLabel" TEXT,
  "checksumSha256" TEXT,
  "authorityStatus" "AuthorityStatus" NOT NULL DEFAULT 'IN_FORCE',
  "isBinding" BOOLEAN,
  "supersedesId" TEXT,
  "supersededById" TEXT,
  "status" "SourceDocumentVersionStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SourceDocumentVersion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RegulatoryDocument"
  ADD COLUMN "officialUrl" TEXT,
  ADD COLUMN "publicationDate" TIMESTAMP(3),
  ADD COLUMN "retrievedAt" TIMESTAMP(3),
  ADD COLUMN "effectiveEndDate" TIMESTAMP(3),
  ADD COLUMN "sourceRegistryId" TEXT,
  ADD COLUMN "sourceDocumentVersionId" TEXT,
  ADD COLUMN "supersededByDocumentId" TEXT,
  ADD COLUMN "indexVersion" TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN "metadata" JSONB;

ALTER TABLE "RegulatoryDocumentChunk"
  ADD COLUMN "pageStart" INTEGER,
  ADD COLUMN "pageEnd" INTEGER,
  ADD COLUMN "sectionNumber" TEXT,
  ADD COLUMN "clauseNumber" TEXT,
  ADD COLUMN "scheduleNumber" TEXT,
  ADD COLUMN "headingPath" JSONB,
  ADD COLUMN "provisionId" TEXT,
  ADD COLUMN "charStart" INTEGER,
  ADD COLUMN "charEnd" INTEGER,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "sourceDocumentVersionId" TEXT,
  ADD COLUMN "indexVersion" TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN "metadata" JSONB;

CREATE INDEX "ApprovedSource_jurisdiction_idx" ON "ApprovedSource"("jurisdiction");
CREATE INDEX "ApprovedSource_authorityName_idx" ON "ApprovedSource"("authorityName");
CREATE INDEX "ApprovedSource_status_idx" ON "ApprovedSource"("status");

CREATE INDEX "SourceDocumentVersion_regulatoryDocumentId_idx" ON "SourceDocumentVersion"("regulatoryDocumentId");
CREATE INDEX "SourceDocumentVersion_approvedSourceId_idx" ON "SourceDocumentVersion"("approvedSourceId");
CREATE INDEX "SourceDocumentVersion_status_idx" ON "SourceDocumentVersion"("status");
CREATE INDEX "SourceDocumentVersion_authorityStatus_idx" ON "SourceDocumentVersion"("authorityStatus");
CREATE INDEX "SourceDocumentVersion_checksumSha256_idx" ON "SourceDocumentVersion"("checksumSha256");
CREATE INDEX "SourceDocumentVersion_supersedesId_idx" ON "SourceDocumentVersion"("supersedesId");
CREATE INDEX "SourceDocumentVersion_supersededById_idx" ON "SourceDocumentVersion"("supersededById");

CREATE INDEX "RegulatoryDocument_sourceRegistryId_idx" ON "RegulatoryDocument"("sourceRegistryId");
CREATE INDEX "RegulatoryDocument_sourceDocumentVersionId_idx" ON "RegulatoryDocument"("sourceDocumentVersionId");
CREATE INDEX "RegulatoryDocument_supersededByDocumentId_idx" ON "RegulatoryDocument"("supersededByDocumentId");
CREATE INDEX "RegulatoryDocument_indexVersion_idx" ON "RegulatoryDocument"("indexVersion");

CREATE INDEX "RegulatoryDocumentChunk_sourceDocumentVersionId_idx" ON "RegulatoryDocumentChunk"("sourceDocumentVersionId");
CREATE INDEX "RegulatoryDocumentChunk_contentHash_idx" ON "RegulatoryDocumentChunk"("contentHash");
CREATE INDEX "RegulatoryDocumentChunk_provisionId_idx" ON "RegulatoryDocumentChunk"("provisionId");
CREATE INDEX "RegulatoryDocumentChunk_indexVersion_idx" ON "RegulatoryDocumentChunk"("indexVersion");

ALTER TABLE "RegulatoryDocument"
  ADD CONSTRAINT "RegulatoryDocument_sourceRegistryId_fkey"
  FOREIGN KEY ("sourceRegistryId") REFERENCES "ApprovedSource"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RegulatoryDocument"
  ADD CONSTRAINT "RegulatoryDocument_sourceDocumentVersionId_fkey"
  FOREIGN KEY ("sourceDocumentVersionId") REFERENCES "SourceDocumentVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RegulatoryDocument"
  ADD CONSTRAINT "RegulatoryDocument_supersededByDocumentId_fkey"
  FOREIGN KEY ("supersededByDocumentId") REFERENCES "RegulatoryDocument"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SourceDocumentVersion"
  ADD CONSTRAINT "SourceDocumentVersion_regulatoryDocumentId_fkey"
  FOREIGN KEY ("regulatoryDocumentId") REFERENCES "RegulatoryDocument"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SourceDocumentVersion"
  ADD CONSTRAINT "SourceDocumentVersion_approvedSourceId_fkey"
  FOREIGN KEY ("approvedSourceId") REFERENCES "ApprovedSource"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SourceDocumentVersion"
  ADD CONSTRAINT "SourceDocumentVersion_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "SourceDocumentVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SourceDocumentVersion"
  ADD CONSTRAINT "SourceDocumentVersion_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "SourceDocumentVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RegulatoryDocumentChunk"
  ADD CONSTRAINT "RegulatoryDocumentChunk_sourceDocumentVersionId_fkey"
  FOREIGN KEY ("sourceDocumentVersionId") REFERENCES "SourceDocumentVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
