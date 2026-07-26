# Known Issues -- SheriaBot Fintech Regulatory Backend

Security findings from the Sprint 2 Phase B IDOR audit (May 2026).
Each item tracks severity, status, and the migration that resolves it.

---

## 2026-07-26 -- Phase 0 contract reconciliation

**Status:** Completed for the code baseline in this working tree.

Phase 0 verified that the dirty working tree contains the intended automation
contract work for blog draft creation, AI draft generation, approval read-back,
publish-by-approval, and templated newsletter sending. The stale generated
frontend API declarations and root smoke-test payloads have been refreshed to
the current bare-JSON tRPC contract. The missing version-controlled schema
history for the content, marketing, and agent model families is now represented
by additive, idempotent raw SQL migrations; no destructive Prisma migration
command was run.

Current production caveat: newsletter sending is implemented, but an actual
send still requires reviewed deployment of the raw SQL migrations plus real
`Contact`/`ContactList` data. Segmentation remains a data-import/setup task,
not a missing `sendNewsletter` implementation.

---

## Class A -- Confirmed IDOR (Critical)

### A1 -- gapAnalysis.runGapAnalysis [RESOLVED -- Batch 1]

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
was poisonable across tenants -- an attacker could return a victim org's cached
analysis by submitting the same file with the victim's orgId.

**Fix:**
- Removed `organizationId` from the Zod input schema.
- Applied `orgMemberProcedure` (requires ACTIVE OrganizationMember row).
- `orgId` derived exclusively from `ctx.orgMembership.organizationId`.
- Dedup key rotated to `sheriabot:gapanalysis:dedup:v2:{userId}:{fileHash}`.
  Old keys (TTL 900s) expire naturally; no migration needed.

---

### A2 -- checklist.generateChecklist [RESOLVED -- Batch 1]

| Field        | Value |
|--------------|-------|
| Severity     | Critical |
| CVE class    | IDOR (CWE-639) |
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

**Root cause:** Same pattern as A1 -- `organizationId: z.string().optional()` in
input, handler fell through to `input.organizationId ?? ctx.user.organizationId`.

**Fix:** Removed `organizationId` from Zod input; applied `orgMemberProcedure`;
`orgId` derived from `ctx.orgMembership.organizationId`.

---

## Class B -- Authorization Hardening (High)

### B1 -- organization.get: org-existence oracle [RESOLVED -- Batch 1]

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

### B2 -- organization.addMember / removeMember: OrganizationMember not written [RESOLVED -- Batch 1]

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

### B3 -- isOrganizationMember middleware: equality check only [RESOLVED -- Batch 2]

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

### B4 -- org-scoped procedures without active membership status check [RESOLVED -- Batch 2]

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

### B5 -- legacy null-org Checklist rows [ACCEPTED -- kept]

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

## Class C -- Informational / Low (Tracked, Deferred)

### C1 -- Pinecone vector namespace: flat `__default__` [ACCEPTED]

| Field        | Value |
|--------------|-------|
| Severity     | Informational |
| Status       | **Accepted risk** |

Only public regulatory documents are indexed (no per-org content). `reingest`
is gated behind `adminProcedure`. Per-org namespace isolation is not required
at current scale. Re-evaluate if client document indexing is added in future.

### C2 -- RLS not enabled on Supabase PostgreSQL [DEFERRED]

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

### C3 -- Stale `src/server/routers/router.ts` deleted [RESOLVED -- Batch 1]

| Field        | Value |
|--------------|-------|
| Status       | **Resolved** |
| Resolved in  | Batch 1 (2026-05-12) |

Dead file with 13 sub-routers that was never imported by production code
(`src/app.ts` imports from `src/server/trpc/router.ts` with 27 sub-routers).
Deleted to eliminate confusion.

### C4 -- Grounded compliance queries bypass the 24hr answer cache [RESOLVED -- Stage 0]

| Field        | Value |
|--------------|-------|
| Severity     | Informational / Performance |
| Status       | **Resolved -- retrieval cache implemented 2026-05-16** |
| Introduced   | Stage 0 grounding fix (2026-05-16) |
| Resolved in  | Stage 0 (retrieval cache, 2026-05-16) |

**Root cause:** The existing `complete()` cache uses prompt content as its implicit
key. When `ragContext` is injected into the prompt, every query generates a unique
prompt even for identical questions -- making the 24hr answer cache a 100% miss for
all grounded compliance queries.

**Measured impact (Stage 0 acceptance gate -- 2026-05-16):**

Baseline source: direct ungrounded-path live runs (3 questions -- run 1, AI cache
primed from prior session -- reflects typical user experience for repeated queries).

| Metric | Baseline (pre-fix) | Post-fix (grounded) | Ratio |
|---|---|---|---|
| p50 latency | 1,492 ms | 27,037 ms | 18.1x |
| p95 latency | 3,287 ms | 34,167 ms | 10.4x |
| Mean cost/query | $0.00911 | $0.01211 | 1.33x |
| Mean input tokens | ~1,387 | 2,303 | +916 (evidence block) |
| Mean output tokens | 2,000 (ceiling hit) | 2,566 (many at 3,000 ceiling) | -- |

Decision: **BLOCK** -- p95 regressed 10.4x (threshold: 2.0x). Cost: **PASS** (1.33x < 1.4x).

**Resolution:** Retrieval cache implemented in `src/lib/rag/rag.service.ts`
(`searchAndGetContext`). Key: `sheriabot:rag:ctx:v1:{sha256(question|topK|minScore)}`,
TTL: 1800s (30 min). Caches Pinecone lookup result only -- AI answer is never cached
for grounded queries (preserves corpus freshness per ODPC note below).

Cache-hit latency improvement: ~2-3s savings per hit (Pinecone lookup removed).
The dominant latency component is Claude generation (~23-27s for 2,000-3,000 output
tokens), which cannot be cached. p95 on cache hit: ~30-31s vs ~34s on cache miss.

**Residual note:** The grounded path is structurally 20-30x slower than the cached
ungrounded path. Streaming response (Stage 4) is the UX mitigation -- first token
arrives in ~2s; users see progressive output rather than a 30s blank wait.

**ODPC note:** Caching the AI answer would be misleading if the corpus is updated
with new CBK circulars or amended regulations between cache writes. Only the
retrieval result (Pinecone search output) is a candidate for short-lived caching.

---

---

## Class B (continued)

### B5-addendum -- payment.router.ts [RESOLVED -- Batch 2.5]

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
does not verify an active `OrganizationMember` row -- a user removed from an
org could continue reading that org's full payment history until their JWT
expired.

**Fix:** Migrated all three procedures to `orgMemberProcedure`. Removed the
manual `!user.organizationId` null guards (now handled by middleware). The
60s membership cache TTL is the upper bound on post-removal access -- flush
`sheriabot:orgmem:{userId}:{orgId}` for immediate revocation.

---

### C5 -- Stage 1 ComplianceQueryRun schema divergence [RESOLVED -- Stage 1.5]

| Field        | Value |
|--------------|-------|
| Severity     | Medium (data integrity -- incomplete traces) |
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

**Pre-condition for Stage 2:** Verified via 5-10 fresh shadow queries confirming
all new fields write correctly before Stage 2 authorization.

### C6 -- Corpus gaps: S1 (Microfinance Act), S2 (DPA registration deadline), C2 (CBK PSP capital framework) [DEFERRED]

| Field        | Value |
|--------------|-------|
| Severity     | Informational (grader correctly abstains) |
| Status       | **Deferred -- corpus expansion items** |
| Identified   | Stage 1.6 investigation (2026-05-16) |

Three query categories where the grader correctly rejects all retrieved chunks
because the relevant regulatory provisions are not in the Pinecone corpus.
`grounded=false`, `verifierVerdict='PARTIAL'`, `unsupportedClaims=['No graded evidence available to verify claims']` is the correct behavior in each case.

**S1 -- Tier 1 Microfinance Bank capital requirements:**
The top 10 Pinecone hits for this query return chunks from the Banking Act (Cap. 488)
and CBK Prudential Guidelines for Banking Act institutions, which specify core capital
for commercial banks (Kshs 1,000M) and financial institutions (Kshs 200M) -- not for
deposit-taking microfinance institutions (DTMs). "Tier 1 microfinance bank" is regulated
under the Microfinance Act 2006 with separate CBK-set capital minimums. The grader
correctly rejects the Banking Act chunks as non-responsive to the specific question.
Investigation confirmed this holds even with 800-char grader truncation.
**Fix required:** Add Microfinance Act 2006 and CBK Prudential Guidelines for DTMs
to `src/scripts/ingest-documents.ts` registry and re-ingest.

**S2 -- DPA 2019 data controller registration deadline:**
The right documents are in the corpus (Data Protection Act 2019, Registration
Regulations 2021, ODPC Guidance Note). The top 10 hits land on scope/purpose and
definitions sections (score >= 0.994). These sections establish the registration
obligation and cite the Regulations effective date (14 July 2022) but do not contain
the compliance deadline period (e.g., "within 6 months for existing controllers").
That deadline provision lives in the transitional section of the Registration
Regulations, which does not rank in the top 10 hits for this query.
**Fix required:** Review chunking of the Registration Regulations' transitional section,
or add a targeted summary chunk for this provision.

**C2 -- NPS Act 2011 / CBK PSP licensing and capital thresholds:**
All 10 retrieved chunks are from CBK Cybersecurity Guidelines for PSPs -- a different
document that mentions PSPs in its authorization preamble and thus ranks highly.
The NPS Act 2011 is in the corpus but its licensing provisions (Sections 7-12) do not
surface in the top 10 for capital-threshold queries. The CBK PSP Licensing Framework
circular (specifying licence tiers and capital minimums per tier) is not in the corpus at all.
**Fix required:** (a) Add CBK PSP Licensing Framework / capital thresholds circular
to corpus. (b) Investigate NPS Act chunk quality and embedding for licensing sections.

### C7 -- R09/R15 routing-coupling: abstain route ran full grader/verifier pipeline [RESOLVED -- Stage 2]

| Field        | Value |
|--------------|-------|
| Severity     | Medium (false-confident PASS on off-topic queries) |
| Status       | **Resolved** |
| Identified   | Stage 2 shadow re-baseline (2026-05-17) |
| Resolved in  | Stage 2, Step 1 -- orchestrator abstain short-circuit (2026-05-17) |

**Root cause:** The orchestrator had no early-exit branch for `route === 'abstain'`. When the router
correctly classified a query as out-of-scope (e.g., R09 "regulations of the gaming industry", R15
"who is the owner of this website"), the full grader and verifier pipeline still executed. The grader
found tangentially-matching chunks (2 for R09, 2 for R15); the verifier returned `PASS` for the
supplied answers with those chunks as evidence. Result: `grounded=true`, `verifierVerdict='PASS'`
for off-topic queries -- the opposite of intended semantics.

**Fix:** Added abstain short-circuit immediately after the tier-gating block in `orchestrator.ts`.
When `route === 'abstain'`: writes a minimal trace row (`grounded=false`, all agent fields null/zero,
only router tokens recorded), logs `orchestrator_run_abstained`, and returns early. Grader and verifier
are never invoked.

---

### C8 -- R07 corpus gap: Draft CBK Non-Deposit Taking Credit Providers Regulations [RESOLVED -- Pre-cutover step 1]

| Field        | Value |
|--------------|-------|
| Severity     | Medium (in-scope abstention -- 8.3% of substantive pilot queries) |
| Status       | **Resolved** |
| Identified   | Stage 2 shadow re-baseline (2026-05-17) |
| Resolved in  | Pre-cutover step 1 (2026-05-17) |

**Symptom:** Query R07 returned `grounded=false`, `verifierVerdict='PARTIAL'` -- grader correctly
rejected all 10 retrieved chunks because the NDTCP Regulations were not in the Pinecone corpus.
These regulations are distinct from the Digital Credit Providers Regulations 2022 (indexed);
existing chunks specified no NDTCP capital thresholds.

**Fix applied (2026-05-17):**
- Document obtained from CBK public register (published 2026-08-07; consultation closed 2025-09-05;
  no gazetted/final version exists as of 2026-05-17 -- the August 2025 draft is the definitive
  current version per CBK Legislation & Guidelines page).
  Source: `centralbank.go.ke/wp-content/uploads/2025/08/Draft-Central-Bank-of-Kenya-Non-Deposit-Taking-Credit-Providers-Regulations-2025.pdf`
- Placed at `documents/kenya/Draft-CBK-Non-Deposit-Taking-Credit-Providers-Regulations.pdf`
  (603 KB, 63 pages, PDF 1.7).
- `pnpm ingest` completed: status=ACTIVE, chunkCount=565, totalCharacters=125,684, errorMessage=null.
- Verification query "NDTCP capital threshold tier 1 non-deposit taking credit provider licence"
  returned 5/5 top-K chunks from this document (scores 0.963-1.006).
  - Chunk [1] (score 1.006): "initial capital more than 20 million shillings -> apply for licence (Form CBK NDTCP 1)"
  - Chunk [2] (score 0.982): "initial capital less than 20 million shillings -> apply for registration"

**Post-fix in-scope abstention rate:** 0/12 substantive pilot queries abstain for corpus gap.
Target <5% met.

### C9 -- Streaming endpoint: FREE_TRIAL effective plan not resolved [DEFERRED -- Stage 3]

| Field        | Value |
|--------------|-------|
| Severity     | Low (conservative fallback -- users treated as base org plan) |
| Status       | **Deferred** |
| Introduced   | Stage 2, Step 7 -- `/api/compliance/stream` (2026-05-17) |
| Planned for  | Stage 3 (trial/grace period plan resolution in SSE auth) |

**Root cause:** `checkAndPrepareUsage()` in `compliance-stream.route.ts` reads `org.plan` directly from
the database. The `EffectivePlan` computation in `withPlanContext` (tRPC middleware) accounts for active
free trials (`User.freeTrialActivatedAt/ExpiresAt`), Stripe grace periods, and cancellation windows.
The streaming route does not replicate this logic. A FREE_TRIAL user's effective plan is `'FREE_TRIAL'`
(TypeScript-only, never persisted); `org.plan` for that user is `REGULATOR` (or whatever their base plan
is). Result: FREE_TRIAL users hitting the streaming endpoint are quota-checked against their base org
plan's `complianceQueries` limit, which is typically `{ limit: -1 }` (unlimited) for REGULATOR.

**Impact:** Slightly over-permissive for FREE_TRIAL users on the streaming endpoint -- they can bypass
the 25-query trial cap. The tRPC `compliance.query` mutation enforces trial limits correctly.

**Fix required (Stage 3):** Extract the FREE_TRIAL resolution logic from `withPlanContext` into a
shared utility (e.g. `src/utils/resolve-effective-plan.ts`). Call it in both `withPlanContext` and
`resolveAuth` in the streaming route. The utility reads `User.freeTrialActivatedAt/ExpiresAt` and
applies `FREE_TRIAL_LIMITS` enforcement when the trial is active and unexpired.

---

### C10 -- Streaming endpoint: AI budget enforcement is pre-call only [ACCEPTED -- by design]

| Field        | Value |
|--------------|-------|
| Severity     | Informational |
| Status       | **Accepted risk** |
| Introduced   | Stage 2, Step 7 -- `/api/compliance/stream` (2026-05-17) |

**Behavior:** `stream()` in `src/lib/ai/client.ts` calls `checkCostLimit(estimatedCost)` before sending
the request to Anthropic. `estimatedCost` is computed from estimated input tokens + `maxTokens` output
ceiling. No enforcement runs mid-stream.

**Rationale for acceptance:** `maxTokens` is a server-side hard ceiling enforced by Anthropic's API --
a stream cannot exceed it regardless of content. The pre-call estimate is therefore conservative:
it budgets for the maximum possible output. If the daily cost limit is reached during a stream (rare,
requires the estimate to have been under-computed), the current stream completes and `trackCost()`
records the overage. The next request is blocked at the pre-call check. This is equivalent to the
non-streaming path's behavior and is acceptable for the current scale.

**Re-evaluate when:** daily query volume exceeds ~500 queries/day or cost-per-query increases
significantly (model upgrade, longer context). At that point, add a mid-stream token counter and abort
the stream when a per-request token ceiling is crossed.

---

### C11 -- Citation join fallback attaches wrong section's text snippet on multi-chunk documents [KNOWN -- Stage 2.5]

| Field        | Value |
|--------------|-------|
| Severity     | Low (display only -- citation list is correctly filtered) |
| Status       | **Known -- fix before Stage 3 begins** |
| Identified   | Stage 2, Step 7/8 amendment review (2026-05-17) |
| Planned for  | Stage 2.5 (post-Stage-2 ship, pre-Stage-3) |

**Symptom:** In `compliance-stream.route.ts`, the citation join logic matches `AcceptedChunkRef` entries
to `ragContext.results` by `(documentId, section)`. When the exact section match fails (e.g., `section`
is undefined on one side), a fallback `find((r) => r.documentId === ref.documentId)` picks the *first*
RAG chunk for that document ID. If the document contributed multiple chunks to the top-K and the accepted
chunk is not the first, the displayed `textSnippet` and `score` belong to a different chunk than the one
the verifier approved.

**Impact:** Citations array is correctly filtered (only accepted documents appear -- no over-inclusion or
under-inclusion). This is a presentation error only: the text shown in the "Sources" panel may not be the
exact passage the verifier approved, though it is from the same document. Occurs only when `section`
fields are inconsistent between Pinecone metadata and the orchestrator's stored `AcceptedChunkRef`.

**Fix required (Stage 2.5):** Add a stable `vectorId` (Pinecone vector id, already available on
`QueryResult.id` in `src/lib/rag/client.ts`) to `AcceptedChunkRef` during grader bookkeeping, and
propagate it through the orchestrator's `acceptedChunkIds` JSON column. Use `vectorId` as the primary
join key in `compliance-stream.route.ts`, with `(documentId, section)` as fallback only for pre-fix
trace rows. Update `SearchResult` in `rag.service.ts` to carry the vector id from `QueryResult.id`.

**Files to change (Stage 2.5):**
- `src/modules/compliance/orchestrator/types.ts` -- add `vectorId: string` to `AcceptedChunkRef`
- `src/modules/compliance/orchestrator/grader.agent.ts` -- populate `vectorId` from graded chunk
- `src/lib/rag/rag.service.ts` -- add `id: string` (vector id) to `SearchResult` interface
- `src/routes/compliance-stream.route.ts` -- join on `vectorId` first, fall back to `(documentId, section)`

---

## Stage 2 -- Compliance Orchestrator + Streaming UI (2026-05-17)

### What shipped

| Component | File(s) | Description |
|-----------|---------|-------------|
| Router agent | `src/modules/compliance/orchestrator/router.agent.ts` | Classifies query scope; returns `route` + `confidence` |
| Grader agent | `src/modules/compliance/orchestrator/grader.agent.ts` | Scores/accepts RAG chunks; populates `AcceptedChunkRef[]` |
| Verifier agent | `src/modules/compliance/orchestrator/verifier.agent.ts` | Cross-checks synthesized answer against accepted chunks |
| Orchestrator | `src/modules/compliance/orchestrator/orchestrator.ts` | Wires agents; writes `ComplianceQueryRun` trace row |
| SSE endpoint | `src/routes/compliance-stream.route.ts` | `POST /api/compliance/stream` -- Fastify hijack, SSE, deferred usage increment |
| `reportGap` tRPC | `compliance.router.ts:1383` | Corpus gap feedback mutation; IDOR-protected |
| `useComplianceStream` hook | `fintech-regulatory-platform/hooks/use-compliance.ts` | State machine (idle->connecting->streaming->verifying->complete\|error); AbortController lifecycle |
| `AbstainCard` component | `fintech-regulatory-platform/components/compliance/abstain-card.tsx` | Two variants: scope-abstain (amber) + corpus-gap (blue); inline `GapForm` |
| `UngroundedBanner` component | `fintech-regulatory-platform/components/compliance/ungrounded-banner.tsx` | Blue info banner for PARTIAL verdict |
| Compliance query page | `fintech-regulatory-platform/app/(dashboard)/startup/compliance-query/page.tsx` | Streaming path; conditional AbstainCard / UngroundedBanner; live streaming bubble |
| R07 registry entry | `src/scripts/ingest-documents.ts` | ... Ingested -- 565 chunks, ACTIVE, verified in Pinecone (2026-05-17) |
| Smoke test script | `src/scripts/smoke-stream-done.ts` | Manual SSE smoke test verifying `done` event shape |

### Pending actions before production cutover

1. ... **R07 ingestion** -- COMPLETE (2026-05-17). Draft CBK NDTCP Regulations obtained from CBK public register, ingested (565 chunks, ACTIVE), Pinecone verification query confirmed 5/5 top-K chunks from this document with capital threshold provisions. C8 closed. In-scope abstention rate: 0/12 (was 1/12 = 8.3%).

2. ... **Staging 19-query re-baseline** -- COMPLETE (2026-05-17). All gates PASS. See staging verification record below.

3. **Production cutover** -- Both pre-conditions confirmed (2026-05-17): rollback runbook at `docs/runbooks/orchestrator-rollback.md` ..., C12 abstain-route behavior documented (non-blocking) .... **Ready for production flip** -- set `ORCHESTRATOR_ENABLED=true` in Render dashboard -> SheriaBot Backend -> Environment, trigger redeploy, monitor 30 min.

### Staging Verification Record (2026-05-17)

`ORCHESTRATOR_ENABLED=true` set in local `.env`. 19-query pilot run via in-process `stage2-shadow-rebaseline` (timed wrapper). SSE 4-case rendering verified via curl against local backend on port 4000. Ephemeral Supabase test user created/destroyed for HTTP tests.

| Gate | Target | Result | Status |
|------|--------|--------|--------|
| In-scope abstention rate | <=10% | 0/11 = **0.0%** | **PASS** |
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
*Note: In-process measurements with 600-token answer cap. Real streaming queries (2,000-3,000 tokens) will be somewhat slower; first token via SSE chunk arrives in ~2s regardless.*

**SSE event shape (verified via curl):** `connected -> [N chunks] -> synthesis_complete -> done`. Abstain-route queries still stream synthesis chunks -- `abstained=true` in done event is the frontend signal to suppress streamed content and show AbstainCard. See Section C12 for the synthesis-waste issue (Stage 2.5 fix, does not block cutover).

**R07 verification in pilot:** `route=simple, grounded=true, verdict=PASS, accepted=2, confidence=0.85` -- NDTCP corpus ingestion confirmed working.

**Verifier observations:**
- Downgrade rate: 11/12 grounded queries have `routeDowngraded=true` (all downgraded to `route=simple`). Expected -- the router correctly classifies these as simple queries; the downgraded flag reflects that the plan tier would permit complex routing.
- PARTIAL verdicts (R01, R08, R11, R13, R16): All on broad multi-regulatory queries. Expected -- these span DPA + CBK + consumer protection simultaneously. No FALSE-PASS (weakly-grounded PASS) detected.
- No FAIL verdicts on any in-scope query.
- R16 ("open a compliance website") classified as `route=simple, grounded=true, verdict=PARTIAL` despite being in the off-topic set -- correctly handled as a marginal compliance question.

**Browser rendering note:** SSE event stream verified via curl (identical byte sequence to browser EventSource). Visual React component rendering (AbstainCard variants, UngroundedBanner, CitationList) not visually confirmed -- no browser available in execution environment. Component props are correct per SSE done-event field values.

### Deferred to Stage 2.5 / Stage 3

- **C11** -- Citation `vectorId` join fix (Stage 2.5, before Stage 3)
- **C9** -- FREE_TRIAL plan resolution in streaming endpoint (Stage 3)
- **C12** -- SSE route synthesis waste on abstain path (Stage 2.5)

---

### C12 -- SSE route does not short-circuit on `route=abstain` [STAGE-2.5-FIX]

| Field | Value |
|-------|-------|
| Severity | Low (cost / efficiency; no correctness or security impact) |
| Status | **Open -- STAGE-2.5-FIX, does not block cutover** |
| Confirmed | 2026-05-17 via curl test against local backend with ORCHESTRATOR_ENABLED=true |

**Observed behavior:** When the orchestrator router classifies a query as `route=abstain` (off-topic / out of scope), the SSE route continues to:
1. Return `ragSources: 10` in the `connected` event -- RAG retrieval ran in full.
2. Stream 20-25 Haiku/Sonnet `chunk` events -- full synthesis ran in full.
3. Then emit `done` with `route=abstain, abstained=true, citations=[]`.

The frontend `useComplianceStream` hook suppresses all streamed content when `abstained=true` in the `done` event and renders `AbstainCard` instead. From the user's perspective the page is correct. From a cost perspective, every off-topic query pays ~$0.01-0.03 in Sonnet tokens that are immediately discarded.

**Verified event sequence** (query: "what is the weather in Nairobi today"):
```
connected  { ragSources: 10 }
chunk x 24
synthesis_complete
done       { route: "abstain", abstained: true, citations: [], confidence: null }
```

**Root cause:** `compliance-stream.route.ts` starts the Anthropic streaming call unconditionally before the orchestrator pipeline resolves. The orchestrator result (including `route`) is not available until after synthesis completes, so the route verdict cannot gate the synthesis call.

**Fix (Stage 2.5):** Restructure the SSE route to run the orchestrator router agent first (before opening the Anthropic stream). If `route=abstain`, emit `connected -> done` directly without starting synthesis. This requires pulling the router agent call out of the orchestrator pipeline and into the SSE route handler as a pre-synthesis gate.

**Does not block cutover:** The frontend correctly suppresses streamed content and renders AbstainCard. Users see the correct UX. The only impact is token cost on off-topic queries.

---

## Batch Roadmap

| Batch | Focus | Status |
|-------|-------|--------|
| Batch 1 | IDOR closure (A1, A2), org oracle (B1), member source-of-truth (B2), stale file | **COMPLETE** |
| Batch 2 | Migrate remaining Class B procedures; remove `isOrganizationMember` | **COMPLETE** |
| Batch 2.5 | payment.router.ts scope clarification + orgMemberProcedure migration | **COMPLETE** |
| Batch 3 | Audit logging (AuditLog writes, 100% denials / 10% grant sample); trust page; incident runbook | **COMPLETE** |
| Stage 2 | Compliance orchestrator + SSE streaming + frontend rendering | **CODE COMPLETE -- cutover pending** |
| Sprint 1 | Authorization hardening, dead-code removal, secret-handling controls | **COMPLETE -- 2026-05-18** |

---

## Sprint 1 -- Authorization Hardening & Code Cleanup (2026-05-18)

### BE-O-015 -- updateMemberRole: role change not reflected until session cache expires [RESOLVED -- Sprint 1 Batch 1]

| Field | Value |
|-------|-------|
| Severity | High |
| CVE class | Stale session role -- Broken Access Control (CWE-284) |
| Status | **Resolved** |
| Resolved in | Sprint 1 Batch 1 (2026-05-18) |

**Root cause:** `updateMemberRole` writes the new role to `User.role` (UserRole enum) via
`prisma.user.update`, but does not invalidate the `user:session:{supabaseAuthId}` cache
(TTL 3600s). The cache holds the full Prisma `User` object including `.role`. Until the TTL
expires, `ctx.user.role` on subsequent requests reflects the OLD role -- meaning a demotion
would not take effect for up to one hour, and a promotion (e.g., to ADMIN) would also not
be visible to the promoted user until expiry.

A secondary gap: the `OrganizationMember` membership cache (`sheriabot:orgmem:{userId}:{orgId}`,
TTL 60s) was also not invalidated after the `User.role` change, though since
`updateMemberRole` does not modify `OrganizationMember.role` (a separate `MemberRole` enum:
`OWNER|ADMIN|MEMBER`), this is a defensive eviction rather than a correctness fix.

**Note on the Phase A proposed fix:** Phase A proposed `organizationMember.updateMany` to
sync `OrganizationMember.role` with `User.role`. This was not implemented because the two
role enums are semantically orthogonal -- `UserRole` (`REGULATOR|STARTUP|ENTERPRISE|ADMIN`)
describes the user's platform-level identity type; `MemberRole` (`OWNER|ADMIN|MEMBER`)
describes their position within a specific organization. Direct assignment would cause DB
errors for all non-ADMIN values and incorrect semantics for ADMIN.

**Fix applied:**
- Added `supabaseAuthId: true` to the `findUnique` select in `updateMemberRole`.
- After `prisma.user.update` succeeds: `redis.del(`user:session:${targetUser.supabaseAuthId}`)`.
- Also evicts `sheriabot:orgmem:{userId}:{orgId}` defensively.
- File: `src/server/routers/organization.router.ts`.

---

### BE-D-003 -- executeRawQuery: $queryRawUnsafe wrapper with SQL injection surface [RESOLVED -- Sprint 1 Batch 3]

| Field | Value |
|-------|-------|
| Severity | High (potential injection surface -- zero call sites confirmed) |
| Status | **Resolved -- function deleted** |
| Resolved in | Sprint 1 Batch 3 (2026-05-18) |

**Root cause:** `executeRawQuery<T>(query: string, params: any[])` in
`src/lib/prisma/client.ts` wrapped `prisma.$queryRawUnsafe` which executes an
arbitrary caller-supplied SQL string. The function also logged the raw `query` string,
creating a secondary PII/secret-in-logs risk for any query containing bound parameter
values. Zero confirmed call sites (grep of full codebase + test directories confirmed
before deletion).

**Fix:** Function and JSDoc comment deleted in full. Correct replacement for parameterised
raw SQL is Prisma's `$queryRaw` tagged template literal. `$queryRawUnsafe` usage is banned
-- see `docs/security/secret-handling.md`.

---

### BE-F-005 -- generateChecklistAsync: missing REGULATOR role guard [RESOLVED -- Sprint 1 Batch 2]

| Field | Value |
|-------|-------|
| Severity | Low (mitigated by plan middleware, defense-in-depth gap) |
| Status | **Resolved** |
| Resolved in | Sprint 1 Batch 2 (2026-05-18) |

**Root cause:** The async checklist generation path (`generateChecklistAsync` in
`src/server/routers/checklist.router.ts`) was missing the explicit REGULATOR role check
present on the legacy synchronous `generateChecklist` procedure. The synchronous path
blocks REGULATOR callers at line 44-50 with a FORBIDDEN TRPCError. The async path
proceeded past plan-context and rate-limit middleware before the orgId was resolved,
with no role check.

**Fix:** Explicit guard inserted as the first statement in the `generateChecklistAsync`
mutation body -- before `orgId` resolution -- matching the synchronous counterpart exactly.
Frontend already handles FORBIDDEN response gracefully (toast.error, no change needed).

---

---

## Sprint 2 Phase B -- Authorization Hardening (2026-05-18)

### BE-M-022 -- Orgmem cache invalidation gap on dead organizationModule methods [RESOLVED -- Sprint 2 Batch 1]

| Field | Value |
|-------|-------|
| Severity | High |
| CVE class | Stale-cache privilege persistence (CWE-284) |
| Status | **Resolved** |
| Resolved in | Sprint 2 Batch 1 (2026-05-18) |

**Root cause:** Dead code in `organization.module.ts` included `addMember` and
`removeMember` methods that wrote only to `User.organizationId` without creating or
updating the `OrganizationMember` row. `requireOrgMembership` reads from
`OrganizationMember`; members added/removed via these paths would be invisible to the
new membership gate. Additionally, several router procedures derived `orgId` from
`ctx.user.organizationId` rather than `ctx.orgMembership.organizationId`, bypassing
membership verification entirely.

**Fix:** Dead module methods removed. Router procedures migrated to `orgMemberProcedure`.
`addMember` and `removeMember` in `organization.router.ts` now upsert/update
`OrganizationMember` and explicitly invalidate `sheriabot:orgmem:{userId}:{orgId}`.

---

### BE-M-023 -- tRPC middleware context-narrowing regression [RESOLVED -- Sprint 2 Batch 1.5a]

| Field | Value |
|-------|-------|
| Severity | Medium (TypeScript only -- no runtime auth bypass) |
| Status | **Resolved** |
| Resolved in | Sprint 2 Batch 1.5a (2026-05-18) |

**Root cause:** A prior refactor of `systemAvailable` middleware changed its call from
`next()` to `next({ ctx })`. In tRPC v11, `next({ ctx })` resets the context type to
the base shape, losing the `ctx.user: User` (non-null) narrowing that `isAuthenticated`
provides. All downstream handlers in `protectedProcedure` and its descendants
(`adminProcedure`, `orgMemberProcedure`, etc.) then required `ctx.user!` non-null
assertions, or the compiler reported 140+ type errors.

**Fix:** `systemAvailable` reverted to `next()` (Form A -- no argument). The invariant
is documented in `docs/architecture/data-model-invariants.md`. See that document for
the authoritative rule on when to use each form.

---

### BE-I-024 -- Pre-existing non-ASCII bytes in middleware.ts [DEFERRED -- Sprint 4]

| Field | Value |
|-------|-------|
| Severity | Low (cosmetic -- no runtime impact) |
| Status | **Deferred** |
| Planned for | Sprint 4 non-ASCII cleanup pass |

**Root cause:** `src/server/trpc/middleware.ts` lines ~248 and ~370 contain pre-existing
non-ASCII characters (Unicode arrows, em-dashes) from before Sprint 2 scope. Sprint 2
adopted the policy "fix where you're already touching" -- modified files in each batch
received a full non-ASCII pass. `middleware.ts` was not modified in Sprint 2 and is
therefore out of scope.

**Sprint 2 cleanups applied (for reference):**
- `compliance.router.ts`: 19 occurrences (arrows, em-dashes, box-drawing, U+FFFD)
- `checklist.router.ts`: 4 occurrences (box-drawing section separators, em-dashes)
- `compliance.module.ts`: 15 occurrences (em-dashes, en-dash in range indicator)

**Fix (Sprint 4):** Grep full `src/` tree for bytes > 0x7F; replace with ASCII
equivalents; re-run `pnpm tsc --noEmit` gate.

**Status update (2026-05-26, Phase B Batch 0):** RESOLVED. Byte-level scan on
2026-05-26 (PowerShell, all bytes > 0x7F) confirmed zero non-ASCII bytes in
`src/server/trpc/middleware.ts`. The fix was applied in a prior sprint without
an entry update. The broader non-ASCII scope (113 additional `.ts`/`.tsx` files
identified in the Phase A audit) is tracked separately and deferred to the
non-ASCII cleanup pass in Batch 2. This entry is closed for `middleware.ts`
specifically.

---

### BE-A-026 -- getChecklist cross-org read (same-batch discovery and closure) [RESOLVED -- Sprint 2 Batch 2]

| Field | Value |
|-------|-------|
| Severity | High |
| CVE class | IDOR (CWE-639) |
| Status | **Resolved** |
| Resolved in | Sprint 2 Batch 2 (2026-05-18) |
| Discovery | Same batch -- not in Phase A audit |

**Root cause:** `getChecklist` in `checklist.router.ts` had an access check that read
`if (checklist.userId !== userId)`. This is always false (a value is never not-equal to
itself) -- a tautological condition that granted read access to any authenticated caller
for any checklist ID. The procedure was on `protectedProcedure`, not `orgMemberProcedure`.

**Discovery note:** Phase A named exactly three findings for the checklist surface
(BE-A-002, BE-Q-017, BE-Y-025). `getChecklist` was discovered during Batch 2
implementation as a fourth affected procedure. It is logged as BE-A-026 rather than
folding into BE-Q-017 to preserve an accurate audit trail (the finding was new; closing
it in the same batch is an accelerated resolution, not a pre-existing fix).

**Fix:** Migrated to `orgMemberProcedure`. Access check replaced with `hasAccess`:
- If `checklist.organizationId` is set: require `checklist.organizationId === orgId`.
- If null (legacy row): require `checklist.userId === userId`.
- Admins bypass both checks.

---

### BE-M-027 -- Latent followUp context degradation via stale field reference [RESOLVED -- Sprint 2 Batch 4+6]

| Field | Value |
|-------|-------|
| Severity | Medium (silently-degraded business logic; no security impact) |
| Status | **Resolved** |
| Discovered | Sprint 2 Batch 4+6 (2026-05-18) during cast removal |
| Resolved in | Sprint 2 Batch 4+6 (2026-05-18) |
| Affected | `src/server/routers/compliance.router.ts` -- `followUp` mutation |

**Root cause:** `(originalQuery as any).answer` referenced a field that does not
exist in the ComplianceQuery schema. At runtime this resolved to `undefined`,
and the `as any` cast hid the broken contract from the type system. The
follow-up prompt context for the original answer was effectively empty.

**Fix:** Replaced with `originalQuery.response || originalQuery.summary || ''`,
which reads from fields that actually exist in the schema with safe fallback.

**Impact assessment:** RAG follow-up quality before 2026-05-18 may have been
degraded for queries that relied on the original answer context. Sample-check
pre-2026-05-18 follow-up outputs if RAG quality investigations arise.

**Lesson:** This is the second instance in Sprint 2 where an `as any` cast hid a
real bug. Reinforces the sprint's "no `any` TypeScript type" hard constraint --
every cast warrants investigation of what type-system signal is being
suppressed.

---

### CC-B-038 -- redis.setex() calls in user.module.ts [PRE-RESOLVED]

| Field | Value |
|-------|-------|
| Severity | Medium (fragile Upstash compat-shim dependency) |
| Status | **Pre-resolved before Sprint 2** |
| Source | System hardening audit |

**Issue:** Four `redis.setex(key, ttl, value)` calls in `user.module.ts` used the
ioredis API rather than the Upstash-compatible `redis.set(key, value, { ex: ttl })`.
Upstash Redis does not support `setex()` natively; the calls relied on an undocumented
compatibility layer.

**Resolution:** All `redis.setex()` calls were replaced with `redis.set(key, value,
{ ex: ttl })` as part of the Railway Redis -> Upstash Redis migration (Infrastructure
Migration, March 2026). No `setex` calls remain in the codebase as of Sprint 2 Phase A
audit (2026-05-18, confirmed by grep). No dedicated fix pass required.

---

### BE-I-008 -- Free trial TOCTOU on increment [RESOLVED -- Sprint 3 Batch 2]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Resolved** |
| Discovered | Sprint 3 Phase A refinement (2026-05-18) |
| Resolved in | Sprint 3 Batch 2 (2026-05-20) |
| Affected | `src/modules/trial/trial.service.ts` -- trial usage increments |

**Root cause:** Trial quota enforcement used a check-then-increment pattern:
`checkTrialLimit` read `User.freeTrialUsage`, then `incrementTrialUsage` performed
a separate read-modify-write after successful feature execution. Parallel trial
requests could both pass the preflight check and then under-count or exceed a cap.

**Fix:** Added `incrementTrialUsageAtomic`, backed by a single Postgres conditional
`UPDATE ... RETURNING` against the `freeTrialUsage` JSONB column. The update only
commits when `current + incrementBy <= limit`; otherwise it returns
`allowed: false` with the unchanged count. Existing `incrementTrialUsage` now routes
through the atomic helper.

**Verification:** `scripts/verify-sprint-3-batch-2.ts` covers under-cap, exact-cap,
past-cap, large token step, and concurrent 24/25 increments. The concurrency scenario
confirmed exactly one winner and final DB value 25.

**Batch 2 review (2026-05-20) -- APPROVED**

_Pre-approval items resolved:_

**1. Call-site update status -- scenario (a) confirmed on both files.**

`checkUsageLimit` FREE_TRIAL branch (`src/server/trpc/middleware.ts`):
- `incrementTrialUsageAtomic` called directly at line 611, BEFORE `next()`.
- If `allowed: false` -> throws `TRPCError({ code: 'FORBIDDEN' })` -> handler never runs.
- The `deferIncrement` option is in the Redis monthly quota path below the FREE_TRIAL
  branch and is structurally unreachable from it. FREE_TRIAL always increments atomically
  before calling `next()`. Enforcement gap: closed.

SSE stream increment closure (`src/routes/compliance-stream.route.ts`):
- Imports `incrementTrialUsageAtomic` directly (line 16); `incrementTrialUsage` not used.
- Closure (lines 158-184): calls atomic helper for both `complianceQueries` and
  `totalTokensUsed`; branches on `allowed: false` with `logger.warn(type:
  'compliance_stream_trial_usage_increment_blocked')` + `return`.
- Closure is invoked at line 410 AFTER synthesis is complete and the DB record is written.
  Log-and-continue is correct for a post-answer deferred path: the next request is blocked
  at the `checkTrialLimit` preflight. Log entry confirmed present.

Neither file required changes; both already call `incrementTrialUsageAtomic` directly.

**2. Near-miss scan -- 0 findings across `trial.service.ts`, `trial.types.ts`, `index.ts`.**

| Pattern | Findings | Notes |
|---------|----------|-------|
| `incrementTrialUsage` used as enforcement entry point | 0 | Line 275 is the legacy wrapper only; delegates to atomic and throws on `allowed: false` |
| `checkTrialLimit` used as enforcement primitive | 0 | Preflight/display only; always followed by the atomic increment in enforcement paths |
| `(err as Error).message` unsafe cast | 0 | Lines 91, 107, 184, 353 pass `err` directly to structured logger |
| `redis.setex()` wrong Upstash API | 0 | `redis.set(k, v, { ex: ttl })` at lines 174, 342 |
| `$queryRawUnsafe` | 0 | `prisma.$queryRaw` tagged template at line 226 |
| Missing null guard on Prisma result | 0 | Guards at lines 62, 144, 261 |
| Non-null assertions or `any` casts | 0 | None present |
| Fire-and-forget without try/catch | 0 | `void (async () => {...})()` at lines 97-109, 169-188 both have full try/catch |

**3. Invariants doc -- already present.** "Trial usage increment invariant" section at
`docs/architecture/data-model-invariants.md` lines 82-99. Content: `incrementTrialUsageAtomic`
named as enforcement entry point, `incrementTrialUsage` as legacy wrapper, `checkTrialLimit`
scoped to preflight/display only. No edit required.

---

### BE-S3-001 -- SSE compliance stream duplicates quota-gate business logic [OPEN -- sprint-4]

| Field | Value |
|-------|-------|
| Severity | Medium (drift risk between tRPC and SSE quota enforcement) |
| Status | **Open** |
| Discovered | Sprint 3 Batch 1 amended near-miss scan (2026-05-20) |
| Affected | `src/routes/compliance-stream.route.ts` -- `checkAndPrepareUsage` |

**Issue:** The SSE route carries a local quota implementation for compliance queries
instead of sharing the tRPC `checkUsageLimit` code path. Batch 1 correctly moved
effective-plan resolution into `resolveEffectivePlan`, but the quota check itself can
still drift from middleware semantics over time.

**Deferred action:** Extract a shared compliance-query usage gate or add an integration
test that proves the SSE and tRPC gates remain behaviourally equivalent for FREE_TRIAL,
REGULATOR, and paid plans.

---

### BE-S3-002 -- SSE RAG retrieval failure falls through to ungrounded generation [OPEN -- sprint-4]

| Field | Value |
|-------|-------|
| Severity | Medium (regulatory-answer quality and auditability risk) |
| Status | **Open** |
| Discovered | Sprint 3 Batch 1 amended near-miss scan (2026-05-20) |
| Affected | `src/routes/compliance-stream.route.ts` -- RAG retrieval before stream hijack |

**Issue:** `searchAndGetContext(...).catch(...)` logs retrieval errors and returns an
empty context, allowing the route to continue into AI synthesis. That preserves uptime,
but it can silently convert a grounded compliance answer into an ungrounded answer when
the retrieval dependency fails.

**Deferred action:** Decide whether retrieval failure should return an HTTP 500 before
stream hijack, emit an explicit degraded-mode response, or be allowed only for
non-regulatory/general queries.

---

### BE-S3-003 -- SSE usage increment failure is swallowed after successful answer [OPEN -- sprint-4]

| Field | Value |
|-------|-------|
| Severity | High (quota undercount / billing enforcement bypass on Redis failure) |
| Status | **Open** |
| Discovered | Sprint 3 Batch 1 amended near-miss scan (2026-05-20) |
| Affected | `src/routes/compliance-stream.route.ts` -- deferred usage increment |

**Issue:** After a successful stream, `usage.increment(...)` logs and swallows Redis or
trial JSON update failures. The user receives a successful answer while quota accounting
may not be committed.

**Deferred action:** Define a durable accounting fallback for post-answer increment
failures, such as a retryable usage-adjustment table/event, and alert on failed commits.

---

### BE-S3-004 -- Plan-context cache parser trusts enum-shaped strings [OPEN -- sprint-5a]

| Field | Value |
|-------|-------|
| Severity | Medium (malformed Redis cache can skew plan resolution until expiry) |
| Status | **Open** |
| Discovered | Sprint 3 Batch 1 amended near-miss scan (2026-05-20) |
| Affected | `src/modules/billing/resolve-effective-plan.ts` -- `parseCachedPlanCtx` |

**Issue:** Cached plan context parsing checks that `orgPlan` is a string, then casts
several enum fields without validating membership in the Prisma enum value sets. A
corrupt cache entry could survive as a typed value until the five-minute TTL expires.

**Deferred action:** Validate cached enum values explicitly and treat invalid cache
payloads as misses with eviction.

---

### BE-S3-005 -- Fire-and-forget audit/export update errors use unsafe Error casts [OPEN -- sprint-5b]

| Field | Value |
|-------|-------|
| Severity | Low (logging robustness / secondary-error risk) |
| Status | **Open** |
| Discovered | Sprint 3 Batch 1 amended near-miss scan (2026-05-20) |
| Affected | `src/server/routers/compliance.router.ts` -- export audit/report tracking catch handlers |

**Issue:** Several `.catch((err: unknown) => ...)` handlers log `(err as Error).message`.
If a non-Error rejection is thrown, the log loses useful detail and can itself become
misleading. Batch 1 briefly cleaned this up but the amended scope correction reverted
those unrelated export-path changes.

**Deferred action:** Replace with a local `errorMessage(err)` helper or equivalent in a
future export cleanup pass.

---

### BE-S3-006 -- compliance.router.ts catch blocks use unsafe error casts [OPEN -- sprint-4]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Open** |
| Discovered | Sprint 3 Batch 1 (2026-05-20) |
| Affected | `src/server/routers/compliance.router.ts` -- catch blocks |

**Issue:** 16 catch blocks in `compliance.router.ts` (lines 224, 421, 494, 552,
592, 625, 665, 699, 746, 791, 832, 868, 1127, 1232, 1247, 1416) use the
`(err as Error).message` pattern, which loses detail on non-Error rejections and
can produce misleading logs. Batch 1 cleaned these up incidentally; the cleanup
was reverted to preserve Sprint 3 scope discipline.

**Deferred action:** Handle in a Sprint 4 catch-block hardening pass alongside
BE-S3-005.

---

### BE-C-011 -- applyForPilot: no rate limiting and no email idempotency [RESOLVED -- Sprint 3 Batch 3]

| Field | Value |
|-------|-------|
| Severity | High (AI-cost exposure + duplicate contact records) |
| Status | **Resolved** |
| Discovered | Sprint 3 Phase A audit refinement (2026-05-20) |
| Resolved in | Sprint 3 Batch 3 (2026-05-20) |
| Affected | `src/server/routers/publicMarketing.router.ts` -- `applyForPilot` mutation |

**Root cause (rate limiting):** `applyForPilot` was on `publicProcedure` with no middleware
guard. A single IP could submit unlimited pilot applications, generating unbounded contact
records and consent log entries at zero marginal cost to the attacker.

**Root cause (email idempotency):** No dedup sentinel existed for the normalised email
address. Identical emails submitted in rapid succession (network retry, double-click, bot
replay) each ran the full contact-creation flow and wrote multiple consent log rows for the
same contact.

**Secondary bug (discovered in-batch):** The pre-fix `createContact` call passed the raw
`email` field from `input` rather than `normalizedEmail = email.trim().toLowerCase()`. The
upstream `prisma.contact.findFirst` queried on `normalizedEmail`, so `findFirst` returned
null on a match (different case) and the code took the `createContact` branch, creating a
duplicate contact row under the un-normalized key.

**Fix:**
- `rateLimited('pilotApply', 5, { window: 600, identifier: (ctx) => ctx.req.ip ?? 'anonymous' })`
  added as `.use()` middleware on `applyForPilot`. Five submissions per IP per 10-minute
  sliding window. Uses the three-argument `rateLimited` overload added in the same batch.
- `rateLimited` middleware signature extended in `src/server/trpc/middleware.ts` from
  `(action, maxRequests?)` to `(action, maxRequests?, opts?)` with an optional `opts.window`
  (default 900 s) and `opts.identifier` callback. Backward-compatible -- all 10 pre-existing
  two-argument call sites are unchanged.
- Email idempotency sentinel: `redis.set(dedupKey, '1', { nx: true, ex: 600 })`. Upstash
  returns `'OK'` on first write, `null` on collision. Duplicate submissions within the
  600-second window return `{ success: true }` without entering the contact-creation flow.
  Key: `sheriabot:pilot_apply:dedup:{sha256(normalizedEmail)}`.
- `normalizedEmail = email.trim().toLowerCase()` introduced; used consistently for the
  `contact.findFirst` lookup, `createContact`, `updateContact`, `redis.set` key, and the
  `prisma.contact.update` call.

**Verification:** `scripts/verify-sprint-3-batch-3.ts` (gitignored). Four scenarios:
- S1: 5 calls from same IP succeed; Redis zcard asserted at 5.
- S2: 6th call from same IP returns `TOO_MANY_REQUESTS`; counter asserted at 6
  (zadd runs unconditionally in the pipeline before the allowed check).
- S3: two IPs, same email -- TTL >590 s after first; `recordConsent` called once only.
- S4: `redis.del(dedupKey)` simulates TTL expiry; re-submission accepted and sentinel
  re-acquired (TTL >590 s); `recordConsent` called again.

**Batch 3 conditional review satisfied (2026-05-20) -- APPROVED**

_Pre-approval quality gates:_

**Precondition -- tsc --noEmit (pre-batch):** 0 errors.

**1. Near-miss scan -- 0 findings. Code-location evidence per pattern.**

| Pattern | Findings | Code-location evidence |
|---------|----------|----------------------|
| Redis nx written as `setnx` or wrong option shape | 0 | `publicMarketing.router.ts:191` -- `const acquired = await redis.set(dedupKey, '1', { nx: true, ex: PILOT_APPLY_DEDUP_TTL });` Correct Upstash form. |
| Missing `await` on Redis nx/TTL write | 0 | `publicMarketing.router.ts:191` -- `const acquired = await redis.set(...)`. `await` is present; result captured for null-check at line 192. |
| `email` used where `normalizedEmail` required in contact path | 0 | `publicMarketing.router.ts:181` -- `const normalizedEmail = email.trim().toLowerCase();`. Used at: `:186` (hash input), `:187` (dedupKey via hash), `:202` (`findOrCreateByEmailDomain`), `:209` (`findFirst` where clause), `:229` (`createContact` email field). No bare `email` in the contact path. |
| `opts.identifier` callback typed too broadly / accepting wrong ctx shape | 0 | `middleware.ts:118` -- `opts?: { window?: number; identifier?: (ctx: { req: { ip: string } }) => string }`. Structural type, no `Context` import. Matches Fastify request shape. `publicMarketing.router.ts:167` -- `identifier: (ctx) => ctx.req.ip ?? 'anonymous'` correctly inferred. |
| `as any` casts in new code | 0 | `publicMarketing.router.ts` -- grep for `as any` / `as never` / `!` returns 0 matches in the file. `middleware.ts:115-145` (new three-arg signature and body) -- no casts. |
| Non-ASCII characters introduced by Batch 3 | 0 | New code at `publicMarketing.router.ts:163-263` (applyForPilot) and `middleware.ts:115-145` (rateLimited extension) is clean. Pre-existing em-dashes at `publicMarketing.router.ts:2` (`-- Phase B4`) and `:92` (`-- suppresses`) are from Phase B4 authorship, not Batch 3. Same class as BE-I-024 (deferred to Sprint 4 non-ASCII pass). |
| `(err as Error)` unsafe cast in new catch blocks | 0 | `publicMarketing.router.ts:86-87` (`validateUnsubscribeToken` catch), `:146-147` (`unsubscribe` catch), `:260-261` (`applyForPilot` catch) -- all three delegate to `mapError(err)` (`unknown` typed). `mapError` at `:47-56` uses `instanceof TRPCError` and `instanceof BadRequestError` guards before the fallback. No unsafe cast. |
| `window` option silently defaulting to wrong value on pre-existing call sites | 0 | `middleware.ts:126` -- `const windowSeconds = opts?.window ?? 900;`. Pre-existing 2-arg call sites supply no `opts`, so `windowSeconds` remains 900 (unchanged). `publicMarketing.router.ts:165-168` -- explicit `{ window: 600 }` supplied; no reliance on default. |

**2. Router registration check.**

`publicMarketingRouter` confirmed at:
- `src/server/trpc/router.ts:27` -- import
- `src/server/trpc/router.ts:80` -- registration

**3. `rateLimited(` call-site count -- zero regressions.**

Total call sites: 11 (10 pre-existing two-argument form + 1 new three-argument `pilotApply`
form). All 10 prior call sites confirmed to use the two-argument form with no third argument.
Default `windowSeconds = 900` and default identifier `ctx.user?.id || ctx.req.ip || 'anonymous'`
are preserved for all pre-existing call sites.

**4. Email-normalisation bug blast-radius audit -- 0 duplicate rows.**

Pre-fix behaviour (git HEAD, `publicMarketing.router.ts` before Batch 3):

```typescript
// BEFORE (pre-Batch-3):
const { firstName, lastName, email, companyName, jobTitle, phone } = input;

// findFirst queried on normalised form:
const existing = await prisma.contact.findFirst({
  where: { email: email.trim().toLowerCase(), deletedAt: null },
});
// ...
} else {
  const created = await createContact(
    {
      email,           // <-- raw input.email, NOT normalised
      firstName,
      ...
```

```typescript
// AFTER (Batch 3, publicMarketing.router.ts:181-229):
const normalizedEmail = email.trim().toLowerCase();   // line 181
// ...
const companyId = await findOrCreateByEmailDomain(
  normalizedEmail,   // line 202
  ...
);
const existing = await prisma.contact.findFirst({
  where: { email: normalizedEmail, deletedAt: null },   // line 209
});
// ...
  const created = await createContact(
    { email: normalizedEmail, ... },   // line 229
```

Blast-radius query run against production `Contact` table (2026-05-20):

```sql
SELECT LOWER(TRIM(email)) AS normalised_email,
       COUNT(*)::int      AS cnt,
       array_agg(email ORDER BY email) AS raw_emails,
       array_agg(id ORDER BY email)    AS ids
FROM "Contact"
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;
```

**Result: 0 rows.** The normalisation gap was in shipping code but never produced duplicate
contact rows in the production database. No data hygiene pass required. Bug closed.

**Post-batch -- tsc --noEmit:** 0 errors.

---

### BE-S3-TESTENV-01 -- prisma.policy.count() column-mismatch in test env [OPEN]

| Field | Value |
|-------|-------|
| Severity | Medium (Test Environment Defect) |
| Status | **Open** |
| Discovered | Sprint 3 Batch 5 Verification |

**Issue:** `prisma.policy.count()` throws a column-mismatch error during end-to-end testing of `suspendOrganization`, preventing full automated verification of cache invalidation paths. Suspected stale Prisma client or seed-data issue.

**Deferred action:** Manual verification of `suspendOrganization` end-to-end is required before Batch 7 starts.

### CC-C-039 -- SUSPENDED not a real SubscriptionStatus; suspendOrganization wrote CANCELLED [PARTIALLY RESOLVED -- Sprint 3 Batch 5]

| Field | Value |
|---|---|
| Severity | High |
| CVE class | Semantic / Admin correctness |
| Status | **Partially Resolved** -- Phase 1 complete; Phases 2 and 3 are Batches 6 and 7 |
| Resolved in | Sprint 3 Batch 5 (2026-05-21) |
| Remaining | Batch 6: row backfill. Batch 7: call-site sweep, webhook hardening, billing halt, reactivation. |

**Root cause:** `suspendOrganization` in `src/modules/admin/admin.module.ts` wrote `subscriptionStatus: 'CANCELLED'` instead of `'SUSPENDED'`. `SUSPENDED` did not exist as a Postgres enum value, so no correct write was possible.

**Phase 1 fix (Batch 5 -- 2026-05-21):**
- `ALTER TYPE "SubscriptionStatus" ADD VALUE 'SUSPENDED'` applied to production Supabase DB by operator.
- `prisma/schema.prisma` updated: `SUSPENDED` added to `SubscriptionStatus` enum.
- `pnpm prisma generate` run; Prisma client regenerated.
- `admin.module.ts:suspendOrganization` -- `subscriptionStatus: 'CANCELLED'` changed to `subscriptionStatus: SubscriptionStatus.SUSPENDED`.
- `admin.module.ts:suspendOrganization` -- `await this.invalidatePlanCacheForOrg(orgId, 'admin_suspend_org')` added (was missing; now clears `sheriabot:planctx:{userId}` for all org members on suspension).
- `resolve-effective-plan.ts` -- SUSPENDED branch added as the first guard inside `if (pilotEffectivePlan === null)`. Logs `effective_plan_resolved_suspended` (warn) + `effective_plan_resolved_regulator` (reason: `admin_suspended`). `effectivePlan` remains REGULATOR. FREE_TRIAL is also blocked for SUSPENDED orgs by control-flow position (SUSPENDED is checked before the FREE_TRIAL branch).

**Operator constraint (Batches 5 -- 7 gap):** Do **not** use the admin UI "Suspend organization" button between Batch 5 close and Batch 7 close. The IntaSend `COMPLETE` webhook handler (`src/lib/intasend/webhook.service.ts:244-258`) unconditionally transitions to `ACTIVE` on payment completion; this gate does not check for SUSPENDED until Batch 7. An in-flight payment can silently lift an admin-imposed suspension. If urgent, suspend via direct Supabase SQL (see Sprint 3 Batch 5 brief section 0.3).

**Phase 2 (Batch 6):** Row classification + backfill. Live DB has zero `CANCELLED` rows (confirmed by Phase A audit), so Batch 6 is expected to be a no-op.

**Phase 3 (Batch 7):** Call-site sweep (including churn counter at `admin.module.ts:1257`), IntaSend webhook SUSPENDED guard, Stripe-gated cancellation (`STRIPE_BILLING_ENABLED=false` until Batch 7), reactivation policy (`subscriptionStatus = 'EXPIRED'` to restore previous tier).

**Near-miss findings deferred to Batch 7:**

| ID | Location | Finding |
|----|----------|---------|
| NM-B5-01 | `admin.module.ts:1257` | Churn counter: `SUSPENDED` not counted in `churned` (only CANCELLED \| EXPIRED). Intentional for now -- admin-suspended != churned -- but needs a dedicated `suspended` count field in org analytics. Batch 7 call-site sweep. |
| NM-B5-02 | `pilot-lifecycle-cron.ts:114` | Hardcoded cache key `` `sheriabot:planctx:${user.id}` `` instead of `planCtxCacheKey(user.id)`. Pre-existing; not Batch 5 scope. Batch 7. |
| NM-B5-03 | `billing.router.ts:524` | Same hardcoded key format as NM-B5-02. Batch 7. |
| NM-B5-04 | `admin.module.ts` | `suspendOrganization` missing `invalidatePlanCacheForOrg(orgId, 'admin_suspend_org')` call. Pre-existing; not Batch 5 scope. Deferred to Batch 7. |

---

## Phase B Remediation Sprint -- Batch 1 (2026-05-21)

### SK-3 -- Pino logger missing global PII/secret redaction [RESOLVED -- Phase B Batch 1]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Resolved** |
| Resolved in | Phase B Batch 1 (2026-05-21) |
| Affected | `src/utils/logger.ts` |

**Fix:** Expanded the Pino `redact` configuration to cover auth secrets, tokens,
API keys, emails, phone numbers, IP addresses, request authorization/cookie headers,
and common `user`/`params` envelopes. Censor remains `[REDACTED]`.

### RL-2 -- trustProxy string coercion [RESOLVED -- Phase B Batch 1]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Resolved** |
| Resolved in | Phase B Batch 1 (2026-05-21) |
| Affected | `src/app.ts`, `src/index.ts` |

**Fix:** Added strict trust-proxy parsing so `TRUST_PROXY=false` becomes boolean
`false`, `TRUST_PROXY=true` becomes boolean `true`, numeric hop-count values are
preserved as numbers for proxy deployments, and unset/blank values retain the
existing trusted Render proxy default.

### IV-1 -- Stripe webhook fragile signature error matching [RESOLVED -- Phase B Batch 1]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Resolved** |
| Resolved in | Phase B Batch 1 (2026-05-21) |
| Affected | `src/app.ts` |

**Fix:** Replaced message-string matching with
`err instanceof Stripe.errors.StripeSignatureVerificationError`, preserving the
400 response for signature verification failures and avoiding SDK message drift.

## Phase B Remediation Sprint -- Batch 2 (2026-05-21)

### RL-3 -- Token-redemption endpoints missing rate limits [RESOLVED -- Phase B Batch 2]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Resolved** |
| Resolved in | Phase B Batch 2 (2026-05-21) |
| Affected | `src/server/routers/auth.router.ts` |

**Fix:** Added fail-closed, IP-hash keyed rate limits to `auth.resetPassword`,
`auth.verifyEmail`, `auth.confirmEmailCallback`, and `auth.refreshToken`.
Limits are 5/15 min for reset-password token redemption, 10/15 min for email
verification and callback confirmation, and 20/15 min for refresh-token calls.

### RL-4 -- Unsubscribe token endpoints missing rate limits [RESOLVED -- Phase B Batch 2]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Resolved** |
| Resolved in | Phase B Batch 2 (2026-05-21) |
| Affected | `src/server/routers/publicMarketing.router.ts` |

**Fix:** Added fail-closed, IP-hash keyed 10/15 min rate limits to
`publicMarketing.validateUnsubscribeToken` and `publicMarketing.unsubscribe`.

### RL-1 -- Public content.getBySlug missing rate limit [RESOLVED -- Phase B Batch 2]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Resolved** |
| Resolved in | Phase B Batch 2 (2026-05-21) |
| Affected | `src/server/routers/content.router.ts` |

**Fix:** Added a generous fail-open 60/min rate limit keyed by hashed IP to
`content.getBySlug`, preserving public content availability if Redis is down.

### IV-2 -- IntaSend webhook ingress missing rate limit [RESOLVED -- Phase B Batch 2]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Resolved** |
| Resolved in | Phase B Batch 2 (2026-05-21) |
| Affected | `src/app.ts` |

**Fix:** Added a fail-closed 30/min ingress rate limit keyed by hashed IP after
the existing IntaSend IP allowlist and before challenge/payload processing. The
existing allowlist and invoice re-verification SSRF mitigation were left intact.

## Phase B Remediation Sprint -- Batch 3 (2026-05-21)

### SA-3 -- Logout sequence can leave token usable after partial failure [RESOLVED -- Phase B Batch 3]

| Field | Value |
|-------|-------|
| Severity | High |
| Status | **Resolved** |
| Resolved in | Phase B Batch 3 (2026-05-21) |
| Affected | `src/server/routers/auth.router.ts` |

**Fix:** Reordered logout so the presented JWT ID is blocklisted before any
best-effort cleanup. Supabase signOut, Redis user-cache cleanup, Prisma session
deletion, and idle/fingerprint key cleanup now run in separate non-fatal
try/catch blocks after the blocklist write succeeds.

### SA-2 -- No concurrent-session cap or per-role fingerprint enforcement [RESOLVED -- Phase B Batch 3]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Resolved** |
| Resolved in | Phase B Batch 3 (2026-05-21) |
| Affected | `src/server/trpc/context.ts`, `docs/security/session-policy.md` |

**Fix:** Documented the current session policy and deferred concurrent-session
cap decisions. Added ADMIN-only fingerprint enforcement override so ADMIN
requests are treated as `enforce` even when the global
`SESSION_FINGERPRINT_MODE` is `monitor` or `off`.

## Phase B Remediation Sprint -- Batch 4 (2026-05-21)

### SK-5 -- Legacy AuthModule reads JWT secret in dead token-generation paths [RESOLVED -- Phase B Batch 4]

| Field | Value |
|-------|-------|
| Severity | High |
| Status | **Resolved** |
| Resolved in | Phase B Batch 4 (2026-05-21) |
| Affected | `src/modules/auth/auth.module.ts`, `src/modules/auth/index.ts`, `src/modules/index.ts` |

**Fix:** Verified zero live importers of the legacy `AuthModule` or its JWT
stub helpers from routers, routes, cron paths, or tests. Removed the dead
module and its barrel exports while preserving live `auth.types` and
`auth.utils` exports.

### IV-3 -- Procedures without explicit `.input()` require reclassification [PARTIALLY RESOLVED -- Phase B Batch 4]

| Field | Value |
|-------|-------|
| Severity | Medium |
| Status | **Partially resolved** |
| Resolved in | Phase B Batch 4 (2026-05-21) |
| Affected | `src/server/routers/*.ts` |

**Fix:** Reclassified the first 20 prioritized procedures as Category B
because their bodies do not read `input`. Added explicit `.input(z.void())`
schemas to those no-input procedures. No Category A validation gaps were found
in the 20-procedure Batch 4 cap.

**Remaining:** Continue Appendix B reclassification for the procedures beyond
the 20-procedure cap in a future approved batch.

## Phase B Remediation Sprint -- Batch 5 (2026-05-21)

### SK-1 -- Render environment declaration drift [RESOLVED -- Phase B Batch 5]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Resolved** |
| Resolved in | Phase B Batch 5 (2026-05-21) |
| Affected | `render.yaml` |

**Fix:** Reconciled `render.yaml` with `src/config/env.validator.ts`. Replaced
deprecated `REDIS_URL` with `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`, replaced `JWT_SECRET` with
`SUPABASE_JWT_SECRET`, added Supabase/Direct URL declarations, and removed the
unused HuggingFace deployment variable after confirming no live source-code
references.

### SK-4 -- Environment validation output hardening [RESOLVED -- Phase B Batch 5]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Resolved** |
| Resolved in | Phase B Batch 5 (2026-05-21) |
| Affected | `src/config/app.config.ts`, `src/config/env.validator.ts` |

**Fix:** Hardened boot-time environment validation output so it reports only
invalid variable names and explicitly states that values and parsed defaults are
not logged.

### SK-2 -- Anthropic startup active-ping recommendation [EVALUATED -- recommend declining; see Batch 5 report]

| Field | Value |
|-------|-------|
| Severity | Low |
| Status | **Evaluated - recommend declining** |
| Evaluated in | Phase B Batch 5 (2026-05-21) |
| Affected | Anthropic client startup behavior |

**Decision:** Declined the proposed startup active-ping. A synchronous
boot-time network dependency would prevent the backend from starting during an
Anthropic transient outage, which is a worse failure mode than the current
request-time error handling. Prefer an on-demand `/health/anthropic` endpoint
for operator checks.

---

## CI/CD Sprint -- Batch 0.5 (2026-05-26)

### CI-DEP-001 -- Residual 6 HIGH prod-audit advisories: Prisma dev chain + AWS SDK [DEFERRED -- upstream]

| Field | Value |
|-------|-------|
| Severity | High (6 advisories) |
| Status | **Deferred -- requires upstream releases** |
| Identified | Batch 0.5 dep-triage audit (2026-05-26) |
| Planned for | Re-evaluate on next `@prisma/client` major and `@aws-sdk/client-s3` minor upgrades |

**Context:** After completing Batch 0.5 Sub-Batches 1-5 (remove LangChain, remove unused OTel
SDK, bump fastify, reclassify react-email, xmldom override), `pnpm audit --prod` reports
35 vulnerabilities: 3 low · 26 moderate · **6 high · 0 critical**. The 6 remaining HIGH
advisories cannot be resolved by this repo — they originate in two upstream dep chains.

**Group 1 — Prisma 7 dev chain (5 advisories)**

`@prisma/client@7.x` pulls `prisma` (the CLI) and `@prisma/dev` as runtime dependencies,
which themselves carry `hono`, `@hono/node-server`, `effect`, `lodash` (via
`@mrleebo/prisma-ast`), and `defu` (via `c12`). These are Prisma's internal tooling
packages not used by this application at runtime.

| Advisory | Package | GHSA | Dep path |
|---|---|---|---|
| Arbitrary file access via serveStatic | `hono` <4.12.4 | GHSA-q5qw-h33p-qvwr | `.>@prisma/client>prisma>@prisma/dev>hono` |
| Authorization bypass via encoded slashes | `@hono/node-server` <1.19.10 | GHSA-wc8c-qw6v-h7f6 | `.>@prisma/client>prisma>@prisma/dev>@hono/node-server` |
| AsyncLocalStorage context contamination | `effect` <3.20.0 | GHSA-38f7-945m-qr2g | `.>@prisma/client>prisma>@prisma/config>effect` |
| Code Injection via `_.template` | `lodash` <=4.17.23 | GHSA-r5fr-rjxr-66jc | `.>@prisma/client>prisma>@prisma/dev>@mrleebo/prisma-ast` |
| Prototype pollution via `__proto__` key | `defu` <=6.1.4 | GHSA-737v-mqg7-c878 | `.>@prisma/client>prisma>@prisma/config>c12>defu` |

**Runtime exposure:** None. `prisma`, `@prisma/dev`, `effect`, `hono`, `lodash`, and `defu`
are not imported by any `src/` file and are never loaded in the production Node process.
The advisories affect Prisma's own CLI tooling, not the application runtime.

**Fix required:** A new `@prisma/client` release that updates its internal `@prisma/dev`
and `@prisma/config` sub-trees. No pnpm override is safe — overriding `hono` or `effect`
could break Prisma's internal dependency resolution. Monitor `@prisma/client` release notes.

**Group 2 — AWS SDK transitive (1 advisory)**

| Advisory | Package | GHSA | Dep path |
|---|---|---|---|
| Numeric entity expansion bypass (incomplete CVE-2026-26278 fix) | `fast-xml-parser` >=5.0.0 <5.5.6 | GHSA-8gc5-j5rx-235r | `.>@aws-sdk/client-s3>@aws-sdk/core>@aws-sdk/xml-builder>fast-xml-parser` |

**Runtime exposure:** Bounded. `fast-xml-parser` is used by the AWS SDK's XML builder for
S3 request serialization. An attacker would need to supply a maliciously-crafted XML
document to the S3 request path. SheriaBot's S3 usage (upload/download/presign) does not
parse attacker-controlled XML input — the SDK constructs the XML internally.

**Fix required:** An `@aws-sdk/client-s3` patch that bumps `@aws-sdk/xml-builder` to a
version using `fast-xml-parser >=5.5.6`. No safe pnpm override — the AWS SDK manages its
internal `xml-builder` dep alignment. Monitor `@aws-sdk/client-s3` release notes.

**Action on next Prisma/AWS SDK upgrade:**
1. Run `pnpm audit --prod 2>&1 | tail -3` after upgrading and confirm advisory count drops.
2. Update this entry with the resolving package versions and date.
3. If the Prisma chain advisories persist after the next `@prisma/client` major, evaluate
   a `pnpm overrides` approach with Prisma team guidance.

---

## Known Test Failures (pre-existing, unrelated to security audit)

### Enterprise Policy Generator test/source drift [RESOLVED -- Phase 0]

| Field        | Value |
|--------------|-------|
| Severity     | Low (test-only, not a runtime defect) |
| Status       | **Resolved** -- Phase 0 reconciliation (2026-07-26) |
| Found in     | `src/server/routers/enterprise-policy.router.test.ts`, `src/server/routers/enterprise-policy-frontend-wiring.test.ts` |

**Historical symptom:** 2 of 20 tests failed across these two files. Corrected 2026-07-03
during B9's follow-up check -- **the two failures have two distinct, unrelated
root causes**, not one shared cause as previously described here:

1. `enterprise-policy.router.test.ts` > `'returns a clean BAD_REQUEST for PDF
   export without logging or updating format'`: a genuine string mismatch
   between the test's expected PDF-rejection message and the router's actual
   one. Router (`enterprise-policy.router.ts:738`) currently says
   `'PDF export is not available yet. Please export DOCX.'`; the test asserts
   `'PDF export is not available in this environment. Please export as
   DOCX.'`. Backend-only, single-repo.
2. `enterprise-policy-frontend-wiring.test.ts` > `'detail page presents real
   DOCX export and section editing workflow'`: **not** a message-text issue --
   this test reads live source out of the sibling `fintech-regulatory-platform`
   repo (`frontendRoot = resolve(repoRoot, 'fintech-regulatory-platform')`,
   `enterprise-policy-frontend-wiring.test.ts:5-9`) and asserts the literal
   string `'Export DOCX'` appears on the policy detail page. That frontend's
   export control has since become a dropdown menu (`Export as DOCX` /
   `Export as PDF` menu items under a single `Export`/`Exporting...` button --
   confirmed directly in
   `fintech-regulatory-platform/app/(dashboard)/regulator/policy-generator/[id]/page.tsx`
   lines ~286-297), so the literal substring this test looks for no longer
   exists anywhere in that file. This is cross-repo drift: the frontend
   changed independently of any backend batch, and this backend test's
   assertion was never updated to match.

Neither failure is related to any B-batch agent work; verified independently
by running the suite in isolation before and after Batch B5's changes (2f/18p)
and again on B9's committed HEAD (2f/644p full suite, `git stash` confirmed
identical failures reproduce with zero B9 changes applied).

**Resolution:** Phase 0 updated the router test's PDF rejection expectation to
the current backend message and updated the cross-repo frontend assertion to
match the current dropdown export UI (`Export as DOCX` / `Export as PDF`).
The full backend suite now passes.

---

### Working tree actively modified during B6 pre-flight verification [RESOLVED]

| Field        | Value |
|--------------|-------|
| Severity     | Process, not code |
| Status       | **Resolved** -- 2026-07-03 |
| Observed during | Phase B Batch B6 pre-flight commit/verification pass |

**Symptom:** During B6 pre-flight verification (post-commit gate for B4/B5/the
multi-principal credential refactor), `git status --porcelain` showed new
untracked files appearing in `src/modules/agents/automation/` and
`src/lib/redis/` between consecutive checks, including some (`wire-format.test.ts`,
`import-probe.test.ts`) that were not present moments earlier. A first pass of
`tsc`/Vitest results was discarded because the tree changed mid-run; a
`rate-limiter.automation.test.ts` full-suite-only failure was observed once and
initially suspected to be a shared/module-level state leak in the rate limiter
across test files.

**Root cause:** identified via OS-level process inspection (`Get-CimInstance
Win32_Process`) -- three `claude.exe` processes were running against the same
Antigravity IDE instance, not one. Two were full interactive Claude Code
sessions (both children of the same IDE process), confirming a second,
independent Claude Code session was open on this same repository and actively
scaffolding files in the automation module concurrently with this session's
work. Not a background task belonging to this session (verified via `TaskOutput`
against every known task ID -- all already completed/cleaned up), not a cron
job (`CronList` empty), not an unrelated OS-level watcher.

**Resolution:** the second session was identified and closed by the operator.
Two subsequent `git status --porcelain` checks 65 seconds apart returned
identical output, confirming the tree had genuinely stopped changing. A clean
single-pass `tsc --noEmit` (0 errors) and full Vitest run (2 failed / 562
passed -- exactly the pre-existing enterprise-policy baseline above, nothing
else) followed. `rate-limiter.automation.test.ts` passed both in the full
suite and in isolation on the settled tree (3/3 both ways) -- the earlier
full-suite-only failure did not reproduce, so it is attributed to reading/
executing the file while the second session was still writing it, not a real
test-isolation bug in the rate limiter. No code fix required.

**Process note:** when multiple Claude Code sessions may be open against the
same working directory, a single `git status` check is not sufficient proof of
a stable tree -- confirm with at least two checks 60+ seconds apart before
trusting any `tsc`/test run as a final verification result.

---

## Next Sprint Priorities (in order)

1. **Automated test coverage** -- Vitest setup, integration tests for
   `requireOrgMembership`, regression tests for A1/A2, smoke tests for A6
   ranks 1-10. Prerequisite for ODPC submission and pilot expansion.
2. **RLS follow-up sprint** -- proper Supabase Auth + Prisma service-role
   architecture design.
3. **`organization.router.ts` cleanup** -- 10 remaining procedures still on
   `protectedProcedure` that should be migrated to `orgMemberProcedure`. The
   `updateMemberRole` cache-invalidation bug (BE-O-015) is now fixed.
4. **`AuditLogV2` hash-chain delivery** -- folded back into DPA 2019 sprint
   resumption.
5. **Checklist null-org migration** -- run the three-step plan from the runbook
   after test coverage sprint lands.

See `docs/runbooks/idor-incident-response.md` for the full standing follow-up
list and the Checklist migration sequence.

---

## W-CONTENT-02 Backend Gaps -- Phase B Batch 1 (Gap 2: BlogPost draft creation exposed to agentProcedure)

### Gap 2 -- no agent-callable path created a BlogPost draft row [RESOLVED -- Batch 1]

| Field | Value |
|-------|-------|
| Severity | Blocker (W-CONTENT-02 could not create a real `blogPostId`) |
| Status | **Resolved** |
| Resolved in | Phase B Batch 1 (2026-07-24) |

**Root cause:** `automationContentService.publishContent` requires `approval.metadata.blogPostId`
(`content.service.ts:101`), but no `agentProcedure`-gated route ever created a `BlogPost` row.
The only existing path, `adminCreateDraftFromSuggestion`, is `adminProcedure`-gated (human
dashboard session only).

**Fix:**
- Extracted `adminCreateDraftFromSuggestion`'s transactional block (slug generation,
  `buildDraftSkeletonFromSuggestion`, `BlogPost` + `BlogPostSource` creation, suggestion
  status update) verbatim into `src/modules/blog-automation/draft-creation.service.ts`
  (`createBlogDraftFromSuggestion`). `adminCreateDraftFromSuggestion` now delegates to it;
  behavior and return shape (`{blogPostId, slug}`) unchanged.
- New service `src/modules/agents/automation/blog-draft.service.ts`
  (`AutomationBlogDraftService.createDraftFromCandidate`) bridges a candidate's
  `sourceItemId` (the same field `queueContentCandidate` already receives, correctly in the
  `BlogSourceItem` id space -- see design note below) through the existing, unmodified
  `createSuggestionFromSourceItem` (suggestion-builder.ts) and the newly-shared
  `createBlogDraftFromSuggestion`. No new scoring, templating, or draft-generation logic.
- New procedure `agents.automation.content.createDraft` (`agents.router.ts`), capability
  `agents.automation.content.createDraft`, added to both `AGENT_CAPABILITIES` and
  `AUTOMATION_CAPABILITIES` (`agent-credential.service.ts`) so only
  `sys-automation-orchestrator` holds it. Rate-limited on the existing shared
  `appConfig.agents.automation.workflow*` bucket (same as `publishContent`/
  `queueContentCandidate`). No idempotency-key field: `sourceItemId` is already a natural
  idempotency key, enforced by `createSuggestionFromSourceItem`'s own existing-link/status
  checks and `createBlogDraftFromSuggestion`'s `blogPostId` conflict check.
- `authorId`/`updatedById`/`approvedById` for automation-originated rows are attributed to
  the real `User` row `agentCredentialService.ensureServiceUser` maintains for
  `sys-automation-orchestrator` (`ctx.agent.userId` inside the new procedure) -- not a null
  or fabricated value.

**Design decision -- automation-originated suggestions skip `PENDING_REVIEW`:**
`createSuggestionFromSourceItem` normally lands new suggestions at `PENDING_REVIEW`,
requiring a human to call `adminApproveSuggestionForDraft` in the dashboard before a draft
can be created. `AutomationBlogDraftService.createDraftFromCandidate` instead promotes the
suggestion straight to `APPROVED_FOR_DRAFT` in the same call. Reasoning: nothing in the
n8n-driven W-CONTENT-01->02 handoff is positioned to notice a suggestion sitting in
`PENDING_REVIEW` and either prompt a human or resume the pipeline -- requiring a dashboard
visit between candidate-queue and draft-generation would silently stall every
automation-originated candidate. The meaningful human checkpoint for this pipeline is the
later `AutomationApproval` gate (`createApproval`/`recordApprovalDecision`, HMAC-signed
reviewer email) reviewing the actual generated draft content -- a strictly more informative
review point than approving a bare pre-draft suggestion idea. The suggestion remains fully
visible via `adminListSuggestions`/`adminGetSuggestion` for audit purposes.
`BlogArticleSuggestion.requiresHumanReview` defaults `true` but is confirmed (full-tree
grep) not read/enforced anywhere in this codebase today, so this does not bypass an active
control -- flagged here since a future reader may reasonably expect it to.

**Deferred to Batch 3, with reasoning:** wiring a rejected `AutomationApproval` decision back
to soft-deleting the associated suggestion/draft (the same state `adminDismissSuggestion`
produces) was considered in scope for Batch 1 but deferred. No caller creates an
`AutomationApproval` referencing a blog draft yet -- that linkage (`metadata.blogPostId`
population, and `getApproval` reading it back) is exactly what Batch 3 defines. Building the
reject-cleanup hook now would mean guessing at a `metadata` shape Batch 3 hasn't finalized
yet. Orphaned `DRAFT`-status `BlogPost`/`APPROVED_FOR_DRAFT`-status suggestion rows from
rejected candidates are the known, accepted gap until Batch 3 lands.

**Known upstream gap, not fixed by this batch:** `W-CONTENT-01`'s
`getRecentHighImpactRegulatoryItems` reads `RegulatorySignal` rows (a different discovery
pipeline, the `regIntel` agent) and returns `RegulatorySignal.id` values, while this new
procedure's `sourceItemId` -- like `queueContentCandidate`'s -- expects a `BlogSourceItem.id`
(the `blog-automation` source-monitor pipeline, `BlogSourceMonitor`/`BlogSourceItem`,
scored via `createSuggestionFromSourceItem`). These are two independent "find regulatory
content" systems that were never unified. The n8n workflow JSON follow-up pass (tracked
separately, not part of this batch) needs to source candidates from `BlogSourceItem` (e.g.
via `agents.automation.sources.*`) rather than `getRecentHighImpactRegulatoryItems` for this
new procedure to receive a valid `sourceItemId`.

**Files changed:**
- `src/modules/blog-automation/draft-creation.service.ts` (new)
- `src/server/routers/blog-automation.router.ts` (refactor only, behavior unchanged)
- `src/modules/agents/automation/blog-draft.service.ts` (new)
- `src/modules/agents/automation/blog-draft.service.test.ts` (new)
- `src/modules/agents/agent-credential.service.ts` (new capability string, two arrays)
- `src/modules/agents/agent-credential.service.test.ts` (updated hardcoded capability-list
  assertion to include the new capability)
- `src/server/routers/agents.router.ts` (new procedure)

**Verification:** `tsc --noEmit` clean (zero errors). Non-ASCII scan (Node codepoint scan)
clean on all newly added lines across all 7 changed/new files. Targeted suite (new service
test, automation router-wiring, agent-credential service, wire-format): 4 files, 27/27
passed. Full `vitest run`: 113 files, 4 failed / 779 passed. The 4 failures
(`enterprise-policy.router.test.ts`, `enterprise-policy-frontend-wiring.test.ts`,
`pilot-access.test.ts`, `blog-digest-notification.test.ts`) are pre-existing and unrelated
to this batch -- confirmed by `git stash` and re-running all four against the clean tree
(same 4 failures reproduce with zero Batch 1 changes applied); the first two match the
already-documented pre-existing failures noted elsewhere in this file.

**Status:** Batch 1 (Gap 2) resolved. Batch 2 (Gap 1) resolved -- see below. Batch 3 (Gap 3:
`getApproval` content read-back + `publishContent` stale-overwrite fix) not started --
awaiting approval per sprint discipline.

---

### Gap 1 -- no agent-callable path generated blog draft content [RESOLVED -- Batch 2]

| Field | Value |
|-------|-------|
| Severity | Blocker (W-CONTENT-02 could not fill a draft's content) |
| Status | **Resolved** |
| Resolved in | Phase B Batch 2 (2026-07-24) |

**Root cause:** `automation.service.ts`'s `generate()` has no server-side templating and
persists nothing beyond an `AgentRun` bookkeeping row -- it cannot fill a `BlogPost`'s
content. The real blog-draft templating logic, `generateAiDraftForBlogPost`
(`ai-draft-generation.service.ts`), already exists and is fully built, but was only reachable
via `adminGenerateAiDraft` (`adminProcedure`-gated).

**Fix:**
- New procedure `agents.automation.content.generateDraft` (`agents.router.ts`), capability
  `agents.automation.content.generateDraft`, added to both `AGENT_CAPABILITIES` and
  `AUTOMATION_CAPABILITIES`. Delegates directly to `generateAiDraftForBlogPost` via a new
  method, `AutomationBlogDraftService.generateDraftContent`
  (`src/modules/agents/automation/blog-draft.service.ts`) -- no new templating/prompt logic.
- **Idempotency (a genuine addition, not decorative):** unlike Batch 1's
  `createDraftFromCandidate`, `generateAiDraftForBlogPost` has no idempotency guard of its
  own -- a retry would trigger a second real LLM call and silently re-overwrite the post's
  content. Wrapped with the same `agentRunService.beginRun`/`completeRun`/`failRun` primitive
  `automation.service.ts`'s own `generate()` already uses, with a required client-supplied
  `idempotencyKey` body field (matching the module's established idempotency mechanism, not
  an HTTP header). Duplicate calls with the same key replay the stashed result from
  `AgentRun.metadata` rather than regenerating.
- Cost/budget enforcement confirmed already shared, not duplicated: `checkCostLimit` lives
  inside `LLMGateway.complete()`/`stream()` (`llm-gateway.ts`), and `generateAiDraftForBlogPost`
  reaches that same gateway via `ai/client.ts`'s `complete()` wrapper -- no separate guard was
  needed.

**Small, backward-compatible modification to the delegated function (flagged, not silent):**
`generateAiDraftForBlogPost`'s `adminUserId` parameter drives both FK attribution
(`BlogDraftGenerationRun.requestedById`, `BlogPost.updatedById`) and the "draft ready for
verification" notification target (`blogNotificationService.notifyDraftReadyForVerification`).
For an automation call, `adminUserId` is the `sys-automation-orchestrator` service principal --
notifying it directly would reach no human, silently leaving AI-generated draft content
unmonitored. Added an optional third parameter, `notifyUserId`, defaulting to `adminUserId`
when omitted (byte-identical behavior for the existing `adminGenerateAiDraft` caller, which
never passes it). The new automation path resolves `notifyUserId` by looking up the
`BlogArticleSuggestion` linked to the `blogPostId` (via its unique `blogPostId` FK) and falling
back to `sources[0].sourceItem.monitor.createdById` -- the same fallback target Batch 1 uses
for its analogous HIGH/URGENT suggestion notification.

**Files changed:**
- `src/modules/blog-automation/ai-draft-generation.service.ts` (additive optional parameter;
  existing caller's behavior unchanged)
- `src/modules/agents/automation/blog-draft.service.ts` (new method + supporting types)
- `src/modules/agents/automation/blog-draft.service.test.ts` (9 new tests: disabled/halted
  rejection, notify-target resolution with and without a linked suggestion, successful
  completion + metadata stash, failure path, duplicate replay, duplicate non-completed
  conflict, duplicate corrupt-metadata failure)
- `src/modules/agents/agent-credential.service.ts` (new capability string, two arrays)
- `src/modules/agents/agent-credential.service.test.ts` (updated hardcoded capability-list
  assertion)
- `src/server/routers/agents.router.ts` (new procedure)

**Verification:** `tsc --noEmit` clean (zero errors). Non-ASCII scan (Node codepoint scan)
clean on all newly added lines across all 9 changed/new files (Batch 1 + Batch 2 combined).
Targeted suite (blog-draft service test, automation router-wiring, agent-credential service,
wire-format): 4 files, 36/36 passed. Full `vitest run`: 113 files, 4 failed / 788 passed. Same
4 pre-existing failures as Batch 1 (`enterprise-policy.router.test.ts`,
`enterprise-policy-frontend-wiring.test.ts`, `pilot-access.test.ts`,
`blog-digest-notification.test.ts`), already confirmed unrelated via `git stash` in Batch 1 --
not re-run against a stashed tree a second time since the file set and failure signatures are
identical.

**Status:** Batch 2 (Gap 1) resolved. Batch 3 (Gap 3: `getApproval` content read-back +
`publishContent` stale-overwrite fix) not started -- awaiting approval per sprint discipline.

---

### Notification-routing correction -- fixed ops inbox, not per-monitor derivation [RESOLVED -- post-Batch-2 correction, 2026-07-24]

| Field | Value |
|-------|-------|
| Severity | Reliability (silent notification loss on account deactivation/reassignment) |
| Status | **Resolved** |
| Raised by | Operator review of Batch 2's notify-target design |

**Root cause of the design flaw:** Batch 1's suggestion HIGH/URGENT notification and Batch
2's `resolveNotifyUserId` both derived the notification recipient from
`sourceItem.monitor.createdById` -- correct only as long as that specific user account stays
active and that specific monitor's ownership never changes. Operator feedback: decouple
notification *delivery target* from row *attribution* -- keep `createdById`/`approvedById` in
the DB for audit, but route the actual alert to a fixed, always-live address.

**Fix:**
- New shared service `src/modules/agents/automation/content-ops-alert.service.ts`
  (`ContentOpsAlertService.sendAlert`) -- direct email via `sendEmail()` to
  `appConfig.marketing.adminNotificationEmail`, the same fixed-recipient config and shape
  already established by `security-ops/ops-alert.service.ts`'s `SecurityOpsAlertService`
  (one inbox, not per-entity-derived). Best-effort, never throws.
- Batch 1 (`createDraftFromCandidate`): sends a `ContentOpsAlertService` alert directly for
  HIGH/URGENT-priority auto-approved suggestions, independent of
  `createSuggestionFromSourceItem`'s own internal in-app notification (left unmodified --
  that side effect still fires to `sourceItem.monitor.createdById` and is harmless, just no
  longer the reliable channel).
- Batch 2 (`generateDraftContent`): removed `resolveNotifyUserId` and its monitor-lookup
  entirely. No longer passes a `notifyUserId` to `generateAiDraftForBlogPost` (defaults to
  `adminUserId`, i.e. the service principal -- an inert in-app notification nobody reads, left
  as-is rather than removed, since the third parameter itself remains a harmless, generically
  useful addition for any future caller). Sends a `ContentOpsAlertService` alert after a
  successful generation instead, including uncertainty flags when present. Not sent on
  duplicate-replay (avoids re-alerting on retries) or on failure.
- Both alert emails link to `/admin/content/blog/{id}` via `appConfig.appUrl`, matching the
  existing in-app notifications' link target.

**Files changed:**
- `src/modules/agents/automation/content-ops-alert.service.ts` (new)
- `src/modules/agents/automation/content-ops-alert.service.test.ts` (new, 4 tests)
- `src/modules/agents/automation/blog-draft.service.ts` (both methods updated; `prisma`
  dependency's `blogArticleSuggestion.findUnique` no longer needed for this purpose)
- `src/modules/agents/automation/blog-draft.service.test.ts` (updated: removed 2 obsolete
  notifyUserId-resolution tests, added 5 new tests covering alert-send/no-send conditions)

**Verification:** `tsc --noEmit` clean. Non-ASCII scan clean across all 11 changed/new files
(cumulative Batch 1 + Batch 2 + this correction). Targeted suite (blog-draft service,
content-ops-alert service, automation router-wiring, agent-credential service, wire-format):
5 files, 46/46 passed. Full `vitest run`: 114 files, 4 failed / 798 passed. Same 4
pre-existing failures as Batch 1/2, unchanged.

**Status:** Resolved. Batch 3 resolved -- see below.

---

### Gap 3 -- no cross-execution state handoff; publishContent stale-overwrite risk [RESOLVED -- Batch 3]

| Field | Value |
|-------|-------|
| Severity | Blocker (W-CONTENT-02 decision-webhook execution had no way to see draft content) + Data-integrity risk (caller-supplied `content` could silently discard a human edit) |
| Status | **Resolved** |
| Resolved in | Phase B Batch 3 (2026-07-24) |

**Root cause:** `getApproval` returned only `{status}` -- the approval-decision webhook fires
as a separate n8n execution from the one that generated the draft, with no way to retrieve
the drafted content. Separately, `publishContent` trusted a caller-supplied `content: string`
and wrote it verbatim, which could overwrite a human's in-dashboard edit made between
draft-generation and the approval decision.

**Fix (per the earlier design audit's own recommendation, option (a) over (b)/(c)):**
- `createApproval`'s input handling needed **no change** -- `metadata: Json?` on
  `AutomationApproval` already accepts an arbitrary `blogPostId` field; confirmed, not
  extended.
- `AutomationApprovalService.getApproval` (`approval.service.ts`) now does an
  application-level join: reads `metadata.blogPostId` (via a new non-throwing
  `extractOptionalBlogPostId` helper, mirroring the existing `getApprovalPublicView` metadata-
  extraction pattern) and, when present and still resolvable, fetches the live `BlogPost`
  (`id`, `title`, `excerpt`, `content`, `status`) and includes it as an optional `blogPost`
  field on the response. Not a Prisma relation/FK (`metadata` is unstructured Json, no schema
  change) -- two sequential queries, not a single relational query. Omitted entirely for
  non-blog approvals (marketing/sales/outreach) or a `blogPostId` that no longer resolves.
- `publishContent`'s input schema changed from `{approvalId, content}` to `{approvalId}` only
  (`agents.router.ts`, `content.service.ts`). It no longer writes `content` at all on publish
  -- the live `BlogPost.content` column is already correct, so publishing is purely a
  `status`/`publishedAt`/`lastReviewedAt` flip. Closes the exact stale-overwrite risk flagged
  in the design audit.
- No new schema, confirmed: `git diff --stat prisma/schema.prisma` empty.

**Files changed:**
- `src/modules/agents/automation/approval.service.ts` (`ApprovalPrisma` type extended to
  include `blogPost`; new `ApprovalBlogPostSummary` type; new `extractOptionalBlogPostId`
  helper; `getApproval` extended)
- `src/modules/agents/automation/approval.service.test.ts` (fake prisma extended with an
  in-memory `blogPost` fake; 3 new tests: join present, join omitted for non-blog approvals,
  join omitted for an unresolvable `blogPostId`)
- `src/modules/agents/automation/content.service.ts` (`PublishContentInput` drops `content`;
  `publishContent` no longer writes it; doc comment updated)
- `src/modules/agents/automation/content.service.test.ts` (all `publishContent` calls and
  assertions updated to the new contract)
- `src/server/routers/agents.router.ts` (`publishContent` input schema drops `content`)
- `KNOWN_ISSUES.md` (this entry)

**Phase 0 follow-up completed 2026-07-26:** the pre-built
`fintech-regulatory-platform/api-types` package has been regenerated from the
backend declarations and the root `smoke_test_trpc.mjs` probe now uses the
current `publishContent` payload shape.

**Verification:** `tsc --noEmit` clean (zero errors). Non-ASCII scan clean on all newly added
lines across all 15 changed/new files (cumulative Batches 1-3 + the notification correction).
Targeted suite (approval service, content service, blog-draft service, content-ops-alert
service, automation router-wiring, agent-credential service, wire-format): 7 files, 83/83
passed. Full `vitest run`: 114 files, 4 failed / 801 passed. Same 4 pre-existing failures as
every prior batch in this series, unchanged.

**Status:** Batch 3 (Gap 3) resolved. All three backend gaps blocking W-CONTENT-02
(draft -> approval -> publish) are now closed. Phase 0 confirmed Gap 4 is no longer a
`NOT_IMPLEMENTED` backend gap: `sendNewsletter` now sends through the existing
templated `MarketingCampaign` pipeline after approval, Redis locking, and sent-marker
checks. Remaining newsletter readiness depends on deployment of the reviewed raw SQL
migrations and real contact/list data. The n8n workflow JSON correction pass (to call the
new `createDraftFromCandidate`/`generateDraftContent` procedures and the
`blogPostId`-based flow instead of what the JSON currently assumes) remains a separate
follow-up, not part of this backend series.
