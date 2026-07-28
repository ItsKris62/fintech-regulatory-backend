# SheriaBot Pack 1 — Phase D Test Report

This report lists every test added for Phase D (semantic claim verification,
freshness monitoring, revision-request generation), the validation commands
run, and the honest reconciliation of the full-suite failures against the
already-documented baseline. No pre-existing failing test was modified to
force a pass.

## Part 1 — Semantic claim verification

### `src/modules/blog-automation/verification-evidence.test.ts` — 5/5 PASS

1. prefers an active research pack over BlogPostSource rows
2. falls back to BlogPostSource rows when no active research pack exists, with a confidence penalty
3. returns no_evidence mode when there is no research pack and no BlogPostSource rows
4. reuses the research pack sourceSetHash directly rather than recomputing it
5. assigns stable, unique sourceRefs to each evidence item in research_pack mode

### `src/modules/blog-automation/semantic-verification.service.test.ts` — 33/33 PASS

`computeClaimSeverity` (the code-authoritative severity mapping table):

1. maps VERIFIED to null (no issue row)
2. maps PARTIALLY_SUPPORTED high-stakes to WARNING
3. maps PARTIALLY_SUPPORTED low-stakes to INFO
4. maps UNSUPPORTED high-stakes to BLOCKING
5. maps UNSUPPORTED low-stakes to WARNING
6. maps CONTRADICTED (any category) to BLOCKING
7. maps STALE_SOURCE to WARNING
8. maps HUMAN_REVIEW_REQUIRED to WARNING

`SemanticVerificationService.runSemanticVerification`:

9. rejects when the blog post does not exist
10. fully verified draft: no semantic issues, status stays PASSED
11. unsupported legal obligation blocks the run
12. an incorrect deadline (DEADLINE, UNSUPPORTED) blocks the run
13. a contradicted regulator claim blocks the run
14. a stale source produces NEEDS_REVIEW, not BLOCKED
15. a low-stakes unsupported claim produces NEEDS_REVIEW via WARNING, not BLOCKED
16. no legal claims found: not treated as a failure, status stays at the structural result
17. falls back to BlogPostSource evidence when no active research pack exists
18. revised content (different contentHash) creates a new run rather than reusing
19. changed source set (different sourceSetHash) creates a new run rather than reusing
20. same content and source hashes reuse the latest run without a new AI call
21. second-provider agreement: no extra row is created
22. second-provider disagreement: a second row is created, both forced BLOCKING, sharing the same claimHash
23. second provider unavailable: routes to human review without failing the whole run
24. budget halt during secondary review routes to human review without failing the whole run
25. malformed structured output fails the run and rethrows
26. wraps article content and evidence in explicit blocks and instructs the model to ignore embedded instructions (prompt-injection resistance)
27. a poisoned/unverified source (claim cites only an unknown sourceRef) cannot verify a claim — downgraded to UNSUPPORTED
28. creates a ContentOpsAlert with compact metadata when the run is BLOCKED
29. does not create a ContentOpsAlert when the run is not BLOCKED
30. never logs raw article content or claim explanation text
31. returns budget_halted outcome without throwing when the AgentRun begins in a HALTED_BUDGET state
32. returns agents_disabled outcome when agents are globally disabled
33. writes back requiresHumanReview to the linked suggestion only when the policy flag is enabled

## Part 2 — Freshness monitoring

### `src/modules/blog-automation/freshness-review.service.test.ts` — 28/28 PASS

`determineRiskTier` / `cadenceDaysFor` / `computeNextReviewAt` (pure functions):

1. classifies Regulatory Updates category as HIGH_RISK
2. classifies a post with an OFFICIAL source as HIGH_RISK regardless of category
3. classifies EVERGREEN_EXPLAINER-originated posts as EVERGREEN
4. defaults to NORMAL otherwise
5. uses the correct cadence per tier
6. computes nextReviewAt from lastReviewedAt when present
7. falls back to publishedAt when lastReviewedAt is null

`FreshnessReviewService.runFreshnessReview`:

8. rejects when the post does not exist
9. rejects when the post is not PUBLISHED
10. fresh recent content: no deterministic signals, action is FRESH without an AI call
11. old but unchanged content remains FRESH — age alone never triggers a stale/revision action
12. a new high-impact (critical/high severity) regulatory signal triggers an AI-assisted review
13. a broken source (from the active research pack) contributes to brokenSourceCount and triggers review
14. handles a post with no sources at all without crashing
15. a missing publication date contributes to staleSourceCount
16. an unchanged duplicate review on the same day reuses the existing result without a new AI call
17. a changed source-set hash (even same day) still triggers a new review, not a reuse
18. throws when the AI returns a non-FRESH action with no evidence pointers (guardrail)
19. throws when the AI cites evidence fields but its rationale text never mentions them (guardrail)
20. propagates a malformed structured-output AI failure and fails the run
21. returns budget_halted outcome without throwing when the AgentRun begins in a HALTED_BUDGET state
22. returns agents_disabled outcome when agents are globally disabled
23. creates a ContentOpsAlert only for URGENT_REVISION/ARCHIVE_RECOMMENDED, not for REVIEW_SOON
24. creates a ContentOpsAlert with compact metadata for URGENT_REVISION
25. creates a BlogRevisionRequest for REVISION_REQUIRED/URGENT_REVISION/ARCHIVE_RECOMMENDED actions
26. does not create a BlogRevisionRequest for FRESH/REVIEW_SOON actions
27. never calls any BlogPost update — freshness review never changes publication status or content
28. never logs full article content

## Part 3 — Revision-request generation

### `src/modules/blog-automation/revision-request.service.test.ts` — 12/12 PASS

1. rejects when blogPostId does not exist
2. rejects when freshnessReviewId is given but does not exist
3. creates a revision request for REVISION_REQUIRED-equivalent input with MEDIUM priority
4. creates an URGENT priority revision request
5. always starts PENDING_REVIEW regardless of priority (guardrail: nothing about input can cause an auto-approved state)
6. replays a duplicate idempotencyKey rather than creating a second row
7. two independent manual revision requests for the SAME post with two different caller-supplied keys both succeed as two separate rows (regression test for the corrected manual-collapse defect)
8. creation from a freshness review links freshnessReviewId correctly
9. sets requestedById only when explicitly provided (human-originated)
10. never touches BlogPost — no blogPost.update dependency exists in this service at all
11. `deriveFreshnessOriginatedIdempotencyKey` produces a stable, deterministic key for the same inputs
12. `deriveFreshnessOriginatedIdempotencyKey` differs for different freshnessReviewIds (never a shared literal)

## Shared hashing extensions

### `src/modules/blog-automation/editorial-input-hash.test.ts` — 7 new tests (23/23 total in file)

`computeContentHash`:

1. is deterministic for identical content
2. changes when content changes
3. treats null and undefined the same as empty string
4. never throws for null/undefined/empty input

`computeFallbackSourceSetHash`:

5. is deterministic regardless of input array order (sorted internally)
6. changes when a source updatedAt changes
7. produces a stable hash for an empty source list

(`computeClaimHash`, used by `semantic-verification.service.ts` to correlate
PRIMARY/SECONDARY_REVIEW issue rows, is exercised indirectly through the
disagreement test above rather than unit-tested in isolation — it is a
one-line sha256-of-normalized-text wrapper with no independent branching
logic to test.)

## Validation commands run (this pass)

| Command | Result |
|---|---|
| `pnpm exec prisma validate` | PASS — no schema changes needed; Phase D uses only models Stage C1 already added |
| `pnpm exec prisma generate` | PASS |
| `pnpm run typecheck` | PASS for all Pack 1 files (0 errors introduced by Phase D); 9 pre-existing unrelated errors remain, all in files untouched by this pass |
| `pnpm run lint` | 0 errors; 7 pre-existing unrelated warnings (none in Pack 1 files) |
| `pnpm run test` (full suite) | 1136/1140 PASS |
| `pnpm run build` (`tsc`, emits) | Fails on the identical 9 pre-existing errors as `typecheck` — confirmed pre-existing baseline, not a Phase D regression |

## Full-suite failure reconciliation (4 failures, all pre-existing/environmental)

| Test | Reconciliation |
|---|---|
| `automation-incident.route.test.ts > ... > accepts valid incident and correctly creates new DB entry if not found` | Pre-existing — documented in `phase-c3-c5-test-report.md`; file untouched by Phase D |
| `automation-incident.route.test.ts > ... > suppresses alert if cooldown is active for existing incident` | Same as above |
| `agent-credential.service.test.ts > ... > grants the automation principal exactly its automation capabilities, nothing broader` | Pre-existing — documented in `phase-c3-c5-test-report.md`; `agent-credential.service.ts` untouched by Phase D |
| `agent-prisma-roundtrip.test.ts > ... > creates and reads AgentRun with cascaded AgentReport shape matching live schema` | The previously-documented flaky live-DB parallel-contention timing test. Consistent with its already-documented flaky nature, not a stable failure. Its own query never touches any Pack 1 model. |

Test count grew from 1055 (end of C6/C7) to 1140 in this pass — an increase
of exactly 85, matching the sum of the new Phase D tests (5 + 33 + 12 + 28 +
7 = 85). No test outside these files changed in count or outcome.

**No test file created or modified by Phase D appears in the failing set.**

## Disclosed gaps and simplifications (carried into the final report)

- **Freshness candidate selection** uses jurisdiction-string matching for
  "new relevant regulatory signal" detection rather than an exact FK-chain
  match, since `BlogPost` has no direct FK to `BlogSourceItem`/`RegulatorySignal`.
  See `freshness-and-revision-policy.md`.
- **`NUMERICAL_CLAIM`/`FACTUAL_EVENT`** claim categories are not named in
  either stakes-tier bucket by the governing severity-mapping table; this
  implementation defaults them to high-stakes (conservative), disclosed via
  the exported `HIGH_STAKES_CLAIM_CATEGORIES` constant rather than a silent
  assumption. See `semantic-verification-policy.md`.
- **`ResearchPackService.backfillBlogPostIdForSuggestion()`** (Stage C7,
  reused by no Phase D code) remains implemented and tested but unwired into
  the draft-creation flow — unchanged status from the C6/C7 pass.
