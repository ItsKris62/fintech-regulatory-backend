# Editorial Triage Policy (Pack 1 Stage C6)

Implemented in `src/modules/blog-automation/editorial-triage.service.ts`,
`editorial-input-hash.ts`. This document is the authoritative reference for
the scoring weights, thresholds, versioning, and idempotency rules the
service implements — read this before changing any constant in that file.

## What this is not

This stage does **not** replace `relevance-scoring.service.ts`. The
deterministic scorer is called, never re-implemented or duplicated. Triage
adds a second, AI-enriched opinion on top of the deterministic score and
combines the two via a fixed, auditable formula — the AI is never allowed to
silently override the deterministic result.

## Candidate resolution

Accepts any of `sourceItemId`, `suggestionId`, `regulatorySignalId` (at least
one required). Resolution preference order: an explicitly-given or
cross-linked `BlogSourceItem` is always preferred; `BlogArticleSuggestion` is
the fallback only when no `BlogSourceItem` can be resolved.

- `suggestionId` alone → looks up the suggestion's linked `BlogSuggestionSource` → `BlogSourceItem`.
- `regulatorySignalId` alone → looks up the signal's `sourceItemId` FK (Foundation A).
- When two or more identities are explicitly given, they must refer to the
  same underlying candidate (checked via the `BlogSuggestionSource`
  compound-unique lookup, or `RegulatorySignal.sourceItemId` equality) — a
  mismatch is rejected, never silently resolved by picking one.

### Suggestion-only fallback (no resolvable `BlogSourceItem`)

`scoreSourceItemForBlogSuggestion` requires a real `BlogSourceItem` (its
`ScoringInput` type is `BlogSourceItem & { monitor: BlogSourceMonitor }`). If
a suggestion's linked source items were later hard-deleted (its
`BlogSuggestionSource` rows cascade-delete with the source item), a
suggestion can legitimately have no resolvable source item left. In that
case, the service falls back to the suggestion's own already-computed
deterministic fields (`relevanceScore`, `category`, `sourceQuality`,
`priority`, `jurisdiction`, `requiresOfficialSource`) rather than fabricate a
score — this is the only path where `suggestionId` (not `sourceItemId`) is
the row's persisted identity and the versioning target. This is a documented
design decision filling a gap the governing docs left implicit, not a
deviation from them.

## Duplicate short-circuit

A candidate is a duplicate when its `BlogSourceItem.status` is
`DUPLICATE`/`CONVERTED_TO_SUGGESTION`, or its `BlogArticleSuggestion.status`
is `DRAFT_CREATED`/`DISMISSED`/`DUPLICATE` (mirroring the already-established
"terminal status" concept from the Stage C3 backfill script). A duplicate
candidate:

- Never triggers a `completeStructured` call (zero AI spend).
- Still creates a **new, `COMPLETE`** `BlogEditorialTriageRun` row with
  `recommendation: REJECT` — chosen over "return an existing result" because
  every triage attempt should leave an auditable row, and a cheap REJECT row
  costs nothing extra to create.
- Still wraps in the normal `AgentRun` lifecycle (`beginRun`/`completeRun`),
  just with zero token/cost usage — the AI call is what's skipped, not the
  audit trail.

## AI enrichment schema (`EditorialEnrichmentSchema`)

Bounded strict Zod schema: `aiRelevanceScore`/`sourceConfidence`/`confidence`
all 0–100 (one consistent scale, matching
`human-review-policy.ts`'s `DEFAULT_STRUCTURED_AI_CONFIDENCE_THRESHOLD`);
`targetAudiences`/`recommendedChannels` capped at 6 items;
`requiresHumanReviewSignals` capped at 8; `rationale` capped at 1200 chars;
every array-item string individually capped. `recommendedArticleType` reuses
the existing `BlogArticleType` enum; `urgency` reuses `BlogSuggestionPriority`
— no new urgency scale.

## Prompt security

The source's `title`/`summary` are wrapped in an explicit `<EVIDENCE>...</EVIDENCE>`
block. The system prompt states the block is evidence, not instructions;
instructs the model to ignore embedded commands regardless of phrasing; and
forbids inferring an authority/obligation not present in the evidence. Uses
`completeStructured` exclusively — never calls `llmGateway.complete()`
directly.

## Input hash (`computeTriageInputHash`)

sha256 of: resolved `sourceItemId`/`suggestionId`, title, summary, source
type, authority type, jurisdiction, publication date, **the deterministic
score itself**, `SCORING_POLICY_VERSION`, and `EDITORIAL_TRIAGE_PROMPT_VERSION`.
Including the deterministic score means a change to the deterministic
scoring formula (a `SCORING_POLICY_VERSION` bump) automatically invalidates
every stored hash, forcing re-triage — without needing to hash the scorer's
internal logic itself. The n8n execution ID is never part of this hash.

## Idempotency and versioning (three independent rules)

1. **Same `idempotencyKey`** → `AgentRunService.beginRun`'s own duplicate
   detection replays the stashed `triageRunId` (read from the `AgentRun`'s
   `metadata`). No new AI call, no new row, no new `AgentRun`.
2. **Different `idempotencyKey`, same `inputHash`** (and `forceRetriage` not
   set) → reuses the latest `COMPLETE` version for the authoritative
   versioning target. No new AI call, no new version — but a **new**
   `AgentRun` row is still created and completed (for its own audit trail),
   at zero cost.
3. **Changed `inputHash`, or `forceRetriage: true`** → creates the next
   version via a read-current-max-then-insert loop that retries on a Postgres
   unique-constraint conflict (`P2002`) up to 5 times — never a vulnerable
   find-then-create race.

**Authoritative versioning target**: `sourceItemId` when resolved, else
`suggestionId` (the suggestion-only fallback path above). The service always
resolves the *next* version by querying whichever single target is present
on the run being created — never both independently, so a candidate's
history cannot fork into two divergent sequences.

**"Authorised" vs. "unauthorised" force retriage**: this stage ships as a
service with no router/capability layer yet (that's Stage C10). At this
layer, "authorised" simply means the caller explicitly passed
`forceRetriage: true` — the router-level authorization gate for who is
allowed to do that is deferred to C10. An **unauthorised** (i.e.
`forceRetriage` omitted or `false`) request with an unchanged `inputHash`
never creates a new version — rule 2 above always wins for it.

## Score combination policy

```
finalScore = round(0.6 × deterministicScore + 0.4 × (aiRelevanceScore ?? deterministicScore))
  capped at 60  if sourceConfidence < 50
  capped at 50  if jurisdiction is not in DEFAULT_SUPPORTED_JURISDICTIONS
```

Weights (`DETERMINISTIC_SCORE_WEIGHT = 0.6`, `AI_SCORE_WEIGHT = 0.4`) and
every threshold above are named exported constants in
`editorial-triage.service.ts` — never inline magic numbers. `sourceConfidence`
comes from the AI when it ran; in the no-AI duplicate path it's derived
deterministically from `sourceQuality` (`OFFICIAL`→100, `HIGH`→80,
`MEDIUM`→60, `LOW`→30) so the low-confidence cap logic still applies
meaningfully even without an AI call.

## Recommendation mapping

```
isDuplicate                              → REJECT
requiresHumanReview (computed, see below) → HUMAN_REVIEW_REQUIRED
finalScore >= 85                          → PRIORITISE_NOW
finalScore >= 70                          → QUEUE
finalScore >= 45                          → MONITOR
else                                      → REJECT
```

`requiresHumanReview` is checked **before** the score thresholds — a
suggestion needing human review is never auto-classified into a score bucket
regardless of how high its score is.

## Human-review integration

Calls the shared `computeRequiresHumanReview` (never a re-derived ad hoc
check) with: `categoryRequiresOfficialSource` (from
`OFFICIAL_SOURCE_REQUIRED_CATEGORIES`), `hasOfficialSource`, `sourceQuality`,
`priority` (AI's `urgency` when available, else the deterministic priority),
`jurisdiction`, and `structuredAiConfidence` (the AI's `confidence` field —
absent, not faked, when no AI ran). The AI's output is one input among many
into this shared deterministic function; it never returns the boolean
itself.

The computed value is **always** persisted on the new `BlogEditorialTriageRun`
row. It is written back onto the linked `BlogArticleSuggestion.requiresHumanReview`
**only when** `EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED` is on (Stage C3's
rollout flag, reused rather than a new one) — this is new write-path
behavior touching already-relied-upon suggestion state, so it inherits the
same safe-default gating Stage C3 established, unlike the run's own new
column which has no legacy readers to protect.

## AgentRun lifecycle

`beginRun` → (duplicate-candidate short-circuit or inputHash-reuse, both
skip the AI call but still `completeRun`) → `completeStructured` →
`createTriageRunWithRetry` → `completeRun` with real token/cost usage. Any
thrown error (including from `completeStructured`) is caught once, the run
is marked `FAILED` via `failRun`, and the original error is rethrown — no
partial/inconsistent row is ever left in a non-terminal state.

## Operational events

`editorial_triage_started` / `editorial_triage_completed` (IDs and
recommendation only) / `editorial_triage_rejected` (fired additionally,
never instead of `_completed`, whenever the final recommendation is
`REJECT`). No rationale, title, or summary text ever appears in a log line.

## Deferred to a later stage

- Router exposure (`agents.automation.triageEditorialCandidate` /
  `getEditorialTriage`) — Stage C10, per this pass's explicit scope.
- `forceRetriage`'s actual authorization/capability gate — Stage C10.
- Tuning the 0.6/0.4 weighting or the score thresholds via a runtime
  `SystemConfig` override — not built in this pass; the constants are
  code-level for now, matching this pass's "safe defaults, bounded values"
  instruction rather than introducing a new tunable-config surface.
