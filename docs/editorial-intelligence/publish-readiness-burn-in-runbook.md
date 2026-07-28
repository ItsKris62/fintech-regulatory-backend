# Publish-Readiness Burn-In Runbook (Pack 1 Stage C5)

This runbook covers the shadow → cutover path for
`src/server/utils/publish-readiness.ts`'s shared evaluator, from "deployed,
changes nothing" through the eventual (out-of-scope-for-this-pass) removal of
the three existing inline gates it's meant to replace.

## Background

Before Stage C5, blog-post publication readiness was checked three separate
times, inline, in three different places:

1. `blog.router.ts::adminSetStatus` (the admin-triggered publish path)
2. `content.service.ts::publishContent` (the automation-triggered publish path)
3. `blog-automation.router.ts`'s own staleness computation (a related but
   distinct check)

Stage C5 introduces one shared, pure, read-only evaluator
(`evaluateBlogPublishReadiness`) and a burn-in wrapper
(`runPublishReadinessShadowCheck`) that both existing publish call sites now
also invoke — but **the original inline gates are left completely in place
and remain fully authoritative** in the default mode. This stage is purely
additive/observational; it does not change what gets published or blocked
today.

## The `BLOG_PUBLISH_READINESS_MODE` flag

Three states:

| Mode | Behavior |
|---|---|
| `off` | The shared evaluator never runs. No-op. Zero added latency or log volume. |
| `shadow` (**default**) | The evaluator always runs alongside the existing inline gate at both call sites. Every divergence between the two is logged as a `blog_publish_readiness_divergence` warning (evaluator's `ready` boolean vs. the legacy gate's own accept/reject decision). Agreement is logged as `blog_publish_readiness_shadow_check` info. **The evaluator's result never blocks or allows anything** — the legacy gate's decision is the only one that has any effect. |
| `enforce` | The evaluator's result becomes authoritative for *new* blocks: if the legacy gate would have allowed publication but the evaluator finds a blocker, publication is now rejected. If the legacy gate would have rejected, that rejection still happens first (the legacy check runs first and its error is rethrown before the evaluator's result is even consulted) — `enforce` mode can only make the gate *stricter*, never looser. |

**This pass ships with the default of `shadow`, and does not flip it to
`enforce` anywhere.**

## Log events to watch

Both are structured `logger.warn`/`logger.info` calls containing only the
`blogPostId`, the call site name (`adminSetStatus` or `publishContent`), the
mode, and finding **codes** (e.g. `MISSING_REQUIRED_OFFICIAL_SOURCE`,
`AI_DRAFT_NEWER_THAN_VERIFICATION`) — never article content, source text, or
prompts, per the non-negotiable content-in-logs rule.

- `blog_publish_readiness_divergence` (warn) — the evaluator and the legacy
  gate disagreed. This is the signal to watch during burn-in.
- `blog_publish_readiness_shadow_check` (info) — the evaluator ran and agreed
  with the legacy gate's outcome. High volume, low signal; useful mainly to
  confirm the shadow check is actually executing in a given environment.
- `blog_publish_readiness_shadow_check_failed` (error) — the evaluator itself
  threw. This should never happen in steady state; the wrapper catches every
  exception so a bug here can never break an existing publish path, but a
  non-zero rate of this event is itself a bug to investigate.

## Burn-in period (operator-driven, not automated)

1. Deploy with `BLOG_PUBLISH_READINESS_MODE=shadow` (the default — no action
   needed unless a prior deploy explicitly set it to `off`).
2. Let real publish attempts (both admin-triggered and automation-triggered)
   accumulate over a period the operator judges sufficient to cover the
   actual variety of content in the pipeline — this is not a fixed duration
   in this plan; it depends on publish volume, and low-volume periods (e.g. a
   quiet week) may not exercise every blocker code.
3. Query logs for `blog_publish_readiness_divergence` events across that
   period.
4. For every distinct divergence found, classify it as one of:
   - **Evaluator is stricter and correct** — the legacy gate had a gap the
     evaluator closes (e.g. it doesn't check `BLOCKING_CONTENT_OPS_ALERT` at
     all). This is expected and desired; it does not block cutover.
   - **Evaluator is stricter and wrong** — a bug in the evaluator's logic
     causing a false blocker. This must be fixed before cutover; do not
     proceed with a known false-positive blocker.
   - **Legacy gate is stricter and evaluator is missing a check** — a gate
     the evaluator hasn't ported yet. This must be added to the evaluator
     before cutover, since cutover means the evaluator becomes the only
     check.
   - **Legacy gate is stricter and wrong** — the legacy gate has a bug the
     evaluator correctly doesn't replicate. Document this; it strengthens
     the case for cutover.

## Cutover criteria (do not flip to `enforce` until all of these hold)

- Zero unexplained divergences remain — every divergence observed during the
  burn-in period has been classified per the table above, and any
  evaluator-side bugs found have been fixed and re-validated.
- The "evaluator is missing a check" case has zero outstanding items — if the
  evaluator is missing anything the legacy gates currently catch, cutover
  would be a regression.
- The burn-in period covered a representative sample of content categories
  (in particular, at least one publish attempt in each of the categories with
  special official-source rules: Regulatory Updates, Enforcement & Penalties,
  International Standards) — a burn-in period that never exercised a given
  category's blocker path hasn't actually validated it.
- An operator has explicitly reviewed and signed off on the above — this is
  not something any script or automated check in this repository determines
  for you.

## After cutover (out of scope for this pass)

Only after the above criteria are met and `BLOG_PUBLISH_READINESS_MODE=enforce`
has itself been running without incident for an operator-judged period should
the three original inline gates be considered for removal. **This pass does
not remove them, per explicit instruction** — `enforce` mode only adds a new
rejection path; it does not delete the old one. Deleting the old inline logic
is a separate, future, explicitly-scoped change.

## Rollback

`BLOG_PUBLISH_READINESS_MODE` can be set back to `shadow` or `off` at any
time — this is a read path only; no data was ever mutated by the evaluator or
the shadow-check wrapper, so there is nothing to undo beyond the flag itself.
