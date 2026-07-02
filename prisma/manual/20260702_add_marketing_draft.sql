-- Phase B Batch B4: Marketing Agent additive schema
-- Run manually in Supabase. Do not run prisma migrate for this batch.
-- Dedup rule: sourceFingerprint is deterministic from sorted sourceSignalIds.
-- Same contentType + same sourceFingerprint means the same source signal set has
-- already produced that draft type and must not be re-drafted.

CREATE TABLE IF NOT EXISTS "MarketingDraft" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "contentType" TEXT NOT NULL,
  "sourceSignalIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sourceFingerprint" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "brief" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "agentRunId" TEXT NOT NULL REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "editedBody" TEXT,
  "metadata" JSONB,
  CONSTRAINT "MarketingDraft_contentType_check" CHECK ("contentType" IN ('newsletter_item', 'linkedin_post')),
  CONSTRAINT "MarketingDraft_status_check" CHECK ("status" IN ('DRAFT', 'REVIEWED', 'DISMISSED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketingDraft_contentType_sourceFingerprint_key"
  ON "MarketingDraft"("contentType", "sourceFingerprint");

CREATE INDEX IF NOT EXISTS "MarketingDraft_contentType_idx" ON "MarketingDraft"("contentType");
CREATE INDEX IF NOT EXISTS "MarketingDraft_status_idx" ON "MarketingDraft"("status");
CREATE INDEX IF NOT EXISTS "MarketingDraft_agentRunId_idx" ON "MarketingDraft"("agentRunId");
CREATE INDEX IF NOT EXISTS "MarketingDraft_generatedAt_idx" ON "MarketingDraft"("generatedAt");