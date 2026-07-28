# SheriaBot Pack 1 — Phase B: Domain Data Model

Status: design proposal. Prisma model definitions below are the target schema
state; see `phase-b-migration-plan.md` for the additive SQL to reach it. Nothing in
this document has been applied.

Naming follows the existing `Blog<Noun>` / `Blog<Noun>Run` convention observed
across `BlogDiscoveryRun`, `BlogVerificationRun`, `BlogDraftGenerationRun`, and
`Blog<Noun><Child>` for one-to-many detail rows (`BlogPostSource`,
`BlogSuggestionSource`, `BlogVerificationIssue`).

---

## 1. Editorial triage assessment → `BlogEditorialTriageRun`

### Decision

**New related model**, not fields bolted onto `BlogArticleSuggestion` and not a
transient `AgentReport` payload. Rationale:

- `BlogArticleSuggestion` already carries `relevanceScore`/`priority`/`sourceQuality`
  from the *deterministic* scorer (`relevance-scoring.service.ts`). Triage adds an
  *AI-enriched* second opinion on top of that score — persisting both on the same
  row would either overwrite the deterministic fields (losing the audit trail of
  what the rule engine originally said) or require doubling every scoring column
  with an `ai`-prefixed twin, which pollutes the suggestion model with a second
  concern it wasn't designed for.
- `BlogArticleSuggestion` has no versioning concept, but triage must be re-runnable
  (a source item's classification can be re-triaged after a research pack surfaces
  new information) — a suggestion is 1:1 with its eventual `BlogPost`
  (`blogPostId String? @unique`, schema.prisma:3330), so it cannot hold multiple
  historical triage attempts.
- `AgentReport` (schema.prisma:3385-3395) is a generic `Json?`-bag keyed only to an
  `AgentRun`, with no relation back to a `BlogArticleSuggestion`/`BlogSourceItem`
  and no queryable typed columns — using it would make every admin-portal query
  ("show me all HUMAN_REVIEW_REQUIRED triage results") a JSON-path scan instead of
  an indexed column read, which is exactly the tradeoff `BlogVerificationRun` was
  already built to avoid over raw `AgentReport.signals` JSON.

### Model

```prisma
enum BlogEditorialRecommendation {
  PRIORITISE_NOW
  QUEUE
  MONITOR
  REJECT
  HUMAN_REVIEW_REQUIRED
}

enum BlogEditorialTriageStatus {
  PENDING
  RUNNING
  COMPLETE
  FAILED
}

model BlogEditorialTriageRun {
  id String @id @default(cuid())

  sourceItemId String?
  suggestionId String?
  agentRunId   String?

  version Int @default(1)

  deterministicScore Int // copied from relevance-scoring.service.ts at triage time, for audit even if the suggestion's own score later changes
  aiRelevanceScore   Int?
  finalScore         Int // see combination policy below — never silently overridden by AI alone

  recommendation      BlogEditorialRecommendation
  urgency             BlogSuggestionPriority // reused enum (LOW/MEDIUM/HIGH/URGENT) — no new urgency scale
  targetAudiences     String[] @default([])
  recommendedArticleType BlogArticleType? // reused enum
  recommendedChannels String[] @default([]) // e.g. ["blog", "newsletter"] — free strings, no existing channel enum to reuse
  rationale           String   @db.Text
  sourceConfidence    Int      // 0-100, mirrors BlogSourceQuality's intent but numeric for combination math

  requiresHumanReview Boolean @default(true) // see Foundation E policy — defaults conservative

  modelProvider String?
  modelName     String?
  promptVersion String  @default("editorial-triage-v1")
  inputHash     String  // sha256 of the normalized triage input, for idempotency (see procedure contract)

  status       BlogEditorialTriageStatus @default(PENDING)
  errorMessage String?                    @db.Text

  createdAt   DateTime  @default(now())
  completedAt DateTime?

  sourceItem BlogSourceItem?        @relation(fields: [sourceItemId], references: [id], onDelete: SetNull)
  suggestion BlogArticleSuggestion? @relation(fields: [suggestionId], references: [id], onDelete: SetNull)
  agentRun   AgentRun?              @relation(fields: [agentRunId], references: [id], onDelete: SetNull)

  @@unique([sourceItemId, version])
  @@unique([suggestionId, version])
  @@index([suggestionId])
  @@index([recommendation])
  @@index([status])
  @@index([createdAt])
}
```

- `sourceItemId`/`suggestionId` are both nullable and independent: a triage run can
  target a raw `BlogSourceItem` (pre-suggestion, the W-CONTENT-04 entry point) or a
  `RegulatorySignal`-derived candidate that has no `BlogSourceItem` yet (see
  Foundation A — once the FK exists, a `RegulatorySignal` candidate can still be
  resolved to `sourceItemId` when populated; when absent, `suggestionId` may be
  populated instead if triage runs after a suggestion already exists). At least one
  of the two must be set — enforced at the procedure/service layer (Zod
  `.refine()` in the input schema), not as a DB constraint, since Postgres has no
  native "at least one of these two nullable columns" check without a `CHECK`
  constraint this project's additive-migration convention doesn't otherwise use.
- **Two unique indexes, one authoritative versioning target.** `@@unique([sourceItemId, version])`
  and `@@unique([suggestionId, version])` both exist because Postgres ignores `NULL`
  in unique indexes — a row with only `suggestionId` set doesn't collide against the
  `sourceItemId` index and vice versa, so both must be present for a version
  collision to be caught regardless of which identifier a given run happens to
  carry. **The service, not the schema, decides which one is authoritative for a
  given re-triage**: if `sourceItemId` is present on the run being created, it is
  always the versioning target (it's the earlier-assigned, more stable identity —
  present from the moment a `BlogSourceItem` exists, before any suggestion does);
  `suggestionId` is the versioning target only when `sourceItemId` is absent (a
  `RegulatorySignal`-only candidate with no linked source item, or a re-triage
  triggered from suggestion context alone). A run must never be created with both
  fields populated by a caller expecting two independent version counters to
  advance together — the service resolves the *next* version number by querying
  whichever single target is present, never both, so a candidate's version history
  cannot fork into two divergent sequences.
- `PRIORITISE_NOW | QUEUE | MONITOR | REJECT | HUMAN_REVIEW_REQUIRED` **is** a new
  enum (`BlogEditorialRecommendation`) — nothing existing represents "should this
  become an article," only "how urgent is it" (`BlogSuggestionPriority`, reused
  directly for `urgency`) and "what state is the suggestion in"
  (`BlogSuggestionStatus`, a different axis).

### Idempotency and re-triage rules

`inputHash` (sha256 of the normalized triage input — the resolved `BlogSourceItem`/
`RegulatorySignal` content plus `promptVersion`) and the caller-supplied
`idempotencyKey` (procedure input, not a model column) are two **separate**
concepts governing two separate questions:

1. **Same `idempotencyKey` → replay the same result.** This is the standard
   `AgentRunService.beginRun` duplicate-detection path (§ procedure contracts) — a
   network-level retry of the exact same call never re-runs the AI or creates a new
   `BlogEditorialTriageRun` row.
2. **Different `idempotencyKey`, same `inputHash` → reuse the latest completed
   result by default.** Before calling the AI, `triageEditorialCandidate` checks
   for an existing `COMPLETE`-status `BlogEditorialTriageRun` for the same
   versioning target (per the authoritative-target rule above) whose `inputHash`
   matches. If found, that result is returned and **no new version is created** —
   a second, differently-keyed call (e.g. a different n8n execution re-triaging
   because it re-polled the same candidate) is not itself evidence anything
   changed.
3. **Changed `inputHash` → create the next version.** Only when the normalized
   input actually differs from the latest version's stored `inputHash` (new
   evidence — e.g. the source item's summary was updated, or a linked research
   pack now exists where none did before) does a new `BlogEditorialTriageRun`
   version get created.
4. **Forced re-triage is an explicit, separate input flag** (`forceRetriage:
   z.boolean().optional()` on `triageEditorialCandidate`'s input — see
   `phase-b-procedure-contracts.md`), not an implicit consequence of calling the
   procedure again. When set, it bypasses rule 2 (reuse-by-inputHash) and always
   creates a new version even if `inputHash` is unchanged — used only for a
   deliberate manual re-triage action (e.g. an admin explicitly requesting a fresh
   AI opinion), logged with its own operational event field
   (`forced: true`) so it's distinguishable in audit trail from an
   evidence-driven re-triage.

**A new n8n `executionId` alone is never sufficient reason to create a new
version** — `executionId` is not part of `inputHash` and is not compared against
anything for versioning purposes; it exists only as the `Idempotency-Key`
transport-level header and in operational log correlation fields, never as a
triage-versioning signal.

### Scoring/combination policy

```
finalScore = round(
  0.6 * deterministicScore +
  0.4 * (aiRelevanceScore ?? deterministicScore)
) adjusted by:
  - sourceConfidence < 50 → finalScore capped at 60 (a low-confidence source can't produce a URGENT/PRIORITISE_NOW recommendation regardless of raw score)
  - jurisdiction not in supported set → finalScore capped at 50
  - duplicate-risk flag (see below) set → recommendation forced to REJECT regardless of finalScore
```

- **The AI never silently overrides the deterministic score**: `aiRelevanceScore` is
  a second input into a fixed weighted formula, not a replacement value, and the
  weighting (60% deterministic / 40% AI) is a named constant in the service, not a
  magic number inline — auditable and independently tunable via `SystemConfig` the
  same way `aiDailyCostLimit` already is.
- **Duplication risk**: before scoring, the triage procedure checks for an existing
  `BlogSuggestionSource`/`BlogArticleSuggestion` already linked to the same
  `sourceItemId` (existing check already present in `suggestion-builder.ts:49-60`) —
  a duplicate short-circuits to `REJECT` without spending an AI call.
- Recommendation thresholds (subject to tuning, but must be explicit and testable):
  `finalScore >= 85 AND requiresHumanReview == false → PRIORITISE_NOW`;
  `finalScore >= 70 → QUEUE`; `finalScore >= 45 → MONITOR`; below → `REJECT`;
  **any** `requiresHumanReview == true` computed per Foundation E policy overrides
  the score-based bucket and forces `HUMAN_REVIEW_REQUIRED`, regardless of score.

---

## 2. Research pack → `BlogResearchPack` + `BlogResearchPackSource`

### Decision

Two models, not one flat table and not three. A single flat `BlogResearchPack` row
with array/JSON columns for sources was rejected because per-source fields
(trust level, availability, contradiction flag) need independent indexing and
independent updates (a single source going stale shouldn't require rewriting the
whole pack's JSON blob) — the existing `BlogPost`/`BlogPostSource` and
`BlogArticleSuggestion`/`BlogSuggestionSource` pairs are the direct precedent. A
third `BlogResearchFinding` model (one row per extracted fact) was evaluated and
**rejected for Phase B**: the illustrative brief's "extracted facts" and "important
dates"/"authorities"/"obligations" fields don't yet have a demonstrated need for
independent per-finding querying (no admin surface requirement asks to filter or
paginate individual findings across packs) — they are stored as structured JSON
columns on `BlogResearchPack` itself instead, re-evaluated as a normalization
candidate only if a real query pattern demands it later (YAGNI, per the "do not
over-normalise without justification" instruction).

**Pipeline-order consequence (corrected from the original design)**: the governing
pipeline order is triage → research → draft creation → verification (`W-CONTENT-04
→ W-CONTENT-05 → W-CONTENT-02 → W-CONTENT-06`), and per Foundation E's corrected
policy, research must be able to run *before* a `BlogPost` exists at all (research
gathers the evidence a human needs to decide on draft promotion, it does not wait
for that decision). This means `blogPostId` is expected to be **null at creation
time** in the common path — `suggestionId` is the primary key for a pack created
pre-draft. When draft creation later happens (an existing suggestion is promoted
and a `BlogPost` row is created from it), the service **backfills `blogPostId`
onto the already-active pack row** (a plain `UPDATE`, not a new version — the
research findings themselves haven't changed, only the fact that a post now
exists to attach them to) rather than creating a redundant `blogPostId`-keyed
version 1 alongside the existing `suggestionId`-keyed history. A pack's version
history is therefore always scoped to a single identity over its lifetime
(`suggestionId` before draft creation, `blogPostId` from draft creation onward on
the *same* row/version lineage) — never two parallel counters for one candidate.

### Model

```prisma
enum BlogResearchPackStatus {
  DRAFT
  COMPLETE
  SUPERSEDED
  FAILED
}

enum BlogResearchSourceCategory {
  OFFICIAL_REGULATOR
  LEGISLATION
  OFFICIAL_GUIDANCE
  APPROVED_CORPUS
  REPUTABLE_NEWS
  INDUSTRY_SOURCE
  COMPANY_SOURCE
  USER_GENERATED
  UNVERIFIED
}

model BlogResearchPack {
  id String @id @default(cuid())

  blogPostId   String?
  suggestionId String?

  version Int                    @default(1)
  status  BlogResearchPackStatus @default(DRAFT)

  researchObjective String  @db.Text
  executiveSummary  String? @db.Text

  importantDates      Json? // [{ label, date, sourceId }]
  authorities         Json? // [{ name, role, sourceId }]
  obligationsSummary  Json? // [{ obligation, category, sourceId }] -- category values drawn from BlogClaimCategory (§3), not re-declared here
  evidenceGaps        String[] @default([])
  contradictions      Json?    @default("[]") // [{ claim, sourceIdA, sourceIdB, note }]

  confidence Int // 0-100

  modelProvider String?
  modelName     String?
  promptVersion String  @default("research-pack-v1")
  inputHash     String  // sha256 of (researchObjective + promptVersion) -- identifies "what were we asked to research," independent of which sources answered it
  sourceSetHash String  // sha256 of each linked BlogResearchPackSource's own contentHash+publicationDate (sorted, stable order) -- NOT URLs alone; a source whose content changed behind the same URL, or whose publicationDate was corrected, must change this hash even though the URL didn't move (see §11 rationale)

  reviewerStatus String?   @default("PENDING") // PENDING | APPROVED | REJECTED -- plain string, matching this codebase's convention of leaving lightweight admin-decision fields as strings rather than minting a single-use enum (same precedent as BlogSourceMonitor.verificationStatus, BlogEditorialDigest.status)
  reviewedById   String?
  reviewedAt     DateTime?

  createdAt DateTime @default(now())

  blogPost   BlogPost?               @relation(fields: [blogPostId], references: [id], onDelete: SetNull)
  suggestion BlogArticleSuggestion?  @relation(fields: [suggestionId], references: [id], onDelete: SetNull)
  reviewedBy User?                   @relation("BlogResearchPackReviewedBy", fields: [reviewedById], references: [id])
  sources    BlogResearchPackSource[]

  @@unique([blogPostId, version])
  @@unique([suggestionId, version])
  @@index([suggestionId])
  @@index([status])
  @@index([createdAt])
}

model BlogResearchPackSource {
  id             String @id @default(cuid())
  researchPackId String

  sourceItemId   String? // link back to BlogSourceItem when the source originated from the monitored pipeline
  postSourceId   String? // link to an existing BlogPostSource row when this pack backs an already-drafted post
  externalUrl    String? // only when neither of the above applies and an approved public-web mechanism supplied it -- see guardrail

  title           String
  publisher       String?
  authority       String?
  jurisdiction    String?
  category        BlogResearchSourceCategory
  publicationDate DateTime?
  retrievalDate   DateTime @default(now())
  trustLevel      Int // 0-100, independent of `category` -- e.g. an OFFICIAL_REGULATOR source with a broken URL still gets category OFFICIAL_REGULATOR but a lowered trustLevel
  contentHash     String?
  isAvailable     Boolean  @default(true)
  isContradictory Boolean  @default(false)

  createdAt DateTime @default(now())

  researchPack BlogResearchPack @relation(fields: [researchPackId], references: [id], onDelete: Cascade)
  sourceItem   BlogSourceItem?  @relation(fields: [sourceItemId], references: [id], onDelete: SetNull)
  postSource   BlogPostSource?  @relation(fields: [postSourceId], references: [id], onDelete: SetNull)

  @@index([researchPackId])
  @@index([sourceItemId])
  @@index([category])
}
```

- `BlogResearchSourceCategory` is a **new** enum, deliberately not a reuse of
  `BlogSourceType` (OFFICIAL/THIRD_PARTY/INTERNAL/MEDIA/INTERNATIONAL_STANDARD).
  `BlogSourceType` answers "what kind of source is this for editorial-quality
  scoring purposes" (a 5-value coarse scale already load-bearing across
  `BlogPostSource`/`BlogSourceItem`/verification gates); the research-pack brief
  requires a 9-value provenance taxonomy that distinguishes `LEGISLATION` from
  `OFFICIAL_GUIDANCE` from `APPROVED_CORPUS` — collapsing those into
  `BlogSourceType.OFFICIAL` would lose exactly the distinction research packs exist
  to preserve. `APPROVED_CORPUS` explicitly means "SheriaBot's own verified legal
  corpus," which `BlogSourceType` has no equivalent for at all.
- **Guardrail enforcement**: `externalUrl` may only be populated by a research-pack
  creation flow that used an already-approved public-source mechanism (per the
  governing "no web scraping without an existing approved mechanism" rule) — Phase B
  does not introduce a new scraping mechanism, so in the initial implementation
  `externalUrl` will in practice only ever be populated by copying an already-vetted
  `BlogSourceItem.url` or `BlogPostSource.url`; the column exists for forward
  compatibility with an approved-source-lookup mechanism, not as a bypass.
- **`inputHash` vs. `sourceSetHash` (corrected from a single `contentHash`)**: the
  original design used one hash of "objective + sorted source URLs," which cannot
  detect two real changes: (1) the objective/prompt version changing while sources
  stay the same, and (2) a source's *content* changing behind a stable URL (a
  regulator quietly updates a guidance page) or its `publicationDate` being
  corrected after the fact — a URL-only hash is blind to both. `inputHash` isolates
  concern (1); `sourceSetHash` is computed from each `BlogResearchPackSource`'s own
  `contentHash`/`publicationDate` fields (already present on that child model,
  populated at source-ingestion time via the same `content-hash.ts` normalization
  `BlogSourceItem` already uses) rather than from `externalUrl`/`sourceItemId`
  identity — so a source going stale in place is detectable without the URL set
  ever changing.

### Versioning

- **Authoritative versioning target** (same rule as `BlogEditorialTriageRun` §1):
  `blogPostId` when present is authoritative (a post already exists — the common
  case once draft creation has happened); `suggestionId` is authoritative only
  when `blogPostId` is absent (the common case for research done *before* draft
  creation, per the pipeline-order note above). The service resolves the next
  version number and the supersede target against whichever single identifier is
  actually present on the pack being created — never both independently. The
  backfill described above (attaching `blogPostId` once a post is created) updates
  the *existing* row in place rather than switching which unique index "owns" the
  version lineage retroactively.
- **Version increment**: a new `BlogResearchPack` row per version increment (on the
  authoritative target), never an in-place overwrite of a `COMPLETE` pack's
  content — mirrors `BlogDraftGenerationRun`'s "one row per attempt" pattern rather
  than `BlogSourceMonitor`'s "one row, mutated in place" pattern, because a research
  pack's history (what did we believe at v1 vs. v3) is itself an audit artifact
  claim-verification will need to reference.
- **Superseded**: creating version N+1 sets version N's `status` to `SUPERSEDED` in
  the same transaction — exactly one `COMPLETE` (or `DRAFT`, mid-generation) pack
  per target at a time; historical versions stay queryable.
- **Active pack**: `findFirst({ where: { OR: [{blogPostId}, {suggestionId}], status: { in: ['DRAFT','COMPLETE'] } }, orderBy: { version: 'desc' } })` — no separate `isActive` boolean column needed, `status` already disambiguates.
- **Stale-pack detection**: `sourceSetHash` (see below) is recomputed whenever
  `runFreshnessReview` (Domain Contract §4) runs against the linked `BlogPost`; a
  mismatch against the pack's stored `sourceSetHash` signals the pack's source set
  no longer reflects reality and should trigger a new version, not silent reuse.
  `inputHash` is not expected to change on a freshness-driven recompute (the
  research objective doesn't change just because a source went stale) — only
  `sourceSetHash` drift triggers this path.
- **Retry idempotency**: `createResearchPack`'s idempotency key
  (`W-CONTENT-05:research:<blogPostId or suggestionId>:v<version>`) makes a retried
  call with the same target and version a safe no-op replay (see
  `phase-b-procedure-contracts.md`), consistent with the `<WORKFLOW>:<op>:<key>:v1`
  convention already used by W-CONTENT-02/03.
- **Deletion behavior** (req corrected from Cascade): `blogPostId`'s FK is
  `onDelete: SetNull`, not `Cascade` — a research pack is an audit artifact of what
  was investigated and found, independently valuable even if the post it was
  attached to is later hard-deleted (which, per `blog.router.ts::adminDelete`,
  never actually happens today — deletion there is a soft `deletedAt` update, so
  this only matters for a hypothetical future hard-delete path). `suggestionId`
  was already `SetNull` and is unchanged.

---

## 3. Semantic claim verification → extend `BlogVerificationRun` / `BlogVerificationIssue`

### Decision

**Extend, do not fork.** `BlogVerificationRun`/`BlogVerificationIssue` already model
exactly the shape needed: a run with aggregate scores and a status
(`PENDING/RUNNING/PASSED/NEEDS_REVIEW/BLOCKED/FAILED`), and child issue rows with
`severity`/`issueType`/`claimText`/`sourceId`/`sourceUrl`/`recommendation` — several
of which (`sourceId`, `sourceUrl`, `recommendation`, `paragraphIndex`,
`sentenceIndex`) are already-existing, currently-unpopulated columns (confirmed:
`runBlogPostVerification` in `blog-verification.service.ts` never sets `sourceId`,
`recommendation`, `paragraphIndex`, or `sentenceIndex` on any issue it creates —
verified by reading every `issues.push(...)` call site, none include those fields).
Semantic verification populates these existing but dormant columns rather than
requiring new ones for them.

Genuinely new concerns need new nullable columns because they don't map onto the
existing `issueType`/`severity` axes (which encode "what kind of structural
problem is this," not "what did AI-vs-evidence comparison conclude," nor "which
model/provider produced this verdict"): `claimCategory`/`claimVerificationStatus`/
`confidence` on `BlogVerificationIssue` for the semantic outcome itself;
`claimHash`/`reviewProvenance` on the same table for correlating and auditing
multi-pass review (corrected — the original design tried to fold provenance into
free-text `recommendation`, which is not queryable); and `contentHash`/
`sourceSetHash`/`promptVersion` on `BlogVerificationRun` so replay/staleness
decisions don't rely solely on `BlogPost.updatedAt` (corrected — see below):

```prisma
enum BlogClaimCategory {
  LEGAL_OBLIGATION
  DEADLINE
  PENALTY
  REGULATOR_AUTHORITY
  LICENSING_REQUIREMENT
  REPORTING_REQUIREMENT
  SECURITY_REQUIREMENT
  DATA_PROTECTION_REQUIREMENT
  NUMERICAL_CLAIM
  FACTUAL_EVENT
  INTERPRETATION
  RECOMMENDATION
  MARKETING_STATEMENT
}

enum BlogClaimVerificationStatus {
  VERIFIED
  PARTIALLY_SUPPORTED
  UNSUPPORTED
  CONTRADICTED
  STALE_SOURCE
  HUMAN_REVIEW_REQUIRED
}
```

```prisma
model BlogVerificationRun {
  // ...all existing fields unchanged...

  contentHash   String? // sha256 of BlogPost.content at the time this run executed -- nullable so existing/structural-only runs are unaffected
  sourceSetHash String? // sha256 of linked BlogPostSource content+dates at run time -- same rationale as BlogResearchPack's split hash (§2/§11): updatedAt alone can't distinguish "the post changed" from "a source changed," and can be defeated by any future code path that touches updatedAt without a real content change
  promptVersion String? // set only when the semantic (AI-assisted) pass actually ran -- null for pre-Pack-1 structural-only runs, matching BlogDraftGenerationRun's promptVersion precedent but nullable here since not every run is AI-assisted
}

model BlogVerificationIssue {
  // ...all existing fields unchanged...

  claimCategory           BlogClaimCategory?           // null for structural/lexical issues (the 17 existing issueType values); set only for semantic-verification issues
  claimVerificationStatus BlogClaimVerificationStatus?  // null unless claimCategory is set
  confidence              Int?                          // 0-100, AI confidence in this specific claim's verification outcome
  claimHash               String?                       // sha256 of normalized claimText -- correlates multiple issue rows (primary pass + forced secondary-review row) that concern the SAME underlying claim; see "query and audit requirements" below
  reviewProvenance        Json?                         // structured, typed shape -- see below; NEVER free text in `recommendation`

  // existing sourceId/sourceUrl/recommendation columns now populated for semantic issues
}
```

**`reviewProvenance` fixed shape** (corrected from the original design, which put
this information only in the free-text `recommendation` field — not queryable,
not auditable as structured data):

```ts
{
  pass: 'PRIMARY' | 'SECONDARY_REVIEW';
  provider: string;   // LLMProviderName ('anthropic' | 'openai' | 'gemini')
  model: string;
  promptVersion: string;
}
```

Each `BlogVerificationIssue` row carries exactly one `reviewProvenance` describing
which pass produced *that row*. A disagreement is represented as two rows sharing
the same `claimHash` — one with `reviewProvenance.pass: 'PRIMARY'`, one with
`'SECONDARY_REVIEW'` — never as one row with both providers' names concatenated
into a string.

**Query and audit requirements this unlocks** (previously impossible with
free-text-only provenance):
- *"Which provider/model produced this specific verification issue?"* —
  `SELECT reviewProvenance->>'provider', reviewProvenance->>'model' FROM
  "BlogVerificationIssue" WHERE id = ?`, a direct structured read, not a
  regex/string-parse over `recommendation`.
- *"Show every pass that touched this claim, across primary and secondary
  review"* — `SELECT * FROM "BlogVerificationIssue" WHERE "claimHash" = ? AND
  "runId" = ? ORDER BY "createdAt"`.
- *"Show every claim where the two models disagreed"* — a `GROUP BY claimHash
  HAVING COUNT(DISTINCT "claimVerificationStatus") > 1` within a single
  `BlogVerificationRun`, used by the admin verification-report page to visually
  flag disagreement rows distinctly from single-pass issues.
- *"How often does provider X's secondary review differ from the primary
  provider, over time?"* — an operational/quality metric query across
  `reviewProvenance->>'provider'` and `claimVerificationStatus`, grouped by
  `createdAt` — useful for tuning which non-Anthropic provider to prefer for
  second-model review, not required for Phase B itself but explicitly enabled by
  storing this as structured JSON rather than prose.

- One new `BlogVerificationIssueType` enum value is added:
  `SEMANTIC_CLAIM_ISSUE` — a single marker distinguishing "this row came from AI
  semantic claim verification" from the 17 existing lexical/structural detectors,
  so existing code that switches on `issueType` (none currently does exhaustively,
  confirmed by grep) is not broken by the new value, and reporting can cleanly
  separate "structural/lexical issues" from "semantic claim issues" without
  inferring it from `claimCategory` being non-null. `VERIFIED` claims (fully
  supported, no issue) do **not** produce a `BlogVerificationIssue` row at all —
  only non-`VERIFIED` outcomes do, keeping the issue table's existing meaning
  ("things wrong with this post") intact rather than repurposing it into a full
  claim ledger.
- **No new run-status enum.** `BlogVerificationStatus` (PENDING/RUNNING/PASSED/
  NEEDS_REVIEW/BLOCKED/FAILED) already covers every semantic-verification outcome
  once its existing derivation rule (any `BLOCKING` issue → `BLOCKED`; any
  `WARNING` or `qualityScore < 85` → `NEEDS_REVIEW`; else `PASSED` —
  `blog-verification.service.ts:254-263`) is fed semantic issues alongside
  structural ones. A `CONTRADICTED` or `UNSUPPORTED` critical/high legal claim is
  simply persisted as a `BLOCKING`-severity `BlogVerificationIssue`, which the
  existing derivation already turns into `BLOCKED` — no new status logic needed.

### Verification policy (exact mapping)

| Semantic outcome | Severity assigned | Run-status effect (via existing derivation) |
|---|---|---|
| `VERIFIED` | — (no issue row) | No effect |
| `PARTIALLY_SUPPORTED`, claim category is low-stakes (`INTERPRETATION`, `RECOMMENDATION`, `MARKETING_STATEMENT`) | `INFO` | Passes with a note |
| `PARTIALLY_SUPPORTED`, claim category is high-stakes (`LEGAL_OBLIGATION`, `DEADLINE`, `PENALTY`, `LICENSING_REQUIREMENT`, `REPORTING_REQUIREMENT`, `SECURITY_REQUIREMENT`, `DATA_PROTECTION_REQUIREMENT`, `REGULATOR_AUTHORITY`) | `WARNING` | Human review required (`NEEDS_REVIEW`) |
| `UNSUPPORTED`, high-stakes category | `BLOCKING` | Blocks approval (`BLOCKED`) — matches "critical/high unsupported legal claims block approval" |
| `UNSUPPORTED`, low-stakes category | `WARNING` | Human review required |
| `CONTRADICTED` (any category) | `BLOCKING` | Blocks approval — matches "contradictions block approval" |
| `STALE_SOURCE` | `WARNING` | Human review required — matches "stale legal sources require review," not an automatic block, since the claim itself may still be accurate |
| `HUMAN_REVIEW_REQUIRED` (model itself flagged low confidence) | `WARNING` | Human review required |
| No legal claims found at all | — (no issues, `claimRiskScore` stays at its structural-only value) | Explicitly not a failure — matches "no legal claims should be recorded explicitly rather than treated as a failure" |

**Revised content invalidates previous verification**: corrected from the original
design, which relied solely on `BlogPost.updatedAt` timestamp comparison
(`calculateBlogStaleness`). A timestamp-only check cannot distinguish "content
actually changed" from "the row was touched for an unrelated reason" (e.g. a
future migration/backfill script that updates `updatedAt` without a real edit),
and offers no way to detect that the *source set* changed independently of the
post body. `BlogVerificationRun.contentHash`/`sourceSetHash` (new nullable columns, see
above) are computed at run time and compared against the *current*
`BlogPost.content`/sources' hash at read time — `verifyBlogPostClaims`'s
idempotency guard (`phase-b-procedure-contracts.md` §5) checks both the hash
match *and* the `updatedAt` timestamp (belt-and-suspenders: the hash is the
authoritative "did content really change" signal for deciding whether to bill a
new AI call; `updatedAt` remains a fast pre-check to avoid recomputing a hash on
every call). This is a distinct, finer-grained mechanism from Foundation D's
`evaluateBlogPublishReadiness`, which continues to reuse `calculateBlogStaleness`'s
coarser timestamp-based definition for the *publish-gate* `isStale`/`isAiStale`
signals — the two mechanisms answer different questions (verification replay
correctness vs. publish-readiness display/gating) and are not required to share
one implementation; a future phase could upgrade the publish-gate check to
hash-based too, but that is not part of this correction.

### Two-model policy (independent second review)

- **Provider selection**: primary verifier uses the `verification` use case
  (`getModelForUseCase('verification')` → `claude-haiku-4-5-20251001` per
  `ai.config.ts:246`, chosen upstream for cost efficiency on citation-style checks).
  Second-model review, when triggered, explicitly requests a **different provider**
  (`provider: 'openai'` or `'gemini'`, whichever is configured) via
  `completeStructured`'s `provider` override — never the same model re-asked the
  same question, which would not constitute independent review.
- **Trigger condition**: second review runs only when the primary pass produces at
  least one `BLOCKING`-severity semantic issue (i.e., only for claims that would
  otherwise block approval) — not for every claim, to bound cost.
- **Disagreement recording** (corrected — structured, not free-text): the primary
  pass's verdict is persisted as one `BlogVerificationIssue` row with
  `reviewProvenance.pass: 'PRIMARY'` and a `claimHash` derived from the claim text.
  If a second review is triggered and its verdict differs, a **second**
  `BlogVerificationIssue` row is created (never an overwrite of the first) sharing
  the same `claimHash`, with `issueType: SEMANTIC_CLAIM_ISSUE`,
  `reviewProvenance.pass: 'SECONDARY_REVIEW'`, and its own
  `claimVerificationStatus`/`confidence`/`reviewProvenance.provider`/`.model` —
  all structured columns/JSON fields, queryable directly, not encoded into
  `recommendation` prose. Both rows' severity is forced to `BLOCKING` once a
  disagreement is detected (a `GROUP BY claimHash` check across the two rows
  within the same run — see "query and audit requirements" above), regardless of
  either individual verdict.
- **Disagreement always requires human review**: yes, unconditionally — a
  disagreement between two independent models on a legal claim is definitionally a
  case automated logic should not resolve; enforced by the forced `BLOCKING`
  severity above, which the existing status derivation already turns into
  `BLOCKED`.
- **Cost cap / timeout / retry**: second review reuses the same
  `AgentRunService` per-run budget guard as the primary pass (both calls happen
  inside the same `AgentRun`, via `advanceRun` for the second call) — no separate
  cap is introduced; if the second call would exceed the per-run cost ceiling,
  `AgentBudgetHalt` fires exactly as it does for any other agent step, and the run
  halts with `HALTED_BUDGET`, surfacing as `requiresHumanReview` by policy (a halted
  second-review is treated the same as a disagreement: it cannot resolve the claim,
  so it defers to a human). Timeout/retry are inherited unchanged from
  `completeStructured`/`LLMGateway`.

---

## 4. Freshness review → `BlogFreshnessReview`

### Decision

New model. `BlogVerificationRun` was considered and rejected as a host for
freshness data: verification answers "is this specific version of the content
correct," freshness answers "has the world changed since publication" — different
trigger cadence (on-demand vs. scheduled), different inputs (regulatory signals vs.
draft content), and conflating them would make `BlogVerificationRun`'s `runType`
enum need a third, semantically different member alongside `MANUAL`/`PRE_PUBLISH`/`SYSTEM`.

```prisma
enum BlogFreshnessRiskTier {
  HIGH_RISK
  NORMAL
  EVERGREEN
}

enum BlogFreshnessAction {
  FRESH
  REVIEW_SOON
  REVISION_REQUIRED
  URGENT_REVISION
  ARCHIVE_RECOMMENDED
  HUMAN_REVIEW_REQUIRED
}

model BlogFreshnessReview {
  id String @id @default(cuid())

  blogPostId String
  agentRunId String?

  triggeredBy String @default("SCHEDULE") // SCHEDULE | SIGNAL | MANUAL -- plain string, mirrors BlogDiscoveryRun.triggeredBy's existing convention rather than a new enum for a 3-value operational tag

  contentHash   String // sha256 of BlogPost.content at review time
  sourceSetHash String // sha256 of sorted BlogPostSource URLs at review time

  riskTier       BlogFreshnessRiskTier
  freshnessScore Int // 0-100
  action         BlogFreshnessAction

  rationale          String   @db.Text
  changedSourceIds   String[] @default([])
  newSignalIds       String[] @default([]) // RegulatorySignal ids found to be relevant since publication
  brokenSourceCount  Int      @default(0)
  staleSourceCount   Int      @default(0)

  nextReviewAt DateTime?

  modelProvider String?
  modelName     String?
  promptVersion String  @default("freshness-review-v1")

  status       BlogEditorialTriageStatus @default(PENDING) // reused enum (PENDING/RUNNING/COMPLETE/FAILED) -- same generic run-lifecycle shape as triage, no need for a fourth near-identical status enum
  errorMessage String?                    @db.Text

  createdAt   DateTime  @default(now())
  completedAt DateTime?

  blogPost BlogPost @relation(fields: [blogPostId], references: [id], onDelete: Restrict)
  agentRun AgentRun? @relation(fields: [agentRunId], references: [id], onDelete: SetNull)

  @@index([blogPostId, createdAt])
  @@index([action])
  @@index([nextReviewAt])
  @@index([status])
}
```

- `BlogEditorialTriageStatus` (PENDING/RUNNING/COMPLETE/FAILED, defined in §1) is
  **reused** here rather than declaring a fourth near-identical
  `BlogFreshnessReviewStatus` — both models share the exact same generic
  "AI-assisted background run" lifecycle, and the illustrative brief's per-domain
  status enums would otherwise multiply four-value PENDING/RUNNING/COMPLETE/FAILED
  enums with no semantic difference between them.
- **Deletion behavior (corrected from Cascade)**: `blogPostId`'s FK is
  `onDelete: Restrict`, not `Cascade`. `blogPostId` is a required (non-nullable)
  field here — unlike `BlogResearchPack`'s optional `blogPostId` — because a
  freshness review only ever exists to assess an already-published post, so
  `SetNull` would leave a semantically broken row (a review with nothing to
  review). `Restrict` instead prevents a `BlogPost` from being hard-deleted while
  freshness-review history references it, forcing an explicit decision (e.g.
  delete the reviews first, or don't hard-delete the post) rather than silently
  destroying that audit trail. Compatible with the existing delete path: confirmed
  `blog.router.ts::adminDelete` performs a soft delete (`data: { deletedAt: new
  Date() }`), never an actual SQL `DELETE`, so this FK's `onDelete` action is
  inert under all current application code and only matters for a hypothetical
  future hard-delete/purge script — for which `Restrict` is the safer default.

### Cadence and risk-tier determination

```
riskTier = HIGH_RISK  if post.category in ['Regulatory Updates', 'Enforcement & Penalties']
                        or any BlogPostSource.sourceType == 'OFFICIAL'
         = EVERGREEN  if post.articleType-equivalent suggestion had articleType == EVERGREEN_EXPLAINER
                        (read from the linked BlogArticleSuggestion, if any; posts with no
                        suggestion origin default to NORMAL, not EVERGREEN, since evergreen
                        status is an explicit editorial classification, not a default assumption)
         = NORMAL     otherwise

nextReviewAt = publishedAt/lastReviewedAt + (
  30 days  if riskTier == HIGH_RISK
  90 days  if riskTier == NORMAL
  180 days if riskTier == EVERGREEN
)
```

**Immediate review after a linked high-impact signal**: `listContentDueForFreshnessReview`
(procedure contract) also selects any `BlogPost` where a new `RegulatorySignal`
exists with `severity IN ('critical','high')`, `createdAt > post.lastReviewedAt`,
and (via the Foundation A FK) `sourceItemId` resolving to a `BlogSourceItem` whose
`jurisdiction`/`authorityType` matches the post's own linked sources — independent
of that post's `nextReviewAt` schedule. This is the concrete mechanism the FK in
Foundation A unlocks: without it, "a new signal is relevant to this specific
published post" cannot be computed from stored data at all, only guessed by
jurisdiction string matching.

### Guardrails (verified against no existing conflicting behavior)

- **Never automatically unpublish**: `runFreshnessReview` only ever writes a
  `BlogFreshnessReview` row and, when warranted, a `BlogRevisionRequest` (§5) — it
  never calls `blogPost.update({ status: ... })`. No code path from this model
  reaches `BlogPost.status`.
  - **Never overwrite published content**: same reasoning — `BlogFreshnessReview`
  has no `content` field and no write path to `BlogPost.content`.
- **Never create an active revision silently**: `BlogRevisionRequest` (§5) always
  starts at `status: 'PENDING_REVIEW'`; nothing auto-approves it.
- **Never treat age alone as proof of staleness**: `freshnessScore`/`action` must be
  derived from at least one of `changedSourceIds`/`newSignalIds`/`brokenSourceCount`/
  `staleSourceCount` being non-zero/non-empty — the service layer asserts this
  invariant (raises an internal error if `action != FRESH` but all four evidence
  fields are empty/zero) rather than trusting the AI call alone to have grounded its
  recommendation in real signals.
- **Every staleness finding must reference evidence**: `changedSourceIds`/
  `newSignalIds` are the evidence pointers; `rationale` text must cite at least one
  of them (checked via a lightweight regex/id-presence assertion, not just prose).
- **Create `ContentOpsAlert` for urgent review**: `runFreshnessReview` calls
  `contentOpsAlertService.createOrIncrementAlert({ type: 'freshness_urgent_revision',
  severity: 'HIGH', entityType: 'BlogPost', entityId: blogPostId, workflowKey:
  'W-CONTENT-07', ... })` whenever `action IN ('URGENT_REVISION',
  'ARCHIVE_RECOMMENDED')`.
- **Revision recommendation must be durable**: satisfied by §5 below.

---

## 5. Revision recommendation → `BlogRevisionRequest`

### Decision

**New, separate model** — evaluated against reusing `BlogFreshnessReview` itself,
`BlogArticleSuggestion`, and `AutomationApproval.metadata`, and rejected all three:

- **Not `BlogFreshnessReview`-owned**: a revision request has its own reviewer
  workflow (assign, approve, resolve) that can outlive and be re-triggered
  independently of the freshness review that spawned it — a human might manually
  request a revision (e.g., a legal team flags an issue outside any scheduled
  freshness cycle) with no `BlogFreshnessReview` row to attach it to at all. Making
  `BlogFreshnessReview` own the full lifecycle would force every manually-initiated
  revision to fabricate a fake freshness-review row just to have somewhere to live.
- **Not `BlogArticleSuggestion`**: `BlogArticleSuggestion.blogPostId` is
  `@unique` (schema.prisma:3330) — a suggestion represents "the idea that became
  this post," strictly one-to-one, and cannot represent a second, third, or
  Nth revision cycle against an already-published post without breaking that
  uniqueness or repurposing the field to mean something else for already-published
  rows.
- **Not `AutomationApproval.metadata`**: approvals are transient (24h TTL,
  `APPROVAL_TTL_MS` at `approval.service.ts:16`) and exist to gate one publish
  action, not to track a reviewable, assignable, potentially-long-lived editorial
  task with its own resolution note.

### Model

```prisma
enum BlogRevisionPriority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum BlogRevisionStatus {
  PENDING_REVIEW
  ACCEPTED
  IN_PROGRESS
  RESOLVED
  DISMISSED
}

model BlogRevisionRequest {
  id String @id @default(cuid())

  blogPostId        String
  freshnessReviewId String? // nullable -- manual revisions have no freshness-review origin
  idempotencyKey    String  @unique // REQUIRED, caller-supplied -- see correction below; never a shared literal sentinel

  reason              String   @db.Text
  priority            BlogRevisionPriority
  recommendedChanges  Json?    // [{ section, currentText?, suggestedChange, evidenceSourceIds: [] }]
  evidence            Json?    // pointers: { signalIds: [], sourceItemIds: [], researchPackId? }

  status BlogRevisionStatus @default(PENDING_REVIEW)

  requestedById String? // null when system-originated (freshness review); set when a human manually files one
  assignedToId  String?
  approvedById  String?

  createdAt  DateTime  @default(now())
  resolvedAt DateTime?

  blogPost        BlogPost             @relation(fields: [blogPostId], references: [id], onDelete: Restrict)
  freshnessReview BlogFreshnessReview? @relation(fields: [freshnessReviewId], references: [id], onDelete: SetNull)
  requestedBy     User?                @relation("BlogRevisionRequestedBy", fields: [requestedById], references: [id])
  assignedTo      User?                @relation("BlogRevisionAssignedTo", fields: [assignedToId], references: [id])
  approvedBy      User?                @relation("BlogRevisionApprovedBy", fields: [approvedById], references: [id])

  @@index([blogPostId, status])
  @@index([freshnessReviewId])
  @@index([status, priority])
  @@index([createdAt])
}
```

**Idempotency correction**: the original design derived a server-side key,
`W-CONTENT-07:revision:<blogPostId>:<freshnessReviewId ?? 'manual'>:v1`, which
silently collapsed *every* manually-filed revision request for a given post into
one shared idempotency bucket (any second manual request would permanently
conflict against the first, forever, since there is no version escape hatch for
the literal `'manual'` branch). Corrected: `idempotencyKey` is now a real column,
**required and always caller-supplied**, never synthesized by the backend:
- For freshness-triggered calls (`runFreshnessReview` creating a revision
  internally), the caller is the backend itself, and it derives a stable key
  `W-CONTENT-07:revision:<blogPostId>:<freshnessReviewId>:v1` — safe because
  `freshnessReviewId` is always a real, unique id in this path (one revision
  request per freshness review that recommends one).
- For manual/standalone calls (`createRevisionRequest` invoked directly, no
  `freshnessReviewId`), the **caller** (a future workflow, or an admin action) is
  required to supply its own durable key derived from stable request-identifying
  data specific to that request — e.g. a support-ticket/reference id, or a hash of
  `(reason + blogPostId + requestedById + a caller-side nonce)` — so that two
  independent manual revision requests for the same post are two independent rows,
  while a genuine retry of the same request (same caller-generated key) still
  replays safely.
- `@@unique` on `idempotencyKey` (not a composite natural key) is sufficient once
  the key itself is guaranteed request-specific rather than post-specific.

- **Trade-off accepted**: this is a sixth new model (after `BlogEditorialTriageRun`,
  `BlogResearchPack`, `BlogResearchPackSource`, `BlogFreshnessReview`, plus
  `ContentOpsAlert` from Foundation C) — more schema surface than folding revisions
  into an existing table. The justification is that "does this post need a
  revision, who owns fixing it, is it done" is a genuinely distinct, independently
  queryable lifecycle (the admin portal's proposed "Revision recommendation
  detail" and freshness queue views need to list/filter/assign these independent of
  any specific `BlogFreshnessReview`'s own fields) — the alternative (jamming
  `assignedToId`/`approvedById`/`status` onto `BlogFreshnessReview` itself) would
  mean a read-only assessment-run model also has to carry a mutable human-workflow
  state machine, mixing two different write-access patterns (system-only-write vs.
  admin-editable) on one row.

---

## Summary table (per the required decision taxonomy)

| Concept | Decision |
|---|---|
| Editorial assessment | **Add new model** — `BlogEditorialTriageRun` |
| Research pack | **Add new models** — `BlogResearchPack` + `BlogResearchPackSource` |
| Claim verification | **Extend existing models** — `BlogVerificationRun` (+3 nullable columns: `contentHash`/`sourceSetHash`/`promptVersion`) and `BlogVerificationIssue` (+5 nullable columns: `claimCategory`/`claimVerificationStatus`/`confidence`/`claimHash`/`reviewProvenance`) + 2 new enums + 1 new enum value on `BlogVerificationIssueType` |
| Freshness review | **Add new model** — `BlogFreshnessReview` |
| Revision recommendation | **Add new model** — `BlogRevisionRequest` |
| Content-ops alerting | **Add new model** — `ContentOpsAlert` (Foundation C) |
| `RegulatorySignal` ↔ `BlogSourceItem` link | **Extend existing model** — additive FK (Foundation A) |
| `requiresHumanReview` enforcement | **No new model** — server-side policy over existing `BlogArticleSuggestion.requiresHumanReview` column (Foundation E) |
| Publish-readiness | **No new model** — shared evaluator function over existing data (Foundation D) |
| Structured AI output | **No new model** — application-layer service, no persistence of its own (Foundation B) |

No concept required "keep transient in AgentRun" or "keep transient in n8n" — every
domain contract in this pack needs durable, queryable backend state, consistent
with the governing instruction: "Do not place large research packs exclusively in
n8n execution data. Do not place critical verification decisions only in workflow
logs."
