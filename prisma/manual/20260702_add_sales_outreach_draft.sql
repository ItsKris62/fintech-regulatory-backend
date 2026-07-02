-- Phase B Batch B5: Sales/Growth Agent additive schema
-- Run manually in Supabase. Do not run prisma migrate for this batch.
-- Dedup rule: sourceFingerprint = "<sourceSignalId>|<organizationId>". A signal
-- affecting the same organization is only ever drafted once, regardless of how
-- many agent runs re-select it.

CREATE TABLE IF NOT EXISTS "SalesOutreachDraft" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceSignalId" TEXT NOT NULL REFERENCES "RegulatorySignal"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "triggerReason" TEXT NOT NULL,
  "engagementContext" JSONB,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "agentRunId" TEXT NOT NULL REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "editedBody" TEXT,
  "sourceFingerprint" TEXT NOT NULL,
  "metadata" JSONB,
  CONSTRAINT "SalesOutreachDraft_priority_check" CHECK ("priority" IN ('high', 'medium', 'low')),
  CONSTRAINT "SalesOutreachDraft_status_check" CHECK ("status" IN ('DRAFT', 'REVIEWED', 'DISMISSED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "SalesOutreachDraft_sourceFingerprint_key"
  ON "SalesOutreachDraft"("sourceFingerprint");

CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_organizationId_idx" ON "SalesOutreachDraft"("organizationId");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_status_idx" ON "SalesOutreachDraft"("status");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_priority_idx" ON "SalesOutreachDraft"("priority");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_agentRunId_idx" ON "SalesOutreachDraft"("agentRunId");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_sourceSignalId_idx" ON "SalesOutreachDraft"("sourceSignalId");
CREATE INDEX IF NOT EXISTS "SalesOutreachDraft_generatedAt_idx" ON "SalesOutreachDraft"("generatedAt");
