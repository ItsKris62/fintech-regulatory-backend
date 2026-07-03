# Phase B - Batch B7 (Security/Ops Agent) - Stage 1 Read-Only Audit

**Status:** STAGE 1 COMPLETE - awaiting operator approval before Stage 2 implementation.
No code was changed to produce this document. Backend `main`, working tree clean at
audit time (HEAD `aee2ba39`, B3-B6 + the multi-principal credential refactor + the
n8n automation module all committed prior history, confirmed via Chris's own commits).

---

## 1. GitHub Dependabot / CodeQL - not configured, and absence of local config does
## not prove they're off

`.github/dependabot.yml` and any `.github/workflows/*codeql*` file: **not found**
anywhere in the backend, platform, or repo root. No `.github/workflows/` directory
exists at all - CI/CD here runs on Render (`render.yaml`), not GitHub Actions.

**Important nuance the naive "not found" conclusion misses:** GitHub has two
independent things people call "Dependabot," and only one needs a committed file.
*Dependabot version-update PRs* need `.github/dependabot.yml` (confirmed absent).
*Dependabot security alerts* (vulnerability alerts on existing dependencies) and
*CodeQL default setup* (GitHub's one-click SAST) are both **repo/org settings
toggles**, not files - a repo can have either or both enabled with zero lines
committed anywhere. I cannot determine from repo contents alone whether Dependabot
alerts or CodeQL default setup are actually enabled on `ItsKris62/fintech-regulatory-
backend` on GitHub - that's only checkable via the GitHub UI (Settings > Code security)
or the GitHub API, which nothing in this codebase calls today (confirmed: zero hits
for `octokit`, `api.github.com`, `GITHUB_TOKEN`, `GH_TOKEN` anywhere in `src/`).

**This is the actual Stage 1 finding, not "nothing exists":** B7 cannot know what
security findings exist today without either (a) Chris confirming what's enabled in
GitHub repo settings, or (b) B7 itself querying the GitHub API once given a token -
option (b) is the real design, but needs the token provisioned first (see Section 5).

---

## 2. Sentry - write-only today, confirmed on both backend and frontend

Backend: `@sentry/node` (`package.json`), initialized in `src/lib/sentry.ts`,
called before all other imports in `src/index.ts`. Captures exceptions
(`Sentry.captureException` in tRPC error handling, `src/app.ts`) and a low-rate trace
sampler (`SENTRY_TRACES_SAMPLE_RATE`, default 0.01, `/health` explicitly excluded from
tracing). Frontend: `@sentry/nextjs`, same write-only pattern (server + edge configs).

**No read path exists anywhere** - no calls to Sentry's REST API (`api.sentry.io`) to
pull issue counts, error rates, or event metadata. Same shape of gap as B5's PostHog
finding: the write side is live and real, the read side needs a **new** Sentry API
token (org-scoped, `read` access to `event:read`/`project:read`) that isn't
provisioned anywhere today.

---

## 3. Better Stack / uptime monitoring - total gap, and there's a cheaper internal
## alternative worth using first

Zero hits anywhere for Better Stack, BetterStack, UptimeRobot, Pingdom, StatusCake, or
any competing service - no external uptime monitor is wired up at all.

**But the backend already has two self-monitoring surfaces B7 can read in-process,
with no new credential and no new HTTP round-trip:**

- `GET /health` (`src/app.ts`) - public, no auth, returns uptime/memory/version. Not
  very useful for B7 beyond confirming the process itself is up.
- `GET /health/detailed` (`src/app.ts`) - admin-JWT-gated, checks DB (Prisma `SELECT
  1`, latency), Redis (Upstash ping, latency), and exposes `errorTracker.getSummary()`
  - an in-memory error-rate tracker (`src/lib/error-tracker.ts`): 5-minute sliding
  window, alerts internally (Pino `error_rate_alert`) past a 10-error threshold,
  returns unique-error counts and the 5 most recent errors.

Since B7 runs inside this same backend process, it should **import and call
`errorTracker.getSummary()` directly**, not make an HTTP request to its own
`/health/detailed` endpoint - that avoids needing a service-level admin JWT for a
call that's happening in-process anyway. This gives B7 a real, already-built error-
rate signal for zero new integration cost. It is in-memory only (resets on deploy/
restart), so it's a "since last restart" window, not a durable history - worth noting
as a limitation in the synthesized report, not silently smoothed over.

---

## 4. Spend tracking - solid for agent-workforce, a real gap for everything else,
## and a total gap for external infra providers

**LLM gateway cost mechanics** (`src/lib/ai/gateway/pricing.ts`,
`src/lib/ai/gateway/llm-gateway.ts`): pricing is a hardcoded per-model table
(Anthropic/OpenAI/Gemini rates per 1M tokens), `calculateCost()` is exported, and
unknown models fail safe to the worst-case known rate rather than under-billing.
Every completion call - agent or not - calls `trackCost()`, which increments a Redis
daily counter `ai:cost:${date}` (7-day TTL) and logs a warning/error at 80%/100% of
the daily limit. This 7-day Redis counter is genuinely cross-feature (agent workforce
+ compliance queries + policy generation + checklist generation + gap analysis all
flow through it), but it's ephemeral - gone after 7 days or a Redis flush, no Prisma
table backs it.

**`AgentRun.costUsd` is durable but scoped to agent-workforce only.** Confirmed the
current `agentType` values: `'automation'`, `'marketing'`, `'product-bi'`,
`'regulatory-intelligence'`, `'sales-growth'`. A `groupBy(['agentType'])` sum over
`AgentRun` (exactly B6's `computeWorkforceCosts` pattern, already built and tested)
gives durable, accurate workforce spend by agent type and by day/week. It does **not**
include compliance-query/policy-generation/checklist/gap-analysis spend - those calls
never create an `AgentRun` row, so their cost only ever lived in the 7-day Redis
counter.

**Implication for B7's "cross-provider spend" scope:** "spend by provider
(Anthropic/OpenAI/Gemini)" is answerable **today**, durably, for agent-workforce
calls via `AgentRun` (no `metadata` field currently records provider split beyond
what each batch's `advanceRun` metadata call happens to include - B4/B5/B6 all pass
`provider` in `metadata`, so it's there, just needs reading out of the JSON column
rather than a dedicated column). "Total spend across the whole product" is only
answerable for the trailing 7 days via the Redis counter, and isn't split by provider
there (it's a single running float, not broken out). Building durable non-agent spend
tracking (e.g. a lightweight `LLMUsageLog` table) is a real option but is scope growth
beyond "read existing data" - flagging it rather than assuming Chris wants it in v1.

**External infra provider spend (Render/Vercel/Supabase-billing/Pinecone-usage): a
total, confirmed gap.** Zero API integration exists for any of the four. None of
Render/Vercel API tokens or a Supabase *Management* API key (distinct from the
existing anon/service-role keys, which are auth-only) are configured anywhere. This
is the single biggest scope item in the spec's ask and needs an explicit decision
from Chris before Stage 2 touches it (see Section 6/7) - it is not something to build
speculatively against APIs I haven't been asked to provision credentials for.

---

## 5. Alerting - reuse the pattern, don't touch the B2 file

`agentRunService.alertOperator()` (`src/modules/agents/agent-run.service.ts`,
private method) is the existing failure-alert path every batch's budget-halt/run-
failure case already goes through. It's narrowly shaped for exactly that purpose:
`alertOperator(subject, run: AgentRun, reason)`, HTML built inline from those three
values, tagged `{ category: 'security', type: 'agent_failure_alert' }`. It's private
and it's a B2 file - not touching it, same standing rule as every prior batch.

**What B7 should actually reuse is the primitive underneath it**, `sendEmail()`
(`src/lib/email/client.ts`), which takes an arbitrary `tags` array and is already
used with different `category`/`type` values across the app (`auth`, `billing`,
`compliance_alert`, `policy_ready`, `agent_failure_alert`). B7 gets its own sibling
send function in its own module (not added to `agent-run.service.ts`), using new tag
values like `{ category: 'security', type: 'security_ops_alert' }`. Recipient:
`appConfig.marketing.adminNotificationEmail`, same as every other operator alert -
no new config needed there. This mirrors exactly how B6 handled the PostHog client:
same pattern, new file, zero diff to the file being mirrored.

`isCriticalEmail()` in `client.ts` already routes emails tagged with certain
category/type combinations into a `prisma.auditLog` write for critical-email
tracking - B7's alerts should probably qualify (a security finding email is
critical), which just means picking a `type` value or adding
`category: 'security'` recognition there if it isn't already covered. Confirming
exact wording is a two-line additive check in Stage 2, not a design blocker now.

---

## 6. "Event-driven, not just scheduled" - what that can honestly mean today

The spec calls B7 "event-driven," but there is no webhook receiver infrastructure
anywhere in this codebase for GitHub, Sentry, or any external service to push events
into - building one is a materially bigger and riskier lift than every prior batch
(new unauthenticated-until-signature-verified public endpoints, HMAC verification,
replay protection). That's a real architecture decision, not a Stage 1 detail to wave
through.

**Recommended v1 scope: polling, not webhooks**, matching every prior batch's
`runDigest`/`runReport` pattern - B7 exposes a mutation an external trigger (n8n, per
the established pattern from the automation batch) calls on a cadence, and each run
asks "what's new since the last run" (GitHub API `since` params, Sentry API time
windows, `errorTracker`'s live in-memory summary, `AgentRun` rows since last
idempotency window). This is "event-driven" in the sense that the *report content* is
about discrete events (a new CVE, a new critical finding), even though the *trigger*
is still an external poll - not true push-based webhooks. If Chris wants real
webhook-driven triggering later, that's a distinct, larger batch with its own
security review, not folded into B7 v1.

---

## 7. Migration map

**CREATE:**
- `src/lib/github/security-findings-client.ts` (+ `.test.ts`) - plain `fetch()`
  client (same shape as B5/B6's PostHog client - no new dependency, Octokit isn't
  needed for two read-only REST endpoints) against
  `GET /repos/{owner}/{repo}/dependabot/alerts` and
  `GET /repos/{owner}/{repo}/code-scanning/alerts`, both read-only, both requiring a
  new `GITHUB_TOKEN` (fine-grained PAT, `security_events: read` + `dependabot_alerts:
  read`) plus `GITHUB_OWNER`/`GITHUB_REPO` - **none of these exist yet, new
  credential needed from Chris.**
- `src/lib/sentry-api/sentry-query-client.ts` (+ `.test.ts`) - plain `fetch()`
  client against Sentry's REST API for issue/error-rate queries, needs a new
  `SENTRY_API_TOKEN` + org/project slugs - **new credential needed from Chris.**
- `src/modules/agents/security-ops/types.ts`
- `src/modules/agents/security-ops/findings-aggregation.service.ts` (+ `.test.ts`) -
  pure TypeScript + the two new clients + `errorTracker` (direct import, in-process)
  + `AgentRun` `groupBy` for workforce spend (mirrors B6's
  `computeWorkforceCosts` exactly).
- `src/modules/agents/security-ops/alert-synthesis.service.ts` (+ `.test.ts`) -
  Claude-only, `provider: 'anthropic'`, `allowFallback: false`, grounding rules
  requiring every finding cited by its real alert ID/severity/timestamp (the
  "evidence over summary" requirement from the prompt), never inventing a CVE
  score or affected-package name not present in the source data.
- `src/modules/agents/security-ops/security-ops.agent.ts` (+ `.test.ts`) -
  `AgentRun`/`AgentReport` lifecycle exactly like B6 (agentType e.g.
  `'security-ops'`), idempotent per run window.
- `src/modules/agents/security-ops/ops-alert.service.ts` (+ `.test.ts`) - the
  `sendEmail()` sibling described in Section 5.
- `src/modules/agents/security-ops/security-ops.safety.test.ts` - zero-write scan
  (mirroring B6's), plus an explicit assertion that it never calls
  `agentRunService.alertOperator` or otherwise imports/modifies
  `agent-run.service.ts`.

**MODIFY (additive only):**
- `src/modules/agents/agent-credential.service.ts` - two capabilities,
  `agents.securityOps.report.create` / `.read`.
- `src/server/routers/agents.router.ts` - `securityOps: router({...})` sixth
  sibling, `agentProcedure`-gated only (same tenant-isolation proof pattern as B6,
  reused verbatim - this agent also spans all organizations, not one tenant).
- `.env.example` / `src/config/app.config.ts` / `src/config/env.validator.ts` - new
  optional env vars for GitHub + Sentry read access (same optional/graceful-
  degrade pattern as B5/B6's PostHog vars - missing credentials degrade the
  relevant section to unavailable, never fail the whole run).

**Explicitly NOT in this batch's Stage 2, pending Chris's go/no-go:**
- Render/Vercel/Supabase-management/Pinecone-usage billing API integration
  (Section 4) - four more credentials, four more API shapes, genuinely separate
  scope from the GitHub+Sentry read paths. Recommend splitting this into its own
  follow-up rather than bundling into B7, but flagging here rather than deciding
  unilaterally.
- True webhook-based event triggering (Section 6) - bigger security surface,
  separate design review.
- A durable non-agent-workforce spend table (Section 4) - real gap, but new scope
  beyond "read what exists."

**Zero writes confirmed to:** any table outside `AgentRun`/`AgentReport` (its own
report path). **No protected surface** touched. **No modification to
`agent-run.service.ts`, `agent-credential.service.ts` logic (only the additive
capability lines), or `agentProcedure`/middleware evaluation logic** - same proof
requirement as every prior batch, `git diff -- middleware.ts trpc.ts` must stay
empty in Stage 2.

---

## Open decisions for Chris before Stage 2

1. Confirm whether GitHub Dependabot alerts / CodeQL default setup are actually
   enabled in repo settings (Section 1) - I cannot check this from repo contents.
2. Provision a `GITHUB_TOKEN` (fine-grained PAT, read-only security scopes) if (1)
   confirms they're enabled and Chris wants B7 to read them.
3. Provision a `SENTRY_API_TOKEN` (org-scoped, read access) if Chris wants live
   Sentry error-rate data rather than just the in-process `errorTracker` window.
4. Decide whether Render/Vercel/Supabase/Pinecone spend tracking is in scope for
   this batch or a separate follow-up (recommend: separate follow-up).
5. Confirm "event-driven" means polling-with-event-shaped-content (Section 6's
   recommendation) rather than true webhook receivers for this v1.

If (2) and (3) aren't provisioned, Stage 2 can still ship a working v1 that
synthesizes from `AgentRun` workforce spend + the in-process `errorTracker` alone,
with the GitHub/Sentry sections gracefully degraded to "unavailable" - same
degrade-don't-fail contract as every external integration since B5.
