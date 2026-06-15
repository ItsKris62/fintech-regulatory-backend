-- Corpus Gap Reporting
-- Apply manually in Supabase SQL Editor.
-- This is additive and does not modify LegalDocument, DocumentChunk, or Pinecone data.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CorpusGapDocumentType') THEN
    CREATE TYPE "CorpusGapDocumentType" AS ENUM (
      'LEGISLATION',
      'REGULATION',
      'CIRCULAR',
      'GUIDELINE',
      'POLICY',
      'STANDARD',
      'OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CorpusGapJurisdiction') THEN
    CREATE TYPE "CorpusGapJurisdiction" AS ENUM (
      'KENYA',
      'MALAWI',
      'NIGERIA',
      'RWANDA',
      'OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CorpusGapReportStatus') THEN
    CREATE TYPE "CorpusGapReportStatus" AS ENUM (
      'PENDING',
      'UNDER_REVIEW',
      'INGESTED',
      'REJECTED',
      'DUPLICATE'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CorpusGapReport" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "reportedByUserId" TEXT NOT NULL,
  "documentName" TEXT NOT NULL,
  "issuingAuthority" TEXT NOT NULL,
  "documentType" "CorpusGapDocumentType" NOT NULL,
  "jurisdiction" "CorpusGapJurisdiction" NOT NULL,
  "description" TEXT,
  "sourceUrl" TEXT,
  "status" "CorpusGapReportStatus" NOT NULL DEFAULT 'PENDING',
  "adminNotes" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CorpusGapReport_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorpusGapReport_reportedByUserId_fkey"
    FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CorpusGapReport_organizationId_idx"
  ON "CorpusGapReport"("organizationId");

CREATE INDEX IF NOT EXISTS "CorpusGapReport_reportedByUserId_idx"
  ON "CorpusGapReport"("reportedByUserId");

CREATE INDEX IF NOT EXISTS "CorpusGapReport_status_idx"
  ON "CorpusGapReport"("status");

CREATE INDEX IF NOT EXISTS "CorpusGapReport_jurisdiction_idx"
  ON "CorpusGapReport"("jurisdiction");

CREATE INDEX IF NOT EXISTS "CorpusGapReport_documentType_idx"
  ON "CorpusGapReport"("documentType");

CREATE INDEX IF NOT EXISTS "CorpusGapReport_documentName_jurisdiction_status_idx"
  ON "CorpusGapReport"("documentName", "jurisdiction", "status");

CREATE INDEX IF NOT EXISTS "CorpusGapReport_createdAt_idx"
  ON "CorpusGapReport"("createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "CorpusGapReport_active_duplicate_idx"
  ON "CorpusGapReport"(lower("documentName"), "jurisdiction")
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'NotificationType'
      AND e.enumlabel = 'CORPUS_GAP_REPORT_INGESTED'
  ) THEN
    ALTER TYPE "NotificationType" ADD VALUE 'CORPUS_GAP_REPORT_INGESTED';
  END IF;
END $$;
