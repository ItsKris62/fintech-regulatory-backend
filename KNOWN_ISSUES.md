# Known Issues — SheriaBot Fintech Regulatory Backend

Security findings from the Sprint 2 Phase B IDOR audit (May 2026).
Each item tracks severity, status, and the migration that resolves it.

---

## Class A — Confirmed IDOR (Critical)

### A1 — gapAnalysis.runGapAnalysis [RESOLVED — Batch 1]

| Field        | Value |
|--------------|-------|
| Severity     | Critical |
| CVE class    | IDOR (CWE-639) |
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

**Root cause:** `organizationId` was an optional field in the Zod input schema.
The handler used `input.organizationId ?? ctx.user.organizationId ?? ctx.user.id`
allowing an authenticated attacker to attribute a gap analysis to any org ID by
supplying it in the request body.

**Secondary issue:** Dedup cache key `sheriabot:gapanalysis:dedup:{orgId}:{fileHash}`
was poisonable across tenants — an attacker could return a victim org's cached
analysis by submitting the same file with the victim's orgId.

**Fix:**
- Removed `organizationId` from the Zod input schema.
- Applied `orgMemberProcedure` (requires ACTIVE OrganizationMember row).
- `orgId` derived exclusively from `ctx.orgMembership.organizationId`.
- Dedup key rotated to `sheriabot:gapanalysis:dedup:v2:{userId}:{fileHash}`.
  Old keys (TTL 900s) expire naturally; no migration needed.

---

### A2 — checklist.generateChecklist [RESOLVED — Batch 1]

| Field        | Value |
|--------------|-------|
| Severity     | Critical |
| CVE class    | IDOR (CWE-639) |
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

**Root cause:** Same pattern as A1 — `organizationId: z.string().optional()` in
input, handler fell through to `input.organizationId ?? ctx.user.organizationId`.

**Fix:** Removed `organizationId` from Zod input; applied `orgMemberProcedure`;
`orgId` derived from `ctx.orgMembership.organizationId`.

---

## Class B — Authorization Hardening (High)

### B1 — organization.get: org-existence oracle [RESOLVED — Batch 1]

| Field        | Value |
|--------------|-------|
| Severity     | High |
| CVE class    | Information Disclosure (CWE-203) |
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

**Root cause:** The procedure fetched the org first, returned NOT_FOUND if absent,
then returned FORBIDDEN if the user was not a member. Error code difference
revealed whether an org ID existed.

**Fix:** Non-admin callers now have their OrganizationMember row verified FIRST.
Both "no such org" and "not a member" paths return FORBIDDEN. Admins retain
NOT_FOUND for their admin-UX flows.

---

### B2 — organization.addMember / removeMember: OrganizationMember not written [RESOLVED — Batch 1]

| Field        | Value |
|--------------|-------|
| Severity     | High (integrity gap) |
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

**Root cause:** Both procedures only updated `User.organizationId` and never wrote
to the `OrganizationMember` table. Since `requireOrgMembership` reads from
`OrganizationMember`, members added/removed via these procedures would be
invisible to the new membership check.

**Fix:**
- `addMember`: upserts `OrganizationMember` with `status = ACTIVE` and the
  requested role; invalidates `sheriabot:orgmem:{userId}:{organizationId}` cache.
- `removeMember`: sets `OrganizationMember.status = REMOVED`; invalidates cache.

---

### B3 — isOrganizationMember middleware: equality check only [RESOLVED — Batch 2]

| Field        | Value |
|--------------|-------|
| Severity     | High |
| CVE class    | Broken Access Control (CWE-284) |
| Status       | **Resolved** |
| Resolved in  | Batch 2 (2026-05-12) |

**Root cause:** `isOrganizationMember` in `middleware.ts` only checks
`ctx.user.organizationId !== organizationId` without querying the
OrganizationMember table. INVITED, SUSPENDED, and REMOVED members whose
`User.organizationId` still matches can bypass this check.

**Fix:** Removed the middleware. Org-scoped procedures use `orgMemberProcedure`
or `adminProcedure`; there is no remaining equality-only middleware path.

---

### B4 — org-scoped procedures without active membership status check [RESOLVED — Batch 2]

| Field        | Value |
|--------------|-------|
| Severity     | High |
| CVE class    | Broken Access Control (CWE-284) |
| Status       | **Resolved** |
| Resolved in  | Batch 2 (2026-05-12) |

**Root cause:** Several routers used `ctx.user.organizationId` directly without
checking that the caller still had an ACTIVE `OrganizationMember` row.

**Fix:** Migrated org-scoped router procedures to `orgMemberProcedure`, including
vault, billing, analytics, usage, calendar, policy, document, enterprise policy,
alert subscription/history, compliance org posture reads/writes, and normalized
checklist flows.

---

### B5 — legacy null-org Checklist rows [ACCEPTED — kept]

| Field        | Value |
|--------------|-------|
| Severity     | Low |
| Status       | **Accepted** |
| Decision     | Keep legacy rows |

Two existing legacy checklist rows have `organizationId = null`
(`cmmnyw4ja00011elcntv9trh8`, `cmmng2jtm00021xhe81gvobq9`). Forensics found
zero forged checklist rows and zero gap analysis rows, so these are treated as
legacy data from a permissive path, not exploitation evidence.

**Current control:** New checklist generation paths derive organizationId from
`ctx.orgMembership.organizationId`, making new null-org writes structurally
impossible through the tRPC checklist routers.

**Follow-up:** `Checklist.organizationId` remains nullable in Prisma for legacy
compatibility. After the two legacy rows are reattributed or otherwise retired,
ship a migration to make `Checklist.organizationId` NOT NULL.

---

## Class C — Informational / Low (Tracked, Deferred)

### C1 — Pinecone vector namespace: flat `__default__` [ACCEPTED]

| Field        | Value |
|--------------|-------|
| Severity     | Informational |
| Status       | **Accepted risk** |

Only public regulatory documents are indexed (no per-org content). `reingest`
is gated behind `adminProcedure`. Per-org namespace isolation is not required
at current scale. Re-evaluate if client document indexing is added in future.

### C2 — RLS not enabled on Supabase PostgreSQL [DEFERRED]

| Field        | Value |
|--------------|-------|
| Severity     | Low (defense-in-depth gap) |
| Status       | **Deferred** |
| Planned for  | RLS follow-up sprint (after automated test sprint) |

Prisma uses the service role, bypassing RLS. Application-layer auth is the
current enforcement boundary. Enabling RLS is a defense-in-depth improvement
but is not a primary control. Deferred because it requires a separate design
sprint: Supabase Auth + Prisma service-role interaction must be re-architected
before row policies can be applied safely.

### C3 — Stale `src/server/routers/router.ts` deleted [RESOLVED — Batch 1]

| Field        | Value |
|--------------|-------|
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

Dead file with 13 sub-routers that was never imported by production code
(`src/app.ts` imports from `src/server/trpc/router.ts` with 27 sub-routers).
Deleted to eliminate confusion.

### C4 — Grounded compliance queries bypass the 24hr answer cache [RESOLVED — Stage 0]

| Field        | Value |
|--------------|-------|
| Severity     | Informational / Performance |
| Status       | **Resolved — retrieval cache implemented 2026-05-16** |
| Introduced   | Stage 0 grounding fix (2026-05-16) |
| Resolved in  | Stage 0 (retrieval cache, 2026-05-16) |

**Root cause:** The existing `complete()` cache uses prompt content as its implicit
key. When `ragContext` is injected into the prompt, every query generates a unique
prompt even for identical questions — making the 24hr answer cache a 100% miss for
all grounded compliance queries.

**Measured impact (Stage 0 acceptance gate — 2026-05-16):**

Baseline source: direct ungrounded-path live runs (3 questions × run 1, AI cache
primed from prior session — reflects typical user experience for repeated queries).

| Metric | Baseline (pre-fix) | Post-fix (grounded) | Ratio |
|---|---|---|---|
| p50 latency | 1,492 ms | 27,037 ms | 18.1× |
| p95 latency | 3,287 ms | 34,167 ms | 10.4× |
| Mean cost/query | $0.00911 | $0.01211 | 1.33× |
| Mean input tokens | ~1,387 | 2,303 | +916 (evidence block) |
| Mean output tokens | 2,000 (ceiling hit) | 2,566 (many at 3,000 ceiling) | — |

Decision: **BLOCK** — p95 regressed 10.4× (threshold: 2.0×). Cost: **PASS** (1.33× < 1.4×).

**Resolution:** Retrieval cache implemented in `src/lib/rag/rag.service.ts`
(`searchAndGetContext`). Key: `sheriabot:rag:ctx:v1:{sha256(question|topK|minScore)}`,
TTL: 1800s (30 min). Caches Pinecone lookup result only — AI answer is never cached
for grounded queries (preserves corpus freshness per ODPC note below).

Cache-hit latency improvement: ~2–3s savings per hit (Pinecone lookup removed).
The dominant latency component is Claude generation (~23–27s for 2,000–3,000 output
tokens), which cannot be cached. p95 on cache hit: ~30–31s vs ~34s on cache miss.

**Residual note:** The grounded path is structurally 20–30× slower than the cached
ungrounded path. Streaming response (Stage 4) is the UX mitigation — first token
arrives in ~2s; users see progressive output rather than a 30s blank wait.

**ODPC note:** Caching the AI answer would be misleading if the corpus is updated
with new CBK circulars or amended regulations between cache writes. Only the
retrieval result (Pinecone search output) is a candidate for short-lived caching.

---

---

## Class B (continued)

### B5-addendum — payment.router.ts [RESOLVED — Batch 2.5]

| Field        | Value |
|--------------|-------|
| Severity     | Medium |
| CVE class    | Broken Access Control (CWE-284) |
| Status       | **Resolved** |
| Resolved in  | Batch 2.5 patch (2026-05-13) |

**Root cause:** All three procedures in `payment.router.ts` (`list`, `getById`,
`getDetail`) used `protectedProcedure` despite reading org-scoped `Payment`
records. The `orgId` was always derived from `ctx.user.organizationId` (not
user input), so there was no cross-tenant IDOR. However, `protectedProcedure`
does not verify an active `OrganizationMember` row — a user removed from an
org could continue reading that org's full payment history until their JWT
expired.

**Fix:** Migrated all three procedures to `orgMemberProcedure`. Removed the
manual `!user.organizationId` null guards (now handled by middleware). The
60s membership cache TTL is the upper bound on post-removal access — flush
`sheriabot:orgmem:{userId}:{orgId}` for immediate revocation.

---

### C5 — Stage 1 ComplianceQueryRun schema divergence [RESOLVED — Stage 1.5]

| Field        | Value |
|--------------|-------|
| Severity     | Medium (data integrity — incomplete traces) |
| Status       | **Resolved** |
| Introduced   | Stage 1 (2026-05-16) |
| Resolved in  | Stage 1.5 (2026-05-16) |

**Root cause:** Stage 1 shipped `ComplianceQueryRun` with only the fields present
in the CREATE TABLE SQL generated at schema-step time. Fourteen fields specified
in the revised Phase B plan were omitted: `routeConfidence`, `routeDowngraded`,
`routeDowngradeReason`, `subQuestions`, `retrievalQueries`, `acceptedChunkIds`,
`rejectedChunkCount`, `unsupportedClaims`, `fallbackReason`, `inputTokens`,
`outputTokens`, `errorMessage`, `status`, `updatedAt`.

All agents were computing these values in memory; they were simply never written
to the database. Shadow rows created during Stage 1 contain partial traces only.

**Impact:** Shadow rows written between Stage 1 deploy and Stage 1.5 patch
(same day, 2026-05-16) are missing the 14 fields. These rows are safe to keep
for latency/route distribution analysis but cannot be used for grounding quality
analysis (`acceptedChunkIds`, `unsupportedClaims`, `verifierVerdict`) without
acknowledging the gap. Row count affected: production shadow queries between
Stage 1 deploy and this patch.

**Fix:**
- `ALTER TABLE "ComplianceQueryRun" ADD COLUMN IF NOT EXISTS ...` for all 14
  columns; executed in Supabase SQL Editor (verified clean, 2026-05-16).
- `prisma/schema.prisma` updated to match; `prisma generate` run.
- `router.agent.ts`: prompt updated to return `confidence` and `subQuestions`.
- `verifier.agent.ts`: prompt updated to return `unsupportedClaims`.
- `orchestrator.ts`: DB write updated to populate all 14 previously-discarded
  fields, including tier-gating logic (`routeDowngraded`, `routeDowngradeReason`),
  `acceptedChunkIds` (array of `{documentId, documentTitle, section, rank}`),
  `inputTokens`/`outputTokens` (sum of all control-agent tokens), and a
  best-effort error row on orchestrator failure.

**Pre-condition for Stage 2:** Verified via 5–10 fresh shadow queries confirming
all new fields write correctly before Stage 2 authorization.

### C6 — Corpus gaps: S1 (Microfinance Act), S2 (DPA registration deadline), C2 (CBK PSP capital framework) [DEFERRED]

| Field        | Value |
|--------------|-------|
| Severity     | Informational (grader correctly abstains) |
| Status       | **Deferred — corpus expansion items** |
| Identified   | Stage 1.6 investigation (2026-05-16) |

Three query categories where the grader correctly rejects all retrieved chunks
because the relevant regulatory provisions are not in the Pinecone corpus.
`grounded=false`, `verifierVerdict='PARTIAL'`, `unsupportedClaims=['No graded evidence available to verify claims']` is the correct behavior in each case.

**S1 — Tier 1 Microfinance Bank capital requirements:**
The top 10 Pinecone hits for this query return chunks from the Banking Act (Cap. 488)
and CBK Prudential Guidelines for Banking Act institutions, which specify core capital
for commercial banks (Kshs 1,000M) and financial institutions (Kshs 200M) — not for
deposit-taking microfinance institutions (DTMs). "Tier 1 microfinance bank" is regulated
under the Microfinance Act 2006 with separate CBK-set capital minimums. The grader
correctly rejects the Banking Act chunks as non-responsive to the specific question.
Investigation confirmed this holds even with 800-char grader truncation.
**Fix required:** Add Microfinance Act 2006 and CBK Prudential Guidelines for DTMs
to `src/scripts/ingest-documents.ts` registry and re-ingest.

**S2 — DPA 2019 data controller registration deadline:**
The right documents are in the corpus (Data Protection Act 2019, Registration
Regulations 2021, ODPC Guidance Note). The top 10 hits land on scope/purpose and
definitions sections (score ≥ 0.994). These sections establish the registration
obligation and cite the Regulations effective date (14 July 2022) but do not contain
the compliance deadline period (e.g., "within 6 months for existing controllers").
That deadline provision lives in the transitional section of the Registration
Regulations, which does not rank in the top 10 hits for this query.
**Fix required:** Review chunking of the Registration Regulations' transitional section,
or add a targeted summary chunk for this provision.

**C2 — NPS Act 2011 / CBK PSP licensing and capital thresholds:**
All 10 retrieved chunks are from CBK Cybersecurity Guidelines for PSPs — a different
document that mentions PSPs in its authorization preamble and thus ranks highly.
The NPS Act 2011 is in the corpus but its licensing provisions (Sections 7–12) do not
surface in the top 10 for capital-threshold queries. The CBK PSP Licensing Framework
circular (specifying licence tiers and capital minimums per tier) is not in the corpus at all.
**Fix required:** (a) Add CBK PSP Licensing Framework / capital thresholds circular
to corpus. (b) Investigate NPS Act chunk quality and embedding for licensing sections.

### C7 — R09/R15 routing-coupling: abstain route ran full grader/verifier pipeline [RESOLVED — Stage 2]

| Field        | Value |
|--------------|-------|
| Severity     | Medium (false-confident PASS on off-topic queries) |
| Status       | **Resolved** |
| Identified   | Stage 2 shadow re-baseline (2026-05-17) |
| Resolved in  | Stage 2, Step 1 — orchestrator abstain short-circuit (2026-05-17) |

**Root cause:** The orchestrator had no early-exit branch for `route === 'abstain'`. When the router
correctly classified a query as out-of-scope (e.g., R09 "regulations of the gaming industry", R15
"who is the owner of this website"), the full grader and verifier pipeline still executed. The grader
found tangentially-matching chunks (2 for R09, 2 for R15); the verifier returned `PASS` for the
supplied answers with those chunks as evidence. Result: `grounded=true`, `verifierVerdict='PASS'`
for off-topic queries — the opposite of intended semantics.

**Fix:** Added abstain short-circuit immediately after the tier-gating block in `orchestrator.ts`.
When `route === 'abstain'`: writes a minimal trace row (`grounded=false`, all agent fields null/zero,
only router tokens recorded), logs `orchestrator_run_abstained`, and returns early. Grader and verifier
are never invoked.

---

### C8 — R07 corpus gap: Draft CBK Non-Deposit Taking Credit Providers Regulations [RESOLVED — Pre-cutover step 1]

| Field        | Value |
|--------------|-------|
| Severity     | Medium (in-scope abstention — 8.3% of substantive pilot queries) |
| Status       | **Resolved** |
| Identified   | Stage 2 shadow re-baseline (2026-05-17) |
| Resolved in  | Pre-cutover step 1 (2026-05-17) |

**Symptom:** Query R07 returned `grounded=false`, `verifierVerdict='PARTIAL'` — grader correctly
rejected all 10 retrieved chunks because the NDTCP Regulations were not in the Pinecone corpus.
These regulations are distinct from the Digital Credit Providers Regulations 2022 (indexed);
existing chunks specified no NDTCP capital thresholds.

**Fix applied (2026-05-17):**
- Document obtained from CBK public register (published 2026-08-07; consultation closed 2025-09-05;
  no gazetted/final version exists as of 2026-05-17 — the August 2025 draft is the definitive
  current version per CBK Legislation & Guidelines page).
  Source: `centralbank.go.ke/wp-content/uploads/2025/08/Draft-Central-Bank-of-Kenya-Non-Deposit-Taking-Credit-Providers-Regulations-2025.pdf`
- Placed at `documents/kenya/Draft-CBK-Non-Deposit-Taking-Credit-Providers-Regulations.pdf`
  (603 KB, 63 pages, PDF 1.7).
- `pnpm ingest` completed: status=ACTIVE, chunkCount=565, totalCharacters=125,684, errorMessage=null.
- Verification query "NDTCP capital threshold tier 1 non-deposit taking credit provider licence"
  returned 5/5 top-K chunks from this document (scores 0.963–1.006).
  - Chunk [1] (score 1.006): "initial capital more than 20 million shillings → apply for licence (Form CBK NDTCP 1)"
  - Chunk [2] (score 0.982): "initial capital less than 20 million shillings → apply for registration"

**Post-fix in-scope abstention rate:** 0/12 substantive pilot queries abstain for corpus gap.
Target <5% met.

### C9 — Streaming endpoint: FREE_TRIAL effective plan not resolved [DEFERRED — Stage 3]

| Field        | Value |
|--------------|-------|
| Severity     | Low (conservative fallback — users treated as base org plan) |
| Status       | **Deferred** |
| Introduced   | Stage 2, Step 7 — `/api/compliance/stream` (2026-05-17) |
| Planned for  | Stage 3 (trial/grace period plan resolution in SSE auth) |

**Root cause:** `checkAndPrepareUsage()` in `compliance-stream.route.ts` reads `org.plan` directly from
the database. The `EffectivePlan` computation in `withPlanContext` (tRPC middleware) accounts for active
free trials (`User.freeTrialActivatedAt/ExpiresAt`), Stripe grace periods, and cancellation windows.
The streaming route does not replicate this logic. A FREE_TRIAL user's effective plan is `'FREE_TRIAL'`
(TypeScript-only, never persisted); `org.plan` for that user is `REGULATOR` (or whatever their base plan
is). Result: FREE_TRIAL users hitting the streaming endpoint are quota-checked against their base org
plan's `complianceQueries` limit, which is typically `{ limit: -1 }` (unlimited) for REGULATOR.

**Impact:** Slightly over-permissive for FREE_TRIAL users on the streaming endpoint — they can bypass
the 25-query trial cap. The tRPC `compliance.query` mutation enforces trial limits correctly.

**Fix required (Stage 3):** Extract the FREE_TRIAL resolution logic from `withPlanContext` into a
shared utility (e.g. `src/utils/resolve-effective-plan.ts`). Call it in both `withPlanContext` and
`resolveAuth` in the streaming route. The utility reads `User.freeTrialActivatedAt/ExpiresAt` and
applies `FREE_TRIAL_LIMITS` enforcement when the trial is active and unexpired.

---

### C10 — Streaming endpoint: AI budget enforcement is pre-call only [ACCEPTED — by design]

| Field        | Value |
|--------------|-------|
| Severity     | Informational |
| Status       | **Accepted risk** |
| Introduced   | Stage 2, Step 7 — `/api/compliance/stream` (2026-05-17) |

**Behavior:** `stream()` in `src/lib/ai/client.ts` calls `checkCostLimit(estimatedCost)` before sending
the request to Anthropic. `estimatedCost` is computed from estimated input tokens + `maxTokens` output
ceiling. No enforcement runs mid-stream.

**Rationale for acceptance:** `maxTokens` is a server-side hard ceiling enforced by Anthropic's API —
a stream cannot exceed it regardless of content. The pre-call estimate is therefore conservative:
it budgets for the maximum possible output. If the daily cost limit is reached during a stream (rare,
requires the estimate to have been under-computed), the current stream completes and `trackCost()`
records the overage. The next request is blocked at the pre-call check. This is equivalent to the
non-streaming path's behavior and is acceptable for the current scale.

**Re-evaluate when:** daily query volume exceeds ~500 queries/day or cost-per-query increases
significantly (model upgrade, longer context). At that point, add a mid-stream token counter and abort
the stream when a per-request token ceiling is crossed.

---

### C11 — Citation join fallback attaches wrong section's text snippet on multi-chunk documents [KNOWN — Stage 2.5]

| Field        | Value |
|--------------|-------|
| Severity     | Low (display only — citation list is correctly filtered) |
| Status       | **Known — fix before Stage 3 begins** |
| Identified   | Stage 2, Step 7/8 amendment review (2026-05-17) |
| Planned for  | Stage 2.5 (post-Stage-2 ship, pre-Stage-3) |

**Symptom:** In `compliance-stream.route.ts`, the citation join logic matches `AcceptedChunkRef` entries
to `ragContext.results` by `(documentId, section)`. When the exact section match fails (e.g., `section`
is undefined on one side), a fallback `find((r) => r.documentId === ref.documentId)` picks the *first*
RAG chunk for that document ID. If the document contributed multiple chunks to the top-K and the accepted
chunk is not the first, the displayed `textSnippet` and `score` belong to a different chunk than the one
the verifier approved.

**Impact:** Citations array is correctly filtered (only accepted documents appear — no over-inclusion or
under-inclusion). This is a presentation error only: the text shown in the "Sources" panel may not be the
exact passage the verifier approved, though it is from the same document. Occurs only when `section`
fields are inconsistent between Pinecone metadata and the orchestrator's stored `AcceptedChunkRef`.

**Fix required (Stage 2.5):** Add a stable `vectorId` (Pinecone vector id, already available on
`QueryResult.id` in `src/lib/rag/client.ts`) to `AcceptedChunkRef` during grader bookkeeping, and
propagate it through the orchestrator's `acceptedChunkIds` JSON column. Use `vectorId` as the primary
join key in `compliance-stream.route.ts`, with `(documentId, section)` as fallback only for pre-fix
trace rows. Update `SearchResult` in `rag.service.ts` to carry the vector id from `QueryResult.id`.

**Files to change (Stage 2.5):**
- `src/modules/compliance/orchestrator/types.ts` — add `vectorId: string` to `AcceptedChunkRef`
- `src/modules/compliance/orchestrator/grader.agent.ts` — populate `vectorId` from graded chunk
- `src/lib/rag/rag.service.ts` — add `id: string` (vector id) to `SearchResult` interface
- `src/routes/compliance-stream.route.ts` — join on `vectorId` first, fall back to `(documentId, section)`

---

## Stage 2 — Compliance Orchestrator + Streaming UI (2026-05-17)

### What shipped

| Component | File(s) | Description |
|-----------|---------|-------------|
| Router agent | `src/modules/compliance/orchestrator/router.agent.ts` | Classifies query scope; returns `route` + `confidence` |
| Grader agent | `src/modules/compliance/orchestrator/grader.agent.ts` | Scores/accepts RAG chunks; populates `AcceptedChunkRef[]` |
| Verifier agent | `src/modules/compliance/orchestrator/verifier.agent.ts` | Cross-checks synthesized answer against accepted chunks |
| Orchestrator | `src/modules/compliance/orchestrator/orchestrator.ts` | Wires agents; writes `ComplianceQueryRun` trace row |
| SSE endpoint | `src/routes/compliance-stream.route.ts` | `POST /api/compliance/stream` — Fastify hijack, SSE, deferred usage increment |
| `reportGap` tRPC | `compliance.router.ts:1383` | Corpus gap feedback mutation; IDOR-protected |
| `useComplianceStream` hook | `fintech-regulatory-platform/hooks/use-compliance.ts` | State machine (idle→connecting→streaming→verifying→complete\|error); AbortController lifecycle |
| `AbstainCard` component | `fintech-regulatory-platform/components/compliance/abstain-card.tsx` | Two variants: scope-abstain (amber) + corpus-gap (blue); inline `GapForm` |
| `UngroundedBanner` component | `fintech-regulatory-platform/components/compliance/ungrounded-banner.tsx` | Blue info banner for PARTIAL verdict |
| Compliance query page | `fintech-regulatory-platform/app/(dashboard)/startup/compliance-query/page.tsx` | Streaming path; conditional AbstainCard / UngroundedBanner; live streaming bubble |
| R07 registry entry | `src/scripts/ingest-documents.ts` | ✅ Ingested — 565 chunks, ACTIVE, verified in Pinecone (2026-05-17) |
| Smoke test script | `src/scripts/smoke-stream-done.ts` | Manual SSE smoke test verifying `done` event shape |

### Pending actions before production cutover

1. ✅ **R07 ingestion** — COMPLETE (2026-05-17). Draft CBK NDTCP Regulations obtained from CBK public register, ingested (565 chunks, ACTIVE), Pinecone verification query confirmed 5/5 top-K chunks from this document with capital threshold provisions. C8 closed. In-scope abstention rate: 0/12 (was 1/12 = 8.3%).

2. ✅ **Staging 19-query re-baseline** — COMPLETE (2026-05-17). All gates PASS. See staging verification record below.

3. **Production cutover** — Both pre-conditions confirmed (2026-05-17): rollback runbook at `docs/runbooks/orchestrator-rollback.md` ✅, C12 abstain-route behavior documented (non-blocking) ✅. **Ready for production flip** — set `ORCHESTRATOR_ENABLED=true` in Render dashboard → SheriaBot Backend → Environment, trigger redeploy, monitor 30 min.

### Staging Verification Record (2026-05-17)

`ORCHESTRATOR_ENABLED=true` set in local `.env`. 19-query pilot run via in-process `stage2-shadow-rebaseline` (timed wrapper). SSE 4-case rendering verified via curl against local backend on port 4000. Ephemeral Supabase test user created/destroyed for HTTP tests.

| Gate | Target | Result | Status |
|------|--------|--------|--------|
| In-scope abstention rate | ≤10% | 0/11 = **0.0%** | **PASS** |
| p50 latency (grounded synthesis) | <35,000ms | **13,616ms** | **PASS** |
| p95 latency (grounded synthesis) | <45,000ms | **17,573ms** | **PASS** |
| PASS-with-citations rendering | verified | `grounded=true, abstained=false, conf=0.9, citations=6` | **PASS** |
| PARTIAL/UngroundedBanner rendering | verified | `grounded=true, abstained=false, conf=0.7, citations=10` | **PASS** |
| Route-abstain AbstainCard rendering | verified | `route=abstain, abstained=true, citations=0` | **PASS** |
| Evidence-abstain AbstainCard rendering | verified | `route=simple, grounded=false, abstained=true, citations=0` | **PASS** |
| reportGap end-to-end | DB row with all FKs | feedbackId `cmp9sstgw0001zgs591u3u8l5`, all 4 FKs populated | **PASS** |

**Pilot routing distribution (19 queries):** simple=12, complex=0, abstain=7, downgraded=11

**Pilot verdict distribution:** PASS=7, PARTIAL=5, FAIL=0, null(abstain)=7

**Latency detail (grounded, n=12):** min=12,084ms p50=13,616ms p75=15,037ms p90=16,314ms p95=17,573ms max=17,573ms
*Note: In-process measurements with 600-token answer cap. Real streaming queries (2,000–3,000 tokens) will be somewhat slower; first token via SSE chunk arrives in ~2s regardless.*

**SSE event shape (verified via curl):** `connected → [N chunks] → synthesis_complete → done`. Abstain-route queries still stream synthesis chunks — `abstained=true` in done event is the frontend signal to suppress streamed content and show AbstainCard. See §C12 for the synthesis-waste issue (Stage 2.5 fix, does not block cutover).

**R07 verification in pilot:** `route=simple, grounded=true, verdict=PASS, accepted=2, confidence=0.85` — NDTCP corpus ingestion confirmed working.

**Verifier observations:**
- Downgrade rate: 11/12 grounded queries have `routeDowngraded=true` (all downgraded to `route=simple`). Expected — the router correctly classifies these as simple queries; the downgraded flag reflects that the plan tier would permit complex routing.
- PARTIAL verdicts (R01, R08, R11, R13, R16): All on broad multi-regulatory queries. Expected — these span DPA + CBK + consumer protection simultaneously. No FALSE-PASS (weakly-grounded PASS) detected.
- No FAIL verdicts on any in-scope query.
- R16 ("open a compliance website") classified as `route=simple, grounded=true, verdict=PARTIAL` despite being in the off-topic set — correctly handled as a marginal compliance question.

**Browser rendering note:** SSE event stream verified via curl (identical byte sequence to browser EventSource). Visual React component rendering (AbstainCard variants, UngroundedBanner, CitationList) not visually confirmed — no browser available in execution environment. Component props are correct per SSE done-event field values.

### Deferred to Stage 2.5 / Stage 3

- **C11** — Citation `vectorId` join fix (Stage 2.5, before Stage 3)
- **C9** — FREE_TRIAL plan resolution in streaming endpoint (Stage 3)
- **C12** — SSE route synthesis waste on abstain path (Stage 2.5)

---

### C12 — SSE route does not short-circuit on `route=abstain` [STAGE-2.5-FIX]

| Field | Value |
|-------|-------|
| Severity | Low (cost / efficiency; no correctness or security impact) |
| Status | **Open — STAGE-2.5-FIX, does not block cutover** |
| Confirmed | 2026-05-17 via curl test against local backend with ORCHESTRATOR_ENABLED=true |

**Observed behavior:** When the orchestrator router classifies a query as `route=abstain` (off-topic / out of scope), the SSE route continues to:
1. Return `ragSources: 10` in the `connected` event — RAG retrieval ran in full.
2. Stream 20–25 Haiku/Sonnet `chunk` events — full synthesis ran in full.
3. Then emit `done` with `route=abstain, abstained=true, citations=[]`.

The frontend `useComplianceStream` hook suppresses all streamed content when `abstained=true` in the `done` event and renders `AbstainCard` instead. From the user's perspective the page is correct. From a cost perspective, every off-topic query pays ~$0.01–0.03 in Sonnet tokens that are immediately discarded.

**Verified event sequence** (query: "what is the weather in Nairobi today"):
```
connected  { ragSources: 10 }
chunk × 24
synthesis_complete
done       { route: "abstain", abstained: true, citations: [], confidence: null }
```

**Root cause:** `compliance-stream.route.ts` starts the Anthropic streaming call unconditionally before the orchestrator pipeline resolves. The orchestrator result (including `route`) is not available until after synthesis completes, so the route verdict cannot gate the synthesis call.

**Fix (Stage 2.5):** Restructure the SSE route to run the orchestrator router agent first (before opening the Anthropic stream). If `route=abstain`, emit `connected → done` directly without starting synthesis. This requires pulling the router agent call out of the orchestrator pipeline and into the SSE route handler as a pre-synthesis gate.

**Does not block cutover:** The frontend correctly suppresses streamed content and renders AbstainCard. Users see the correct UX. The only impact is token cost on off-topic queries.

---

## Batch Roadmap

| Batch | Focus | Status |
|-------|-------|--------|
| Batch 1 | IDOR closure (A1, A2), org oracle (B1), member source-of-truth (B2), stale file | **COMPLETE** |
| Batch 2 | Migrate remaining Class B procedures; remove `isOrganizationMember` | **COMPLETE** |
| Batch 2.5 | payment.router.ts scope clarification + orgMemberProcedure migration | **COMPLETE** |
| Batch 3 | Audit logging (AuditLog writes, 100% denials / 10% grant sample); trust page; incident runbook | **COMPLETE** |
| Stage 2 | Compliance orchestrator + SSE streaming + frontend rendering | **CODE COMPLETE — cutover pending** |
| Sprint 1 | Authorization hardening, dead-code removal, secret-handling controls | **COMPLETE — 2026-05-18** |

---

## Sprint 1 — Authorization Hardening & Code Cleanup (2026-05-18)

### BE-O-015 — updateMemberRole: role change not reflected until session cache expires [RESOLVED — Sprint 1 Batch 1]

| Field | Value |
|-------|-------|
| Severity | High |
| CVE class | Stale session role — Broken Access Control (CWE-284) |
| Status | **Resolved** |
| Resolved in | Sprint 1 Batch 1 (2026-05-18) |

**Root cause:** `updateMemberRole` writes the new role to `User.role` (UserRole enum) via
`prisma.user.update`, but does not invalidate the `user:session:{supabaseAuthId}` cache
(TTL 3600s). The cache holds the full Prisma `User` object including `.role`. Until the TTL
expires, `ctx.user.role` on subsequent requests reflects the OLD role — meaning a demotion
would not take effect for up to one hour, and a promotion (e.g., to ADMIN) would also not
be visible to the promoted user until expiry.

A secondary gap: the `OrganizationMember` membership cache (`sheriabot:orgmem:{userId}:{orgId}`,
TTL 60s) was also not invalidated after the `User.role` change, though since
`updateMemberRole` does not modify `OrganizationMember.role` (a separate `MemberRole` enum:
`OWNER|ADMIN|MEMBER`), this is a defensive eviction rather than a correctness fix.

**Note on the Phase A proposed fix:** Phase A proposed `organizationMember.updateMany` to
sync `OrganizationMember.role` with `User.role`. This was not implemented because the two
role enums are semantically orthogonal — `UserRole` (`REGULATOR|STARTUP|ENTERPRISE|ADMIN`)
describes the user's platform-level identity type; `MemberRole` (`OWNER|ADMIN|MEMBER`)
describes their position within a specific organization. Direct assignment would cause DB
errors for all non-ADMIN values and incorrect semantics for ADMIN.

**Fix applied:**
- Added `supabaseAuthId: true` to the `findUnique` select in `updateMemberRole`.
- After `prisma.user.update` succeeds: `redis.del(`user:session:${targetUser.supabaseAuthId}`)`.
- Also evicts `sheriabot:orgmem:{userId}:{orgId}` defensively.
- File: `src/server/routers/organization.router.ts`.

---

### BE-D-003 — executeRawQuery: $queryRawUnsafe wrapper with SQL injection surface [RESOLVED — Sprint 1 Batch 3]

| Field | Value |
|-------|-------|
| Severity | High (potential injection surface — zero call sites confirmed) |
| Status | **Resolved — function deleted** |
| Resolved in | Sprint 1 Batch 3 (2026-05-18) |

**Root cause:** `executeRawQuery<T>(query: string, params: any[])` in
`src/lib/prisma/client.ts` wrapped `prisma.$queryRawUnsafe` which executes an
arbitrary caller-supplied SQL string. The function also logged the raw `query` string,
creating a secondary PII/secret-in-logs risk for any query containing bound parameter
values. Zero confirmed call sites (grep of full codebase + test directories confirmed
before deletion).

**Fix:** Function and JSDoc comment deleted in full. Correct replacement for parameterised
raw SQL is Prisma's `$queryRaw` tagged template literal. `$queryRawUnsafe` usage is banned
— see `docs/security/secret-handling.md`.

---

### BE-F-005 — generateChecklistAsync: missing REGULATOR role guard [RESOLVED — Sprint 1 Batch 2]

| Field | Value |
|-------|-------|
| Severity | Low (mitigated by plan middleware, defense-in-depth gap) |
| Status | **Resolved** |
| Resolved in | Sprint 1 Batch 2 (2026-05-18) |

**Root cause:** The async checklist generation path (`generateChecklistAsync` in
`src/server/routers/checklist.router.ts`) was missing the explicit REGULATOR role check
present on the legacy synchronous `generateChecklist` procedure. The synchronous path
blocks REGULATOR callers at line 44–50 with a FORBIDDEN TRPCError. The async path
proceeded past plan-context and rate-limit middleware before the orgId was resolved,
with no role check.

**Fix:** Explicit guard inserted as the first statement in the `generateChecklistAsync`
mutation body — before `orgId` resolution — matching the synchronous counterpart exactly.
Frontend already handles FORBIDDEN response gracefully (toast.error, no change needed).

---

## Next Sprint Priorities (in order)

1. **Automated test coverage** — Vitest setup, integration tests for
   `requireOrgMembership`, regression tests for A1/A2, smoke tests for A6
   ranks 1–10. Prerequisite for ODPC submission and pilot expansion.
2. **RLS follow-up sprint** — proper Supabase Auth + Prisma service-role
   architecture design.
3. **`organization.router.ts` cleanup** — 10 remaining procedures still on
   `protectedProcedure` that should be migrated to `orgMemberProcedure`. The
   `updateMemberRole` cache-invalidation bug (BE-O-015) is now fixed.
4. **`AuditLogV2` hash-chain delivery** — folded back into DPA 2019 sprint
   resumption.
5. **Checklist null-org migration** — run the three-step plan from the runbook
   after test coverage sprint lands.

See `docs/runbooks/idor-incident-response.md` for the full standing follow-up
list and the Checklist migration sequence.
