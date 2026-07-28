# Freshness Monitoring and Revision-Request Policy (Pack 1 Phase D, Parts 2–3)

Implemented in `src/modules/blog-automation/freshness-review.service.ts`,
`freshness-review-prompt.ts`, `revision-request.service.ts`. Authoritative
reference for cadence, evidence guardrails, hashing/idempotency, and
revision-creation rules.

## Candidate selection and cadence

```
riskTier = HIGH_RISK  if post.category in ['Regulatory Updates', 'Enforcement & Penalties']
                        or any BlogPostSource.sourceType === 'OFFICIAL'
         = EVERGREEN  if the linked BlogArticleSuggestion.articleType === 'EVERGREEN_EXPLAINER'
                        (no suggestion origin -> NORMAL, never assumed EVERGREEN)
         = NORMAL     otherwise

cadenceDays = 30 (HIGH_RISK) | 90 (NORMAL) | 180 (EVERGREEN)
nextReviewAt = (lastReviewedAt ?? publishedAt) + cadenceDays
```

`FreshnessReviewService.selectFreshnessCandidates(maxItems)` selects
`PUBLISHED`, non-deleted posts whose computed/stored `nextReviewAt` has
passed (`reason: 'SCHEDULED'`), plus any post with a qualifying new
`RegulatorySignal` since its last review regardless of schedule
(`reason: 'SIGNAL_TRIGGERED'`), capped at `maxItems`.

**Disclosed simplification**: "new linked `RegulatorySignal`" detection uses
jurisdiction-**string** matching (`BlogPost.jurisdiction`, e.g. "Kenya", vs.
`RegulatorySignal.jurisdiction`, e.g. "KE", normalized via a small local code↔label
table mirroring `relevance-scoring.service.ts`'s own `countryMap`) rather than
an exact FK-chain match. `BlogPost` carries no direct FK to `BlogSourceItem`/
`RegulatorySignal` (only a post's origin `BlogArticleSuggestion`, if any, does
via `BlogSuggestionSource`) — building the exact chain match was assessed as
disproportionate scope for this pass versus the string-matching fallback the
governing doc itself describes as the alternative Foundation A's FK exists to
improve on. This uses only already-stored data (no new fetch), and is
flagged here as a concrete improvement opportunity for a future pass.

## Deterministic-first, AI-only-when-justified

Before any AI call, the service computes:

- **`changedSources`**: `BlogPostSource` rows whose `updatedAt` is after the
  last review's `createdAt` (or `publishedAt`, if never reviewed).
- **`newSignals`**: `RegulatorySignal` rows matching the post's jurisdiction,
  `severity IN ('critical', 'high')`, newer than the last review.
- **`brokenSourceCount`**: reused directly from the post's active
  `BlogResearchPack`'s `BlogResearchPackSource.isAvailable === false` rows —
  **never a new fetch/liveness check**, purely a re-read of Stage C7's
  already-computed availability.
- **`staleSourceCount`**: `BlogPostSource` rows with a missing `publishedAt`,
  or one older than `SOURCE_STALENESS_THRESHOLD_DAYS` (730).
- **`sourceSetHashChanged`**: current source-set hash vs. the last review's
  stored hash.

**The AI is only called when at least one of these is non-empty/non-zero.**
If none are, the review is `FRESH` deterministically — `freshnessScore: 100`,
a fixed rationale, zero AI spend. This directly satisfies "age alone must
never produce a stale/revision action": with no evidence, there is
structurally no path to a non-FRESH outcome at all in this implementation,
independent of how old the post is.

## Freshness schema and evidence guardrail

`FreshnessAssessmentSchema` (bounded: ≤20 changed-source refs, ≤20 signal
refs, ≤1000-char rationale) returns `freshnessScore`, `action`
(`FreshnessAction` enum), `rationale`, `changedSourceRefs`,
`relevantSignalRefs`, `brokenSourceCount`, `staleSourceCount`, and optional
`recommendedReviewDate`/`recommendedRevisionSummary`.

Two service-level assertions run on every AI response (both throw
`FreshnessEvidenceGuardrailError`, caught by the outer handler and reported
as a run failure — never silently downgraded):

1. **Evidence-presence guardrail**: any `action !== 'FRESH'` must have at
   least one non-empty/non-zero evidence field
   (`changedSourceRefs`/`relevantSignalRefs`/`brokenSourceCount`/`staleSourceCount`).
2. **Rationale-citation guardrail**: the `rationale` text must actually
   mention at least one of the cited evidence tokens (a ref string, or the
   literal word "broken"/"stale" when those counts are non-zero) — a
   lightweight substring check, not a prose-quality judgment, but enough to
   catch a rationale that asserts staleness without grounding it in the
   evidence it claims to have.

## Persistence

One `BlogFreshnessReview` row per review: `contentHash`, `sourceSetHash`
(reuses `computeFallbackSourceSetHash`, the same function `semantic-verification.service.ts`
uses in its own fallback mode — one hash implementation, not a third
near-identical one), `riskTier`, `freshnessScore`, `action`, `rationale`,
`changedSourceIds`/`newSignalIds` (real row IDs, resolved from the AI's refs
back through the same candidate lists built for the prompt — never the AI's
own invented IDs), `brokenSourceCount`, `staleSourceCount`, `nextReviewAt`,
`modelProvider`/`modelName` (null in the deterministic-FRESH,
no-AI-call path), `promptVersion`.

## Idempotency

- Same `idempotencyKey` → `AgentRun` replay (existing `AgentRunService.beginRun` mechanism).
- **Same-day guard**: a review already created *today* for this post, with
  matching `contentHash` **and** `sourceSetHash`, **and** no newer qualifying
  signal since that review → reused, no new AI call, no new row. Prevents a
  scheduler misfire from burning AI budget twice in one day on the same post.
- Either hash changed, or a newer qualifying signal exists → a new review
  always runs (never silently reused, even same-day).

## Guardrails (verified by construction, not just by test)

- **Never auto-unpublishes or edits content**: `FreshnessReviewPrisma`'s type
  signature has no `blogPost.update` method at all — there is no code path in
  this service that could write to `BlogPost.status` or `.content` even by
  mistake, confirmed by a dedicated test asserting `'update' in prisma.blogPost === false`.
- **`ContentOpsAlert` only for the two most severe actions**:
  `createOrIncrementAlert({ type: 'freshness_urgent_revision', severity: 'HIGH', ... })`
  fires only for `URGENT_REVISION`/`ARCHIVE_RECOMMENDED` — `REVIEW_SOON`
  and lower never alert. Metadata is IDs/action/score/counts only.

## Revision-request creation (`revision-request.service.ts`)

Pure persistence, no AI call, no `AgentRun` — matches the procedure
contract's "AI use case: N/A." Created for `REVISION_REQUIRED` (priority
`MEDIUM`), `URGENT_REVISION` (priority `URGENT`), `ARCHIVE_RECOMMENDED`
(priority `HIGH`); never for `FRESH`/`REVIEW_SOON`/`HUMAN_REVIEW_REQUIRED`.
Always starts `PENDING_REVIEW` — **nothing about the input (priority
included) can produce an auto-approved state**, verified by an explicit test
sweeping all four priority values.

### Idempotency — always caller-supplied, never synthesized

The original design's server-derived key
(`<blogPostId>:<freshnessReviewId ?? 'manual'>:v1`) silently collapsed every
manually-filed revision request for a post into one shared bucket via the
literal `'manual'` fallback — permanently conflicting a second, unrelated
manual request against the first. Corrected: `idempotencyKey` is a real,
required, `@@unique` column the **caller** always supplies.
`deriveFreshnessOriginatedIdempotencyKey(blogPostId, freshnessReviewId)`
gives `runFreshnessReview`'s own internal call a stable, safe key (since
`freshnessReviewId` is always a fresh, unique ID in that path); a
standalone/manual caller must supply its own request-specific key. Verified
by a regression test creating two independent manual requests for the same
post with two different keys, both succeeding as two separate rows.

Duplicate inserts are handled through the `idempotencyKey` unique
constraint — insert, catch `P2002`, look up and return the existing row
(`replayed: true`) — the same pattern `AutomationApprovalService.createApproval`
already uses, not a vulnerable find-then-create.

## Deferred to a later stage

- Router exposure (`agents.automation.listFreshnessReviewCandidates`/`runFreshnessReview`/`createRevisionRequest`) — Stage E.
- Exact FK-chain-based signal matching (see "disclosed simplification" above) — noted as a future improvement, not built in this pass.
- Admin assignment/resolution workflow for `BlogRevisionRequest` (`assignedToId`/`approvedById`/status transitions beyond creation) — this pass only creates requests; the review/resolve workflow is an admin-surface concern, out of scope.
