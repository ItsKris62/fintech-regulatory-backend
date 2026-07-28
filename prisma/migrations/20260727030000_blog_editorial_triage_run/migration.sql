-- SheriaBot Pack 1 (Editorial Intelligence) — Domain Contract §1.
-- Additive only. Apply manually, then run `prisma generate`.

DO $$ BEGIN CREATE TYPE "BlogEditorialRecommendation" AS ENUM ('PRIORITISE_NOW', 'QUEUE', 'MONITOR', 'REJECT', 'HUMAN_REVIEW_REQUIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogEditorialTriageStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BlogEditorialTriageRun" (
  "id" TEXT NOT NULL,
  "sourceItemId" TEXT,
  "suggestionId" TEXT,
  "agentRunId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deterministicScore" INTEGER NOT NULL,
  "aiRelevanceScore" INTEGER,
  "finalScore" INTEGER NOT NULL,
  "recommendation" "BlogEditorialRecommendation" NOT NULL,
  "urgency" "BlogSuggestionPriority" NOT NULL,
  "targetAudiences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recommendedArticleType" "BlogArticleType",
  "recommendedChannels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rationale" TEXT NOT NULL,
  "sourceConfidence" INTEGER NOT NULL,
  "requiresHumanReview" BOOLEAN NOT NULL DEFAULT true,
  "modelProvider" TEXT,
  "modelName" TEXT,
  "promptVersion" TEXT NOT NULL DEFAULT 'editorial-triage-v1',
  "inputHash" TEXT NOT NULL,
  "status" "BlogEditorialTriageStatus" NOT NULL DEFAULT 'PENDING',
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "BlogEditorialTriageRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BlogEditorialTriageRun_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "BlogSourceItem"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogEditorialTriageRun_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "BlogArticleSuggestion"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogEditorialTriageRun_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL
);

-- Both unique indexes are needed: sourceItemId and suggestionId are both
-- nullable, and Postgres unique indexes ignore NULL, so a run keyed by one
-- alone would not be protected by an index on the other. The SERVICE (not the
-- schema) decides which single index is authoritative for a given run —
-- sourceItemId when present, else suggestionId. See phase-b-data-model.md §1.
CREATE UNIQUE INDEX IF NOT EXISTS "BlogEditorialTriageRun_sourceItemId_version_key" ON "BlogEditorialTriageRun"("sourceItemId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "BlogEditorialTriageRun_suggestionId_version_key" ON "BlogEditorialTriageRun"("suggestionId", "version");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_suggestionId_idx" ON "BlogEditorialTriageRun"("suggestionId");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_recommendation_idx" ON "BlogEditorialTriageRun"("recommendation");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_status_idx" ON "BlogEditorialTriageRun"("status");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_createdAt_idx" ON "BlogEditorialTriageRun"("createdAt");

-- Rollback (only safe if step blog_freshness_review has not yet been applied —
-- BlogEditorialTriageStatus is reused there):
-- DROP TABLE IF EXISTS "BlogEditorialTriageRun";
-- DROP TYPE IF EXISTS "BlogEditorialRecommendation";
-- DROP TYPE IF EXISTS "BlogEditorialTriageStatus";
