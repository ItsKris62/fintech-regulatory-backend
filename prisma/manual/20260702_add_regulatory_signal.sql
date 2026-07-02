-- Phase B Batch B3: Regulatory Intelligence Agent additive schema
-- Run manually in Supabase. Do not run prisma migrate for this batch.
-- Dedup rule: same sourceUrl + same contentHash means already processed and is skipped
-- by INSERT ... ON CONFLICT DO NOTHING RETURNING. Same sourceUrl with a changed
-- contentHash creates a new row and triggers a fresh classification pass.

CREATE TABLE IF NOT EXISTS "RegulatorySignal" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceUrl" TEXT NOT NULL,
  "normalizedUrl" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "sourceItemId" TEXT,
  "sourceMonitorId" TEXT,
  "jurisdiction" TEXT NOT NULL,
  "regulatoryBody" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "affectedSectors" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "affectedObligations" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "effectiveDate" TIMESTAMP(3),
  "complianceWindowDays" INTEGER,
  "corpusGapDetected" BOOLEAN NOT NULL DEFAULT false,
  "corpusGapDetails" JSONB,
  "pilotFintechsAffected" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "rawContent" TEXT,
  "agentRunId" TEXT NOT NULL REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "providerTrace" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "RegulatorySignal_sourceUrl_contentHash_key"
  ON "RegulatorySignal"("sourceUrl", "contentHash");

CREATE INDEX IF NOT EXISTS "RegulatorySignal_normalizedUrl_idx" ON "RegulatorySignal"("normalizedUrl");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_jurisdiction_idx" ON "RegulatorySignal"("jurisdiction");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_regulatoryBody_idx" ON "RegulatorySignal"("regulatoryBody");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_severity_idx" ON "RegulatorySignal"("severity");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_status_idx" ON "RegulatorySignal"("status");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_corpusGapDetected_idx" ON "RegulatorySignal"("corpusGapDetected");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_agentRunId_idx" ON "RegulatorySignal"("agentRunId");
CREATE INDEX IF NOT EXISTS "RegulatorySignal_createdAt_idx" ON "RegulatorySignal"("createdAt");