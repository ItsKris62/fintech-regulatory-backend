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

## Batch Roadmap

| Batch | Focus | Status |
|-------|-------|--------|
| Batch 1 | IDOR closure (A1, A2), org oracle (B1), member source-of-truth (B2), stale file | **COMPLETE** |
| Batch 2 | Migrate remaining Class B procedures; remove `isOrganizationMember` | **COMPLETE** |
| Batch 2.5 | payment.router.ts scope clarification + orgMemberProcedure migration | **COMPLETE** |
| Batch 3 | Audit logging (AuditLog writes, 100% denials / 10% grant sample); trust page; incident runbook | **COMPLETE** |

---

## Next Sprint Priorities (in order)

1. **Automated test coverage** — Vitest setup, integration tests for
   `requireOrgMembership`, regression tests for A1/A2, smoke tests for A6
   ranks 1–10. Prerequisite for ODPC submission and pilot expansion.
2. **RLS follow-up sprint** — proper Supabase Auth + Prisma service-role
   architecture design.
3. **`organization.router.ts` cleanup** — 10 procedures + `updateMemberRole`
   pattern fix.
4. **`AuditLogV2` hash-chain delivery** — folded back into DPA 2019 sprint
   resumption.
5. **Checklist null-org migration** — run the three-step plan from the runbook
   after test coverage sprint lands.

See `docs/runbooks/idor-incident-response.md` for the full standing follow-up
list and the Checklist migration sequence.
