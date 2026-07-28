# SheriaBot Pack 1 — Phase C: Schema Verification Report

Status: Stage C1 complete. No migration has been applied to any database —
`prisma validate`/`prisma generate` run only against the local schema, per the
governing guardrails.

## What was validated

| Check | Command | Result |
|---|---|---|
| Schema syntax/relations | `pnpm exec prisma validate` | **PASS** — `The schema at prisma\schema.prisma is valid` |
| Client generation | `pnpm exec prisma generate` | **PASS** — Prisma Client (v7.4.0) generated in 15.75s with zero errors |
| Schema-verifier unit tests | `pnpm exec vitest run src/utils/schema-verifier.test.ts` | **PASS** — 26/26 |
| Backend typecheck | `pnpm run typecheck` | **PASS** for all Pack 1 files; 9 pre-existing unrelated errors remain (see below) |
| Backend lint | `pnpm run lint` | **PASS** — 0 errors, 7 pre-existing unrelated warnings |

No live database connection was made by any of the above — `prisma validate`/
`generate` operate purely on the local `.prisma` file and do not require
`DATABASE_URL` connectivity for a schema-only check.

## Schema-verifier extension

`src/utils/schema-verifier.ts` gained a new exported inventory,
`PACK1_EDITORIAL_INTELLIGENCE_INVENTORY`, additive to the existing
`COMPLETE_PHASE0_INVENTORY` (left untouched). A new merged export,
`ALL_EXPECTED_SCHEMA_INVENTORY`, is what `verifyCompleteSchema()`'s four
verification loops (tables/columns, enums/values, indexes, foreign keys) now
iterate — this is a **live** `pre`/`post` migration gate, runnable via
`pnpm tsx src/scripts/verify-schema.ts --mode=pre|post` against a real target
database once the migrations are actually applied (not run in this phase).

### Coverage added

- 11 new enums (`ContentOpsAlertNotificationStatus`, `BlogEditorialRecommendation`,
  `BlogEditorialTriageStatus`, `BlogResearchPackStatus`,
  `BlogResearchSourceCategory`, `BlogClaimCategory`,
  `BlogClaimVerificationStatus`, `BlogFreshnessRiskTier`, `BlogFreshnessAction`,
  `BlogRevisionPriority`, `BlogRevisionStatus`) plus the additive
  `BlogVerificationIssueType.SEMANTIC_CLAIM_ISSUE` value on the pre-existing enum.
- 6 new tables (`ContentOpsAlert`, `BlogEditorialTriageRun`, `BlogResearchPack`,
  `BlogResearchPackSource`, `BlogFreshnessReview`, `BlogRevisionRequest`) plus
  additive-column checks on the 2 pre-existing tables extended
  (`BlogVerificationRun`, `BlogVerificationIssue`).
- 28 new indexes (unique + non-unique).
- 19 new foreign keys.

### Known gap: `ContentOpsAlert`'s dedupe expression index is not automatically checked

`ContentOpsAlert_dedupe_key` — the raw SQL `COALESCE("workflowKey", '')`
expression unique index required by Foundation C's corrected dedupe design
(see `phase-b-foundations.md`) — is **deliberately not** listed in
`PACK1_EDITORIAL_INTELLIGENCE_INVENTORY.indexes`. The generic verifier's
index-column parser extracts columns via a single-paren-group regex
(`/\(([^)]+)\)/`) against `pg_indexes.indexdef`; an expression index containing
its own nested parentheses (`(COALESCE("workflowKey", ''))`) breaks that
extraction and would produce a false `CONFLICT`, not a genuine finding. Until a
dedicated expression-index-aware check is added to the verifier engine, this
one index must be confirmed manually post-migration, e.g.:

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'ContentOpsAlert_dedupe_key';
```//expected: ... USING btree (type, "entityType", "entityId", (COALESCE("workflowKey", ''::text)))

This is documented inline in both the migration file
(`prisma/migrations/20260727020000_content_ops_alert/migration.sql`) and the
schema-verifier source itself.

## Pre-existing, unrelated typecheck errors (not touched by this session)

`pnpm run typecheck` reports 9 errors, all in files with zero `git status`
changes relative to `HEAD` — confirmed unrelated to Pack 1:

- `src/routes/automation-incident.route.test.ts` (2 errors)
- `src/scripts/verify-backend-incidents.ts` (5 errors)
- `src/utils/sanitizer.ts` (2 errors)

## Rollback

Each of the 7 migration files carries its own commented rollback SQL. Full
pack rollback order (reverse of apply order): `blog_revision_request` →
`blog_freshness_review` → `blog_verification_semantic_extension` →
`blog_research_pack` → `blog_editorial_triage_run` → `content_ops_alert` →
`regulatory_signal_source_item_fk`.
