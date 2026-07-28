# SheriaBot Pack 1 — Phase C/D: Implementation Report (Stage C1–C7, Phase D)

Status: Stage C1 (schema and additive migrations), Stage C2 (structured AI
output foundation), Stage C3 (`requiresHumanReview` policy and rollout),
Stage C4 (persisted `ContentOpsAlert`), Stage C5 (shared publish-readiness
evaluator and burn-in integration), Stage C6 (editorial triage), Stage C7
(research-pack generation and persistence), and Phase D (semantic claim
verification, freshness monitoring, revision-request generation) are
implemented and validated. Only Phase E (API/admin/router exposure) remains
— see `phase-c-rollout-plan.md` for its scope. This report covers only what
was actually built and run across all sessions; no claim is made about work
not yet started.

## Stage C1 — Schema and additive migrations

### Schema changes (`prisma/schema.prisma`)

- `RegulatorySignal.sourceItem` relation added (Foundation A), inverse
  `BlogSourceItem.regulatorySignals`, additive FK + index. Field type/nullability
  of `sourceItemId` unchanged.
- 6 new models: `ContentOpsAlert`, `BlogEditorialTriageRun`, `BlogResearchPack`,
  `BlogResearchPackSource`, `BlogFreshnessReview`, `BlogRevisionRequest`.
- 11 new enums + 1 additive enum value (`BlogVerificationIssueType.SEMANTIC_CLAIM_ISSUE`).
- `BlogVerificationRun` extended with nullable `contentHash`/`sourceSetHash`/`promptVersion`.
- `BlogVerificationIssue` extended with nullable `claimCategory`/
  `claimVerificationStatus`/`confidence`/`claimHash`/`reviewProvenance`.
- Inverse relation fields added to `User`, `AgentRun`, `BlogPost`,
  `BlogArticleSuggestion`, `BlogSourceItem`, `BlogPostSource` as required by
  the new models' `@relation` declarations.
- `BlogEditorialTriageRun`/`BlogResearchPack` each carry **two** unique
  version-target indexes (`sourceItemId`/`suggestionId` and
  `blogPostId`/`suggestionId` respectively) per the Phase B.1 correction.
- `BlogFreshnessReview`/`BlogRevisionRequest` use `onDelete: Restrict` on their
  `BlogPost` relation (corrected from `Cascade`); `BlogResearchPack` uses
  `onDelete: SetNull`.
- `BlogRevisionRequest.idempotencyKey String @unique` (corrected — no
  server-synthesized fallback).

### Migration files created (7, none applied)

All under `prisma/migrations/`, additive-only, idempotent
(`DO $$ ... EXCEPTION WHEN duplicate_object`/`IF NOT EXISTS` throughout,
matching this project's existing convention):

1. `20260727010000_regulatory_signal_source_item_fk`
2. `20260727020000_content_ops_alert`
3. `20260727030000_blog_editorial_triage_run`
4. `20260727040000_blog_research_pack`
5. `20260727050000_blog_verification_semantic_extension`
6. `20260727060000_blog_freshness_review`
7. `20260727070000_blog_revision_request`

Each carries a header comment naming its dependency on prior steps where
applicable, and a commented rollback block. Full detail in
`phase-c-schema-verification.md`.

### Schema verifier extended

`src/utils/schema-verifier.ts` — new `PACK1_EDITORIAL_INTELLIGENCE_INVENTORY`
export (additive, `COMPLETE_PHASE0_INVENTORY` untouched) plus a merged
`ALL_EXPECTED_SCHEMA_INVENTORY` that `verifyCompleteSchema()` now checks
against. `src/utils/schema-verifier.test.ts` updated so its mock builder
derives from the merged inventory — 26/26 tests pass.

**One design correction made mid-implementation**: the first draft marked the
new `BlogVerificationRun`/`BlogVerificationIssue` column-checks and the
`BlogVerificationIssueType` enum-value check as `isPrerequisite: true`. This
broke an existing pre-mode test (`2. Expected Phase 0 table missing passes in
pre mode`) because `isPrerequisite` in this engine means "must already exist
independent of any migration in this repo" (e.g. the `User` table) — these
Pack 1 additions don't fit that definition, they're ordinary expected objects
like every other Phase 0 entry. Fixed by removing the flag from all three;
re-ran the full schema-verifier suite to confirm.

## Stage C2 — Structured AI output foundation

New module: `src/lib/ai/structured/` —

- `types.ts` — `AIUseCase`, `StructuredCompletionResult<T>`,
  `CompleteStructuredInput<T>`, `AIStructuredOutputErrorCode`.
- `errors.ts` — `AIStructuredOutputError`.
- `extract-json.ts` — `extractJsonCandidate()` (fenced/unfenced/prose-wrapped
  extraction), `MAX_STRUCTURED_RESPONSE_LENGTH` (200,000 chars).
- `redact.ts` — `redactForPrompt()`, `summarizeZodIssuesForCorrection()` (caps
  correction-prompt issues at 10, strips URL/secret-shaped substrings).
- `completeStructured.ts` — the main function, layered strictly on top of the
  existing `llmGateway.complete()` (imported, never reimplemented): schema
  suffix built from zod v4's native `z.toJSONSchema()` (no new dependency —
  `zod-to-json-schema` in package.json was investigated and skipped in favor
  of the version already installed, `zod@^4.3.6`, which has this built in and
  avoids a zod-v3-vs-v4 compatibility risk); one bounded correction attempt
  (type-capped at `0 | 1`); token/cost summed across both attempts via the
  existing `calculateCost()` from `../gateway/pricing`; `rawResponseHash`
  (sha256) returned, raw text never logged or persisted; gateway errors mapped
  to the fixed `AIStructuredOutputErrorCode` taxonomy.

### Tests

- `extract-json.test.ts` — 7 tests (fenced, unfenced, prose-wrapped, no-JSON,
  empty string, max-length constant).
- `completeStructured.test.ts` — 15 tests covering: first-attempt success,
  fenced-block success, correction-success, correction-failure (exactly 2
  gateway calls), `NO_JSON_FOUND`, `RESPONSE_TOO_LARGE` (1 call only, no
  correction), `correctionAttemptLimit: 0`, correction-prompt redaction,
  token/cost summation across attempts, `rawResponseHash` shape and
  non-containment, never-partial-data-on-throw, `UNSUPPORTED_PROVIDER`
  mapping, `BUDGET_EXHAUSTED` mapping, `PROVIDER_TIMEOUT` mapping,
  `INVALID_SCHEMA_CONFIGURATION` (gateway never called).

### One implementation-time type fix

The dependency-injection interface was first typed as
`Pick<typeof defaultLlmGateway, 'complete'>`, which TypeScript rejected when
tests supplied a `vi.fn()` mock (variance mismatch against the class method's
exact signature). Replaced with a plain interface,
`StructuredCompletionGateway { complete(...): Promise<...> }`, and explicitly
parameterized the test's `vi.fn<CompleteFn>()` — both changes are pure typing
fixes with no behavior change, verified by re-running `tsc --noEmit` until
clean.

## Stage C3 — `requiresHumanReview` policy and safe rollout

### New module: `src/modules/blog-automation/human-review-policy.ts`

A single, pure, shared policy function with no side effects and no dependency
on any specific caller's stage of the pipeline:

- `computeRequiresHumanReview(input)` — evaluates only the evidence fields
  actually passed in; never fakes or defaults research/verification signals
  that a given caller hasn't produced yet.
- `computeRequiresHumanReviewAtCreation(evidence)` — the creation-time-only
  entry point used by `suggestion-builder.ts`, restricted to fields available
  at suggestion-creation time (category, official-source requirement, source
  quality, jurisdiction). It deliberately cannot see research/verification
  evidence that doesn't exist yet.
- 8 reason codes (`HumanReviewReason`), an `OFFICIAL_SOURCE_REQUIRED_CATEGORIES`
  list, `DEFAULT_SUPPORTED_JURISDICTIONS` (derived from the `BlogJurisdiction`
  enum, not hand-duplicated), and `DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD`.

### Persistence at creation time (`suggestion-builder.ts`)

`createSuggestionFromSourceItem` now computes an **explicit** `requiresHumanReview`
value at creation, gated behind `EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED`
(default `false`). When the flag is off, the field is omitted from the
`create` payload entirely — the existing Prisma column default is preserved
exactly, byte-for-byte, with zero behavior change. When on, the computed
boolean is persisted explicitly rather than silently inherited.

### Backfill script: `src/scripts/backfill-editorial-human-review.ts`

Recomputes `requiresHumanReview` for existing `BlogArticleSuggestion` rows
still in a non-terminal state (`PENDING_REVIEW`/`NEEDS_MORE_SOURCES` only —
terminal rows are never touched). Defaults to `--dry-run`; requires an
explicit `--write` flag to persist, and refuses to write against a
production-shaped database unless `--allow-production` is also passed
(reusing `validateEnvironmentSafety` from `schema-verifier.ts`). Paginates in
batches of 200. Exposed via `pnpm run editorial:backfill-human-review` (dry
run) and `editorial:backfill-human-review:write`.

### Enforcement gate (`blog-draft.service.ts`)

`createDraftFromCandidate` now checks `EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED`
(default `false`, independent of the policy-compute flag) immediately before
the existing `APPROVED_FOR_DRAFT` auto-promotion. When enabled and the
suggestion's persisted `requiresHumanReview` is `true`, the function returns a
new typed outcome — `{ status: 'human_review_required', suggestionId, reasons }`
— instead of promoting and drafting. When disabled (default), or when the
suggestion doesn't require review, the exact prior auto-promotion behavior is
unchanged. Research/triage paths are never gated by this flag — only the
draft-promotion call site checks it, per the non-negotiable "research must
not be blocked by `requiresHumanReview`" rule.

### Rollout order (env vars, both default `false`/`shadow`)

```
EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED=false        # step 1: turn on computation/persistence
EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED=false   # step 2: turn on only after backfill review
```

Full sequencing in `human-review-backfill-runbook.md`.

## Stage C4 — Persisted `ContentOpsAlert`

### Sanitizer: `src/modules/agents/automation/content-ops-alert-sanitizer.ts`

`sanitizeAlertText()` and `sanitizeAlertMetadata()` strip HTML, cap string
lengths (2000 chars for summaries, 500 per metadata value, 4000 for the
serialized metadata blob), drop any metadata key matching
`/token|secret|credential|password|prompt|html|body|content|cookie|authoriz/i`,
and drop non-scalar metadata values (arrays/nested objects) — enforcing the
non-negotiable "no full article/prompt/source-document/credential content in
alerts" rule at the data layer, not just by caller convention.

### `ContentOpsAlertService` rewrite

Rewritten from a fire-and-forget `sendAlert`-only service to a persist-first
design:

- `createOrIncrementAlert()` — the new primary entry point. Deduplicates via
  a single atomic `INSERT ... ON CONFLICT ("type", "entityType", "entityId",
  (COALESCE("workflowKey", ''))) DO UPDATE` against the `ContentOpsAlert_dedupe_key`
  expression index (Stage C1), **not** a find-then-create pattern — eliminates
  the race window a separate read-then-write would have. On conflict,
  increments `occurrenceCount`, bumps `lastSeenAt`, and reopens the alert
  (`status` → `OPEN`) if it had been `RESOLVED`/`IGNORED`, clearing
  `acknowledgedAt` on reopen. `resolutionNote` is deliberately **excluded**
  from the `DO UPDATE SET` clause — operator resolution notes are preserved
  across a reopen rather than silently destroyed.
- Notification policy: only `HIGH`/`CRITICAL` severities are notification-eligible;
  a 12-hour cooldown suppresses repeat emails for the same alert.
  `notificationStatus` distinguishes `SUPPRESSED` (eligible but cooling down)
  from `NOT_REQUIRED` (severity too low to ever notify) — these are never
  conflated with `IGNORED` (an operator's explicit status decision).
- `acknowledgeAlert()` / `resolveAlert()` — actor-derived (caller passes the
  resolved admin user id; the service never re-derives identity itself).
  No agent-facing acknowledge/resolve procedure is exposed in this stage, per
  spec.
- `listOpenAlerts()` / `getAlert()` / `markNotificationResult()`.
- `sendAlert()` (the pre-existing raw email method) is preserved as a thin
  wrapper so nothing calling it directly breaks; both existing call sites in
  `blog-draft.service.ts` were migrated to `createOrIncrementAlert()`.
- The alert's `id` is generated via `randomUUID()` (`node:crypto`) in
  TypeScript rather than a Postgres-side `gen_random_uuid()`, matching the
  existing convention in `reg-intel.agent.ts` for raw-SQL inserts that bypass
  Prisma's client-side `@default(cuid())`.

## Stage C5 — Shared publish-readiness evaluator and burn-in integration

### `src/server/utils/publish-readiness.ts`

`evaluateBlogPublishReadiness(prisma, blogPostId)` — a single, read-only,
side-effect-free evaluator consolidating the three existing inline gate
implementations (`blog.router.ts::adminSetStatus`, `content.service.ts::publishContent`,
and `blog-automation.router.ts`'s own staleness computation) without yet
replacing any of them. Blockers: `MISSING_TITLE`/`SLUG`/`EXCERPT`/`CATEGORY`/`CONTENT`,
`NO_SOURCES`, `MISSING_REQUIRED_OFFICIAL_SOURCE`, `VERIFICATION_BLOCKED`,
`AI_DRAFT_NEWER_THAN_VERIFICATION` (applied-draft-only — reuses
`calculateBlogStaleness` from `blog-staleness.ts` rather than a fifth inline
staleness definition), `HUMAN_REVIEW_REQUIRED`, and `BLOCKING_CONTENT_OPS_ALERT`
(only when an open alert's metadata explicitly sets `blocksPublication: true`).
`POST_OR_SOURCE_UPDATED_SINCE_VERIFICATION` is a warning, not a blocker. An
empty/missing `content` field blocks publication via this evaluator
independent of any other check, satisfying the "empty content blocks both
paths" requirement.

`ReadinessPrisma` is derived from `typeof defaultPrisma` (the real singleton's
type, which is extended via `.$extends()`) rather than the raw `PrismaClient`
export — a plain `Pick<PrismaClient, ...>` is not structurally assignable
from the extended client's type.

`runPublishReadinessShadowCheck(prisma, blogPostId, legacyReady, callSite)` —
the burn-in wrapper. Reads `BLOG_PUBLISH_READINESS_MODE` (`off`/`shadow`/`enforce`,
**default `shadow`**, never `enforce` by default per spec). In `off` mode it
is a no-op. In `shadow` and `enforce` modes it always runs the evaluator and
logs a `blog_publish_readiness_divergence` (warn) or
`blog_publish_readiness_shadow_check` (info) event — blog post ID and finding
codes only, never article content, source text, or prompts. `shouldBlock` is
only ever `true` when `mode === 'enforce'` **and** the evaluator found
blockers. The function never throws — a bug in the new evaluator can never
break an existing publish path.

### Integration (both existing gates left in place, unchanged, per spec)

- `blog.router.ts::adminSetStatus` — the existing inline `PUBLISHED` gate
  block is now wrapped in a `try/catch` capturing any thrown `TRPCError` as
  `legacyError`. The shadow check always runs afterward (so divergence is
  always observed, even when the legacy path already rejected). The legacy
  error is rethrown first if present (legacy behavior is fully authoritative
  in the default `shadow` mode); only if the legacy path would have allowed
  publication does `shadowCheck.shouldBlock` get consulted.
- `content.service.ts::publishContent` — identical pattern. `ContentPrisma`
  was widened to include `contentOpsAlert` so the evaluator's
  `BLOCKING_CONTENT_OPS_ALERT` check has the data it needs.

Neither existing inline gate was removed or altered in its own logic, per the
explicit "do not remove the old inline gates in this pass" instruction — this
stage is additive/observational only.

## Stage C6 — Editorial triage

Full policy detail in `editorial-triage-policy.md`. Summary:

### New modules

- **`src/modules/blog-automation/editorial-input-hash.ts`** —
  `computeTriageInputHash`, `computeResearchInputHash`,
  `computeResearchSourceSetHash` (shared by C6 and C7): plain sha256 of an
  explicit, ordered field list — the n8n execution ID is never part of any of
  these hashes.
- **`src/modules/blog-automation/editorial-triage.service.ts`** —
  `EditorialTriageService.triageEditorialCandidate()`. Extends
  `relevance-scoring.service.ts` (called, never duplicated) with a strict,
  bounded `EditorialEnrichmentSchema` AI enrichment via `completeStructured`
  (never `llmGateway.complete()` directly). Combines the deterministic and AI
  scores via a named-constant weighted formula (`0.6`/`0.4`), applies a
  low-source-confidence cap and an unsupported-jurisdiction cap, and maps to
  one of `PRIORITISE_NOW`/`QUEUE`/`MONITOR`/`REJECT`/`HUMAN_REVIEW_REQUIRED` —
  `requiresHumanReview` (computed via the shared `computeRequiresHumanReview`,
  never re-derived ad hoc) always overrides the score-based bucket.
- Candidate resolution accepts `sourceItemId`/`suggestionId`/`regulatorySignalId`
  (at least one required), cross-links whichever wasn't given directly, and
  rejects an explicit mismatch between two given identities. A duplicate
  candidate (source/suggestion already in a terminal state) short-circuits to
  a `COMPLETE`/`REJECT` row with zero AI calls.
- Versioning: `sourceItemId` is the authoritative target when resolvable;
  falls back to `suggestionId` only when no `BlogSourceItem` can be resolved
  (a documented edge case — see the policy doc). Version allocation retries
  on a Postgres unique-constraint conflict rather than a vulnerable
  find-then-create.
- Three independent idempotency rules (same key → `AgentRun` replay;
  different key + unchanged `inputHash` → reuse latest version;
  changed hash or `forceRetriage: true` → next version) — matching
  `phase-b-data-model.md` §1 exactly.

### Tests

`editorial-input-hash.test.ts` (16), `editorial-triage.service.test.ts` (30) —
see `phase-c6-c7-test-report.md` for the full itemized list.

## Stage C7 — Research-pack generation and persistence

Full policy detail in `research-pack-policy.md`. Summary:

### New modules

- **`src/modules/blog-automation/research-source-classifier.ts`** —
  `classifySource()`: deterministic, precedence-ordered mapping to the 9-value
  `BlogResearchSourceCategory` enum, run **before** any AI call — the AI is
  never able to assign or upgrade a source's category or trust level.
- **`src/modules/blog-automation/research-pack.service.ts`** —
  `ResearchPackService.createResearchPack()`. Gathers sources only from
  already-vetted `BlogSuggestionSource→BlogSourceItem`/`BlogPostSource`
  relationships (no new fetching/scraping mechanism); deduplicates by
  `sourceItemId` > `postSourceId` > normalized URL; synthesizes via a strict,
  bounded `ResearchSynthesisSchema` (executive summary, dated events,
  authorities, obligations, evidence gaps, contradictions, confidence).
- **Code-level (not just prompt-level) enforcement** that a high-stakes
  obligation (`LEGAL_OBLIGATION`/`DEADLINE`/`PENALTY`/`LICENSING_REQUIREMENT`/
  `REPORTING_REQUIREMENT`/`SECURITY_REQUIREMENT`/`DATA_PROTECTION_REQUIREMENT`)
  citing only a non-official-tier source is downgraded into `evidenceGaps`
  rather than persisted as an obligation — this is the concrete mechanism
  behind "a poisoned/unverified source cannot verify a legal obligation," not
  merely a prompt instruction the model could ignore.
- Any AI finding whose `sourceRef` doesn't resolve to a known source is
  dropped from that specific finding, never upgraded, never failing the
  whole pack.
- Two independent hashes (`inputHash` for objective+target+versions,
  `sourceSetHash` for the full sorted source set including content hash and
  publication date — never URLs alone). Superseding the prior active version
  happens in the same `$transaction` as creating the new one, and only after
  synthesis succeeds — a failed AI call never supersedes anything.
- Feeds `computeRequiresHumanReview` (evidence-gap count, contradiction
  count, AI confidence) and, when material, creates a compact
  `ContentOpsAlert` (`entityType: 'BlogResearchPack'`, IDs/counts only, never
  research text) — research completion never auto-promotes or auto-approves
  the suggestion.
- `backfillBlogPostIdForSuggestion()` is implemented and tested per the
  documented "attach `blogPostId` as a plain UPDATE, not a new version"
  requirement, but **not yet wired into any caller** (that's the
  draft-creation flow, out of this pass's scope) — see
  `research-pack-policy.md`'s "Deferred" section.

### Tests

`research-source-classifier.test.ts` (13), `research-pack.service.test.ts`
(32) — see `phase-c6-c7-test-report.md` for the full itemized list.

## Phase D — Semantic verification, freshness monitoring, revision requests

Full policy detail in `semantic-verification-policy.md` and
`freshness-and-revision-policy.md`. Summary:

### Part 1 — Semantic claim verification

- **`src/modules/blog-automation/verification-evidence.ts`** — resolves
  evidence from the post's active `BlogResearchPack` (preferred, its
  synthesized findings, `sourceSetHash` reused directly) or falls back to
  `BlogPostSource` rows (confidence-penalized) when no pack exists.
- **`src/modules/blog-automation/semantic-verification-prompt.ts`** —
  `SemanticVerificationSchema` (bounded, ≤40 claims) and
  `SecondaryClaimReviewSchema` for the independent second pass.
- **`src/modules/blog-automation/semantic-verification.service.ts`** —
  `SemanticVerificationService.runSemanticVerification()`. **Extends**
  `runBlogPostVerification` (called unchanged, injected as
  `runStructuralVerification`) by appending semantic
  `BlogVerificationIssue` rows to the same run and re-deriving its final
  status from the combined structural + semantic counts — not a parallel
  verification system.
- Severity is always computed by the fixed, code-level
  `computeClaimSeverity(status, category)` mapping table from
  `phase-b-data-model.md` §3 — the model's own `severityOpinion` is captured
  but never used to set the persisted severity.
- A claim citing zero resolvable evidence refs is downgraded to
  `UNSUPPORTED` before severity mapping — the concrete mechanism behind "a
  poisoned/unverified source cannot verify a claim."
- Second-model review triggers only for `BLOCKING`-severity claims (or an
  explicit `requestSecondReview`), uses an explicitly different provider,
  and **forces both rows to `BLOCKING` on disagreement** — no model's
  verdict is silently preferred. Provider-unavailable/budget-halt during the
  second call routes to human review rather than failing the whole run.
- Hashing/replay reuses `computeContentHash` + the evidence's own
  `sourceSetHash` against `BlogVerificationRun.contentHash`/`.sourceSetHash`
  — not `BlogPost.updatedAt` alone.

### Part 2 — Freshness monitoring

- **`src/modules/blog-automation/freshness-review-prompt.ts`** —
  `FreshnessAssessmentSchema`, bounded, evidence-ref-based.
- **`src/modules/blog-automation/freshness-review.service.ts`** —
  `FreshnessReviewService.runFreshnessReview()` and
  `.selectFreshnessCandidates()`. Computes five deterministic signals
  (changed sources, new critical/high `RegulatorySignal`s, broken sources
  reused from Stage C7's `BlogResearchPackSource.isAvailable`, stale
  sources, source-set-hash drift) **before** any AI call — if none are
  present, the review is `FRESH` deterministically, zero AI spend.
- Two service-level guardrails, both throwing `FreshnessEvidenceGuardrailError`
  (never silently downgraded): a non-`FRESH` action must carry at least one
  evidence pointer, and its `rationale` must actually cite one — enforcing
  "age alone must never produce a stale/revision action" structurally, not
  just by convention.
- Same-day + unchanged-hashes + no-newer-signal reuses the existing review;
  either hash changing (or a newer qualifying signal) always triggers a new
  review, even same-day.
- `FreshnessReviewPrisma`'s type has no `blogPost.update` method at all —
  there is no code path in this service that could touch `BlogPost.status`
  or `.content`, verified by a dedicated test.
- **Disclosed simplification**: new-signal detection uses jurisdiction-string
  matching rather than an exact FK-chain match (`BlogPost` has no direct FK
  to `BlogSourceItem`) — see the policy doc's "Deferred" section.

### Part 3 — Revision-request generation

- **`src/modules/blog-automation/revision-request.service.ts`** —
  `RevisionRequestService.createRevisionRequest()`. Pure persistence, no AI
  call, no `AgentRun`. Always starts `PENDING_REVIEW` regardless of input
  priority. `idempotencyKey` is always caller-supplied — `deriveFreshnessOriginatedIdempotencyKey()`
  gives `runFreshnessReview`'s internal calls a safe, unique key; a manual
  caller supplies its own. Duplicate inserts are handled through the
  `idempotencyKey` unique constraint (insert, catch `P2002`, look up), the
  same pattern `AutomationApprovalService.createApproval` already uses — a
  regression test confirms two independent manual requests for the same post
  with two different keys both succeed as two separate rows (the defect the
  original design's `'manual'`-literal fallback would have caused).
- `runFreshnessReview` creates a `BlogRevisionRequest` only for
  `REVISION_REQUIRED`/`URGENT_REVISION`/`ARCHIVE_RECOMMENDED` actions, with
  priority `MEDIUM`/`URGENT`/`HIGH` respectively.

### Tests

`verification-evidence.test.ts` (5), `semantic-verification.service.test.ts`
(33), `revision-request.service.test.ts` (12),
`freshness-review.service.test.ts` (28), plus 7 new tests added to the
existing `editorial-input-hash.test.ts` (`computeContentHash`,
`computeFallbackSourceSetHash`, `computeClaimHash`) — 85 new tests total.
See `phase-d-test-report.md` for the full itemized list.

## Validation run across all sessions (this pass: Phase D)

| Command | Result |
|---|---|
| `pnpm exec prisma validate` | PASS |
| `pnpm exec prisma generate` | PASS |
| `pnpm run typecheck` | PASS for all Pack 1 files; 9 pre-existing unrelated errors remain (untouched files: `automation-incident.route.test.ts`, `verify-backend-incidents.ts`, `sanitizer.ts`) |
| `pnpm run lint` | 0 errors; 7 pre-existing unrelated warnings |
| `pnpm run test` (full suite) | 1136/1140 PASS — 4 failures, all confirmed pre-existing/environmental by exact test name (see below) |
| `pnpm run build` (`tsc`, emits) | Fails on the identical 9 pre-existing errors as `typecheck` — confirmed as the same pre-existing baseline state, not a Phase D regression |

Focused Stage C3–C5 test files (unchanged, all still passing):

| File | Tests |
|---|---|
| `human-review-policy.test.ts` | 14/14 |
| `backfill-editorial-human-review.test.ts` | 6/6 |
| `suggestion-builder.test.ts` | 3/3 |
| `content-ops-alert-sanitizer.test.ts` | 8/8 |
| `content-ops-alert.service.test.ts` (createOrIncrementAlert + related, added to existing file) | 18/18 new |
| `publish-readiness.test.ts` | 25/25 |
| `blog-draft.service.test.ts` (enforcement block, added to existing file) | 3/3 new (25/25 total) |
| `content.service.test.ts` (shadow-integration block, added to existing file) | 2/2 new (13/13 total) |

Focused Stage C6–C7 test files (unchanged, all still passing):

| File | Tests |
|---|---|
| `editorial-input-hash.test.ts` | 16/16 at end of C6/C7, now 23/23 (Phase D added 7) |
| `research-source-classifier.test.ts` | 13/13 |
| `editorial-triage.service.test.ts` | 30/30 |
| `research-pack.service.test.ts` | 32/32 |

Focused Phase D test files (new in this pass, all passing):

| File | Tests |
|---|---|
| `verification-evidence.test.ts` | 5/5 |
| `semantic-verification.service.test.ts` | 33/33 |
| `revision-request.service.test.ts` | 12/12 |
| `freshness-review.service.test.ts` | 28/28 |

### Full-suite failure investigation (all 4 confirmed pre-existing/environmental, none new)

Same baseline-comparison methodology as prior sessions was used: every
failing test name was checked against the exact 4 failures already documented
in `phase-c3-c5-test-report.md`, and none of the failing files were touched
by Phase D (confirmed via `git status`):

- `automation-incident.route.test.ts` (2 failures) — same pre-existing
  failures documented previously; untouched by Phase D.
- `agent-credential.service.test.ts` (1 failure) — same pre-existing failure
  documented previously; untouched by Phase D.
- `agent-prisma-roundtrip.test.ts` (1 failure) — the previously-documented
  flaky, live-DB parallel-contention timing test; consistent with its
  already-documented flaky, timing-dependent nature, not a stable failure
  and not caused by Phase D (its own query never touches any Pack 1 model).

**No test file created or modified by Phase D appears in the failing set.**
Total test count grew from 1055 (end of C6/C7) to 1140 (+85, exactly the sum
of the new Phase D test files: 5+33+12+28+7=85), with zero tests lost or
broken elsewhere.

Also reconfirmed: the pre-existing, unrelated `AbortController`/timeout
addition in `content.service.ts::queueContentCandidate` remains untouched —
this pass did not modify `content.service.ts` at all.

### Known test-coverage gap (disclosed, not silently accepted)

`blog.router.ts::adminSetStatus`'s burn-in wiring (the `try/catch` +
`runPublishReadinessShadowCheck` call added in this stage) has **no direct
automated test**. This is consistent with this codebase's existing
convention of not writing tRPC-caller-based tests for any router in this
repo (confirmed: no `createCaller`-style test exists anywhere in `src/server/routers/`)
— but it does mean this specific call site's wiring is only indirectly
covered by the fact that it calls the same, separately-and-heavily-tested
`runPublishReadinessShadowCheck` function that `content.service.ts::publishContent`
also calls (which *is* covered, in `content.service.test.ts`). The underlying
evaluator and shadow-check function have 25 direct tests; the thin wiring in
`adminSetStatus` itself does not. See the final report for how this affects
the rollout verdict.

## Files changed

```
M  prisma/schema.prisma
M  src/utils/schema-verifier.ts
M  src/utils/schema-verifier.test.ts
M  src/config/app.config.ts
M  src/modules/blog-automation/suggestion-builder.ts
M  src/modules/agents/automation/blog-draft.service.ts
M  src/modules/agents/automation/blog-draft.service.test.ts
M  src/modules/agents/automation/content-ops-alert.service.ts
M  src/modules/agents/automation/content-ops-alert.service.test.ts
M  src/modules/agents/automation/content.service.ts
M  src/modules/agents/automation/content.service.test.ts
M  src/server/routers/blog.router.ts
M  package.json
?? prisma/migrations/20260727010000_regulatory_signal_source_item_fk/
?? prisma/migrations/20260727020000_content_ops_alert/
?? prisma/migrations/20260727030000_blog_editorial_triage_run/
?? prisma/migrations/20260727040000_blog_research_pack/
?? prisma/migrations/20260727050000_blog_verification_semantic_extension/
?? prisma/migrations/20260727060000_blog_freshness_review/
?? prisma/migrations/20260727070000_blog_revision_request/
?? src/lib/ai/structured/ (types.ts, errors.ts, extract-json.ts, extract-json.test.ts, redact.ts, completeStructured.ts, completeStructured.test.ts)
?? src/modules/blog-automation/human-review-policy.ts
?? src/modules/blog-automation/human-review-policy.test.ts
?? src/modules/blog-automation/suggestion-builder.test.ts
?? src/scripts/backfill-editorial-human-review.ts
?? src/scripts/backfill-editorial-human-review.test.ts
?? src/modules/agents/automation/content-ops-alert-sanitizer.ts
?? src/modules/agents/automation/content-ops-alert-sanitizer.test.ts
?? src/server/utils/publish-readiness.ts
?? src/server/utils/publish-readiness.test.ts
?? docs/editorial-intelligence/phase-c-implementation-report.md
?? docs/editorial-intelligence/phase-c-schema-verification.md
?? docs/editorial-intelligence/phase-c-rollout-plan.md
?? docs/editorial-intelligence/phase-c3-c5-test-report.md
?? docs/editorial-intelligence/human-review-backfill-runbook.md
?? docs/editorial-intelligence/publish-readiness-burn-in-runbook.md
?? src/modules/blog-automation/editorial-input-hash.ts
?? src/modules/blog-automation/editorial-input-hash.test.ts
?? src/modules/blog-automation/research-source-classifier.ts
?? src/modules/blog-automation/research-source-classifier.test.ts
?? src/modules/blog-automation/editorial-triage.service.ts
?? src/modules/blog-automation/editorial-triage.service.test.ts
?? src/modules/blog-automation/research-pack.service.ts
?? src/modules/blog-automation/research-pack.service.test.ts
?? docs/editorial-intelligence/phase-c6-c7-test-report.md
?? docs/editorial-intelligence/editorial-triage-policy.md
?? docs/editorial-intelligence/research-pack-policy.md
?? src/modules/blog-automation/verification-evidence.ts
?? src/modules/blog-automation/verification-evidence.test.ts
?? src/modules/blog-automation/semantic-verification-prompt.ts
?? src/modules/blog-automation/semantic-verification.service.ts
?? src/modules/blog-automation/semantic-verification.service.test.ts
?? src/modules/blog-automation/revision-request.service.ts
?? src/modules/blog-automation/revision-request.service.test.ts
?? src/modules/blog-automation/freshness-review-prompt.ts
?? src/modules/blog-automation/freshness-review.service.ts
?? src/modules/blog-automation/freshness-review.service.test.ts
?? docs/editorial-intelligence/phase-d-test-report.md
?? docs/editorial-intelligence/semantic-verification-policy.md
?? docs/editorial-intelligence/freshness-and-revision-policy.md
```

(`src/modules/blog-automation/editorial-input-hash.ts` and `.test.ts` are
listed above as new from C6/C7 but were also **extended** in this Phase D
pass — `computeContentHash`, `computeFallbackSourceSetHash`,
`computeClaimHash` added, 7 new tests — since neither file had been
committed yet, this shows as one continuous addition, not a separate `M`.)

Stage C6/C7/Phase D touched no other existing file — every change is a new,
additive module. `prisma/schema.prisma` needed no changes across any of
these three passes: `BlogEditorialTriageRun`, `BlogResearchPack`,
`BlogResearchPackSource`, `BlogVerificationRun`/`BlogVerificationIssue`'s
semantic extension columns, `BlogFreshnessReview`, and `BlogRevisionRequest`
all already existed from Stage C1.

(`src/modules/agents/automation/content.service.ts`'s `queueContentCandidate`
`AbortController`/timeout addition remains unrelated pre-existing work, not
part of this report — see above. The rest of that file's diff in this pass
is Stage C5's `publishContent` burn-in integration.)

## No commits created

Per the commit-strategy instructions, commits were not created automatically
in this pass — none were explicitly requested to be finalized here, and no
`git commit` was run. Working tree remains as listed above, ready for review.

## Deferred / not done in this pass

- **Phase E**: router/API exposure of every backend capability built across
  C6/C7/Phase D (`triageEditorialCandidate`, `getEditorialTriage`,
  `createResearchPack`, `getResearchPack`, `verifyBlogPostClaims`,
  `getVerificationResult`, `listFreshnessReviewCandidates`,
  `runFreshnessReview`, `createRevisionRequest`), plus any admin pages. All
  nine are backend services and schemas only as of this pass.
- Wiring `ResearchPackService.backfillBlogPostIdForSuggestion()` into
  `blog-draft.service.ts`'s draft-creation flow — implemented and tested,
  not yet called by anything (see `research-pack-policy.md`).
- The exact FK-chain-based "new regulatory signal relevant to this post"
  match in freshness candidate selection — this pass uses a disclosed
  jurisdiction-string-matching simplification (see `freshness-and-revision-policy.md`).
- An admin assignment/resolution workflow for `BlogRevisionRequest` beyond
  creation (`assignedToId`/`approvedById`/status transitions) — out of
  backend-service scope for this pass.
- Applying any of the 7 migrations to any database.
- The live `RegulatorySignal` orphan-detection query (deployment-time gate,
  unchanged from Phase B.1 status).
- Manual verification of `ContentOpsAlert_dedupe_key`'s expression-index
  definition (not automatable by the current schema-verifier engine).
- Flipping `EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED`,
  `EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED`, or
  `BLOG_PUBLISH_READINESS_MODE` away from their safe defaults in any
  environment — that is an operator decision, not part of this pass.
- A direct automated test for `blog.router.ts::adminSetStatus`'s burn-in
  wiring (see the disclosed gap above — unchanged since the C3–C5 pass, this
  pass never touched that router).
- Tuning the Stage C6 score-combination weights/thresholds, or any Phase D
  threshold (staleness-day counts, alert thresholds), via a runtime
  `SystemConfig` override — currently code-level constants (safe, bounded
  defaults), not yet a tunable surface.
