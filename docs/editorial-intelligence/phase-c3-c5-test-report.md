# SheriaBot Pack 1 — Phase C Stages C3–C5: Test Report

This report lists every test added or touched for Stages C3–C5, the exact
validation commands run, their results, and the honest reconciliation of the
full-suite failures against the pre-existing baseline. No test listed here
was modified to force a pass; the 3 failures in the last section were
diagnosed as pre-existing and left untouched, per instruction.

## Stage C3 — `requiresHumanReview` policy and rollout

### `src/modules/blog-automation/human-review-policy.test.ts` — 14/14 PASS

1. returns required: false with no reasons for a fully safe candidate
2. flags MISSING_REQUIRED_OFFICIAL_SOURCE when the category requires one and none exists
3. does not flag a missing official source when the category does not require one
4. flags INSUFFICIENT_SOURCE_QUALITY for a HIGH/URGENT suggestion with low source quality
5. does not flag source quality for a LOW/MEDIUM priority suggestion regardless of quality
6. flags UNSUPPORTED_JURISDICTION for a jurisdiction outside the supported set
7. flags UNRESOLVED_EVIDENCE_GAPS only when research evidence is provided and non-empty
8. flags CONTRADICTORY_SOURCES when research reports contradictions
9. flags VERIFICATION_NEEDS_REVIEW_OR_BLOCKED for NEEDS_REVIEW or BLOCKED status
10. flags SEMANTIC_CLAIM_NOT_VERIFIED when verification reports an unverified semantic claim
11. flags LOW_STRUCTURED_AI_CONFIDENCE only when a confidence value is actually provided and below threshold
12. never evaluates research/verification reasons when that evidence is absent (no fake defaults)
13. evaluates purely from creation-time evidence with no research/verification data
14. derives categoryRequiresOfficialSource from the Regulatory Updates / Enforcement & Penalties rule

### `src/modules/blog-automation/suggestion-builder.test.ts` — 3/3 PASS (added in this remediation pass to close a disclosed gap)

1. omits requiresHumanReview from the create payload when the policy flag is disabled (default) — preserves the existing Prisma column default
2. persists an explicit computed requiresHumanReview value when the policy flag is enabled
3. persists an explicit false when the policy flag is enabled and no reason requires review

### `src/scripts/backfill-editorial-human-review.test.ts` — 6/6 PASS

1. dry-run (default) makes no writes even when computed values differ
2. dry-run reports current/computed true and false counts and rows that would change
3. write mode only updates rows whose computed result differs from what is stored
4. reports failures without silently skipping them
5. groups reasons by count across all evaluated rows
6. paginates across multiple batches (a full-size batch triggers a second fetch)

Environment-safety refusal (`validateEnvironmentSafety` gating `--write`
against a production-shaped database unless `--allow-production` is passed)
is covered indirectly via the reused, already-tested `schema-verifier.ts`
function rather than re-tested inline in this script's suite.

### `src/modules/agents/automation/blog-draft.service.test.ts` — 3 new tests (25/25 total in file)

1. preserves current auto-promotion behavior when enforcement is disabled, even for a requiresHumanReview=true suggestion
2. returns human_review_required, never promotes, and never creates a draft when enforcement is enabled for a requiresHumanReview=true suggestion
3. still promotes and creates a draft when enforcement is enabled but the suggestion does not require human review

## Stage C4 — Persisted `ContentOpsAlert`

### `src/modules/agents/automation/content-ops-alert-sanitizer.test.ts` — 8/8 PASS

1. strips HTML tags
2. caps length
3. passes through ids, counts, scores, enum values, and booleans unchanged
4. drops forbidden keys by name regardless of value shape
5. drops arrays and nested objects (only flat scalars allowed)
6. strips HTML and truncates long string values
7. returns an empty object for undefined/null input
8. falls back to a minimal marker when the sanitized object is still oversized

### `src/modules/agents/automation/content-ops-alert.service.test.ts` — 18/18 total in file (14 new for Stage C4, 4 pre-existing `sendAlert` tests left unchanged as a thin-wrapper regression check)

New (`createOrIncrementAlert` and related methods):

1. persists a first-occurrence HIGH-severity alert and sends a notification (cooldown never elapsed before)
2. the atomic upsert targets the (type, entityType, entityId, COALESCE(workflowKey, '')) expression index
3. increments occurrenceCount and updates lastSeenAt while preserving firstSeenAt on a duplicate occurrence
4. does not attempt notification for a non-HIGH/CRITICAL severity — notificationStatus stays NOT_REQUIRED
5. suppresses (does not email) a HIGH/CRITICAL alert re-occurring inside the cooldown window
6. notifies again once the cooldown has elapsed
7. SUPPRESSED notification status does not imply IGNORED alert status — they are independent axes
8. persists the alert even when the notification email fails
9. sanitizes metadata before persisting — forbidden keys never reach the query
10. acknowledgeAlert sets status/acknowledgedById/acknowledgedAt, derived from a server-side actor id
11. resolveAlert sets status/resolvedById/resolvedAt and sanitizes an optional resolutionNote
12. resolveAlert omits resolutionNote from the update entirely when not provided (does not clear an existing note)
13. listOpenAlerts filters to OPEN/ACKNOWLEDGED by default and supports severity/type/entityType filters
14. getAlert reads a single alert by id

Pre-existing (`sendAlert`, unchanged, still passing against the rewritten
service to confirm the thin-wrapper preserved its behavior): sends via
sendEmail to the fixed admin address with content_ops_alert tags; always
uses the fixed config recipient regardless of input; never throws when
sendEmail fails; omits the details list and link when not provided.

Existing call-site migration verified via `blog-draft.service.test.ts`'s
existing alert-related assertions, updated to assert against
`createOrIncrementAlert` instead of `sendAlert` (all passing, no reduction in
assertion strength).

## Stage C5 — Shared publish-readiness evaluator and burn-in integration

### `src/server/utils/publish-readiness.test.ts` — 25/25 PASS

`evaluateBlogPublishReadiness`:

1. returns ready: true with no blockers/warnings for a fully valid post
2. never mutates the post — only findUnique/findMany are called, never update
3–6. blocks when {title, slug, excerpt, category} is missing (`it.each`, 4 cases)
7. blocks when content is empty or missing (both admin and agent paths use this evaluator)
8. blocks when there are no sources
9. blocks Regulatory Updates / Enforcement & Penalties without an OFFICIAL source
10. accepts Regulatory Updates with an OFFICIAL source
11. accepts International Standards with an INTERNATIONAL_STANDARD source (not just OFFICIAL)
12. blocks when the latest verification run is BLOCKED
13. blocks when the linked suggestion requires human review and is not approved
14. does not block when the linked suggestion requires human review but has been approved
15. blocks on an OPEN ContentOpsAlert explicitly marked metadata.blocksPublication=true for this BlogPost
16. does NOT block on an open alert of any severity that is not explicitly marked blocksPublication=true
17. warns (does not block) when the post or a source was updated after the latest verification
18. blocks when an APPLIED AI draft postdates the latest verification
19. does NOT block or flag AI-staleness for an unapplied draft run, even if it postdates verification
20. returns POST_NOT_FOUND for a missing or soft-deleted post

`runPublishReadinessShadowCheck`:

21. does nothing (mode: off) and never evaluates
22. shadow mode never blocks even when the evaluator disagrees with the legacy outcome (default mode)
23. logs a divergence with only the BlogPost ID and finding codes, never content
24. enforce mode is implemented (shouldBlock becomes true) but is never the default
25. never throws even if the underlying evaluator fails

### `src/modules/agents/automation/content.service.test.ts` — 2 new tests (13/13 total in file)

1. shadow mode (default): a legacy-accepted publish still succeeds even if the new evaluator would have found a blocker
2. enforce mode: the same divergence now blocks publication (not enabled by default)

### Known gap: `blog.router.ts::adminSetStatus`

No direct test exercises the burn-in wiring added to `adminSetStatus`. This
codebase has no `createCaller`-style tRPC test anywhere (confirmed by
searching `src/server/routers/**/*.test.ts`), so adding one here would
introduce a new testing pattern rather than follow an established one. The
wiring is a thin, mechanical call to the same `runPublishReadinessShadowCheck`
function that IS directly tested (25 tests above) and indirectly tested again
via `content.service.test.ts`'s 2 tests against the structurally identical
`publishContent` call site. Risk is assessed as low but not zero — see the
final report's verdict section.

## Validation commands run (this remediation pass)

| Command | Result |
|---|---|
| `pnpm prisma validate` | PASS |
| `pnpm prisma generate` | PASS |
| `pnpm run typecheck` | PASS for all Pack 1 files (0 errors introduced by C3–C5); 9 pre-existing unrelated errors remain in `automation-incident.route.test.ts`, `verify-backend-incidents.ts`, `sanitizer.ts` — none of these 3 files were touched by C3–C5 (confirmed via `git status`) |
| `pnpm run lint` | 0 errors; 7 pre-existing unrelated warnings (none in Pack 1 files) |
| `pnpm run test` (full suite) | 961/964 PASS |
| `pnpm run build` (`tsc`, emits) | Fails on the identical 9 pre-existing errors above — `build` and `typecheck` run the same compiler over the same files, differing only in `--noEmit`; since the 3 offending files are untouched, this is the pre-existing baseline state, not a build regression from this pass |

## Full-suite failure reconciliation (3 failures, all pre-existing)

| Test | Reconciliation |
|---|---|
| `automation-incident.route.test.ts > POST /internal/automation/v1/incidents > accepts valid incident and correctly creates new DB entry if not found` | Pre-existing — documented in `phase-c-implementation-report.md`'s Stage C1/C2 baseline investigation (byte-identical failure against `git stash` baseline); this file is untouched by C3–C5 |
| `automation-incident.route.test.ts > POST /internal/automation/v1/incidents > suppresses alert if cooldown is active for existing incident` | Same as above |
| `agent-credential.service.test.ts > AgentCredentialService > multi-principal scoping (sys-automation-orchestrator) > grants the automation principal exactly its automation capabilities, nothing broader` | Pre-existing — same prior baseline investigation; `agent-credential.service.ts` is untouched by C3–C5 |

A 4th test documented as pre-existing/flaky in the C1/C2 baseline investigation
(`agent-prisma-roundtrip.test.ts`, live-DB parallel-contention timing) did not
fail in this pass's full-suite run — consistent with its already-documented
flaky, timing-dependent nature rather than a stable pass/fail state.

**No test file created or modified by Stages C3–C5 appears in the failing
set.** No pre-existing failing test was modified in this pass to obtain a
passing result.
