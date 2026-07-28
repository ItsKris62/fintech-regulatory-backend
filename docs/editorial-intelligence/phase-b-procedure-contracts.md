# SheriaBot Pack 1 — Phase B: Procedure Contract Matrix

Status: design proposal. No router/service/capability code has been written.

## Conventions confirmed from existing code (must be followed exactly)

- Every `agents.automation.*` procedure is a **flat camelCase key** directly under
  `automation: router({...})` in `agents.router.ts` — capability strings are
  dot-namespaced (`agents.automation.content.publish`), but the tRPC procedure path
  itself is never nested to match (e.g. `publishContent`, not `content.publish`).
  The nine new procedures below follow this exactly: flat keys, dot-namespaced
  capabilities.
- Every procedure is `agentProcedure('<capability>').use(rateLimited(...)).input(z.object({...})).mutation(...)`
  — including reads that a human would think of as a query — because n8n's HTTP
  Request node always issues a bare `POST`, and every other n8n-facing
  `agents.automation.*` procedure (including pure reads like `getApproval`,
  `getSources`) is a `.mutation()` for exactly this reason. Only the two
  browser-facing, `adminProcedure`-gated exceptions (`listApprovals`,
  `recordApprovalDecision`) use `.query()`/session-derived actors.
- Capabilities added here go **only** into `AUTOMATION_CAPABILITIES`
  (`agent-credential.service.ts:65-86`), which is exclusively granted to
  `sys-automation-orchestrator`. They must **not** be added to
  `AGENT_CAPABILITIES` in a way that reaches `sys-agent-orchestrator` (which gets
  everything *except* `AUTOMATION_CAPABILITIES`/`TRIGGER_CAPABILITIES`, per the
  `.filter()` at `agent-credential.service.ts:129-131`) or to
  `TRIGGER_CAPABILITIES` (unrelated — that set is exactly one `run*` capability per
  B3-B8 scheduled agent).
- Response envelope is the standard tRPC bare-POST shape, `{"result":{"data": ... }}`,
  confirmed by `wire-format.test.ts`. No procedure below introduces a different
  envelope.
- Idempotency keys, where the procedure is not naturally idempotent via a single
  natural key, follow the confirmed `<WORKFLOW-ID>:<operation>:<natural-key>:v1`
  string convention from `n8n_W-CONTENT-02...json:371,431` and
  `n8n_W-CONTENT-03...json:305`.

**Explicit correction (required per Phase B.1 review)**: the first draft of this
document violated its own stated convention above — every "Procedure path" row in
the nine tables below used a nested-looking form,
`agents.automation.editorial.<name>` (e.g.
`agents.automation.editorial.triageEditorialCandidate`), copying the capability
string's namespace directly into the tRPC path. **The tRPC path and the
capability string are two independent strings that happen to share a domain word
("editorial") and must never be confused**:

| | Form | Example |
|---|---|---|
| tRPC procedure path (what n8n's HTTP Request node calls) | flat, directly under `automation:` | `agents.automation.triageEditorialCandidate` |
| Capability string (what `agentProcedure(...)` gates on) | dot-namespaced | `agents.automation.editorial.triage.create` |

All nine "Procedure path" rows below have been corrected to the flat form. The
capability rows were already correct in the original draft and are unchanged.

## New capabilities (added to `AUTOMATION_CAPABILITIES`, principal: `sys-automation-orchestrator` only)

```
agents.automation.editorial.triage.create
agents.automation.editorial.triage.read
agents.automation.editorial.research.create
agents.automation.editorial.research.read
agents.automation.editorial.verify.create
agents.automation.editorial.verify.read
agents.automation.editorial.freshness.list
agents.automation.editorial.freshness.run
agents.automation.editorial.revision.create
```

Nine capabilities, one per procedure — narrow, matching the existing
`content.publish` / `content.queueCandidate` / `content.createDraft` /
`content.generateDraft` granularity (four distinct capabilities for four
operations on one resource) rather than the coarser five-bucket
(`editorial.triage`/`.research`/`.verify`/`.freshness`/`.revision`) the governing
brief offered as an example — a leaked `sys-automation-orchestrator` credential
still can't, say, create a verification result without also being able to read
one under a coarser scheme, whereas here create/read are independently revocable
in principle (though in practice both are granted to the same single principal
today — the separation still documents intent and leaves room for a future
narrower principal, same rationale as B9's `sys-scheduler-orchestrator` split).

## New rate-limit buckets (`app.config.ts`, alongside existing `agents.automation.*`)

**Corrected count**: only **four** of the nine procedures call AI — `triageEditorialCandidate`,
`createResearchPack`, `verifyBlogPostClaims`, `runFreshnessReview`. The original
draft of this document incorrectly grouped `createRevisionRequest` into this set;
it is pure persistence (a single `BlogRevisionRequest` insert, no LLM call in the
procedure itself — see its own table below) and has no cost/latency profile that
differs from the existing cheap Phase-3 procedures.

These four AI-calling procedures get their **own** shared bucket, separate from
the existing `workflowRateLimitMax` bucket used by cheap/non-LLM Phase-3
procedures — mirroring how `generate` already has its own dedicated
`generateRateLimitMax` distinct from `workflowRateLimitMax`, precisely because
LLM-calling procedures have a meaningfully different cost/latency profile than a
plain DB read or forward:

```ts
// app.config.ts, inside agents.automation:
editorialRateLimitMax: env.AUTOMATION_EDITORIAL_RATE_LIMIT_MAX,
editorialRateLimitWindowSeconds: env.AUTOMATION_EDITORIAL_RATE_LIMIT_WINDOW_SECONDS,
```

The remaining five procedures reuse the existing `workflowRateLimitMax` bucket,
same as `getApproval`/`getSources` today: the four pure-read procedures
(`getEditorialTriage`, `getResearchPack`, `getVerificationResult`,
`listFreshnessReviewCandidates` — the last is a read despite being named "list"),
plus `createRevisionRequest` (a write, but not an AI-calling one — grouped with
the reads on this bucket specifically because it has no LLM cost/latency profile
to isolate, not because it's a read).

## A note on AI use-case routing (read before the per-procedure tables)

`getModelForUseCase()` (`ai.config.ts:239-252`) only varies the **Claude** model
selected; `LLMGateway.resolveProviderAndModel()` (`llm-gateway.ts:147-156`) shows
that for `provider: 'openai'` or `'gemini'`, the model is always
`appConfig.openai.model`/`appConfig.gemini.model` regardless of `useCase` — the
use-case → model map is Anthropic-specific. This matters for the two-model
verification policy (`phase-b-data-model.md` §3): requesting a second, independent
review via a non-Anthropic provider does **not** get a "verification-tier" model
automatically, it gets whatever single default model that provider is configured
with. This is a real, pre-existing gap in the gateway's "capability-based routing"
promise, not something Pack 1 introduces — flagged here because it constrains what
"independent second-model review" can actually guarantee about model quality today,
and is out of scope to fix in Phase B (fixing it means adding a use-case-aware model
map per provider in `ai.config.ts`, a general gateway improvement, not
editorial-intelligence-specific work).

The existing use case named `'verification'` maps to `claude-haiku-4-5-20251001`
(`ai.config.ts:32,246`) — chosen originally for cheap citation-format checks
(`citationVerification`). **Pack 1's legal claim verification deliberately does not
reuse this use case** despite the name match: legal claim verification needs
"high reasoning quality, conservative confidence" (governing brief §4), which the
existing `'verification'` use case was never tuned for. Pack 1 routes claim
verification through `'analysis'` (`claude-opus-4-6`) instead — this is called out
explicitly so a future reader doesn't "fix" this as an apparent naming mismatch.

---

## 1. `triageEditorialCandidate`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.triageEditorialCandidate` |
| Type | mutation |
| Capability | `agents.automation.editorial.triage.create` |
| Input | `z.object({ sourceItemId: z.string().min(1).optional(), suggestionId: z.string().min(1).optional(), regulatorySignalId: z.string().min(1).optional(), idempotencyKey: z.string().min(8).max(200), forceRetriage: z.boolean().optional() }).refine(v => !!(v.sourceItemId || v.suggestionId || v.regulatorySignalId), 'one of sourceItemId/suggestionId/regulatorySignalId is required')` |
| Output | `{ triageRunId: string; recommendation: BlogEditorialRecommendation; finalScore: number; requiresHumanReview: boolean; version: number; replayed: boolean }` |
| DB reads | `BlogSourceItem` (+ `monitor`), `BlogArticleSuggestion`, `RegulatorySignal` (whichever input variant is present), existing `BlogEditorialTriageRun` rows for the authoritative versioning target (`sourceItemId` if present, else `suggestionId` — see `phase-b-data-model.md` §1) to resolve `inputHash` match / next version |
| DB writes | `BlogEditorialTriageRun` (create); `AgentRun`/`AgentReport` via `agentRunService` |
| Idempotency | Three independent rules (corrected — see `phase-b-data-model.md` §1 "Idempotency and re-triage rules" for full detail, summarized here): (1) same `idempotencyKey` → `agentRunService.beginRun` replays the stashed result, no new AI call, no new row. (2) Different `idempotencyKey` but the computed `inputHash` matches the latest `COMPLETE` version's stored `inputHash` → reuse that version's result (`replayed: true` in the output), still no new AI call, still no new row — this is the default behavior for a second, differently-keyed call that turns out to carry unchanged input. (3) `inputHash` differs from the latest version → create the next version (increments on whichever of `sourceItemId`/`suggestionId` is authoritative). `forceRetriage: true` bypasses rule (2) unconditionally, always creating a new version even with an unchanged `inputHash` — reserved for an explicit, logged manual re-triage action. **A new `executionId` alone is never a reason to create a new version** — only `inputHash` drift (or `forceRetriage`) does. |
| Retry safety | Yes — `AgentRun`-wrapped, per rule (1) above. |
| Rate-limit bucket | `editorialRateLimitMax` (shared with `createResearchPack`/`verifyBlogPostClaims`/`runFreshnessReview` — the other three AI-calling procedures; `createRevisionRequest` is not AI-calling and uses `workflowRateLimitMax` instead, see the corrected rate-limit section above) |
| AI use case | `'query'` (`claude-haiku-4-5-20251001`) — fast, cheap, structured classification |
| Timeout | Inherited from `aiConfig.timeout.default` (60s) via `completeStructured` — triage does not need the longer policy/checklist timeouts |
| Budget category | Global `agents` per-run/per-day pool (`appConfig.agents.maxCostPerRunUsd/maxCostPerDayUsd`) — not partitioned per procedure, consistent with how `generate`/`generateDraftContent` already share the same pool |
| Errors | `BAD_REQUEST` (none of the three optional inputs provided, or referenced entity not found); `TOO_MANY_REQUESTS` (budget halted); `INTERNAL_SERVER_ERROR` (structured-output validation failure after correction, per `AIStructuredOutputError` mapping) |
| Operational events | `editorial_triage_started`, `editorial_triage_completed`, `editorial_triage_rejected` (per governing brief §8), each `{ workflowKey, event, executionId, payload: { triageRunId, sourceItemId, recommendation } }` — no full rationale text in the event payload |
| Tests | valid high-priority source → `PRIORITISE_NOW`; duplicate source → short-circuit `REJECT` with no AI call; missing provenance (no source resolvable) → `BAD_REQUEST`; low-confidence source → `sourceConfidence` cap applied; unsupported jurisdiction → score cap + `HUMAN_REVIEW_REQUIRED`; AI timeout → `INTERNAL_SERVER_ERROR`, `AgentRun` marked `FAILED`; structured-output failure after correction → same; budget exceeded → `TOO_MANY_REQUESTS`; human-review route → `requiresHumanReview: true` forces `HUMAN_REVIEW_REQUIRED` regardless of score; malformed backend envelope → covered by existing `wire-format.test.ts`-style harness, not per-procedure; **same `idempotencyKey` twice → replay, one `AgentRun`**; **different `idempotencyKey`, unchanged `inputHash` → `replayed: true`, no new version, no new AI call**; **changed `inputHash` → new version created**; **`forceRetriage: true` with unchanged `inputHash` → new version created anyway**; **two calls with different `executionId`-derived headers but identical logical input → asserted to NOT create two versions** (guards against the corrected "new executionId alone is not a versioning trigger" rule) |

## 2. `getEditorialTriage`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.getEditorialTriage` |
| Type | mutation (read, POST convention — matches `getApproval`) |
| Capability | `agents.automation.editorial.triage.read` |
| Input | `z.object({ triageRunId: z.string().min(1) })` |
| Output | Full `BlogEditorialTriageRun` row (all columns except none sensitive — no redaction needed, this table holds no secrets/PII) |
| DB reads | `BlogEditorialTriageRun` |
| DB writes | None |
| Idempotency | N/A (pure read) |
| Retry safety | Yes, trivially (read-only) |
| Rate-limit bucket | `workflowRateLimitMax` (existing, shared with other cheap reads) |
| AI use case | N/A |
| Timeout | Standard tRPC/HTTP timeout, no AI call |
| Budget category | N/A |
| Errors | `NOT_FOUND` |
| Operational events | None (a read does not need an operational log line beyond standard access logging) |
| Tests | found → full row; not found → `NOT_FOUND` |

## 3. `createResearchPack`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.createResearchPack` |
| Type | mutation |
| Capability | `agents.automation.editorial.research.create` |
| Input | `z.object({ blogPostId: z.string().min(1).optional(), suggestionId: z.string().min(1).optional(), idempotencyKey: z.string().min(8).max(200) }).refine(v => !!(v.blogPostId || v.suggestionId), '...')` |
| Output | `{ researchPackId: string; version: number; status: BlogResearchPackStatus; confidence: number; evidenceGapCount: number }` |
| DB reads | `BlogPost`/`BlogArticleSuggestion` (+ linked `BlogPostSource`/`BlogSuggestionSource` → `BlogSourceItem`), prior `BlogResearchPack` versions for the authoritative versioning target (`blogPostId` if present, else `suggestionId` — see `phase-b-data-model.md` §2) for the supersede check. **`requiresHumanReview` is deliberately NOT read as a gate here (corrected)** — research must be able to proceed regardless of that flag; see Foundation E's corrected policy. |
| DB writes | `BlogResearchPack` (create, marks prior version `SUPERSEDED`), `BlogResearchPackSource` (createMany), `AgentRun`/`AgentReport`. If the target suggestion's persisted `requiresHumanReview` needs to change based on this pack's `confidence`/`evidenceGaps`/`contradictions` (Foundation E "Research completion" enforcement point), the shared `computeRequiresHumanReview` function is re-invoked and the suggestion updated as a side effect — this is a *feed into* the human-review policy, not a gate blocking this procedure itself. |
| Idempotency | `W-CONTENT-05:research:<blogPostId ?? suggestionId>:v<nextVersion>` — matches the confirmed `<WORKFLOW>:<op>:<key>:v1` convention; a retried call with the same key and no intervening source-set change replays the existing version rather than creating version N+2. |
| Retry safety | Yes — `AgentRun`-wrapped, same replay-on-duplicate pattern as `generateDraftContent`. |
| Rate-limit bucket | `editorialRateLimitMax` |
| AI use case | `'analysis'` (`claude-opus-4-6`) — long-context synthesis across multiple sources, highest available reasoning tier |
| Timeout | `aiConfig.timeout.policyGeneration` (120s) via an explicit `overrideTimeoutMs` on the `completeStructured` call — default 60s is too tight for multi-source synthesis, matching the existing precedent that policy/checklist generation already get longer timeouts than plain queries |
| Budget category | Global `agents` pool |
| Errors | `BAD_REQUEST` (neither id provided); `NOT_FOUND` (target post/suggestion missing); `TOO_MANY_REQUESTS`; `INTERNAL_SERVER_ERROR` (structured-output failure). **No `requiresHumanReview`-related error exists (corrected)** — this procedure never refuses to run on that basis. |
| Operational events | `research_pack_started`, `research_pack_completed`, `research_pack_gap_detected` (fired additionally, not instead, when `evidenceGaps.length > 0`) |
| Tests | complete source set → `COMPLETE`, no gaps; one unavailable source → `isAvailable: false` on that `BlogResearchPackSource` row, pack still completes with a note; contradictory sources → `contradictions` populated, `confidence` reduced; duplicate URLs → deduped at the source-list-building step before the AI call (reuses `content-hash.ts`'s existing normalization); stale source → flagged via `BlogFreshnessReview`-independent staleness check on the source's own `publicationDate`; unsupported source type → rejected at input-normalization with a `BAD_REQUEST`-class internal validation error surfaced as an `evidenceGaps` entry, not a hard failure (a research pack should still complete and flag the gap, not abort); no official source → `requiresHumanReview` escalated per Foundation E, pack still completes; malformed document → treated as `isAvailable: false`, not a hard failure; AI failure → `INTERNAL_SERVER_ERROR`, run `FAILED`; persistence retry → idempotency replay test; duplicate research request → same idempotency key, same version returned |

## 4. `getResearchPack`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.getResearchPack` |
| Type | mutation (read) |
| Capability | `agents.automation.editorial.research.read` |
| Input | `z.object({ researchPackId: z.string().min(1).optional(), blogPostId: z.string().min(1).optional() }).refine(...)` — `blogPostId` variant returns the current active pack (`DRAFT`/`COMPLETE`, highest version) |
| Output | Full `BlogResearchPack` row plus `sources: BlogResearchPackSource[]` |
| DB reads | `BlogResearchPack`, `BlogResearchPackSource` |
| DB writes | None |
| Idempotency | N/A |
| Retry safety | Yes |
| Rate-limit bucket | `workflowRateLimitMax` |
| AI use case | N/A |
| Timeout | Standard |
| Budget category | N/A |
| Errors | `NOT_FOUND` |
| Operational events | None |
| Tests | by id; by blogPostId (active-version resolution); not found |

## 5. `verifyBlogPostClaims`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.verifyBlogPostClaims` |
| Type | mutation |
| Capability | `agents.automation.editorial.verify.create` |
| Input | `z.object({ blogPostId: z.string().min(1), idempotencyKey: z.string().min(8).max(200), requestSecondReview: z.boolean().optional() })` |
| Output | `{ verificationRunId: string; status: BlogVerificationStatus; blockingIssueCount: number; needsHumanReview: boolean; replayed: boolean }` |
| DB reads | `BlogPost` (+ `sources`, `draftGenerationRuns`), active `BlogResearchPack` for the post (claims are compared against research-pack evidence, not raw source URLs directly — if no research pack exists, falls back to `BlogPostSource` rows with a `HUMAN_REVIEW_REQUIRED`-biased policy since evidence quality is lower), prior `BlogVerificationRun.contentHash`/`sourceSetHash` for this post (idempotency/replay check, see below) |
| DB writes | `BlogVerificationRun` (reuses `runBlogPostVerification`'s existing structural checks, then appends semantic issues — this procedure calls the existing `blog-verification.service.ts` function first, then extends its result rather than duplicating the structural pass; persists its own `contentHash`/`sourceSetHash`/`promptVersion`), `BlogVerificationIssue` (including new `claimCategory`/`claimVerificationStatus`/`confidence`/`claimHash`/`reviewProvenance` columns — `reviewProvenance` is structured JSON, never free text in `recommendation`, per `phase-b-data-model.md` §3), `AgentRun`/`AgentReport` |
| Idempotency | Corrected (was `updatedAt`-only): `W-CONTENT-06:verify:<blogPostId>:v1` plus a **hash-based** guard — compute the current `BlogPost.content` hash and linked-sources hash, compare against the latest `COMPLETE`/`PASSED`/`BLOCKED` run's stored `contentHash`/`sourceSetHash` for the same idempotency key. Matching hashes → replay that run's result (`replayed: true`), no new AI call. `BlogPost.updatedAt` is checked first as a fast pre-filter only (if `updatedAt` is unchanged, the hashes cannot have changed either, so the hash computation itself can be skipped) — but a changed `updatedAt` with unchanged hashes (e.g. an unrelated field like `tags` was edited) still correctly replays rather than re-verifying, which pure `updatedAt` comparison could not distinguish. |
| Retry safety | Yes |
| Rate-limit bucket | `editorialRateLimitMax` |
| AI use case | `'analysis'` (`claude-opus-4-6`) for the primary pass — see "note on AI use-case routing" above for why `'verification'` is deliberately not used. Second-model pass (when triggered) uses an explicit `provider` override (`'openai'` or `'gemini'`), whichever is configured, per `phase-b-data-model.md` §3. |
| Timeout | `aiConfig.timeout.policyGeneration` (120s) via override — legal claim extraction+comparison across a full post is not a quick call |
| Budget category | Global `agents` pool; second-model pass draws from the same `AgentRun` via `advanceRun`, so a budget halt mid-second-review correctly counts against the same run rather than opening an unbounded second spend |
| Errors | `NOT_FOUND` (post missing); `BAD_REQUEST` (no research pack and no `BlogPostSource` rows at all — nothing to verify against); `TOO_MANY_REQUESTS`; `INTERNAL_SERVER_ERROR` |
| Operational events | `verification_started`, `verification_completed`, `verification_blocked` (fired when final `status === 'BLOCKED'`) |
| Tests | fully verified draft → `PASSED`; unsupported obligation → `BLOCKED`; incorrect deadline → `BLOCKED` (`DEADLINE` category, `UNSUPPORTED`); contradictory regulator source → `BLOCKED` (`CONTRADICTED`); stale citation → `NEEDS_REVIEW` (`STALE_SOURCE`, not blocking per policy table); missing research pack → falls back to `BlogPostSource`, `requiresHumanReview` biased true; no legal claims → `PASSED`, zero semantic issue rows, not treated as a failure; AI structured-output failure → `INTERNAL_SERVER_ERROR`; budget exhaustion → `TOO_MANY_REQUESTS`; duplicate verification → content-hash-guarded replay; revised draft after verification → new run required, content-hash mismatch detected; content hash mismatch → explicit test of the guard itself; **`updatedAt` changed but `contentHash`/`sourceSetHash` unchanged (e.g. only `tags` edited) → still replays, does not re-verify**; **two disagreeing review passes share the same `claimHash` and are both queryable via it** (req #8 audit-query test); human override path → a `BlogVerificationIssue` with `claimVerificationStatus: HUMAN_REVIEW_REQUIRED` can be manually resolved via the admin portal (not this procedure — see `phase-b-admin-review-surfaces.md`), verified via an integration test that a resolved issue no longer contributes to `evaluateBlogPublishReadiness`'s blocker count once the resolution path (admin-only, out of this procedure's scope) is exercised |

## 6. `getVerificationResult`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.getVerificationResult` |
| Type | mutation (read) |
| Capability | `agents.automation.editorial.verify.read` |
| Input | `z.object({ verificationRunId: z.string().min(1).optional(), blogPostId: z.string().min(1).optional() }).refine(...)` — `blogPostId` variant returns the latest run |
| Output | Full `BlogVerificationRun` + `issues: BlogVerificationIssue[]` |
| DB reads | `BlogVerificationRun`, `BlogVerificationIssue` |
| DB writes | None |
| Idempotency | N/A |
| Retry safety | Yes |
| Rate-limit bucket | `workflowRateLimitMax` |
| AI use case | N/A |
| Timeout | Standard |
| Budget category | N/A |
| Errors | `NOT_FOUND` |
| Operational events | None |
| Tests | by id; by blogPostId (latest-run resolution); not found |

## 7. `listFreshnessReviewCandidates`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.listFreshnessReviewCandidates` |
| Type | mutation (n8n-polled worklist, POST convention) |
| Capability | `agents.automation.editorial.freshness.list` |
| Input | `z.object({ maxItems: z.number().int().positive().max(200).default(50) })` |
| Output | `{ items: Array<{ blogPostId: string; riskTier: BlogFreshnessRiskTier; reason: 'SCHEDULED' | 'SIGNAL_TRIGGERED'; nextReviewAt: string | null }> }` |
| DB reads | `BlogPost` (status `PUBLISHED`, `deletedAt: null`) joined against latest `BlogFreshnessReview.nextReviewAt`, plus the signal-triggered query described in `phase-b-data-model.md` §4 (`RegulatorySignal` via the Foundation A FK, filtered to `createdAt > lastReviewedAt`) |
| DB writes | None |
| Idempotency | N/A (read) |
| Retry safety | Yes |
| Rate-limit bucket | `workflowRateLimitMax` |
| AI use case | N/A |
| Timeout | Standard (this is a DB query, not an AI call — must stay fast even with `maxItems` at the cap) |
| Budget category | N/A |
| Errors | None beyond standard validation |
| Operational events | None |
| Tests | scheduled-due items returned; signal-triggered items returned even when not yet due on schedule; `maxItems` cap respected; empty result when nothing is due |

## 8. `runFreshnessReview`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.runFreshnessReview` |
| Type | mutation |
| Capability | `agents.automation.editorial.freshness.run` |
| Input | `z.object({ blogPostId: z.string().min(1), idempotencyKey: z.string().min(8).max(200) })` |
| Output | `{ freshnessReviewId: string; action: BlogFreshnessAction; freshnessScore: number; revisionRequestId?: string }` |
| DB reads | `BlogPost` (+ sources), linked `RegulatorySignal`s (via Foundation A FK), prior `BlogFreshnessReview` rows for cadence/hash comparison |
| DB writes | `BlogFreshnessReview` (create), `BlogRevisionRequest` (create, only when `action IN ('REVISION_REQUIRED','URGENT_REVISION','ARCHIVE_RECOMMENDED')`), `ContentOpsAlert` (via `createOrIncrementAlert`, only for `URGENT_REVISION`/`ARCHIVE_RECOMMENDED`), `AgentRun`/`AgentReport` |
| Idempotency | `W-CONTENT-07:freshness:<blogPostId>:v1` + a same-day guard (a post already reviewed today with no new signal since is a no-op replay, not a re-review — prevents a scheduler misfire from burning AI budget twice in one day on the same post) |
| Retry safety | Yes |
| Rate-limit bucket | `editorialRateLimitMax` |
| AI use case | `'checklist'` (`claude-sonnet-4-6`) — balances cost against reasoning quality for what is expected to be a recurring, potentially high-volume scheduled job; escalate to `'analysis'` only if a future tuning pass shows `'checklist'`-tier quality is insufficient (not a Phase B blocker) |
| Timeout | `aiConfig.timeout.checklistTier3` (150s) via override |
| Budget category | Global `agents` pool |
| Errors | `NOT_FOUND` (post missing/not published); `TOO_MANY_REQUESTS`; `INTERNAL_SERVER_ERROR` |
| Operational events | `freshness_review_started`, `freshness_review_completed`, `revision_recommended` (fired only when a `BlogRevisionRequest` is created) |
| Tests | fresh content → `FRESH`, no revision request; old but still valid → `FRESH` or `REVIEW_SOON` despite age, per the "age alone is not proof" guardrail (test explicitly asserts an old-but-unchanged post with no signals/broken links stays `FRESH`); superseded source → `REVISION_REQUIRED`; changed regulator guidance (new high-impact signal) → `URGENT_REVISION` + `ContentOpsAlert` created; broken URL → contributes to `brokenSourceCount`, at least `REVIEW_SOON`; missing publication date → does not by itself force staleness (informational only, matching existing `UNKNOWN_PUBLICATION_DATE` issue-type precedent); no cited sources → `HUMAN_REVIEW_REQUIRED` (can't assess freshness without evidence to compare); duplicate review → same-day idempotency guard returns the existing review; AI failure → `INTERNAL_SERVER_ERROR`; urgent revision → full path through `BlogRevisionRequest` + `ContentOpsAlert`; archive recommendation → `ARCHIVE_RECOMMENDED` action, `BlogRevisionRequest` created with that recommendation in `recommendedChanges`, `BlogPost.status` **not** touched (guardrail test) |

## 9. `createRevisionRequest`

| Field | Detail |
|---|---|
| Procedure path | `agents.automation.createRevisionRequest` |
| Type | mutation |
| Capability | `agents.automation.editorial.revision.create` |
| Input | `z.object({ blogPostId: z.string().min(1), freshnessReviewId: z.string().min(1).optional(), reason: z.string().min(1).max(2000), priority: z.enum(['LOW','MEDIUM','HIGH','URGENT']), recommendedChanges: jsonObjectSchema.optional(), evidence: jsonObjectSchema.optional(), idempotencyKey: z.string().min(8).max(200) })` — `idempotencyKey` is **required and always caller-supplied** (corrected, see below); exposed both for `runFreshnessReview`'s internal use and as a standalone entry point for a manually-triggered revision request from n8n (e.g., a future workflow reacting to a support ticket or legal-team flag) |
| Output | `{ revisionRequestId: string; status: BlogRevisionStatus }` |
| DB reads | `BlogPost`, `BlogFreshnessReview` (if provided), existing `BlogRevisionRequest` by `idempotencyKey` (replay check) |
| DB writes | `BlogRevisionRequest` (create, always `status: PENDING_REVIEW`, `idempotencyKey` persisted as a real `@@unique` column — see `phase-b-data-model.md` §5) |
| Idempotency | **Corrected — no server-synthesized key.** The original design derived `W-CONTENT-07:revision:<blogPostId>:<freshnessReviewId ?? 'manual'>:v1` server-side, which silently collapsed *every* manual revision request for a given post into one shared bucket via the literal `'manual'` fallback (a second, unrelated manual request would permanently conflict against the first). Corrected: `idempotencyKey` is a required input field the **caller** must generate. `runFreshnessReview`'s internal call derives `W-CONTENT-07:revision:<blogPostId>:<freshnessReviewId>:v1` (safe — `freshnessReviewId` is always a real, unique id in that path). A manual/standalone caller must derive its own durable, request-specific key (e.g. a ticket/reference id, or a hash of `reason + blogPostId + requestedById + a caller-side nonce`) — never a shared literal. |
| Retry safety | Yes — plain unique-constraint-backed idempotency (`@@unique` on `idempotencyKey` itself, not a composite natural key), same insert-then-catch-P2002 pattern as `AutomationApprovalService.createApproval` |
| Rate-limit bucket | `workflowRateLimitMax` (corrected — this procedure is not AI-calling; see the corrected rate-limit section above. It is grouped with the cheap reads/writes, not `editorialRateLimitMax`.) |
| AI use case | N/A — pure persistence, no AI call in this procedure itself |
| Timeout | Standard |
| Budget category | N/A |
| Errors | `NOT_FOUND` (post missing); `CONFLICT` (idempotent replay of a request already resolved differently — mirrors `AutomationApprovalService`'s conflict semantics) |
| Operational events | `revision_recommended` (same event as `runFreshnessReview` fires when it creates one internally — this procedure fires it too when called directly, so the event always means "a `BlogRevisionRequest` now exists," regardless of caller) |
| Tests | manual creation succeeds with a caller-supplied key; duplicate idempotency key replays; **two independent manual revision requests for the SAME post with two different caller-supplied keys both succeed as two separate rows** (regression test for the corrected 'manual'-collapse defect); creation from a freshness review links correctly; always starts `PENDING_REVIEW` regardless of `priority` (guardrail: nothing about this input can cause an auto-approved state) |

---

## Cross-cutting: `workflow_failed`

Per the governing brief's event list, every one of the nine procedures above
additionally relies on the **existing** W-SHARED-ERR mechanism for
`workflow_failed` — this is not a new event any procedure emits itself, it is the
n8n-side `Error Trigger` firing when any node (including an HTTP Request node
calling one of these procedures) throws. No backend change is needed for this
event; see `phase-b-security-review.md` for the required extension to
W-SHARED-ERR's `operationPolicies` regex table so these nine new node names get a
specific classification instead of falling through to `UNKNOWN_OPERATION`.
