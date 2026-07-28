# Research-Pack Policy (Pack 1 Stage C7)

Implemented in `src/modules/blog-automation/research-pack.service.ts`,
`research-source-classifier.ts`, `editorial-input-hash.ts`. Authoritative
reference for source classification, hashing, versioning, and alerting.

## No new fetching mechanism

This stage builds research packs **only** from sources already present via
`BlogSuggestionSource → BlogSourceItem` and `BlogPostSource`. It never
fetches or scrapes a new URL. `BlogResearchPackSource.externalUrl` exists in
the schema for forward compatibility with a future approved-source-lookup
mechanism, but in this implementation it is only ever copied from an
already-vetted `BlogPostSource.url` — never populated from anywhere else.

## Target resolution

Accepts `blogPostId` and/or `suggestionId` (at least one required). When
both are given, they must be consistently linked
(`suggestion.blogPostId === blogPost.id`) or the request is rejected. Per
Foundation E's corrected policy, **research is never gated on
`requiresHumanReview`** — a suggestion requiring human review can still have
a research pack built for it; this stage never checks that flag as a
precondition.

`blogPostId` is the authoritative versioning target when present;
`suggestionId` otherwise — matching the common pipeline order (triage →
research → draft creation → verification), where research routinely runs
*before* a `BlogPost` exists at all.

### Backfilling `blogPostId` after draft creation

`ResearchPackService.backfillBlogPostIdForSuggestion(suggestionId, blogPostId)`
implements the documented "attach `blogPostId` to the already-active
suggestion-keyed pack as a plain UPDATE, not a new version" behavior. **It is
implemented and tested in this pass but not yet wired into any caller** — the
draft-creation flow that would call it
(`blog-draft.service.ts::createDraftFromCandidate`) is out of this pass's
explicit scope (only C6/C7 were authorized). Wiring this in is a small,
well-defined follow-up for whichever stage next touches draft creation.

## Source gathering, deduplication, classification

Sources are gathered from both `BlogSuggestionSource→BlogSourceItem` (when a
suggestion is resolved) and `BlogPostSource` (when a post is resolved) —
both, when both targets exist, since together they represent the full body
of vetted evidence. Deduplication preference: `sourceItemId` > `postSourceId`
> normalized-URL match — a `BlogPostSource` sharing a normalized URL with an
already-loaded `BlogSourceItem` is skipped rather than sent to the AI prompt
twice.

Each deduplicated source gets a short, stable `sourceRef` (`S1`, `S2`, ...)
used throughout the AI prompt and response — the AI never sees or invents
internal database IDs.

Classification (`research-source-classifier.ts::classifySource`) runs
**before** the AI call, deterministically, in strict precedence order:
`isApprovedCorpus` flag → `APPROVED_CORPUS`; `GAZETTE` authority →
`LEGISLATION`; `LEGAL_DATABASE` authority → `OFFICIAL_GUIDANCE`; `OFFICIAL`
sourceType + a regulator authority type → `OFFICIAL_REGULATOR`;
`INTERNATIONAL_STANDARD` → `OFFICIAL_GUIDANCE`; `INDUSTRY_BODY` →
`INDUSTRY_SOURCE`; `INTERNAL` → `COMPANY_SOURCE`; `MEDIA` → `REPUTABLE_NEWS`;
explicit `isUserGenerated` → `USER_GENERATED`; anything else → `UNVERIFIED`.
**The AI is never given the opportunity to assign or upgrade a category or
trust level** — it only ever references sources by `sourceRef`.
`trustLevel` (0–100, independent of `category`) is lowered by a fixed 20-point
penalty (floored at 0) when a source is unavailable, without ever changing
its category.

## Hashing (two separate hashes, never one)

- **`inputHash`** (`computeResearchInputHash`) — sha256 of the research
  objective + canonical target id + prompt version + research policy
  version. Isolates "did what we were asked to research change" independent
  of the source set.
- **`sourceSetHash`** (`computeResearchSourceSetHash`) — sha256 of every
  deduplicated source's stable id, normalized URL, content hash, publication
  date, availability, category, and trust level, in sorted order. **Never
  URLs alone** — a source whose content changed behind a stable URL, or
  whose publication date was corrected, changes this hash even though no URL
  moved.

## AI synthesis schema (`ResearchSynthesisSchema`)

Strict, bounded Zod schema: `executiveSummary` (≤3000 chars);
`importantDates`/`authorities` (≤15 each); `obligations` (≤25, each with a
`BlogClaimCategory` and up to 10 `sourceRefs`); `evidenceGaps` (≤15);
`contradictions` (≤10); `confidence` (0–100). Every finding that references a
source must do so via its `sourceRef` — **any reference to an unknown
`sourceRef` is dropped from that specific finding (never upgrades, never
fails the whole pack)**, logged as `research_pack_unknown_source_ref_dropped`.

### Code-level enforcement: no legal obligation without official support

The prompt instructs the model not to conclude a legal obligation without an
official/legislative source — but this is **also enforced in code**, not
left to the model's compliance alone (`enforceOfficialSourceForHighStakesObligations`).
Any obligation whose category is one of `LEGAL_OBLIGATION`/`DEADLINE`/
`PENALTY`/`LICENSING_REQUIREMENT`/`REPORTING_REQUIREMENT`/`SECURITY_REQUIREMENT`/
`DATA_PROTECTION_REQUIREMENT` and whose `sourceRefs` do not include at least
one source classified `OFFICIAL_REGULATOR`/`LEGISLATION`/`OFFICIAL_GUIDANCE`/
`APPROVED_CORPUS` is **downgraded**: removed from `obligationsSummary` and
appended to `evidenceGaps` instead (never silently dropped). This is the
concrete mechanism behind "a poisoned/unverified source cannot verify a legal
obligation" — a misbehaving or successfully-prompt-injected model cannot
bypass it merely by asserting a claim in its JSON response.

## Prompt security

Every source is wrapped in an explicit `<SOURCE id="Sx" category="..." trustLevel="..." available="...">...</SOURCE>`
block. The system prompt states this content is evidence, not instructions;
instructs the model to ignore embedded commands; requires every fact to cite
its `sourceRef`; forbids inventing an authority; requires disagreements to be
reported as `contradictions` rather than silently resolved; and requires
uncertainty to become an `evidenceGaps` entry rather than a guess. Uses
`completeStructured` exclusively, with `overrideTimeoutMs: aiConfig.timeout.policyGeneration`
(120s) — multi-source synthesis needs more time than the 60s default.

## Idempotency and versioning

Same three-rule structure as Stage C6 (same `idempotencyKey` → `AgentRun`
replay; different key + unchanged `inputHash`+`sourceSetHash` → reuse the
latest active version; either hash changed, or `forceRegenerate: true` →
next version). **Both** hashes must match for a reuse — either one changing
is sufficient grounds for a new version. Version allocation uses the same
read-then-insert-with-retry-on-`P2002` pattern as Stage C6, capped at 5
attempts.

**Superseding is transactional and synthesis-gated**: the prior active
version (`DRAFT`/`COMPLETE`) is marked `SUPERSEDED` in the **same**
`$transaction` that creates the new `COMPLETE` version and its
`BlogResearchPackSource` rows. If structured synthesis throws, the
transaction is never entered at all — the prior version is never touched and
no new pack row is created, satisfying "avoid creating a COMPLETE research
pack if persistence fails" together with "do not supersede before successful
synthesis."

## Human-review integration

After synthesis, feeds `research: { evidenceGapCount, contradictionCount }`
(plus `structuredAiConfidence: confidence`) into the same shared
`computeRequiresHumanReview` function Stage C6 uses. When a suggestion is
resolved, `hasOfficialSource`/`sourceQuality`/`priority`/`jurisdiction` come
from the suggestion's own fields; for a `BlogPost`-only target with no
suggestion, they're derived from the post's own `category`/`jurisdiction`
plus whether any *loaded* source classified as `OFFICIAL_REGULATOR`/
`LEGISLATION`. The computed value is written back onto the linked
suggestion's `requiresHumanReview` **only when**
`EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED` is on (same Stage C3 flag Stage C6
reuses) — **research completion never auto-promotes or auto-approves** the
suggestion; only this one boolean is ever touched.

## ContentOpsAlert integration

`createOrIncrementAlert` fires when `evidenceGaps.length >= 1` OR
`contradictions.length >= 1` OR `confidence < 50` (named constants
`ALERT_MIN_EVIDENCE_GAPS`/`ALERT_MIN_CONTRADICTIONS`/`ALERT_LOW_CONFIDENCE_THRESHOLD`).
Severity is `HIGH` when there's a contradiction or low confidence, else
`MEDIUM`. `entityType: 'BlogResearchPack'`, `entityId: <the pack's id>`.
Metadata is compact and IDs/counts-only (`researchPackId`,
`suggestionId`/`blogPostId`, `evidenceGapCount`, `contradictionCount`,
`confidence`) — never research text, per the sanitizer's own enforcement in
`createOrIncrementAlert` and re-confirmed by a dedicated test here.

## AgentRun lifecycle

`beginRun` → gather+dedupe sources → `advanceRun` (records `sourceCount`) →
`completeStructured` → `advanceRun` (records token/cost usage) → transactional
persistence → `completeRun`. Any thrown error → `failRun`, rethrow — no
partial pack is ever left behind.

## Operational events

`research_pack_started` / `research_pack_completed` (IDs and
`evidenceGapCount` only) / `research_pack_gap_detected` (fired additionally
whenever `evidenceGapCount > 0`, not instead of `_completed`). No source
content, executive summary, or rationale text ever appears in a log line.

## Deferred to a later stage

- Router exposure (`agents.automation.createResearchPack` /
  `getResearchPack`) — Stage C10.
- Wiring `backfillBlogPostIdForSuggestion` into the draft-creation flow —
  next touch of `blog-draft.service.ts`, out of this pass's scope.
- Stale-pack detection via `runFreshnessReview` recomputing `sourceSetHash`
  against a live post — Stage C9 (`BlogFreshnessReview`), not built here.
  This stage's own hashing makes that future integration straightforward
  (the hash already exists and is stored), but the recompute trigger itself
  is Stage C9's responsibility.
