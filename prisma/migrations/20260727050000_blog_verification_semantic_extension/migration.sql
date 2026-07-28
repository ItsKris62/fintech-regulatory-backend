-- SheriaBot Pack 1 (Editorial Intelligence) — Domain Contract §3.
-- Additive only. Apply manually, then run `prisma generate`.

DO $$ BEGIN CREATE TYPE "BlogClaimCategory" AS ENUM ('LEGAL_OBLIGATION', 'DEADLINE', 'PENALTY', 'REGULATOR_AUTHORITY', 'LICENSING_REQUIREMENT', 'REPORTING_REQUIREMENT', 'SECURITY_REQUIREMENT', 'DATA_PROTECTION_REQUIREMENT', 'NUMERICAL_CLAIM', 'FACTUAL_EVENT', 'INTERPRETATION', 'RECOMMENDATION', 'MARKETING_STATEMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogClaimVerificationStatus" AS ENUM ('VERIFIED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'STALE_SOURCE', 'HUMAN_REVIEW_REQUIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Additive enum value on the EXISTING BlogVerificationIssueType enum.
ALTER TYPE "BlogVerificationIssueType" ADD VALUE IF NOT EXISTS 'SEMANTIC_CLAIM_ISSUE';

ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "claimCategory" "BlogClaimCategory";
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "claimVerificationStatus" "BlogClaimVerificationStatus";
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "confidence" INTEGER;
-- claimHash correlates multiple issue rows (primary pass + forced secondary-
-- review) about the SAME claim; reviewProvenance is structured JSON
-- model/provider/pass metadata (corrected — the original design considered
-- cramming this into the free-text `recommendation` column, which is not
-- queryable). See phase-b-data-model.md §3 for the fixed reviewProvenance shape.
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "claimHash" TEXT;
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "reviewProvenance" JSONB;
CREATE INDEX IF NOT EXISTS "BlogVerificationIssue_claimHash_idx" ON "BlogVerificationIssue"("claimHash");

-- Nullable hash/version columns on the RUN itself so replay/staleness decisions
-- don't rely exclusively on BlogPost.updatedAt. Existing runs (pre-Pack-1,
-- structural-only) get NULL for all three and remain fully valid.
ALTER TABLE "BlogVerificationRun" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
ALTER TABLE "BlogVerificationRun" ADD COLUMN IF NOT EXISTS "sourceSetHash" TEXT;
ALTER TABLE "BlogVerificationRun" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;

-- All new columns on both tables are nullable — existing rows remain fully valid.

-- Rollback (note: the added enum VALUE 'SEMANTIC_CLAIM_ISSUE' cannot be cleanly
-- removed from BlogVerificationIssueType without recreating the type once rows
-- use it — reassign those rows to 'OTHER' first if a full rollback is needed):
-- ALTER TABLE "BlogVerificationIssue" DROP COLUMN IF EXISTS "claimCategory", DROP COLUMN IF EXISTS "claimVerificationStatus", DROP COLUMN IF EXISTS "confidence", DROP COLUMN IF EXISTS "claimHash", DROP COLUMN IF EXISTS "reviewProvenance";
-- ALTER TABLE "BlogVerificationRun" DROP COLUMN IF EXISTS "contentHash", DROP COLUMN IF EXISTS "sourceSetHash", DROP COLUMN IF EXISTS "promptVersion";
-- DROP TYPE IF EXISTS "BlogClaimCategory";
-- DROP TYPE IF EXISTS "BlogClaimVerificationStatus";
