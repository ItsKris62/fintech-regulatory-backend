-- SheriaBot Blog Phase 1.
-- Additive only. Do not apply to production until the Phase 0 production
-- read-only audit has passed and W-CONTENT-02 is confirmed against production.

DO $$ BEGIN CREATE TYPE "BlogPostFeedbackValue" AS ENUM ('HELPFUL', 'NOT_HELPFUL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogTopicRequestStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'ACCEPTED', 'DISMISSED', 'SPAM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BlogPostFeedback" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT NOT NULL,
  "value" "BlogPostFeedbackValue" NOT NULL,
  "reasonCode" TEXT,
  "anonymousKeyHash" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogPostFeedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BlogPostFeedback_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE CASCADE,
  CONSTRAINT "BlogPostFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlogPostFeedback_blogPostId_userId_key" ON "BlogPostFeedback"("blogPostId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "BlogPostFeedback_blogPostId_anonymousKeyHash_key" ON "BlogPostFeedback"("blogPostId", "anonymousKeyHash");
CREATE INDEX IF NOT EXISTS "BlogPostFeedback_blogPostId_value_idx" ON "BlogPostFeedback"("blogPostId", "value");
CREATE INDEX IF NOT EXISTS "BlogPostFeedback_createdAt_idx" ON "BlogPostFeedback"("createdAt");

CREATE TABLE IF NOT EXISTS "BlogTopicRequest" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "category" TEXT,
  "jurisdiction" TEXT,
  "sourcePage" TEXT,
  "contactEmail" TEXT,
  "anonymousKeyHash" TEXT,
  "status" "BlogTopicRequestStatus" NOT NULL DEFAULT 'PENDING',
  "spamTrap" TEXT,
  "adminNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "relatedPostId" TEXT,
  CONSTRAINT "BlogTopicRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BlogTopicRequest_relatedPostId_fkey" FOREIGN KEY ("relatedPostId") REFERENCES "BlogPost"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "BlogTopicRequest_status_idx" ON "BlogTopicRequest"("status");
CREATE INDEX IF NOT EXISTS "BlogTopicRequest_category_idx" ON "BlogTopicRequest"("category");
CREATE INDEX IF NOT EXISTS "BlogTopicRequest_jurisdiction_idx" ON "BlogTopicRequest"("jurisdiction");
CREATE INDEX IF NOT EXISTS "BlogTopicRequest_createdAt_idx" ON "BlogTopicRequest"("createdAt");
CREATE INDEX IF NOT EXISTS "BlogTopicRequest_anonymousKeyHash_createdAt_idx" ON "BlogTopicRequest"("anonymousKeyHash", "createdAt");

-- Rollback:
-- DROP TABLE IF EXISTS "BlogTopicRequest";
-- DROP TABLE IF EXISTS "BlogPostFeedback";
-- DROP TYPE IF EXISTS "BlogTopicRequestStatus";
-- DROP TYPE IF EXISTS "BlogPostFeedbackValue";
