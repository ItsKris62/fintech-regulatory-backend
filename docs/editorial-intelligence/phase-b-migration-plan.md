# SheriaBot Pack 1 — Phase B: Migration Plan

Status: proposal only. **No migration has been applied.** Per this project's
established convention (confirmed in every existing migration header comment,
e.g. `20260722_automation_approval/migration.sql:1-3`), these are additive raw SQL
files applied manually, followed by `prisma generate` — never `prisma migrate dev`
or `prisma migrate deploy`.

All SQL below follows conventions verified directly in
`20260726_phase0_content_marketing_agent_schema_reconciliation/migration.sql` and
`20260722_automation_approval/migration.sql`: `DO $$ BEGIN CREATE TYPE ...
EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for idempotent enum creation,
`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` /
`CREATE UNIQUE INDEX IF NOT EXISTS`, `<Table>_<column>_fkey` /
`<Table>_<column>_idx` / `<Table>_<column>_key` naming.

## Dependency order

```
1. regulatory_signal_source_item_fk        (needs: BlogSourceItem — exists)
2. content_ops_alert                        (needs: AutomationIncidentSeverity/Status enums — exist; User — exists)
3. blog_editorial_triage_run                (needs: BlogSourceItem, BlogArticleSuggestion, AgentRun, BlogSuggestionPriority, BlogArticleType — all exist)
4. blog_research_pack                       (needs: BlogPost, BlogArticleSuggestion, BlogSourceItem, BlogPostSource, User — all exist)
5. blog_verification_semantic_extension     (needs: BlogVerificationIssue — exists; extends its enum)
6. blog_freshness_review                    (needs: BlogPost, AgentRun; needs BlogEditorialTriageStatus enum from step 3)
7. blog_revision_request                    (needs: BlogPost, BlogFreshnessReview from step 6, User)
```

Each step is its own migration folder so a partial rollout (e.g., ship Foundation
A+C first, domain contracts later) is possible without forcing an all-or-nothing
apply. Steps 3-7 do depend on earlier steps in this list, so folder timestamps must
be sequential in this order.

---

## 1. `<TS>_regulatory_signal_source_item_fk`

See `phase-b-foundations.md` Foundation A for the full pre-migration orphan-check
queries — they are not repeated here; **do not skip them**, this is the one
migration in this pack with a real (if verified-low-probability) chance of
rejecting existing data.

```sql
-- Additive only. Apply manually, then run `prisma generate`.
-- Pre-migration: run the orphan-detection query from phase-b-foundations.md
-- Foundation A and null any orphaned sourceItemId values BEFORE this file.

DO $$ BEGIN
  ALTER TABLE "RegulatorySignal"
    ADD CONSTRAINT "RegulatorySignal_sourceItemId_fkey"
    FOREIGN KEY ("sourceItemId") REFERENCES "BlogSourceItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "RegulatorySignal_sourceItemId_idx" ON "RegulatorySignal"("sourceItemId");
```

Rollback:
```sql
ALTER TABLE "RegulatorySignal" DROP CONSTRAINT IF EXISTS "RegulatorySignal_sourceItemId_fkey";
DROP INDEX IF EXISTS "RegulatorySignal_sourceItemId_idx";
```

Post-migration verification: orphan query returns 0 rows; `prisma generate`
produces a `sourceItem` relation field on `RegulatorySignal`.

---

## 2. `<TS>_content_ops_alert`

```sql
-- Additive only. Apply manually, then run `prisma generate`.
-- Reuses existing AutomationIncidentSeverity/AutomationIncidentStatus enums
-- (created in 20260726_phase0...) rather than declaring new ones — see
-- phase-b-foundations.md Foundation C for the reuse rationale.

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
  CONSTRAINT "ContentOpsAlert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id"),
  CONSTRAINT "ContentOpsAlert_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id")
);

-- Corrected (was a plain @@unique-style index on ("type","entityType","entityId",
-- "workflowKey") — Postgres treats NULL as distinct from every other NULL, so two
-- admin-originated alerts (workflowKey IS NULL) of the same type/entity would
-- NOT have deduped against each other, silently defeating the whole point of
-- this constraint for every non-workflow alert. Fixed via a COALESCE expression
-- index instead of making workflowKey non-null with ADMIN/SYSTEM sentinels — see
-- phase-b-foundations.md Foundation C for the full rationale. This index is not
-- (and cannot be) declared as a Prisma @@unique in schema.prisma; it exists only
-- here. The service's createOrIncrementAlert must upsert via a raw query
-- targeting this expression index, not Prisma Client's typed .upsert().
CREATE UNIQUE INDEX IF NOT EXISTS "ContentOpsAlert_dedupe_key"
  ON "ContentOpsAlert" ("type", "entityType", "entityId", (COALESCE("workflowKey", '')));
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_status_severity_idx" ON "ContentOpsAlert"("status", "severity");
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_entityType_entityId_idx" ON "ContentOpsAlert"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_workflowKey_lastSeenAt_idx" ON "ContentOpsAlert"("workflowKey", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "ContentOpsAlert_createdAt_idx" ON "ContentOpsAlert"("createdAt");
```

**Corrected note**: `workflowKey` stays a true nullable column (`NULL` means "not
workflow-originated," directly queryable via `IS NULL`) — the dedupe correctness
comes entirely from the `COALESCE(..., '')` expression index above, not from
forcing non-null sentinel values. See `phase-b-foundations.md` Foundation C for
why the sentinel-value alternative was rejected, and for the explicit
`status: IGNORED` (human content decision) vs. `notificationStatus: SUPPRESSED`
(delivery-mechanics decision) distinction.

Rollback: `DROP TABLE IF EXISTS "ContentOpsAlert"; DROP TYPE IF EXISTS "ContentOpsAlertNotificationStatus";` — safe, brand-new table/type, no dependents yet at this point in the sequence. (The expression index is dropped along with the table.)

---

## 3. `<TS>_blog_editorial_triage_run`

```sql
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

CREATE UNIQUE INDEX IF NOT EXISTS "BlogEditorialTriageRun_sourceItemId_version_key" ON "BlogEditorialTriageRun"("sourceItemId", "version");
-- Corrected: added so a triage run versioned solely by suggestionId (no
-- sourceItemId — e.g. a RegulatorySignal-only candidate) also gets version-
-- collision protection. See phase-b-data-model.md §1 "authoritative versioning
-- target" for how the service decides which of the two indexes governs a given run.
CREATE UNIQUE INDEX IF NOT EXISTS "BlogEditorialTriageRun_suggestionId_version_key" ON "BlogEditorialTriageRun"("suggestionId", "version");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_suggestionId_idx" ON "BlogEditorialTriageRun"("suggestionId");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_recommendation_idx" ON "BlogEditorialTriageRun"("recommendation");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_status_idx" ON "BlogEditorialTriageRun"("status");
CREATE INDEX IF NOT EXISTS "BlogEditorialTriageRun_createdAt_idx" ON "BlogEditorialTriageRun"("createdAt");
```

Note (corrected): both `sourceItemId` and `suggestionId` are nullable, and
Postgres unique indexes ignore rows where any indexed column is `NULL` — so a
triage run created from `suggestionId` alone doesn't collide against the
`sourceItemId` index, and vice versa. Both unique indexes are needed (not just
one) precisely so that whichever identifier is actually present still gets
version-collision protection — see `phase-b-data-model.md` §1 for the
service-layer rule on which single index is authoritative for a given run.

Rollback: `DROP TABLE IF EXISTS "BlogEditorialTriageRun"; DROP TYPE IF EXISTS "BlogEditorialRecommendation"; DROP TYPE IF EXISTS "BlogEditorialTriageStatus";` — note `BlogEditorialTriageStatus` is reused by step 6 below, so this rollback is only safe if step 6 has not yet been applied (rollback steps must run in reverse dependency order).

---

## 4. `<TS>_blog_research_pack`

```sql
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
  "inputHash" TEXT NOT NULL,
  "sourceSetHash" TEXT NOT NULL,
  "reviewerStatus" TEXT DEFAULT 'PENDING',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogResearchPack_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BlogResearchPack_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogResearchPack_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "BlogArticleSuggestion"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogResearchPack_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlogResearchPack_blogPostId_version_key" ON "BlogResearchPack"("blogPostId", "version");
-- Corrected: added so a pack created pre-draft (blogPostId still null, per the
-- pipeline-order correction in phase-b-data-model.md §2) is also protected
-- against version collision, keyed on suggestionId instead.
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
```

**Two corrections applied to this step**: (1) the original single `contentHash`
column is replaced with separate `inputHash`/`sourceSetHash` columns — a URL-only
hash couldn't detect a source's content changing behind a stable URL or a
publication-date correction; see `phase-b-data-model.md` §2/§11 for the full
rationale. (2) `blogPostId`'s FK changed from `ON DELETE CASCADE` to `ON DELETE
SET NULL` — a research pack is an audit artifact independently valuable even if
its post is later hard-deleted (which, per the existing `adminDelete` soft-delete
convention, never actually happens today — see `phase-b-data-model.md` §2's
"Deletion behavior" note).

Rollback: `DROP TABLE IF EXISTS "BlogResearchPackSource"; DROP TABLE IF EXISTS "BlogResearchPack"; DROP TYPE IF EXISTS "BlogResearchPackStatus"; DROP TYPE IF EXISTS "BlogResearchSourceCategory";` (child table first).

---

## 5. `<TS>_blog_verification_semantic_extension`

```sql
DO $$ BEGIN CREATE TYPE "BlogClaimCategory" AS ENUM ('LEGAL_OBLIGATION', 'DEADLINE', 'PENALTY', 'REGULATOR_AUTHORITY', 'LICENSING_REQUIREMENT', 'REPORTING_REQUIREMENT', 'SECURITY_REQUIREMENT', 'DATA_PROTECTION_REQUIREMENT', 'NUMERICAL_CLAIM', 'FACTUAL_EVENT', 'INTERPRETATION', 'RECOMMENDATION', 'MARKETING_STATEMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogClaimVerificationStatus" AS ENUM ('VERIFIED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'STALE_SOURCE', 'HUMAN_REVIEW_REQUIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Additive enum value on the EXISTING BlogVerificationIssueType enum. Per Postgres
-- restriction, ALTER TYPE ... ADD VALUE cannot run inside the same transaction
-- block as other DDL touching that type in older Postgres versions (16+ relaxed
-- this, but this project's migrations already run each statement as its own
-- implicit transaction via the standard `prisma db execute`-style manual apply,
-- matching the precedent at 20260726.../migration.sql:15's
-- `ALTER TYPE "MarketingTemplateKey" ADD VALUE IF NOT EXISTS`).
ALTER TYPE "BlogVerificationIssueType" ADD VALUE IF NOT EXISTS 'SEMANTIC_CLAIM_ISSUE';

ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "claimCategory" "BlogClaimCategory";
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "claimVerificationStatus" "BlogClaimVerificationStatus";
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "confidence" INTEGER;
-- Corrected additions: claimHash correlates multiple issue rows (primary +
-- forced secondary-review) about the SAME claim; reviewProvenance is structured
-- JSON model/provider/pass metadata, replacing the original design's (rejected)
-- plan to cram this into the free-text `recommendation` column. See
-- phase-b-data-model.md §3 for the fixed reviewProvenance shape and the query/
-- audit requirements this unlocks.
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "claimHash" TEXT;
ALTER TABLE "BlogVerificationIssue" ADD COLUMN IF NOT EXISTS "reviewProvenance" JSONB;
CREATE INDEX IF NOT EXISTS "BlogVerificationIssue_claimHash_idx" ON "BlogVerificationIssue"("claimHash");

-- Corrected addition (req: "do not rely exclusively on updatedAt" for
-- replay/staleness decisions): nullable hash/version columns on the RUN itself,
-- not just the issue. Existing runs (pre-Pack-1, structural-only) get NULL for
-- all three and remain fully valid.
ALTER TABLE "BlogVerificationRun" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
ALTER TABLE "BlogVerificationRun" ADD COLUMN IF NOT EXISTS "sourceSetHash" TEXT;
ALTER TABLE "BlogVerificationRun" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;
```

All new columns on both tables are nullable — existing rows (structural/lexical
issues, pre-Pack-1 verification runs) get `NULL` throughout and remain fully
valid, matching the exact "nullable... existing rows get NULL... safe by
construction" pattern already used in
`20260723_automation_approval_idempotency_ttl/migration.sql`.

Rollback: `ALTER TABLE "BlogVerificationIssue" DROP COLUMN IF EXISTS "claimCategory", DROP COLUMN IF EXISTS "claimVerificationStatus", DROP COLUMN IF EXISTS "confidence", DROP COLUMN IF EXISTS "claimHash", DROP COLUMN IF EXISTS "reviewProvenance"; ALTER TABLE "BlogVerificationRun" DROP COLUMN IF EXISTS "contentHash", DROP COLUMN IF EXISTS "sourceSetHash", DROP COLUMN IF EXISTS "promptVersion"; DROP TYPE IF EXISTS "BlogClaimCategory"; DROP TYPE IF EXISTS "BlogClaimVerificationStatus";` — the added enum *value* (`SEMANTIC_CLAIM_ISSUE`) cannot be cleanly removed from `BlogVerificationIssueType` in Postgres without recreating the type; if a full rollback of this step is ever needed after rows using that value exist, it requires a manual data migration first (reassign those rows to `OTHER`), same caveat that would apply to any additive enum value in this codebase's existing convention (e.g. `KENYAN_COMPLIANCE_BRIEF`'s addition to `MarketingTemplateKey` carries the same one-way-door property).

---

## 6. `<TS>_blog_freshness_review`

```sql
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
  -- Corrected: ON DELETE RESTRICT, not CASCADE — freshness-review history is an
  -- audit trail that should block (not silently lose) a hard delete of its post.
  -- See phase-b-data-model.md §4 "Deletion behavior" for compatibility with the
  -- existing (soft-delete-only) adminDelete path.
  CONSTRAINT "BlogFreshnessReview_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlogFreshnessReview_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_blogPostId_createdAt_idx" ON "BlogFreshnessReview"("blogPostId", "createdAt");
CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_action_idx" ON "BlogFreshnessReview"("action");
CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_nextReviewAt_idx" ON "BlogFreshnessReview"("nextReviewAt");
CREATE INDEX IF NOT EXISTS "BlogFreshnessReview_status_idx" ON "BlogFreshnessReview"("status");
```

Depends on `BlogEditorialTriageStatus` from step 3 — must apply after it.

Rollback: `DROP TABLE IF EXISTS "BlogFreshnessReview"; DROP TYPE IF EXISTS "BlogFreshnessRiskTier"; DROP TYPE IF EXISTS "BlogFreshnessAction";` — does not drop `BlogEditorialTriageStatus` (owned by step 3).

---

## 7. `<TS>_blog_revision_request`

```sql
DO $$ BEGIN CREATE TYPE "BlogRevisionPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BlogRevisionStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BlogRevisionRequest" (
  "id" TEXT NOT NULL,
  "blogPostId" TEXT NOT NULL,
  "freshnessReviewId" TEXT,
  -- Corrected addition: required, caller-supplied idempotency key. The original
  -- design derived this server-side with a 'manual' literal fallback for
  -- non-freshness-triggered calls, which silently collapsed every manual
  -- revision request for a post into one shared bucket. See
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
  -- Corrected: ON DELETE RESTRICT, not CASCADE — same audit-retention rationale
  -- as BlogFreshnessReview above.
  CONSTRAINT "BlogRevisionRequest_blogPostId_fkey" FOREIGN KEY ("blogPostId") REFERENCES "BlogPost"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlogRevisionRequest_freshnessReviewId_fkey" FOREIGN KEY ("freshnessReviewId") REFERENCES "BlogFreshnessReview"("id") ON DELETE SET NULL,
  CONSTRAINT "BlogRevisionRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id"),
  CONSTRAINT "BlogRevisionRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id"),
  CONSTRAINT "BlogRevisionRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlogRevisionRequest_idempotencyKey_key" ON "BlogRevisionRequest"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_blogPostId_status_idx" ON "BlogRevisionRequest"("blogPostId", "status");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_freshnessReviewId_idx" ON "BlogRevisionRequest"("freshnessReviewId");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_status_priority_idx" ON "BlogRevisionRequest"("status", "priority");
CREATE INDEX IF NOT EXISTS "BlogRevisionRequest_createdAt_idx" ON "BlogRevisionRequest"("createdAt");
```

Depends on `BlogFreshnessReview` from step 6 — must apply after it.

Rollback: `DROP TABLE IF EXISTS "BlogRevisionRequest"; DROP TYPE IF EXISTS "BlogRevisionPriority"; DROP TYPE IF EXISTS "BlogRevisionStatus";`

---

## Cross-cutting pre/post checklist (every step)

1. **Row-count snapshot** of every table being altered (not just created), taken
   immediately before applying — for this pack, only step 1 (`RegulatorySignal`)
   and step 5 (`BlogVerificationIssue`) alter existing tables; steps 2-4 and 6-7
   create wholly new tables with no existing rows to snapshot.
2. **SQL safety review**: every statement above uses `IF NOT EXISTS` /
   `duplicate_object`-guarded `DO` blocks, matching the project's idempotent-replay
   convention — re-running any file against a database where it already applied
   is a no-op, not an error.
3. **Rollback plan**: given per-step above; steps must be rolled back in reverse
   dependency order (7, 6, 5, 4, 3, 2, 1) if a full pack rollback is ever needed.
4. **Post-migration verifier**: after all seven steps, run `prisma generate` once
   and confirm the generated client exposes every new model/enum/field listed in
   `phase-b-data-model.md`; run the full existing test suite
   (`blog-staleness.test.ts`, `content.service.test.ts`, `blog-draft.service.test.ts`,
   `approval.service.test.ts`, `automation.router-wiring.test.ts`) unchanged and
   confirm zero regressions — none of these seven migrations modify any column or
   constraint those tests depend on.
