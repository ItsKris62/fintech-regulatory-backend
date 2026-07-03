# Phase B - Batch B9 (n8n Trigger Wiring) - Stage 1 Read-Only Audit

**Status:** STAGE 1 COMPLETE - awaiting operator approval before Stage 2 implementation.
No code was changed to produce this document. Backend `main`, B1-B8 plus the
multi-principal credential refactor and the n8n automation module (`agents.automation.*`)
confirmed present and committed prior history. All six `run*` mutations named in the
spec exist and are reachable only via `agentProcedure`.

---

## 1. Credential-scoping decision - recommend Option B, with one sub-decision flagged

**Recommendation: Option B - a third principal, narrowly scoped to trigger-only
capabilities.** Reasoning, checked against the actual code rather than assumed:

- The credential infrastructure is already built for N principals, not two.
  `AGENT_PRINCIPALS` (`src/modules/agents/agent-credential.service.ts:69`) is a
  `Record<AgentPrincipalId, ...>`, and `issue-agent-credential.ts`
  (`src/scripts/issue-agent-credential.ts`) already takes `--principal <id>` as a
  generic argument - adding a third principal is extending an existing pattern, not
  inventing a new one.
- `verifyCredential()` (`agent-credential.service.ts:257`) already evaluates every
  principal on every request without early-exit specifically to keep timing
  indistinguishable across principals - it was written to scale past two.
- Option A (issue n8n the full `sys-agent-orchestrator` credential) directly
  reintroduces the exact risk the multi-principal split's own code comment states it
  exists to prevent: "so a leaked automation secret can never call the broader
  agent-run/marketing/sales API." `sys-agent-orchestrator` currently holds every
  capability except the two automation ones - `agents.run.advance`, `agents.run.
  complete`, `agents.run.fail`, all report-read and draft-read capabilities included.
  A leaked n8n credential under Option A could read every marketing/sales draft,
  every product-bi/security-ops/chief-of-staff report, and forge run-state
  transitions - materially larger blast radius than "kicks off scheduled work."
- Cost of Option B is small and mechanical: six new capability strings (one is a
  rename of an existing shared one, see below), one new `AgentPrincipalDefinition`
  entry, one new `SystemConfig` key for its hashed secret, one credential issuance
  via the existing script with `--principal sys-scheduler-orchestrator`. No new
  files beyond what capability/router wiring already requires.

**Sub-decision Stage 1 is flagging, not deciding: should the six trigger
capabilities be disjoint from `sys-agent-orchestrator`, or additionally held by it?**

Today, `sys-agent-orchestrator` already holds five of the six capabilities the
`run*` mutations require (everything except the one described in the next section),
because `AGENT_PRINCIPALS` only carves `AUTOMATION_CAPABILITIES` out of its grant -
nothing else is excluded. Two ways to proceed:

- **B1 (non-disjoint, less change):** add the six trigger capabilities only to the
  new `sys-scheduler-orchestrator` principal; leave `sys-agent-orchestrator`'s grant
  untouched (it keeps its current, incidental ability to call all six `run*`
  mutations too). Zero behavior change to the existing principal.
- **B2 (disjoint, tighter, matches the automation-principal precedent exactly):**
  exclude the six trigger capabilities from `sys-agent-orchestrator` the same way
  `AUTOMATION_CAPABILITIES` is excluded today, so scheduled runs can *only* be
  triggered via the new narrow principal. Nothing in production currently depends
  on `sys-agent-orchestrator` calling these six mutations (the workforce is
  dormant), so this costs nothing functionally today, and it closes blast radius
  further: even a leaked orchestrator credential could no longer spin up new scans/
  drafts/reports on demand.

Recommend **B2** for consistency with the pattern already established for the
automation principal, but this narrows `sys-agent-orchestrator`'s current grant and
should be Chris's call, not assumed.

---

## 2. Exact `run*` mutation names and current capabilities

Read directly from `src/server/routers/agents.router.ts` (current HEAD), not from
the batch spec's paraphrased names - one of the six differs from what the spec
assumed:

| Agent | Procedure path | Current required capability | Notes |
|---|---|---|---|
| Regulatory Intelligence (B3) | `agents.regIntel.runScan` | **`agents.run.create`** | Reused/shared - see finding below |
| Marketing (B4) | `agents.marketing.runDrafting` | `agents.marketing.draft.create` | Dedicated, single-endpoint-scoped |
| Sales/Growth (B5) | `agents.sales.runDrafting` | `agents.sales.draft.create` | Dedicated, single-endpoint-scoped |
| Product/BI (B6) | `agents.productBi.runReport` | `agents.productBi.report.create` | Dedicated, single-endpoint-scoped |
| Security/Ops (B7) | `agents.securityOps.runReport` | `agents.securityOps.report.create` | **Not `runDigest`** - spec's name was aspirational, actual endpoint is `runReport` |
| Chief of Staff (B8) | `agents.chiefOfStaff.runBrief` | `agents.chiefOfStaff.report.create` | Dedicated, single-endpoint-scoped |

**Finding that matters for Option B: `regIntel.runScan` is the one exception to the
"each `run*` mutation has its own dedicated, single-endpoint capability" pattern.**
It reuses `agents.run.create`, the same capability the fully generic
`agentsRouter.beginRun` mutation requires (`agents.router.ts:47`) - the raw
mutation that lets a caller create an `AgentRun` row for *any* `agentType` string,
*any* `organizationId`, and arbitrary `metadata`. Granting a trigger-only principal
`agents.run.create` so it can call `regIntel.runScan` would also, as a side effect,
let it call the generic `beginRun` directly - broader than "kick off the six known
scans," and exactly the kind of gap Option B exists to close.

**Required fix, additive and router-only (not a B3 module change):** mint a new
dedicated capability `agents.regIntel.run.create`, add it to `AGENT_CAPABILITIES`,
and change `regIntel.runScan`'s procedure in `agents.router.ts` from
`agentProcedure('agents.run.create')` to `agentProcedure('agents.regIntel.run.create')`.
This is a change to the shared router/capability-wiring file every batch from B4
onward has already touched additively - not a change to `reg-intel.agent.ts` itself,
so it stays inside B9's stated boundary ("only adds what's needed for external
callers to safely invoke the existing `run*` mutations"). Because
`AGENT_PRINCIPALS['sys-agent-orchestrator'].capabilities` is computed as "everything
in `AGENT_CAPABILITIES` except `AUTOMATION_CAPABILITIES`," `sys-agent-orchestrator`
picks up the new capability automatically and keeps calling `regIntel.runScan`
without any separate change - the rename is transparent to every existing caller.

Also confirmed: none of the six `run*` mutations currently has `rateLimited(...)`
applied (only `agents.automation.logEvent`/`generate` do - `agents.router.ts:184-207`).
The fail-closed rate limit that already exists on every `agentProcedure` call today
is `requireAgentCapability`'s own `agent-auth` bucket (`middleware.ts:851-866`, 20
attempts/60s per hashed IP, fail-closed) - that throttles *credential-verification
attempts*, not per-mutation throughput. Batch B2's automation surface additionally
rate-limits *successful, authenticated* calls per action (`AUTOMATION_LOG_RATE_LIMIT_MAX`
etc., `app.config.ts:89-92`). The six `run*` mutations have no equivalent today. Per
the batch's own non-negotiable constraint ("rate-limit and log every trigger call,
same fail-closed pattern as B2's credential verification"), Stage 2 should add one
`rateLimited('agent-trigger-<name>', ...)` middleware per `run*` mutation, new
config keys following the exact `app.config.ts:89-92` shape (e.g.
`AGENT_TRIGGER_RATE_LIMIT_MAX` / `_WINDOW_SECONDS`, or per-agent if Chris wants
different ceilings for the tighter reg-intel/security-ops loop vs. the twice-weekly
ones). Logging is already unconditional and structured for every call via
`logger.info`/`auditAgentAuthorization` inside `requireAgentCapability` and inside
each agent's own `beginRun`/`agent_run_started` log line - no additional logging
plumbing needed beyond what already fires today.

---

## 3. Idempotency confirmation - all six confirmed safe to double-fire

Read each agent's `run*` method directly. All six call `agentRunService.beginRun()`
(`agent-run.service.ts:176`) first, which does a Redis `SET NX` on the idempotency
key (`agent-run.service.ts:182-192`) before creating any `AgentRun` row - a second
call with the same key returns `{ started: true, duplicate: true, run: existing }`
as a pure no-op, never a second run or a double LLM spend. Confirmed default key
shape (used whenever the caller omits `idempotencyKey`, which n8n should always do
- see Section 5):

| Agent | Default idempotency key | Window |
|---|---|---|
| `regIntel.runScan` | `reg-intel:${YYYY-MM-DD}` | Per calendar day |
| `marketing.runDrafting` | `marketing:${YYYY-MM-DD}` | Per calendar day |
| `sales.runDrafting` | `sales:${YYYY-MM-DD}` | Per calendar day |
| `securityOps.runReport` | `security-ops:${YYYY-MM-DD}` | Per calendar day |
| `productBi.runReport` | `bi-report:${isoWeek}` | Per ISO week |
| `chiefOfStaff.runBrief` | `chief-of-staff:${isoWeek}` | Per ISO week |

Implication for n8n workflow design: **never pass an explicit `idempotencyKey`
generated per-execution (e.g. n8n's own execution ID or a timestamp)** - that would
defeat the built-in window and let a retry or overlapping schedule create a second
real run. Leave the input body's `idempotencyKey` field absent entirely and let the
backend default apply; a retry or an accidental double-fire within the same
day/week then collapses to the existing no-op path automatically.

---

## 4. Cadence design

Two of the six are weekly-idempotent already (`productBi`, `chiefOfStaff`); calling
them more than once inside the same ISO week is a guaranteed no-op, so there's no
benefit to scheduling them more than once/week regardless of Chris's Tue/Fri
cadence. The other four are daily-idempotent, which supports a tighter loop than
twice weekly if desired.

**Recommended schedule:**

- **`regIntel.runScan` - daily.** Compliance/regulatory monitoring benefits from
  catching new signals same-day rather than waiting up to 4 days (Sat->Tue gap on a
  strict Tue/Fri cadence); the per-day idempotency key makes daily calls free of
  duplicate-run risk.
- **`securityOps.runReport` - daily.** Same reasoning - security findings
  (dependency CVEs, error-rate spikes) shouldn't sit unreported for days; per-day
  idempotency makes this safe.
- **`marketing.runDrafting` - Tue/Fri**, scheduled to run *after* that day's
  `regIntel.runScan` completes. Marketing's signal selector drafts from
  `RegulatorySignal` rows `regIntel` produces (confirmed in
  `marketing.agent.ts:67`: "Marketing drafting completed with no new eligible
  RegulatorySignal rows" is an explicit reachable state) - running before that
  day's scan means drafting against whatever signals already existed, not the
  freshest ones. Matches Chris's actual twice-weekly review cadence rather than
  generating daily draft batches he didn't ask for.
- **`sales.runDrafting` - Tue/Fri**, same ordering requirement as marketing (after
  that day's `regIntel.runScan`).
- **`productBi.runReport` - Fri only.** Weekly-idempotent; running it Tuesday too
  would just be a documented no-op, so pick the day closer to the weekly synthesis
  for the freshest usage-metrics pulse.
- **`chiefOfStaff.runBrief` - Fri only, scheduled last.** `chiefOfStaffSourceReportsService.
  fetchAllSourceReports()` (per the B8 audit, confirmed against
  `chief-of-staff.agent.ts:91`) reads the *latest* `AgentReport` per agentType with
  no freshness/staleness check - if it runs before the other five have produced
  that week's reports, it silently synthesizes on stale data instead of failing
  loudly. This ordering dependency is **not enforced by the backend** (each `run*`
  mutation is independently callable) - it must be encoded in the n8n workflow
  itself (e.g., a single Friday workflow with sequential HTTP Request nodes:
  regIntel -> marketing/sales (parallel, both depend only on regIntel) ->
  productBi/securityOps (parallel, independent of the others) -> chiefOfStaff last;
  or separate workflows chained with n8n's "Execute Workflow" node). Flagging this
  explicitly per the spec's Section 1 item 4 instruction, since nothing in the
  backend will catch a misordered n8n workflow - it will just produce a
  quietly-stale weekly brief.

---

## 5. n8n-side HTTP reference (for Chris/Codex to build the workflow - not backend code)

Confirmed from `src/server/trpc/router.ts:106` (`agents: agentsRouter`) and
`API_DOCUMENTATION.md` (tRPC served at `/trpc`, mutations are `POST`, HTTP batch
link convention):

- **Base URL:** `<backend origin>/trpc/<procedure.path>` (no batching needed for a
  single-call n8n HTTP Request node - omit the batch-array wrapper and call the
  procedure path directly).
- **Method:** `POST` (all six are mutations).
- **Header:** `X-Agent-Credential: <secret>` (constant name importable as
  `AGENT_CREDENTIAL_HEADER_DISPLAY` - `agent-credential.service.ts:9`). This is the
  scheduler principal's own secret, issued via
  `npm run <script> -- --principal sys-scheduler-orchestrator` (exact script name
  TBD in Stage 2 - currently `src/scripts/issue-agent-credential.ts`, invoked
  directly with `ts-node`/`tsx` per existing usage, not yet wrapped in a package.json
  script - confirm invocation convention in Stage 2).
- **Body (tRPC JSON convention):** `{ "json": { ... } }`, where the inner object is
  the mutation's optional input. For every one of the six, the input is optional
  and every field inside it is optional - **the simplest and recommended n8n body
  is `{ "json": {} }`** (or an empty body, since the whole input object itself is
  `.optional()` on all six), which lets every default (idempotency key, `maxItems`/
  `maxSignals`/`maxProspects`/`windowDays` defaults) apply. Only pass `windowDays`/
  `maxItems`/etc. explicitly if Chris wants non-default tuning; never pass
  `idempotencyKey` (see Section 3).
- **Procedure paths to call, one HTTP Request node each:**
  - `POST /trpc/agents.regIntel.runScan`
  - `POST /trpc/agents.marketing.runDrafting`
  - `POST /trpc/agents.sales.runDrafting`
  - `POST /trpc/agents.productBi.runReport`
  - `POST /trpc/agents.securityOps.runReport`
  - `POST /trpc/agents.chiefOfStaff.runBrief`
- **Response shape:** each resolves to that agent's own `*RunResult` type - all six
  share the shape `{ runId: string | null, status: 'SKIPPED_DISABLED' | 'DUPLICATE'
  | 'COMPLETED' | 'HALTED_BUDGET' | 'FAILED', ...agent-specific counts }`. n8n
  workflows can branch on `status` (e.g., alert Chris only on `'FAILED'` or
  `'HALTED_BUDGET'`, treat `'DUPLICATE'`/`'SKIPPED_DISABLED'` as expected no-ops,
  not errors).
- **Failure modes to expect and not misinterpret as bugs:** `401` with "Invalid
  agent credential" (bad/rotated secret), `429` with "Too many agent authentication
  attempts" (agent-auth bucket - would only fire under credential-guessing volumes,
  not normal scheduled traffic) or the new per-trigger rate-limit `429` once Stage 2
  adds it, and `403`-equivalent `authorization.denied` for a capability mismatch
  (e.g., using the scheduler credential against an endpoint it wasn't granted -
  should never happen if Section 2's capability list is correct, but worth an n8n
  alert if it ever does, since it likely means a mis-scoped credential).

---

## 6. Migration map

**CREATE:**
- Nothing under `src/modules/agents/*` module directories - B9 touches no B3-B8
  internals per the spec's constraint.

**MODIFY (additive/wiring only):**
- `src/modules/agents/agent-credential.service.ts`:
  - Add `'agents.regIntel.run.create'` to `AGENT_CAPABILITIES` (Section 2 fix).
  - Add a `TRIGGER_CAPABILITIES` array (the six trigger capabilities, using the
    corrected `regIntel` entry) alongside the existing `AUTOMATION_CAPABILITIES`
    array.
  - Add `'sys-scheduler-orchestrator'` to `AgentPrincipalId` and a matching entry
    in `AGENT_PRINCIPALS` (own `configKey`, e.g.
    `agent.schedulerOrchestrator.activeCredential`; `capabilities:
    TRIGGER_CAPABILITIES`).
  - If Chris picks sub-decision **B2** (Section 1): change
    `sys-agent-orchestrator`'s capability filter to also exclude
    `TRIGGER_CAPABILITIES`, mirroring the existing `AUTOMATION_CAPABILITIES`
    exclusion.
- `src/server/routers/agents.router.ts`:
  - Change `regIntel.runScan`'s procedure from `agentProcedure('agents.run.create')`
    to `agentProcedure('agents.regIntel.run.create')`.
  - Add `.use(rateLimited('agent-trigger-<name>', appConfig.agents.trigger.<name>RateLimitMax, { window: appConfig.agents.trigger.<name>RateLimitWindowSeconds }))`
    to all six `run*` procedures, matching the existing `automation.logEvent`/
    `generate` shape exactly (`agents.router.ts:184-207`).
- `src/config/app.config.ts`:
  - New env-schema entries following the exact `AUTOMATION_LOG_RATE_LIMIT_MAX`
    shape (`app.config.ts:89-92`) for the new trigger rate limits, plus the
    corresponding `appConfig.agents.trigger.*` block.
- `.env.example`: document the new rate-limit env vars (matching how
  `AUTOMATION_LOG_RATE_LIMIT_MAX` etc. are presumably already documented there).
- `src/scripts/issue-agent-credential.ts`: no code change needed -
  `parsePrincipalArg()` already accepts any key present in `AGENT_PRINCIPALS`, so
  `--principal sys-scheduler-orchestrator` works automatically once the principal
  entry exists.

**Tests to add (mirroring existing coverage patterns):**
- `agent-credential.service.test.ts`: extend for the third principal (issuance,
  verification, disjoint-capability assertion per whichever sub-decision Chris
  picks).
- A new `*.router-wiring.test.ts` (mirroring `automation.router-wiring.test.ts`)
  or an extension of an existing one, asserting each `run*` procedure's capability
  string matches the corrected table in Section 2, and that the new rate limiters
  are wired (mirroring `rate-limiter.automation.test.ts`'s "rejects past X,
  independent of the shared agent-auth bucket" pattern).

**Zero writes confirmed to:** any table beyond what B3-B8 already write via their
own `beginRun`/`createReport` calls - B9 adds no new Prisma models or migrations.
**No protected surface touched** (RAG pipeline, R2 buckets, compliance
orchestrator, SSE route untouched). **No modification to any B3-B8 agent/service
file** - only the shared `agents.router.ts`, `agent-credential.service.ts`,
`app.config.ts`, and the credential-issuance script's *usage* (not its code). **No
new npm dependency** - no scheduler library, `agentProcedure`/`rateLimited`/
`agentCredentialService` are all existing primitives. **No `prisma migrate`** - the
new principal's secret reuses the existing `SystemConfig` key/value pattern, same
as both current principals.

---

## Decisions - confirmed by Chris directly in conversation, 2026-07-03

Chris reviewed and explicitly confirmed all four items in his own words (not
inferred from the earlier structured question responses alone):

1. **Section 1: Option B confirmed.** New `sys-scheduler-orchestrator` principal,
   trigger-only capabilities.
2. **Section 1 sub-decision: B2 confirmed.** Fully disjoint - the six trigger
   capabilities are stripped from `sys-agent-orchestrator`'s grant as well as
   granted to the new principal, mirroring the existing `AUTOMATION_CAPABILITIES`
   exclusion pattern.
3. **Section 2: `agents.regIntel.run.create` fix confirmed in scope.** `regIntel.
   runScan` is repointed from the shared `agents.run.create` to this new
   dedicated capability as part of this batch.
4. **Section 4: cadence confirmed as proposed.** Reg-intel + security-ops daily;
   marketing + sales Tue/Fri after that day's reg-intel run; product-bi +
   chief-of-staff Fri only, chief-of-staff scheduled last.

---

## Stage 2 - implemented, 2026-07-03

All four decisions implemented exactly as described in Section 6's migration map,
plus the standing constraints (additive only, no new npm dependency, no `prisma
migrate`, deny-by-default, rate-limited + logged, positive-assertion tests).

**Changed files:**
- `src/modules/agents/agent-credential.service.ts` - added `agents.regIntel.run.
  create` to `AGENT_CAPABILITIES`; added `TRIGGER_CAPABILITIES` (the six trigger
  capabilities); added `'sys-scheduler-orchestrator'` to `AgentPrincipalId` and
  `AGENT_PRINCIPALS` (own `configKey: 'agent.schedulerOrchestrator.activeCredential'`,
  `capabilities: TRIGGER_CAPABILITIES`); `sys-agent-orchestrator`'s capability
  filter now excludes both `AUTOMATION_CAPABILITIES` and `TRIGGER_CAPABILITIES`
  (fully disjoint, per B2).
- `src/server/routers/agents.router.ts` - `regIntel.runScan` repointed from
  `agentProcedure('agents.run.create')` to `agentProcedure('agents.regIntel.run.
  create')`; all six `run*` mutations now chain `.use(rateLimited('agent-trigger-
  <agent>-<mutation>', appConfig.agents.trigger.rateLimitMax, { window: appConfig.
  agents.trigger.rateLimitWindowSeconds }))`, mirroring the existing
  `automation.logEvent`/`generate` shape exactly; each endpoint's doc comment now
  states it's callable only by `sys-scheduler-orchestrator`.
- `src/config/app.config.ts` - new env-schema entries `AGENT_TRIGGER_RATE_LIMIT_MAX`
  (default 10) / `AGENT_TRIGGER_RATE_LIMIT_WINDOW_SECONDS` (default 3600), and a
  new `appConfig.agents.trigger` block, following the exact shape of the existing
  `appConfig.agents.automation` block. One shared bucket definition, six distinct
  action-key buckets (one per mutation) - kept as a single config pair rather than
  twelve per-agent env vars since Chris didn't ask for per-agent ceilings and
  expected call volume is at most once per cadence window either way.
- `.env.example` - left unchanged. Confirmed the existing `AUTOMATION_LOG_RATE_
  LIMIT_MAX` etc. aren't documented there either (all are optional, defaulted
  env vars) - the new trigger rate-limit vars follow that same undocumented-default
  convention, not a gap introduced by this batch.

**New test files:**
- `src/modules/agents/agent-credential.service.test.ts` - extended with a
  `multi-principal scoping (sys-scheduler-orchestrator)` describe block (4 tests):
  scheduler gets exactly the six trigger capabilities and nothing broader;
  orchestrator never gets the trigger capabilities (disjoint, confirms B2); one
  principal's secret can't authenticate as another; revoking the scheduler
  credential doesn't affect the orchestrator's.
- `src/server/routers/agents.router.trigger-wiring.test.ts` (new) - table-driven
  test asserting all six `run*` procedures chain the correct capability-scoped
  rate limiter reading from `appConfig.agents.trigger`; asserts `regIntel.runScan`
  uses its own dedicated capability, distinct from `beginRun`'s `agents.run.create`;
  asserts action-key namespacing stays distinct from `agent-auth` and the
  automation buckets.
- `src/lib/redis/rate-limiter.trigger.test.ts` (new) - behavioral test (in-memory
  Upstash sorted-set fake, same fixture as `rate-limiter.automation.test.ts`)
  proving a trigger bucket actually rejects the `(max+1)`th request within its
  window, independent of the `agent-auth` bucket, and that the six trigger
  buckets stay independent of each other for the same identifier.

**Verification gate:**
- `tsc --noEmit`: clean.
- Targeted suite (credential service, router wiring, both rate-limiter files):
  5 files, 28 tests, all passed.
- Full `vitest run`: 91/93 files, 644/646 tests passed. The 2 failures
  (`enterprise-policy.router.test.ts`, `enterprise-policy-frontend-wiring.test.ts`)
  are pre-existing and unrelated to this batch - confirmed by `git stash` and
  re-running those two files against the clean tree (same 2 failures reproduce
  with zero B9 changes applied).
- Single lockfile (`package-lock.json`), no drift.
- Non-ASCII scan (Node codepoint scan, not shell `grep -P` which isn't reliably
  UTF-8-aware on this platform): clean across every changed/new file.
- Diff isolated to the four files the migration map named plus the three new
  test files - no B3-B8 agent/service file touched, no protected surface
  touched, no new npm dependency, no `prisma migrate`.

**Not done in this batch (explicitly out of scope, matches the spec):**
- No n8n workflow was created or touched (`agents.sheriabot.com` is external to
  this repo).
- No credential was actually issued yet - issuing the `sys-scheduler-orchestrator`
  secret (`--principal sys-scheduler-orchestrator` against
  `src/scripts/issue-agent-credential.ts`) is an operational step for whoever
  configures the n8n workflow, not a code change.
