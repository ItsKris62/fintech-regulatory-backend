-- SheriaBot Pack 1 (Editorial Intelligence) — Domain Contract §5.
-- Additive only. Apply manually, then run `prisma generate`.
-- Depends on BlogFreshnessReview (created in 20260727060000_blog_freshness_review) — apply after it.

DO $$ BEGIN CREATE TYPE "BlogRevisionPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogRevisionStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BlogRevisionRequest" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT NOT NULL,
  "freshnessReviewId" TEXT,
  -- Required, caller-supplied idempotency key (corrected — the original design
  -- derived this server-side with a 'manual' literal fallback for
  -- non-freshness-triggered calls, which silently collapsed every manual
  -- revision request for a post into one shared bucket). See
  -- phase-b-data-model.md §5 for the corrected caller-supplied-key contract.
  "idempotencyKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "priority" "BlogRevisionPriority" NOT NULL,
  "recommendedChanges" JSONB,
  "evidence" JSONB,
  "status" "BlogRevisionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "requestedById" TEXT,
  "assignedToId" TEXT,
  "approvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "BlogRevisionRequest_pkey" PRIMARY KEY ("id"),
  -- ON DELETE RESTRICT (corrected from CASCADE) — same audit-retention rationale
  -- as BlogFreshnessReview above.
  CONSTRAINT "BlogRevisionRequest_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlogRevisionRequest_freshnessReviewId_fkey" FOREIGN KEY ("freshnessReviewId") REFERENCES "BlogFreshnessReview"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogRevisionRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogRevisionRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogRevisionRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlogRevisionRequest_idempotencyKey_key" ON "BlogRevisionRequest"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_blogPostId_status_idx" ON "BlogRevisionRequest"("blogPostId", "status");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_freshnessReviewId_idx" ON "BlogRevisionRequest"("freshnessReviewId");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_status_priority_idx" ON "BlogRevisionRequest"("status", "priority");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_createdAt_idx" ON "BlogRevisionRequest"("createdAt");

-- Rollback:
-- DROP TABLE IF EXISTS "BlogRevisionRequest";
-- DROP TYPE IF EXISTS "BlogRevisionPriority";
-- DROP TYPE IF EXISTS "BlogRevisionStatus";
