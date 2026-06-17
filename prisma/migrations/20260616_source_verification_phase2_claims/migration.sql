-- Source Verification Phase 2: claim-level verification audit tables.
-- Nullable source links preserve compatibility with existing v1 chunks/vectors.

CREATE TABLE "ComplianceAnswerClaim" (
  "id" TEXT NOT NULL,
  "complianceQueryId" TEXT NOT NULL,
  "claimText" TEXT NOT NULL,
  "claimType" TEXT NOT NULL,
  "requiresCitation" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ComplianceAnswerClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplianceClaimCitation" (
  "id" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "regulatoryDocumentChunkId" TEXT,
  "documentId" TEXT,
  "documentTitle" TEXT,
  "section" TEXT,
  "chunkRank" INTEGER,
  "quoteStart" INTEGER,
  "quoteEnd" INTEGER,
  "supportExcerpt" TEXT NOT NULL,
  "supportVerdict" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION,
  "verifierModel" TEXT,
  "rawSource" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ComplianceClaimCitation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComplianceAnswerClaim_complianceQueryId_idx" ON "ComplianceAnswerClaim"("complianceQueryId");
CREATE INDEX "ComplianceAnswerClaim_status_idx" ON "ComplianceAnswerClaim"("status");
CREATE INDEX "ComplianceAnswerClaim_claimType_idx" ON "ComplianceAnswerClaim"("claimType");

CREATE INDEX "ComplianceClaimCitation_claimId_idx" ON "ComplianceClaimCitation"("claimId");
CREATE INDEX "ComplianceClaimCitation_regulatoryDocumentChunkId_idx" ON "ComplianceClaimCitation"("regulatoryDocumentChunkId");
CREATE INDEX "ComplianceClaimCitation_documentId_idx" ON "ComplianceClaimCitation"("documentId");
CREATE INDEX "ComplianceClaimCitation_supportVerdict_idx" ON "ComplianceClaimCitation"("supportVerdict");

ALTER TABLE "ComplianceAnswerClaim"
  ADD CONSTRAINT "ComplianceAnswerClaim_complianceQueryId_fkey"
  FOREIGN KEY ("complianceQueryId") REFERENCES "ComplianceQuery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComplianceClaimCitation"
  ADD CONSTRAINT "ComplianceClaimCitation_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "ComplianceAnswerClaim"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComplianceClaimCitation"
  ADD CONSTRAINT "ComplianceClaimCitation_regulatoryDocumentChunkId_fkey"
  FOREIGN KEY ("regulatoryDocumentChunkId") REFERENCES "RegulatoryDocumentChunk"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
