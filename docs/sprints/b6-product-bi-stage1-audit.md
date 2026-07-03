# Phase B - Batch B6 (Product/BI Agent) - Stage 1 Read-Only Audit

**Status:** STAGE 1 COMPLETE - awaiting operator approval before Stage 2 implementation.
No code was changed to produce this document. Backend `main`, working tree clean at
audit time (HEAD `2fb54ece`, B4/B5/multi-principal-refactor/automation all prior
history; five automation-batch files from a separate, not-yet-reviewed session remain
uncommitted and untouched by this audit).

---

## 1. B5's PostHog query shape - reuse decision

`src/modules/agents/sales/engagement-lookup.service.ts` (B5, unmodified, read only):
`SalesEngagementLookupService.lookup(organizationId, contactEmail)` does a single
`fetch(POST ${host}/api/projects/${projectId}/query, { Authorization: Bearer
${personalApiKey} }, body: { query: { kind: 'HogQLQuery', query, values } })`, with a
5s `AbortController` timeout, and returns a sales-specific `EngagementContext` union
(`{ available: true, lastSeenAt, eventCount7d } | { available: false, reason }`).
Config comes from an injectable `configProvider()` defaulting to `appConfig.posthog`.

**B6 needs a broader query surface** than B5: activation events, feature-usage
aggregates across many orgs at once (not one contact email at a time), and possibly
multi-row HogQL results, not just a single `[timestamp, count]` row.

**Decision: new low-level shared client, B5 untouched.** The spec's own constraint
("B3/B4/B5 modules: consume, never modify") rules out extracting a shared module that
B5 would need to be refactored onto - that's a modification to a B5 file. Instead:
create `src/lib/posthog/query-client.ts`, a generic `runHogQLQuery(query: string,
values: Record<string, unknown>): Promise<HogQLQueryResult>` built from the exact
same fetch/auth-header/timeout/degrade-on-failure shape already in
`engagement-lookup.service.ts` (same `PostHogQueryConfig` reading `appConfig.posthog`,
same graceful-degradation contract). This is "reuse the pattern," not "share the
file" - B5's file gets zero diff. Future batches could adopt the shared client too,
but retrofitting B5 onto it is out of scope here and not something this batch should
do unprompted (mirrors the standing rule from the B5-adjacent incident: no touching
another batch's files without an explicit ask).

---

## 2. Internal metrics available via Prisma

**Subscription/plan state** - `Organization` (`prisma/schema.prisma` ~lines 150-252):
`subscriptionStatus` (`SubscriptionStatus`: `ACTIVE | TRIALING | PAST_DUE | CANCELLED
| GRACE_PERIOD | EXPIRED | SUSPENDED`), `plan` (`SubscriptionPlan`: `REGULATOR |
STARTUP | BUSINESS | ENTERPRISE`), `trialEndsAt`, `gracePeriodEndsAt`, `cancelledAt`,
`planStartDate`/`planEndDate`, `mpesaFailedRenewalAttempts`,
`mpesaLastRenewalAttemptAt`.

**Entitlements** - `src/config/entitlements.config.ts` lines 127-290,
`PLAN_ENTITLEMENTS` const. Confirmed directly: `STARTUP.gapAnalysis = { limit: 0,
period: 'month' }` (line 168), comment reads `// blocked -- upsell to Business tier`.
**This is intentional product design, not a bug** - the spec's framing of it as a
"known conflict" is itself slightly off; there's nothing in `KNOWN_ISSUES.md` calling
it a defect, and the code comment states the upsell intent directly. It does affect
signal *construction* though (see Section 3).

**Usage tracking** - `UsagePeriod` (`prisma/schema.prisma` ~lines 1713-1750): one row
per org per calendar month, with live counters (`complianceQueries`,
`checklistGenerations`, `gapAnalyses`, etc.) **and** a plan-limit snapshot captured at
period creation (`planTier`, `gapAnalysisLimit`, `checklistGenerationLimit`, ...,
using the `-1 = unlimited, 0 = disabled, n = cap` convention). `UsageRecord` is an
older/adjacent per-metric table (`BillingMetric` enum). `UsagePeriod` is the richer,
more BI-friendly source - has both usage and the limit it was measured against in one
row, so month-over-month trend queries don't need a join back to `PLAN_ENTITLEMENTS`.

**No denial log exists.** Confirmed via the trial-limit enforcement path
(`incrementTrialUsageAtomic` / `checkUsageLimit` middleware) - a blocked request is
rejected with `TRPCError(FORBIDDEN)` and only reaches Pino logs, not a queryable
table. `UsagePeriod.gapAnalyses` for a STARTUP org will read `0` forever (the request
never gets far enough to increment anything), so it **cannot** answer "how many times
did this org try and get blocked." See Section 3 for the workaround.

**Pilot fields** - confirmed unchanged from B5's audit: `PilotAccess` (`status`,
`startsAt`, `expiresAt`, `convertedAt`, `convertedPlan`), `User.pilotCohort` (cohort
lives on `User`, not `PilotAccess` - noted again here since B6 is exactly the kind of
consumer that note was written for).

**AgentRun across all agents** (`prisma/schema.prisma` ~lines 3364-3382): `agentType,
status, inputTokens, outputTokens, costUsd (Decimal 12,6), iterations, startedAt,
completedAt, organizationId`. Confirmed every `agentType` string in use today via each
module's `_AGENT_TYPE` const: `'regulatory-intelligence'` (B3), `'marketing'` (B4),
`'sales-growth'` (B5), `'automation'` (the n8n surface). A `groupBy(['agentType'])`
sum of `costUsd`/`inputTokens`/`outputTokens` plus a `count` by `status` over the
reporting window gives the workforce-spend section directly - no new fields needed.

---

## 3. Upgrade-moment signal design

Given there's no direct denial log (Section 2), the credible, queryable-today signal
is **indirect and trend-based**, not a "count of blocked attempts":

- **Primary signal:** `Organization.plan = 'STARTUP'` AND `subscriptionStatus IN
  ('ACTIVE','TRIALING')` AND, across the last 2-3 `UsagePeriod` rows for that org,
  `checklistGenerations >= checklistGenerationLimit` (i.e. hitting the 5/month STARTUP
  cap repeatedly) OR `complianceQueries` trending up near the top of its own recent
  history (STARTUP's compliance-query limit is unlimited, so "high" here means
  self-relative intensity, not a hard cap).
- **Secondary/weaker signal:** `UsagePeriod.gapAnalyses` will never be nonzero for a
  STARTUP org (feature is gated pre-request), so it cannot be used as a signal at all
  for that tier - only usable to detect *actual usage intensity* on BUSINESS/ENTERPRISE
  orgs approaching their own caps (20/month for BUSINESS).
- **Open question for Chris, not assumed:** if the frontend fires a PostHog event when
  a STARTUP user clicks into the gated gap-analysis feature and sees the upsell block
  (e.g. something like `gap_analysis_upsell_viewed`), that would be the actual direct
  "attempted and was blocked" signal and should be the primary one instead. I have no
  way to confirm this event exists - SheriaBot has zero PostHog integration configured
  anywhere (confirmed in B5's audit: no API keys, no capture calls in the codebase at
  all), so there's nothing to introspect. Stage 2 will build the trend-based signal
  above as the concrete, working v1, and treat a PostHog-event-based signal as
  additive if/when Chris confirms such an event exists and names it.

Every upgrade-moment candidate the agent surfaces must cite the specific
`UsagePeriod` rows/values it's based on (organizationId, periodStart, the metric and
its limit) - grounding discipline applies exactly as it did to B4/B5's "trace every
claim to a real field" rule, just at the metrics layer instead of the LLM-prompt layer.

---

## 4. Report cadence & audience

No scheduling infrastructure exists for this today (no cron, no node-cron usage tied
to report generation, confirmed by grep). Matches B4/B5's own pattern: the agent
exposes a `runReport` mutation: something external (n8n, most likely, given B5's
"automation" sibling batch is already n8n-facing) triggers it on the desired cadence.
B6 doesn't need to *implement* the Tue/Fri schedule itself - it needs to be safely
**idempotent per ISO week** so an external trigger firing twice (or on both Tue and
Fri, if that's intentional for two separate cadence hits) doesn't double-count.
Idempotency key: `bi-report:${isoYear}-W${isoWeek}` (mirrors B4/B5's `${type}:${date}`
convention, at week granularity instead of day granularity).

**`AgentReport` shape, no new table needed** (see Section 6) - confirmed the same
`summary / signals / recommendedActions / risks / humanApproved` contract B3/B4/B5
already write to is sufficient for a downstream B8 consumer: `summary` = the Claude
narrative, `signals` = the structured metrics snapshot (activation, funnel, adoption,
workforce cost/volume by agentType), `recommendedActions` = upgrade-moment candidates
+ anomalies worth a human look, `risks` = churn/drop-off flags. No B8 code exists yet
to consume this (confirmed: only reference to "B8" anywhere in the repo is the
"B8 synthesis note" comment left in B5's own Stage 1 doc, a forward-looking note with
no implementation) - so this is a forward-compatible shape decision, not integration
with existing code.

---

## 5. PostHog read scope check

Cannot be verified from the repo - there is no live PostHog project connected to
SheriaBot at all (Section 1 findings restated). The `POSTHOG_PERSONAL_API_KEY`/`HOST`/
`PROJECT_ID` env vars B5 added are optional and, per the deployment state visible
here, unset. Whatever scope that key has (once Chris provisions and sets it) applies
equally to B5's per-contact-email query and B6's broader activation/feature-usage
queries - HogQL Personal API Keys are project-scoped, not query-shape-scoped, so
there's no separate "B6 needs more scope than B5" concern once a key exists. Flagging
as a gap for Chris only in the sense that **no key is configured yet**, same gap B5
already surfaced - not a new, B6-specific gap.

---

## 6. Migration map

**Schema: confirmed `AgentReport` alone suffices, no `BIInsightReport` table.** B6
produces one synthesis per reporting window, not individually-actionable drafts
needing per-item review/dismissal (B4/B5's reason for a dedicated table was
per-draft `status`/`reviewedBy`/dedup). B6's dedup is per-report (the whole run), via
`AgentRun.idempotencyKey`, exactly like B3's `runScan`. **No DDL, no `prisma
generate` needed for schema.** (`prisma generate` still needs to run if any other
concurrent change touched `schema.prisma` - not expected to be needed for this batch
specifically.)

**CREATE:**
- `src/lib/posthog/query-client.ts` (+ `.test.ts`) - generic HogQL query function,
  pattern-matched to B5's `engagement-lookup.service.ts`, B5 untouched.
- `src/modules/agents/product-bi/types.ts`
- `src/modules/agents/product-bi/metrics-computation.service.ts` (+ `.test.ts`) -
  pure TypeScript, Prisma reads only (`Organization`, `UsagePeriod`, `AgentRun`,
  `PilotAccess`/`User` pilot fields) plus the new PostHog client for activation/
  feature-usage events.
- `src/modules/agents/product-bi/insight-synthesis.service.ts` (+ `.test.ts`) -
  Claude-only narrative layer, `provider: 'anthropic'`, `allowFallback: false`,
  grounding rules mirroring B4/B5's (no invented numbers, correlations phrased as
  "worth investigating," not causal).
- `src/modules/agents/product-bi/product-bi.agent.ts` (+ `.test.ts`) - orchestrator,
  `AgentRun` lifecycle, weekly idempotency key.
- `src/modules/agents/product-bi/product-bi.safety.test.ts` - mirrors B4/B5's
  zero-write-path regex scan, adjusted for Organization/User/PilotAccess/
  Subscription/Plan write-method names, plus a PostHog capture/identify/write scan
  same as B5's.

**MODIFY (additive only):**
- `src/modules/agents/agent-credential.service.ts` - add
  `agents.productBi.report.create` and `agents.productBi.report.read` to
  `AGENT_CAPABILITIES`. Two lines, same pattern as every prior batch.
- `src/server/routers/agents.router.ts` - add `productBi: router({...})` as a fifth
  sibling after `automation`.

**No `reviewDraft`-equivalent endpoint** - confirmed not needed per the "no
individually actionable drafts" reasoning above. If Chris wants individual insights
dismissable later, that's an additive follow-up, not blocking this batch.

**Zero writes confirmed to:** `Organization`, `User`, `PilotAccess`, `Subscription`/
`Plan`-adjacent tables, any PostHog capture/write path. **No protected surface**
touched. **No new dependency** - `runHogQLQuery` is a plain `fetch()`, same as B5.

---

## Note on repo state at time of this audit

The five automation-batch files from the separate, unreviewed session
(`src/lib/redis/rate-limiter.automation.test.ts`,
`src/modules/agents/automation/{automation.router-wiring,types,wire-format}.test.ts`,
and the `types.ts` export-visibility diff) remain uncommitted, per your standing
instruction not to fold them into any B6 commit. This audit did not read, rely on, or
modify any of them - B6's own metrics/orchestrator design has no dependency on that
test coverage.
