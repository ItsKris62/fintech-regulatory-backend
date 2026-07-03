# Phase B - Batch B8 (Chief of Staff Agent) - Stage 1 Read-Only Audit

**Status:** STAGE 1 COMPLETE - awaiting operator approval before Stage 2 implementation.
No code was changed to produce this document. Backend `main`, working tree clean at
audit time (HEAD `ce60e98f`, B3-B7 + the multi-principal credential refactor + the
n8n automation module all committed prior history, confirmed via Chris's own commits).

---

## 1. AgentReport shapes across B3-B7 - real inconsistency, not just cosmetic

Read all five `createReport` call sites directly (not from memory) to confirm current
state. **The `summary` field is the only one with a uniform contract across every
batch**: a plain-English string, always present. Everything else diverges by design
intent, not accident:

| Batch | `signals` | `recommendedActions` | `risks` |
|---|---|---|---|
| B3 regIntel | Array of full serialized `RegulatorySignal` objects (the actual content) | `{ marketing: RecommendedAction[], sales: RecommendedAction[], corpus: RecommendedAction[] }` - typed objects with `category/signalId/actionType/priority/brief/organizationId/sourceUrl` | `{ critical: string[], high: string[], budgetOrCoverageNotes: string[], sourceFailures: string[] }` - four separately-named string arrays |
| B4 marketing | `{ draftIds: string[], sourceSignalIds: [...] }` - **pointers only**, not content | `{ humanReviewQueue: [{draftId, contentType, status}] }` | `{ notes: string[] }` |
| B5 sales-growth | `{ draftIds: string[], sourceSignalIds: string[] }` - **pointers only** | `{ humanReviewQueue: [{draftId, organizationId, priority, status}] }` | `{ notes: string[] }` |
| B6 product-bi | Full `GroundedMetricsSnapshot` (self-contained structured metrics) | `{ upgradeMomentCandidates: [...], opportunities: string[] }` | `{ churnRiskOrgs: [...], risks: string[] }` |
| B7 security-ops | Full `GroundedOpsSnapshot` (self-contained: workforceCosts, serviceHealth, errorSummary) | `{ notes: ['No individual drafts to review...'] }` - **placeholder, effectively unused** | `{ risks: string[] }` |

**The inconsistency that matters for B8's design:** B3's `signals` is the raw
content itself; B4/B5's `signals` are references that require a *second* query
(into `MarketingDraft`/`SalesOutreachDraft` by the listed `draftIds`) to get
anything human-readable beyond what's already in `summary`; B6/B7's `signals` are
self-contained structured data. A synthesis layer that naively does
`JSON.stringify(report.signals)` for all five and drops that into one Claude prompt
would produce wildly uneven grounding quality - rich detail for B6/B7, ID-only noise
for B4/B5, and a large raw-content dump for B3.

**Recommendation, not papering over it:** B8's synthesis input should be built from
(a) every batch's `summary` (uniform, always meaningful, already Claude-written
prose - the safest cross-batch signal), plus (b) only the parts of
`recommendedActions`/`risks` that are already plain string arrays across every
batch (`notes`/`risks`/`opportunities` fields, all `string[]`), plus (c) small
scalar counts extracted from the structured arrays where useful (e.g. "3 items in
B3's `sales` queue", "2 upgrade-moment candidates from B6") rather than the full
nested objects. This keeps grounding honest (every number B8's prompt sees is
either a real string a prior agent's own Claude call already wrote, or a count of a
real array) without requiring five bespoke deep-parsers that will drift out of sync
every time B3-B7 change their own internal shapes - which "consume, never modify"
guarantees will keep happening independently of this batch.

---

## 2. Querying "latest per agentType"

No single-query trick is needed or beneficial here - there are exactly five known,
fixed `agentType` strings (`regulatory-intelligence`, `marketing`, `sales-growth`,
`product-bi`, `security-ops`), and B3/B6/B7 already each implement the identical
one-agentType version of this query:

```ts
this.prisma.agentReport.findFirst({
  where: { run: { agentType: X } },
  orderBy: { createdAt: 'desc' },
});
```

B8's version is a `Promise.all` of that same call five times (one per known
agentType constant, imported as literal strings the same way B7 hardcoded its own
`agentType` value - not by importing B3-B6's `_AGENT_TYPE` constants, which would
be a cross-module import into "consume, never modify" territory for constants that
are one-line string literals anyway). A Postgres `DISTINCT ON` raw-SQL query would
only be worth it if the agentType list were open-ended or large; it isn't, so plain
Prisma stays simpler and fully typed.

---

## 3. Capability - confirmed no generic `agents.report.read` exists

Checked `AGENT_CAPABILITIES` directly (`src/modules/agents/agent-credential.service.ts`,
current HEAD): the only top-level, generic report capability is
**`agents.report.create`** (write-side, used by the original generic `createReport`
mutation). There has never been a matching generic `agents.report.read`. Read access
to reports has been handled two different ways across batches, confirming this
premise needed checking rather than assuming:

- B3's `getLatestReport`/`listSignals` are gated by **`agents.run.read`** (the
  generic run-read capability, reused rather than a report-specific one - `agents.
  router.ts` line ~128).
- B4/B5 gate report-adjacent reads (`listDrafts`/`getDraft`) by their own
  `agents.marketing.draft.read` / `agents.sales.draft.read`.
- B6/B7 each minted their own `agents.productBi.report.read` /
  `agents.securityOps.report.read`.

**There is no existing capability B8 can correctly reuse as-is.** `agents.run.read`
is the closest generic option, but reusing it would mean B8's report-reading
endpoints are gated by the same string as every other batch's raw `getRun(runId)`
lookup - a real but *coincidental* overlap, not a designed-for-reuse contract, and
it would make B8's specific read scope harder to reason about or revoke
independently later. Recommend following the **more recent and more consistent
B6/B7 convention**: two new capabilities, `agents.chiefOfStaff.report.create` /
`agents.chiefOfStaff.report.read`, additive to the array like every batch before it.

---

## 4. Delivery - new sibling send service, not a shared file

B7 already established the exact pattern this batch should repeat: a small
service in the batch's own module (B7's `ops-alert.service.ts`) that calls
`sendEmail()` (`src/lib/email/client.ts`) directly with batch-specific tags,
rather than adding a branch to `agent-run.service.ts`'s private alert method. B8
should NOT import or modify B7's `ops-alert.service.ts` (B7 is now equally
"consume, never modify" protected, same as every prior batch once committed) - it
gets its own file, e.g. `weekly-brief-delivery.service.ts`, same `sendEmail()`
primitive, new tags (e.g. `{ category: 'operations', type: 'weekly_brief' }`),
same recipient (`appConfig.marketing.adminNotificationEmail`, no new config).

Unlike B7 (which alerts conditionally, only on evidence of trouble), B8's entire
purpose is a scheduled digest - it should send **every successful run**, not
conditionally, since a "no news is good news" week is still the point of a weekly
brief. Recommend keeping B7's evidence-gated pattern *only* as an option for a
future "urgent" path (e.g. if a `risks` entry is flagged critical) rather than
mixing it into v1 - flagging that as a design choice for the Stage 2 approval to
confirm rather than assuming.

---

## 5. AgentRun/AgentReport - B8 gets its own, same as every batch

Following B6/B7's established contract, B8 should create its own `AgentRun`
(`agentType: 'chief-of-staff'`, matching the plain-string-literal convention every
other batch uses) and its own `AgentReport` per run - `summary` = the weekly brief
text, `signals` = the five source reports' IDs + their own summaries (for
traceability - "this brief was built from reportId X (regulatory-intelligence),
reportId Y (marketing), ..."), `recommendedActions` = the ranked actions list,
`risks` = decisions needed from Chris. This keeps B8 auditable and cost-tracked
exactly like B3-B7, and means B7's own workforce-cost aggregation (`AgentRun`
`groupBy(['agentType'])`) will automatically pick up B8's spend too, with zero
changes needed to B7.

---

## 6. No scheduling infrastructure exists (re-confirmed, unchanged since B6)

Re-checked directly rather than trusting B6's audit to still be current: the two
`cron` hits in the repo are prose only (`src/lib/email/README.md`'s manual setup
instructions, a comment in `billing.module.ts` describing a *hypothetical* future
scheduled job) - neither is a real `node-cron`/`@fastify/schedule` integration.
Zero references anywhere to "chief of staff," "weekly brief," or a Tue/Fri cadence
beyond the one forward-looking comment already documented in B5's own Stage 1 doc.
B8 should expose a `runBrief` mutation triggered externally (n8n, matching every
prior batch's pattern), idempotent per week (`chief-of-staff:${isoWeek}`, same
`isoWeekIdentifier` shape B6 already established and B8 will need to
re-implement locally, not import - B6 is consume-only too).

---

## 7. Tenant isolation - applicable, same test as B6/B7

B8 synthesizes across reports that are themselves already cross-organization
(B6/B7 explicitly aggregate across all orgs; B3/B4/B5's reports reference specific
orgs but the *report itself* isn't org-scoped data a tenant should see). B8's
output is unambiguously operator-only. Same positive-assertion test as B6/B7:
every `chiefOfStaff.*` router endpoint must resolve to `agentProcedure` or
`adminProcedure`, verified by matching the actual `endpoint: procedureName`
binding, not a string-absence check (that pattern false-positived on its own
comments twice already in B6 and B7 - the fix is now standard practice, not
something to rediscover).

---

## 8. Migration map

**CREATE:**
- `src/modules/agents/chief-of-staff/types.ts`
- `src/modules/agents/chief-of-staff/source-reports.service.ts` (+ `.test.ts`) -
  the five-way `Promise.all(findFirst)` from Section 2, plus the
  extract-safe-fields-only logic from Section 1 (summary + plain string arrays +
  scalar counts, never the full heterogeneous nested JSON).
- `src/modules/agents/chief-of-staff/brief-synthesis.service.ts` (+ `.test.ts`) -
  Claude-only, `provider: 'anthropic'`, `allowFallback: false`, grounding rules
  requiring every "decision needed" and "ranked action" to cite which source
  report (by agentType + reportId) it came from - evidence over summary, same
  standard as every prior batch's synthesis layer.
- `src/modules/agents/chief-of-staff/weekly-brief-delivery.service.ts` (+
  `.test.ts`) - the `sendEmail()` sibling from Section 4.
- `src/modules/agents/chief-of-staff/chief-of-staff.agent.ts` (+ `.test.ts`) -
  orchestrator, `AgentRun`/`AgentReport` lifecycle per Section 5, weekly
  idempotency.
- `src/modules/agents/chief-of-staff/chief-of-staff.safety.test.ts` - zero-write
  scan, tenant-isolation positive-assertion test, plus an explicit assertion this
  module never imports from `src/modules/agents/{marketing,sales,product-bi,
  security-ops}/*.service.ts` or `regulatory-intelligence/reg-intel.agent.ts`
  (reads only via its own Prisma queries against `AgentReport`/`AgentRun`, never
  by calling another batch's service methods) and never imports/modifies B7's
  `ops-alert.service.ts`.

**MODIFY (additive only):**
- `src/modules/agents/agent-credential.service.ts` - two capabilities,
  `agents.chiefOfStaff.report.create` / `.read` (Section 3).
- `src/server/routers/agents.router.ts` - `chiefOfStaff: router({...})` seventh
  sibling, `agentProcedure`-gated only.

**Zero writes confirmed to:** any table outside `AgentRun`/`AgentReport`. **No
protected surface** touched. **No modification to any of B3-B7's own modules**
(read via direct Prisma queries against the shared `AgentReport`/`AgentRun`
tables only, never via importing another batch's service class). **No new
dependency.**

---

## Open decision for Chris before Stage 2

Confirm the delivery-cadence question from Section 4: should B8 email the brief on
every successful run unconditionally (recommended default for a "weekly digest"),
or only when something in the synthesized risks is flagged critical (B7's
evidence-gated pattern)? Recommend unconditional send for v1, with a critical-flag
fast path as a clearly separable follow-up rather than bundled in now.
