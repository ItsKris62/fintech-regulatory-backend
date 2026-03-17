-- ============================================================================
-- Migration: Add UsagePeriod table
-- Purpose:   Durable per-org monthly usage snapshots with snapshotted plan
--            limits. Used for historical comparison on the usage dashboard.
--            Redis counters remain the real-time enforcement source of truth;
--            this table is synced lazily on dashboard reads.
--
-- Run with:  psql $DATABASE_URL -f prisma/migrations/add_usage_period.sql
-- ============================================================================

-- CreateTable
CREATE TABLE "UsagePeriod" (
    "id"                      TEXT NOT NULL,
    "organizationId"          TEXT NOT NULL,

    -- Period boundaries (UTC equivalents of EAT calendar-month boundaries)
    "periodStart"             TIMESTAMP(3) NOT NULL,
    "periodEnd"               TIMESTAMP(3) NOT NULL,

    -- Usage counters (synced lazily from Redis)
    "complianceQueries"       INTEGER NOT NULL DEFAULT 0,
    "checklistGenerations"    INTEGER NOT NULL DEFAULT 0,
    "apiCalls"                INTEGER NOT NULL DEFAULT 0,
    "documentStorageMb"       DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gapAnalyses"             INTEGER NOT NULL DEFAULT 0,
    "policyGenerations"       INTEGER NOT NULL DEFAULT 0,

    -- Plan snapshot at period creation
    -- Convention: -1 = unlimited, 0 = unavailable, n = monthly cap
    "planTier"                TEXT NOT NULL,
    "complianceQueryLimit"    INTEGER NOT NULL,
    "checklistGenerationLimit" INTEGER NOT NULL,
    "apiCallLimit"            INTEGER NOT NULL,
    "documentStorageMbLimit"  DOUBLE PRECISION NOT NULL,
    "gapAnalysisLimit"        INTEGER NOT NULL,
    "policyGenerationLimit"   INTEGER NOT NULL,

    -- Audit
    "syncedFromRedisAt"       TIMESTAMP(3),
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsagePeriod_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one period record per org per month
CREATE UNIQUE INDEX "UsagePeriod_organizationId_periodStart_key"
    ON "UsagePeriod"("organizationId", "periodStart");

-- Indexes for dashboard and history queries
CREATE INDEX "UsagePeriod_organizationId_periodStart_idx"
    ON "UsagePeriod"("organizationId", "periodStart");

CREATE INDEX "UsagePeriod_periodStart_periodEnd_idx"
    ON "UsagePeriod"("periodStart", "periodEnd");

-- Foreign key: cascades delete so orphan rows never accumulate
ALTER TABLE "UsagePeriod"
    ADD CONSTRAINT "UsagePeriod_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- ============================================================================
-- Trigger to auto-update updatedAt on row modification
-- (Prisma normally handles this in application code; included here for
--  correctness if rows are ever patched directly via SQL.)
-- ============================================================================
CREATE OR REPLACE FUNCTION update_usage_period_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usage_period_updated_at_trigger
    BEFORE UPDATE ON "UsagePeriod"
    FOR EACH ROW
    EXECUTE FUNCTION update_usage_period_updated_at();
