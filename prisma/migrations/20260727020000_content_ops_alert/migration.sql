-- SheriaBot Pack 1 (Editorial Intelligence) — Foundation C.
-- Additive only. Apply manually, then run `prisma generate`.
-- Reuses existing AutomationIncidentSeverity/AutomationIncidentStatus enums
-- (created in 20260726_phase0_content_marketing_agent_schema_reconciliation)
-- rather than declaring new ones — see phase-b-foundations.md Foundation C.

DO $$ BEGIN CREATE TYPE "ContentOpsAlertNotificationStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SENT', 'FAILED', 'SUPPRESSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ContentOpsAlert" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "severity" "AutomationIncidentSeverity" NOT NULL,
  "status" "AutomationIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "workflowKey" TEXT,
  "executionId" TEXT,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notificationStatus" "ContentOpsAlertNotificationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastNotificationAt" TIMESTAMP(3),
  "acknowledgedById" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentOpsAlert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentOpsAlert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "ContentOpsAlert_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL
);

-- Dedupe uniqueness (corrected — see phase-b-foundations.md Foundation C): a
-- plain @@unique on (type, entityType, entityId, workflowKey) would NOT dedupe
-- two rows that both have workflowKey IS NULL, since Postgres treats every NULL
-- as distinct. Fixed via a COALESCE expression index instead of forcing
-- workflowKey non-null with ADMIN/SYSTEM sentinels (which would overload its
-- meaning elsewhere). This index cannot be declared in prisma/schema.prisma's
-- @@unique DSL (expression indexes aren't supported there) — it exists only here.
-- The service layer's createOrIncrementAlert must upsert via a raw query
-- targeting this index, not Prisma Client's typed .upsert().
CREATE UNIQUE INDEX IF NOT EXISTS "ContentOpsAlert_dedupe_key"
  ON "ContentOpsAlert" ("type", "entityType", "entityId", (COALESCE("workflowKey", '')));

CREATE INDEX IF NOT EXISTS "ContentOpsAlert_status_severity_idx" ON "ContentOpsAlert"("status", "severity");
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_entityType_entityId_idx" ON "ContentOpsAlert"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_workflowKey_lastSeenAt_idx" ON "ContentOpsAlert"("workflowKey", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_createdAt_idx" ON "ContentOpsAlert"("createdAt");

-- status (AutomationIncidentStatus.IGNORED) = human content-review decision.
-- notificationStatus (SUPPRESSED) = delivery-mechanics decision (cooldown).
-- These are independent axes; do not conflate.

-- Rollback:
-- DROP TABLE IF EXISTS "ContentOpsAlert";
-- DROP TYPE IF EXISTS "ContentOpsAlertNotificationStatus";
