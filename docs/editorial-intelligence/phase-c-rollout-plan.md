# SheriaBot Pack 1 — Phase C: Rollout Plan

Status: reflects Stage C1 (schema/migrations), Stage C2 (structured AI output
foundation), Stage C3 (`requiresHumanReview` policy), Stage C4 (persisted
`ContentOpsAlert`), Stage C5 (shared publish-readiness evaluator), Stage C6
(editorial triage), Stage C7 (research-pack generation), and Phase D
(semantic claim verification, freshness monitoring, revision-request
generation — consolidating former Stages C8/C9) as implemented and
validated. Only Phase E (router/API/admin exposure, consolidating former
Stages C10–C12) remains — this plan sequences the remaining work so a future
session can continue without re-deriving order-of-operations.

## Sequencing rationale

Stages are ordered so no stage depends on an unfinished foundation, per the
governing instruction. C1/C2 are pure foundations with no behavioral surface
of their own (a schema with no reader, a completion helper nothing calls yet)
— safe to land first and validate in isolation. C3–C5 are the first stages
with real behavioral surface, and each ships behind a flag or in shadow-only
mode so none of them change production behavior by merely being deployed.

```
C1  Schema + migrations                    [DONE]
C2  Structured AI output foundation        [DONE]
C3  requiresHumanReview policy + rollout    [DONE — flags default off]
C4  Persisted ContentOpsAlert service       [DONE]
C5  Shared publish-readiness evaluator      [DONE — mode defaults to shadow]
C6  Editorial triage service                [DONE — service-only, no router yet]
C7  Research-pack service                   [DONE — service-only, no router yet]
Phase D §1  Semantic claim verification     [DONE — service-only, no router yet]
Phase D §2  Freshness monitoring            [DONE — service-only, no router yet]
Phase D §3  Revision-request generation     [DONE — service-only, no router yet]
Phase E     Router/API/admin exposure       [depends on all of the above]
```

### C6/C7/Phase D status detail

All of C6, C7, and Phase D's three parts are implemented as backend services
and schemas only — per explicit instruction, no `agents.automation.*` router
procedures were added in any of these passes.
`editorial-triage.service.ts`/`research-pack.service.ts`/
`semantic-verification.service.ts`/`freshness-review.service.ts`/
`revision-request.service.ts` are all fully callable and tested in
isolation; Phase E is where they get thin tRPC wrappers (the nine procedures
from `phase-b-procedure-contracts.md` §1–9: `triageEditorialCandidate`,
`getEditorialTriage`, `createResearchPack`, `getResearchPack`,
`verifyBlogPostClaims`, `getVerificationResult`,
`listFreshnessReviewCandidates`, `runFreshnessReview`,
`createRevisionRequest`). No new public API contract exists yet, so no
frontend API type regeneration was needed or performed in any of these
passes.

### C3–C5 flag/mode state at the end of this pass (all safe defaults, none flipped)

| Flag | Default | Meaning when off/shadow |
|---|---|---|
| `EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED` | `false` | `requiresHumanReview` still inherits the Prisma column default; nothing computed or persisted explicitly |
| `EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED` | `false` | Draft auto-promotion behaves exactly as before C3; suggestions are never routed to `human_review_required` |
| `BLOG_PUBLISH_READINESS_MODE` | `shadow` | The shared evaluator runs and logs divergences on every publish attempt but never blocks; the three existing inline gates remain fully authoritative |

Turning any of these on in any environment is an explicit operator action for
a future session/deployment, not something this pass did or recommends doing
without first reviewing the backfill/divergence-log evidence described in the
two new runbooks.

## Feature-flag / burn-in gates carried forward from Phase B.1

Two stages have an explicit, non-negotiable rollout order that must not be
compressed:

1. **C3 (`requiresHumanReview`)**: policy code deployed → creation/update paths
   persist an explicit computed value → dry-run backfill reviewed → backfill
   applied in write mode → enforcement flag enabled. The enforcement flag must
   default OFF and must not be flipped on until the backfill's row counts have
   been reviewed by an operator. **Implemented this pass; the code for every
   step in this order exists and is tested, but no step past "policy code
   deployed" has been executed against any real environment** — see
   `human-review-backfill-runbook.md` for the exact commands an operator runs
   next.
2. **C5 (shared publish-readiness evaluator)**: dual-compute burn-in (new
   evaluator runs in log-only mode alongside the existing three inline gate
   implementations) → zero unexplained divergences (or all explained against
   the Foundation D decision table) → cutover flag enabled → old inline logic
   deleted. Cutover must not happen in the same change that introduces the
   evaluator. **Implemented this pass in shadow mode only; no burn-in period
   has actually elapsed against real traffic yet** — see
   `publish-readiness-burn-in-runbook.md` for the cutover criteria and the
   exact log event names an operator watches for.

Both flags are read via `appConfig.editorial.*` (env-var-backed, following
this codebase's existing `zod`-validated `envSchema` pattern) rather than a
runtime-mutable `SystemConfig` row — a deliberate simplification for this
pass since none of these three flags need to change without a redeploy; no
new feature-flag mechanism is introduced beyond what `app.config.ts` already
provides.

## Migration application (deployment-gated, not part of any code stage)

The 7 migration files created in C1 are **not applied** by this plan. Applying
them is a separate, explicitly-authorized deployment action requiring, in
order:

1. Run the `RegulatorySignal` orphan-detection query (see
   `phase-c-schema-verification.md` / `phase-b-foundations.md` Foundation A)
   against the real target database and null any orphaned rows.
2. Apply the 7 migration files in their timestamp order (they are
   inter-dependent — see each file's header comment).
3. Run `prisma generate` against the deployed database's schema.
4. Run `pnpm tsx src/scripts/verify-schema.ts --mode=post` and confirm
   `gateStatus: PASSED`.
5. Manually confirm `ContentOpsAlert_dedupe_key` (the expression index) exists
   with the expected definition — not automated, see
   `phase-c-schema-verification.md`.

## Remaining work: Phase E (router/API/admin exposure) — not started

Phase E's acceptance criteria are already fully specified in the Phase B.1
documents (`phase-b-foundations.md`, `phase-b-data-model.md`,
`phase-b-procedure-contracts.md`, `phase-b-structured-ai-design.md`,
`phase-b-security-review.md`, `phase-b-test-plan.md`) — specifically the nine
procedure contracts in §1–9 of `phase-b-procedure-contracts.md`. No new
design work is needed to begin Phase E — only implementation: thin tRPC
wrappers over the now-complete `EditorialTriageService`,
`ResearchPackService`, `SemanticVerificationService`,
`FreshnessReviewService`, and `RevisionRequestService`, plus whatever admin
read/action surfaces are scoped for it, following the same pattern
established by C1–C7/Phase D: real code, real test runs, honest reporting of
what passed (including disclosed gaps — C5's `blog.router.ts` wiring test
gap, C7's unwired `backfillBlogPostIdForSuggestion`, and Phase D's
jurisdiction-string-matching simplification in freshness candidate
selection — see `phase-c3-c5-test-report.md`, `phase-c6-c7-test-report.md`,
and `phase-d-test-report.md`).

Phase E's procedures depend on the domain services completed across C6/C7/
Phase D exactly as designed: `verifyBlogPostClaims` calls
`SemanticVerificationService` (which itself already calls
`ResearchPackService.getResearchPack`-equivalent evidence resolution
internally, per `phase-b-data-model.md` §3's "compare claims against
research-pack evidence" design); `runFreshnessReview`/`createRevisionRequest`
call `FreshnessReviewService`/`RevisionRequestService` directly. No
additional backend service work is needed before Phase E can begin.

## Explicit non-goals for this rollout (unchanged from Phase B.1)

- No n8n workflow JSON at any point through Phase E.
- No frontend admin pages (Phase E is backend admin *procedures* only).
- No production connection, deployment, or push at any point.
- No destructive migration at any point — every migration file in this pack
  is additive-only.
- No new web-fetch/scraping mechanism at any point (C7's research-pack
  sourcing and Phase D's freshness checks both reuse only already-stored
  data).
