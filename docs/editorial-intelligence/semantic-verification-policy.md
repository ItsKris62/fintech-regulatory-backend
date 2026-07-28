# Semantic Verification Policy (Pack 1 Phase D, Part 1)

Implemented in `src/modules/blog-automation/semantic-verification.service.ts`,
`semantic-verification-prompt.ts`, `verification-evidence.ts`. Authoritative
reference for severity mapping, evidence resolution, hashing/replay, and the
second-model review policy.

## Extends, never forks, the existing pipeline

`runBlogPostVerification` (`blog-verification.service.ts`) is called
unchanged — its structural/lexical checks, scoring, and issue rows are
untouched. `SemanticVerificationService` runs it first (injected as
`runStructuralVerification`, swappable in tests), then **appends** semantic
`BlogVerificationIssue` rows to the **same** `BlogVerificationRun` row via
`blogVerificationIssue.createMany`, then re-derives the run's final
`status`/`blockingIssueCount`/`warningIssueCount`/`infoIssueCount` from the
**combined** structural + semantic counts, using the same three-line
derivation rule already established in `blog-verification.service.ts`
(`blockingIssues>0 → BLOCKED`; `warningIssues>0 || qualityScore<85 → NEEDS_REVIEW`;
else `PASSED`). This is a second, minimal, explicitly-cited re-application of
that rule — not a parallel verification system.

## Evidence resolution (`verification-evidence.ts`)

Preferred evidence is the post's active `BlogResearchPack` (`status: 'COMPLETE'`,
highest version) — its already-synthesized `obligationsSummary`/`authorities`/
`importantDates` JSON fields, turned into short-lived `Ex`-labelled evidence
items. **Never re-fetches or re-reads raw source bodies** — the research
pack's synthesis IS the evidence, consistent with the procedure contract's
"compare claims against research-pack evidence, not raw source URLs
directly." The pack's own `sourceSetHash` is **reused directly**, never
recomputed, since it's already the authoritative hash of that exact source
set.

**Fallback** (no active research pack): builds evidence items directly from
`BlogPostSource.title`/`.notes`, with an explicit `FALLBACK_CONFIDENCE_PENALTY`
(20) and its own hash (`computeFallbackSourceSetHash`, sorted URL+updatedAt
pairs) — weaker evidence than a synthesized research pack, and callers should
weight `requiresHumanReview` accordingly (this stage doesn't apply the
penalty as a hard block; it's a signal for the human-review computation, not
a schema-enforced clamp on `confidence` values the AI itself returns).

`mode: 'no_evidence'` (no research pack, zero `BlogPostSource` rows) skips
the AI call entirely — nothing to compare claims against.

## Claim schema and severity mapping

`SemanticVerificationSchema` (bounded, ≤40 claims, ≤500-char claim text,
≤600-char explanation) is per the exact taxonomy given: 13
`BlogClaimCategory` values, 6 `BlogClaimVerificationStatus` outcomes. The
model's own `severityOpinion` field is captured but **never used directly**
— the persisted `severity` always comes from `computeClaimSeverity(status, category)`,
the fixed, code-level mapping table from `phase-b-data-model.md` §3:

| Outcome | High-stakes category | Severity |
|---|---|---|
| `VERIFIED` | any | *(no issue row)* |
| `PARTIALLY_SUPPORTED` | yes | `WARNING` |
| `PARTIALLY_SUPPORTED` | no | `INFO` |
| `UNSUPPORTED` | yes | `BLOCKING` |
| `UNSUPPORTED` | no | `WARNING` |
| `CONTRADICTED` | any | `BLOCKING` |
| `STALE_SOURCE` | any | `WARNING` |
| `HUMAN_REVIEW_REQUIRED` | any | `WARNING` |

High-stakes: `LEGAL_OBLIGATION`, `DEADLINE`, `PENALTY`, `LICENSING_REQUIREMENT`,
`REPORTING_REQUIREMENT`, `SECURITY_REQUIREMENT`, `DATA_PROTECTION_REQUIREMENT`,
`REGULATOR_AUTHORITY` (per `phase-b-data-model.md` §3, explicit). Low-stakes:
`INTERPRETATION`, `RECOMMENDATION`, `MARKETING_STATEMENT` (also explicit).
**Gap-fill, disclosed**: `NUMERICAL_CLAIM`/`FACTUAL_EVENT` are not named in
either bucket by the governing doc's mapping table — this implementation
defaults them to high-stakes (conservative), exported as part of
`HIGH_STAKES_CLAIM_CATEGORIES` for auditability, not silently assumed.

### Poisoned/unverified source cannot verify a claim

Code-level enforcement, mirroring Stage C7's obligation downgrade: a claim
whose `sourceRefs` resolve to **zero** known evidence items (all cited refs
were unknown/dropped) cannot remain `VERIFIED`/`PARTIALLY_SUPPORTED` — it is
downgraded to `UNSUPPORTED` before severity mapping runs. Unknown refs are
always dropped, never silently accepted, and logged as
`verification_unknown_source_ref_dropped` (counts only).

## Hashing and replay

Reuses `computeContentHash(post.content)` and the evidence's own
`sourceSetHash` (from the research pack, or the fallback hash) —
`BlogVerificationRun.contentHash`/`.sourceSetHash`/`.promptVersion` are the
authoritative replay signal, **not** `BlogPost.updatedAt` alone (per
`phase-b-data-model.md` §3's correction — an unrelated field edit bumping
`updatedAt` must not force a re-verification).

- Same `idempotencyKey` → `AgentRun` replay (no new AI call, no new row).
- Different key, same `contentHash` **and** same `sourceSetHash` → reuse the
  latest run in a terminal status (`PASSED`/`NEEDS_REVIEW`/`BLOCKED`).
- Either hash changed → runs the full pipeline again (new structural run +
  new semantic pass).

## Second-model review

Triggered per-claim when that claim's **code-computed** severity is
`BLOCKING`, or when the caller explicitly sets `requestSecondReview: true`
(bounds cost — not every claim gets a second opinion, only ones that would
already block). Uses `completeStructured` with an explicit `provider`
override to a **different** provider than the primary pass
(`selectSecondaryProvider`: `openai` unless the primary already used
`openai`, in which case `gemini`) — never the same model asked twice.

- **Agreement** (`secondary.verificationStatus === primary.status`): no
  second row is created: the primary row already stands. This still yields a
  correct disagreement-audit query (`GROUP BY claimHash HAVING COUNT(DISTINCT
  claimVerificationStatus) > 1`) — it simply finds nothing for a claim that
  was never disputed.
- **Disagreement**: a second `BlogVerificationIssue` row is created (never an
  overwrite), sharing the same `claimHash`, `reviewProvenance.pass: 'SECONDARY_REVIEW'`.
  **Both** rows' severity is forced to `BLOCKING` regardless of what the
  mapping table would otherwise say — no model's verdict is silently
  preferred, and a disagreement on a legal claim is unconditionally a
  human-review case.
- **Second provider unavailable, or a budget halt during the second call**:
  caught, logged (`verification_secondary_review_inconclusive`, reason only —
  never claim text), and treated as inconclusive — the primary row still
  persists with its own severity, and `requiresHumanReview` is forced `true`
  via the same `hasUnverifiedSemanticClaim` flag Foundation E's shared policy
  already reads. The whole run is never failed because of this.

## Persistence

`reviewProvenance` is always structured JSON (`{ pass, provider, model, promptVersion }`),
never encoded into free-text `recommendation`. `claimHash` (sha256 of
normalized claim text) correlates a `PRIMARY` row with its `SECONDARY_REVIEW`
counterpart. `sourceId`/`sourceUrl` are populated only in fallback-evidence
mode (research-pack-mode evidence has no single raw source to point at — by
design, since it's synthesized). Raw model output/full article content is
never persisted — only the schema-validated, bounded fields.

## Human-review and ContentOpsAlert integration

Feeds `computeRequiresHumanReview` (`verification: { status, hasUnverifiedSemanticClaim }`)
using the linked `BlogArticleSuggestion`'s fields when present, else
post-derived defaults (mirrors Stage C7's `BlogPost`-only fallback exactly).
Writes back to the suggestion's `requiresHumanReview` **only** when
`EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED` is on (Stage C3's flag, reused). A
`BLOCKED` final status creates/increments a compact `ContentOpsAlert`
(`entityType: 'BlogPost'`, IDs/counts only, `type: 'verification_blocked'`).

## Deferred to a later stage

- Router exposure (`agents.automation.verifyBlogPostClaims`/`getVerificationResult`) — Stage E (per this phase's explicit scope).
- An admin-portal resolution path for a `HUMAN_REVIEW_REQUIRED`-flagged issue — out of this phase's scope (backend service only).
