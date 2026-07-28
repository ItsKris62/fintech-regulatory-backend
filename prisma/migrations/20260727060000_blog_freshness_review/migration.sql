-- SheriaBot Pack 1 (Editorial Intelligence) — Domain Contract §4.
-- Additive only. Apply manually, then run `prisma generate`.
-- Depends on BlogEditorialTriageStatus (created in 20260727030000_blog_editorial_triage_run) — apply after it.

DO $$ BEGIN CREATE TYPE "BlogFreshnessRiskTier" AS ENUM ('HIGH_RISK', 'NORMAL', 'EVERGREEN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogFreshnessAction" AS ENUM ('FRESH', 'REVIEW_SOON', 'REVISION_REQUIRED', 'URGENT_REVISION', 'ARCHIVE_RECOMMENDED', 'HUMAN_REVIEW_REQUIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BlogFreshnessReview" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT NOT NULL,
  "agentRunId" TEXT,
  "triggeredBy" TEXT NOT NULL DEFAULT 'SCHEDULE',
  "contentHash" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "riskTier" "BlogFreshnessRiskTier" NOT NULL,
  "freshnessScore" INTEGER NOT NULL,
  "action" "BlogFreshnessAction" NOT NULL,
  "rationale" TEXT NOT NULL,
  "changedSourceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "newSignalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "brokenSourceCount" INTEGER NOT NULL DEFAULT 0,
  "staleSourceCount" INTEGER NOT NULL DEFAULT 0,
  "nextReviewAt" TIMESTAMP(3),
  "modelProvider" TEXT,
  "modelName" TEXT,
  "promptVersion" TEXT NOT NULL DEFAULT 'freshness-review-v1',
  "status" "BlogEditorialTriageStatus" NOT NULL DEFAULT 'PENDING',
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "BlogFreshnessReview_pkey" PRIMARY KEY ("id"),
  -- ON DELETE RESTRICT (corrected from CASCADE): freshness-review history is an
  -- audit trail that should block (not silently lose) a hard delete of its post.
  -- Compatible with the existing (soft-delete-only) adminDelete path — see
  -- phase-b-data-model.md §4 "Deletion behavior".
  CONSTRAINT "BlogFreshnessReview_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlogFreshnessReview_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_blogPostId_createdAt_idx" ON "BlogFreshnessReview"("blogPostId", "createdAt");
CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_action_idx" ON "BlogFreshnessReview"("action");
CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_nextReviewAt_idx" ON "BlogFreshnessReview"("nextReviewAt");
CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_status_idx" ON "BlogFreshnessReview"("status");

-- Rollback (does not drop BlogEditorialTriageStatus, owned by an earlier step):
-- DROP TABLE IF EXISTS "BlogFreshnessReview";
-- DROP TYPE IF EXISTS "BlogFreshnessRiskTier";
-- DROP TYPE IF EXISTS "BlogFreshnessAction";
