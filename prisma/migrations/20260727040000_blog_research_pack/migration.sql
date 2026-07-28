-- SheriaBot Pack 1 (Editorial Intelligence) — Domain Contract §2.
-- Additive only. Apply manually, then run `prisma generate`.

DO $$ BEGIN CREATE TYPE "BlogResearchPackStatus" AS ENUM ('DRAFT', 'COMPLETE', 'SUPERSEDED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogResearchSourceCategory" AS ENUM ('OFFICIAL_REGULATOR', 'LEGISLATION', 'OFFICIAL_GUIDANCE', 'APPROVED_CORPUS', 'REPUTABLE_NEWS', 'INDUSTRY_SOURCE', 'COMPANY_SOURCE', 'USER_GENERATED', 'UNVERIFIED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BlogResearchPack" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT,
  "suggestionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "BlogResearchPackStatus" NOT NULL DEFAULT 'DRAFT',
  "researchObjective" TEXT NOT NULL,
  "executiveSummary" TEXT,
  "importantDates" JSONB,
  "authorities" JSONB,
  "obligationsSummary" JSONB,
  "evidenceGaps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "contradictions" JSONB DEFAULT '[]',
  "confidence" INTEGER NOT NULL,
  "modelProvider" TEXT,
  "modelName" TEXT,
  "promptVersion" TEXT NOT NULL DEFAULT 'research-pack-v1',
  -- Split hash (corrected from a single URL-only contentHash) — a URL-only hash
  -- can't detect a source's content changing behind a stable URL, or a
  -- publication-date correction. See phase-b-data-model.md §2/§11.
  "inputHash" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "reviewerStatus" TEXT DEFAULT 'PENDING',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogResearchPack_pkey" PRIMARY KEY ("id"),
  -- ON DELETE SET NULL (corrected from CASCADE): a research pack is an audit
  -- artifact independently valuable even if its post is later hard-deleted.
  -- See phase-b-data-model.md §2 "Deletion behavior".
  CONSTRAINT "BlogResearchPack_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogResearchPack_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "BlogArticleSuggestion"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogResearchPack_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlogResearchPack_blogPostId_version_key" ON "BlogResearchPack"("blogPostId", "version");
-- Added so a pack created pre-draft (blogPostId still null, per the pipeline
-- order: triage -> research -> draft creation -> verification) is also
-- protected against version collision, keyed on suggestionId instead.
CREATE UNIQUE INDEX IF NOT EXISTS "BlogResearchPack_suggestionId_version_key" ON "BlogResearchPack"("suggestionId", "version");
CREATE INDEX IF NOT EXISTS "BlogResearchPack_suggestionId_idx" ON "BlogResearchPack"("suggestionId");
CREATE INDEX IF NOT EXISTS "BlogResearchPack_status_idx" ON "BlogResearchPack"("status");
CREATE INDEX IF NOT EXISTS "BlogResearchPack_createdAt_idx" ON "BlogResearchPack"("createdAt");

CREATE TABLE IF NOT EXISTS "BlogResearchPackSource" (
  "id" TEXT NOT NULL,
  "researchPackId" TEXT NOT NULL,
  "sourceItemId" TEXT,
  "postSourceId" TEXT,
  "externalUrl" TEXT,
  "title" TEXT NOT NULL,
  "publisher" TEXT,
  "authority" TEXT,
  "jurisdiction" TEXT,
  "category" "BlogResearchSourceCategory" NOT NULL,
  "publicationDate" TIMESTAMP(3),
  "retrievalDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "trustLevel" INTEGER NOT NULL,
  "contentHash" TEXT,
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "isContradictory" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogResearchPackSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BlogResearchPackSource_researchPackId_fkey" FOREIGN KEY ("researchPackId") REFERENCES "BlogResearchPack"("id") ON DELETE CASCADE,
  CONSTRAINT "BlogResearchPackSource_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "BlogSourceItem"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogResearchPackSource_postSourceId_fkey" FOREIGN KEY ("postSourceId") REFERENCES "BlogPostSource"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "BlogResearchPackSource_researchPackId_idx" ON "BlogResearchPackSource"("researchPackId");
CREATE INDEX IF NOT EXISTS "BlogResearchPackSource_sourceItemId_idx" ON "BlogResearchPackSource"("sourceItemId");
CREATE INDEX IF NOT EXISTS "BlogResearchPackSource_category_idx" ON "BlogResearchPackSource"("category");

-- Rollback (child table first):
-- DROP TABLE IF EXISTS "BlogResearchPackSource";
-- DROP TABLE IF EXISTS "BlogResearchPack";
-- DROP TYPE IF EXISTS "BlogResearchPackStatus";
-- DROP TYPE IF EXISTS "BlogResearchSourceCategory";
