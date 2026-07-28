# SheriaBot Pack 1 — Phase B: Test Plan

Status: proposal — enumerates required tests to write during implementation.
None of these tests exist yet; this document is the acceptance criteria for that
later work, not a report of tests already passing.

Framework/conventions to follow (verified from existing tests): Vitest,
dependency-injected service classes (constructor `Dependencies` objects, e.g.
`AutomationApprovalServiceDependencies`) so every service below is testable with
mocked `prisma`/`fetchImpl`/`now`/`llmGateway` exactly like
`content.service.test.ts`, `blog-draft.service.test.ts`, `approval.service.test.ts`
already do — no new test-infrastructure pattern is introduced.

## Unit tests

| Area | Cases |
|---|---|
| Structured JSON extraction (`completeStructured`) | fenced code block; unfenced raw JSON; prose-wrapped JSON; no JSON present → `NO_JSON_FOUND`; oversized response → `RESPONSE_TOO_LARGE` before parse |
| Zod success/failure paths | valid schema match on first attempt (`validationAttempts: 1`); invalid → correction → valid (`validationAttempts: 2`); invalid → correction → still invalid → `SCHEMA_VALIDATION_FAILED`, gateway called exactly twice (no silent third attempt) |
| Correction-prompt redaction | a Zod issue message containing a URL/secret-shaped string is asserted absent from the correction prompt payload sent to the mocked gateway |
| Triage score combination | deterministic-only (no AI score) falls back correctly; weighted combination arithmetic; `sourceConfidence < 50` cap applied; unsupported-jurisdiction cap applied; duplicate-candidate short-circuit to `REJECT` with zero gateway calls |
| Triage versioning target selection | `sourceItemId` present → that index is authoritative for next-version resolution, `suggestionId` ignored for versioning purposes even if also present; `sourceItemId` absent, `suggestionId` present → `suggestionId` is authoritative; same `idempotencyKey` twice → replay; different key, unchanged `inputHash` → reuse latest version (`replayed: true`), no new row; changed `inputHash` → new version; `forceRetriage: true` → new version even with unchanged `inputHash`; a new `executionId` alone (unchanged input) → asserted NOT to create a new version |
| Audience classification | triage's `targetAudiences` output is asserted non-hardcoded (varies with input) — a direct regression test against the current `relevance-scoring.service.ts` defect of always returning the same fixed three-item array |
| Human-review enforcement (Foundation E) | each of the eight `requiresHumanReview = true` trigger conditions independently asserted; `computeRequiresHumanReview` is the single function under test for all of them (not re-implemented per call site); `createDraftFromCandidate` stops at `PENDING_REVIEW` instead of auto-promoting when the persisted `requiresHumanReview=true` (the one behavior change to existing code); **`createResearchPack` proceeds and completes normally even when the target suggestion's `requiresHumanReview=true`** (regression test for the corrected "research is not gated" policy — the original design's refusal check must NOT be present) |
| Human-review backfill and rollout gate | backfill script recomputes `requiresHumanReview` for `PENDING_REVIEW`/`NEEDS_MORE_SOURCES` suggestions and leaves terminal-status suggestions (`APPROVED_FOR_DRAFT`/`DRAFT_CREATED`/`DISMISSED`/`DUPLICATE`) untouched; enforcement gate (feature flag) rejects being enabled while unbackfilled non-terminal suggestions remain, per Foundation E's rollout-order requirement |
| Alert dedupe (`ContentOpsAlertService`) | first occurrence creates a row with `occurrenceCount: 1`; second occurrence within cooldown increments count, does not resend email; occurrence after cooldown resends; occurrence on a `RESOLVED` row reopens to `OPEN` and clears `resolvedAt`; **two alerts with `workflowKey: null` but identical `(type, entityType, entityId)` correctly dedupe against each other** (via the corrected `createOrIncrementAlert` raw-query upsert targeting the `COALESCE` expression index — this is the regression test for the plain-`@@unique`-with-nullable-column defect) |
| Alert acknowledgement/resolution | `acknowledgeAlert` sets fields without touching `occurrenceCount`; `resolveAlert` sets fields, allows subsequent reopen; `status: IGNORED` and `notificationStatus: SUPPRESSED` are asserted independently settable (a row can be `OPEN`+`SUPPRESSED` or `IGNORED`+`SENT`) |
| Research-pack versioning | first version created as `DRAFT`→`COMPLETE`, keyed by `suggestionId` when created pre-draft (no `blogPostId` yet); draft creation backfills `blogPostId` onto the existing active pack row as an `UPDATE`, not a new version; second explicit re-research call for the same target marks the prior version `SUPERSEDED` and creates v2; `sourceSetHash` mismatch against a freshness-review recompute correctly flags a pack as needing a new version, while an unchanged `inputHash` in that same scenario does not falsely suggest the objective changed |
| Verification-run hash-based replay | `verifyBlogPostClaims` idempotency guard: unchanged `contentHash`/`sourceSetHash` since last run → replay, regardless of `updatedAt`; `updatedAt` changed but hashes unchanged (e.g. only `tags` edited) → still replays; either hash changed → fresh run required |
| Semantic claim mapping | each row of the verification policy table (`phase-b-data-model.md` §3) independently asserted: outcome × category → correct severity → correct resulting `BlogVerificationStatus` |
| Second-model disagreement and provenance | primary VERIFIED + second UNSUPPORTED (or any mismatch) → forced `BLOCKING` issue created, `BLOCKED` run status, regardless of which individual verdict "sounds more confident"; both the primary and secondary `BlogVerificationIssue` rows share the same `claimHash` and each carry their own structured `reviewProvenance` (`pass`/`provider`/`model`/`promptVersion`) — **never** encoded into `recommendation` free text |
| Freshness cadence | risk-tier → `nextReviewAt` offset (30/90/180 days) computed correctly; signal-triggered immediate-review candidates surfaced independent of `nextReviewAt` |
| Revision recommendation and idempotency | always starts `PENDING_REVIEW` regardless of input `priority`; idempotent replay on duplicate caller-supplied `idempotencyKey`; **two independent manual revision requests for the same `blogPostId` with two different caller-supplied keys succeed as two separate rows** (regression test for the corrected 'manual'-literal-collapse defect) |
| Shared publish-readiness evaluator | every row of the Foundation D consolidated-checks table independently asserted, including the corrected behavior change: **missing/empty `content` is a blocker on both the admin and agent publish paths** (the agent path, `content.service.ts::publishContent`, is the one gaining this check — `adminSetStatus` is unchanged); applied-draft-only AI-staleness; evaluator never mutates `BlogPost.content` or any other field under any input |
| Audit-retention deletion behavior | `BlogResearchPack.blogPostId` FK is `SET NULL` on a hard delete of its post; `BlogFreshnessReview.blogPostId` and `BlogRevisionRequest.blogPostId` FKs are `RESTRICT` (a hard delete is rejected while such rows exist) |

## Integration tests

Real Fastify + tRPC + real router/middleware, only Prisma/Redis/LLM gateway mocked
— matching `wire-format.test.ts`'s existing pattern, extended to the nine new
procedures.

| Area | Cases |
|---|---|
| Source FK behavior (Foundation A) | a `RegulatorySignal` with a valid `sourceItemId` round-trips through Prisma with the new `sourceItem` relation populated; a `BlogSourceItem` deletion nulls the referencing `RegulatorySignal.sourceItemId` rather than failing or cascading |
| Triage persistence | `triageEditorialCandidate` end-to-end: creates `BlogEditorialTriageRun`, `AgentRun`, correct capability-gated auth |
| Research-pack persistence | `createResearchPack` end-to-end: creates pack + source rows in one transaction, supersedes prior version |
| Verification issue persistence | `verifyBlogPostClaims` end-to-end: creates run + semantic issue rows with new columns populated, existing structural-issue creation path (`runBlogPostVerification`) untouched and still passing its own existing tests |
| Publish blocked by unsupported legal claim | fixture draft with a fabricated unsupported `LEGAL_OBLIGATION` claim → `verifyBlogPostClaims` → `BLOCKED` → `evaluateBlogPublishReadiness` → `ready: false`, blocker present |
| Publish blocked by missing content (agent path, corrected behavior change) | a `BlogPost` with empty `content` submitted via `content.service.ts::publishContent` → `evaluateBlogPublishReadiness` → `ready: false`, `MISSING_CONTENT` blocker present — the specific regression test pinning the corrected agent-path behavior change; the same fixture via `blog.router.ts::adminSetStatus` was already blocked before Pack 1 and remains blocked |
| Publish blocked by stale verification | edit `content` after a `PASSED` verification → `evaluateBlogPublishReadiness` reflects the applied-draft-only staleness definition |
| Admin override where permitted | an admin resolving a `NEEDS_REVIEW`-severity semantic issue (via the admin surface, out of Pack 1 procedure scope but exercised here as a precondition) removes it from the blocker count on a subsequent `evaluateBlogPublishReadiness` call |
| Urgent freshness alert creation | `runFreshnessReview` returning `URGENT_REVISION` creates both a `BlogRevisionRequest` and a `ContentOpsAlert` in the same call, verified as two separate persisted rows, not conflated |
| `AgentRun` lifecycle | each of the **four** AI-calling procedures (`triageEditorialCandidate`, `createResearchPack`, `verifyBlogPostClaims`, `runFreshnessReview`) correctly calls `beginRun`→(`advanceRun` for two-model verification)→`completeRun`/`failRun`, mirroring the existing `generateDraftContent` wrapping pattern; `createRevisionRequest` is asserted to NOT open an `AgentRun` (it is pure persistence) |
| Agent capability enforcement | each of the nine procedures rejects a credential lacking its specific capability, and rejects credentials for `sys-agent-orchestrator`/`sys-scheduler-orchestrator` (neither of which should hold any `agents.automation.editorial.*` **capability** — note: capability strings only, not tRPC paths, which are flat under `agents.automation.*`) |
| tRPC wire format | bare POST, `{result:{data}}` envelope, confirmed for all nine new procedures at their corrected flat paths (`agents.automation.<name>`, not `agents.automation.editorial.<name>`) via the same harness as `wire-format.test.ts` |
| ContentOpsAlert raw-upsert dedupe | `createOrIncrementAlert`'s raw `$executeRaw` upsert against the `COALESCE` expression index round-trips correctly through real Prisma (not just mocked) — the one Pack 1 write path that can't use Prisma Client's typed `.upsert()` |

## Regression tests (must still pass unchanged, or intentionally-updated with the specific behavior change documented)

| Existing suite | Expected outcome |
|---|---|
| `blog-staleness.test.ts` | Unchanged — `calculateBlogStaleness` itself is not modified, only newly wired into production via Foundation D |
| `content.service.test.ts` (`publishContent`, `queueContentCandidate`, `getRecentHighImpactRegulatoryItems`, `getApprovedContentThisWeek`) | `getRecentHighImpactRegulatoryItems`'s existing `sourceItemId` passthrough test continues to pass with the new FK in place (nullable behavior unchanged); `publishContent`'s gate tests continue to pass through the Foundation D burn-in period (inline logic still primary until cutover), then gain a **new** test asserting `publishContent` now blocks on missing/empty `content` (corrected direction — this tightens the agent path, it does not loosen `blog.router.ts::adminSetStatus`, whose existing content-required test is unaffected) |
| `blog-draft.service.test.ts` | `createDraftFromCandidate`'s existing below-threshold/duplicate tests unchanged; a **new** test is added (not a modification) asserting the human-review-gate behavior change; existing auto-promotion tests for suggestions that do *not* require human review continue to pass |
| `approval.service.test.ts` | Unchanged — no Pack 1 procedure modifies `AutomationApprovalService` |
| `automation.router-wiring.test.ts` | Unchanged, extended with new rate-limiter-wiring assertions for the nine new procedures following the exact same pattern already used for the existing ones |
| `blog-digest-notification.test.ts` | Unchanged |
| API type generation (`api-types:prepare`) | Must succeed and produce `.d.ts` declarations for all nine new procedures and every new model, consumed without error by `fintech-regulatory-platform` |
| Frontend TypeScript + build | `fintech-regulatory-platform` must typecheck and build cleanly once `@sheriabot/api-types` is regenerated, even before any new admin page is implemented (additive router/type changes must not break existing pages that import `AppRouter`) |

## Evidence classification (per governing convention)

Every test above, once written, must be labeled one of: `STATIC PASS` (typecheck/lint
only), `MOCKED PASS` (unit/integration test against mocked Prisma/Redis/gateway),
`UNIT PASS`, `INTEGRATION PASS`, `LIVE TEST DEFERRED` (requires a real deployed
backend/AI provider), or `BLOCKED BY DEPLOYMENT` — matching
`docs/workflows/stage-d-n8n-import-and-offline-uat-report.md`'s existing
classification scheme for the W-CONTENT-01..03 pack. No test in this plan may be
claimed as passing until it has actually been run; this document defines what must
exist, not a report that it does.
