# IDOR Audit Findings
## SheriaBot Fintech Regulatory Platform — Phase A Security Audit
**Date:** 2026-05-12  
**Auditor:** Claude Sonnet 4.6 (read-only engagement)  
**Status:** Phase A Complete — Awaiting Operator Approval Before Phase B

---

## Executive Summary

Two confirmed IDOR vulnerabilities exist in the current codebase. Both accept `organizationId` directly from client-supplied request input without verifying that the authenticated user is a member of that organization. The more severe of the two (`gapAnalysis.runGapAnalysis`) is the reported issue; the second (`checklist.generateChecklist`) is an identical pattern on an adjacent procedure that was overlooked.

Beyond the two confirmed IDORs, a broader class of authorization gap affects approximately 38 registered procedures: they use `ctx.user.organizationId` from the session (which is correct) but never verify that the user holds an **active** `OrganizationMember` row for that organization. This means suspended, removed, or invited-but-not-yet-joined members can still invoke org-scoped operations. This is a distinct (less severe) vulnerability class from the two confirmed IDORs.

A third structural issue surfaced during the audit: there are **two `appRouter` definitions** in the codebase. The stale one at `src/server/routers/router.ts` registers 13 sub-routers. The production one at `src/server/trpc/router.ts` registers 27 sub-routers. All findings in this report reference the production router. This dual-definition is itself a risk — any tooling or test that imports from the wrong path silently misses 14 routers.

---

## A1. tRPC Procedure Inventory

The production `appRouter` is defined at `src/server/trpc/router.ts`. It registers **27 sub-routers** covering approximately **120 procedures**. The table below focuses on procedures that accept an organizationId (or equivalent org identifier) and documents whether a membership check exists.

**Legend:**  
- `org-id-in-input` = client can supply an org identifier in the request body  
- `ctx-scoped` = org identifier read from `ctx.user.organizationId` (session, not client-supplied)  
- `resource-check` = access gate checks `resource.organizationId === ctx.user.organizationId`  
- `requireOrgMember` = middleware queries OrganizationMember table, verifies ACTIVE status  
- `IDOR` = no org authorization check at all (critical)  
- `no-status-check` = org is constrained to session org but OrganizationMember.status not verified  

### Critical / High — Procedures with no effective org membership check

| Router | Procedure | Type | Org ID Source | Membership Check | Classification |
|--------|-----------|------|---------------|-----------------|----------------|
| `gapAnalysis` | `runGapAnalysis` | mutation | `input.organizationId` (optional, client-supplied) | NONE | **IDOR (WRITE)** |
| `checklist` | `generateChecklist` | mutation | `input.organizationId` (optional, client-supplied) | NONE | **IDOR (WRITE)** |

**Detail — `gapAnalysis.runGapAnalysis`** (`src/server/routers/gap-analysis.router.ts`, line 62):  
Input Zod schema at line 75: `organizationId: z.string().optional()`. Line 136 resolves the effective orgId: `const orgId = input.organizationId ?? ctx.user!.organizationId ?? ctx.user!.id`. This orgId flows into (a) the dedup Redis cache key `sheriabot:gapanalysis:dedup:{orgId}:{fileHash}`, (b) `complianceModule.runGapAnalysis(userId, { organizationId: input.organizationId ?? ... })`. No membership lookup occurs at any point before this value is used as a tenant identifier.

**Detail — `checklist.generateChecklist`** (`src/server/routers/checklist.router.ts`, line 25):  
Input schema at line 37: `organizationId: z.string().optional()`. Line 63: `organizationId: input.organizationId ?? ctx.user!.organizationId ?? undefined`. The Checklist record is persisted under whichever org ID the client supplied.

### Medium — Procedures that accept org ID from input but guard with equality check (no membership status check)

| Router | Procedure | Type | Org ID Source | Check Applied | Gap |
|--------|-----------|------|---------------|---------------|-----|
| `analytics` | `getOrgDashboard` | query | `input.orgId` (optional) | `orgId !== ctx.user.organizationId` equality | No MemberStatus check |
| `analytics` | `getComplianceTrends` | query | `input.orgId` (optional) | `orgId !== ctx.user.organizationId` equality | No MemberStatus check |
| `analytics` | `generateReport` | mutation | `input.orgId` (optional) | `orgId !== ctx.user.organizationId` equality | No MemberStatus check |
| `analytics` | `exportData` | mutation | `input.orgId` (optional) | `orgId !== ctx.user.organizationId` equality | No MemberStatus check |

These procedures guard against cross-tenant access (an attacker cannot supply an arbitrary orgId), but they allow suspended or removed members whose `User.organizationId` still points at the org to access analytics data.

### Lower Risk — Procedures that use ctx.user.organizationId but don't check OrganizationMember.status

The following categories of procedures use `ctx.user.organizationId` (not client-supplied) and apply resource-level checks, but never query `OrganizationMember` to verify the user's current membership status:

**`vault` router (12 procedures):** `getUploadLimits`, `getUploadUrl`, `confirmUpload`, `list`, `getById`, `getDownloadUrl`, `update`, `updateStatus`, `delete`, `getStats`, `getReplaceUrl`, `confirmReplace`. All read `ctx.user.organizationId`. All pass it directly to `vaultModule` without membership status check.

**`compliance` router (12+ procedures):** `query`, `followUp`, `search`, `history`, `get`, `getScore`, `getScoreHistory`, `getRecommendations`, `getRequirements`, `updateRequirement`, `getDeadlines`, `getRoadmap`, `submitFeedback`, `getFeedbackStatus`, `toggleSave`, `getSavedStatus`, `listSavedResponses`, `logExport`, `exportDocx`, `exportChecklistDocx`. Most are user-scoped by userId but `getScore`, `getScoreHistory`, `getRecommendations`, `getRequirements`, `updateRequirement`, `getDeadlines`, `getRoadmap`, `exportDocx` all use `ctx.user.organizationId` without membership status check.

**`policy` router (9 procedures):** `list`, `get`, `generate`, `update`, `delete`, `export`, `refine`, `verifyCitations`, `getStatus`, `getVersionHistory`. All use resource-check pattern (`policy.organizationId === ctx.user.organizationId`) — no `OrganizationMember.status` check.

**`document` router (8 procedures):** `getUploadUrl`, `confirmUpload`, `list`, `get`, `getDownloadUrl`, `delete`, `restore`, `getProcessingStatus`, `reingest` (admin only). Use `ctx.user.organizationId` or userId-equality; no membership status check.

**`billing` router (7 procedures):** `getPlanAndUsage`, `createCheckoutSession`, `createPortalSession`, `requestEnterprise`, `updatePaymentMethod`, `initiateMpesaPayment`, `getMpesaPaymentStatus`. Use `ctx.user.organizationId` directly; no membership status check. Billing operations by a suspended member are particularly sensitive.

**`enterprisePolicy` router:** `createDraft` and downstream procedures — use `ctx.user.organizationId`; no membership status check.

**`checklist` router (additional procedures beyond `generateChecklist`):** `generateChecklistAsync`, `getChecklistStatus`, `listChecklists`, `getChecklistDetail`, `updateChecklistItem`, `getChecklistUsage`, `retryChecklist`. These use `ctx.user.organizationId` from context (not client input), no membership status check.

**`gapAnalysis` router (additional procedures):** `getFrameworks`, `getGapAnalyses`, `getGapAnalysisResult`, `getGapAnalysisLimits`, `deleteGapAnalysis`. Use `ctx.user.id` or resource ownership check; no cross-tenant risk for these.

### Correctly Protected

| Router | Procedure | Type | Check Applied |
|--------|-----------|------|---------------|
| `complianceDashboard` | `getComplianceDashboard` | query | `requireOrgMember` (queries OrganizationMember, verifies ACTIVE) |
| `complianceDashboard` | `updateDashboardItem` | mutation | `requireOrgMember` + `requireMemberRole([MEMBER, ADMIN, OWNER])` |
| `complianceDashboard` | `getChecklistByCategory` | query | `requireOrgMember` |

### Legitimately Not Org-Scoped (no membership check needed)

| Router | Reason |
|--------|--------|
| `auth.*` | Public auth operations — no org context relevant |
| `user.*` | User-scoped only (profile, sessions, 2FA) |
| `admin.*` | `adminProcedure` — platform-wide admin operations |
| `adminMarketing.*`, `adminSupport.*`, `pilot.*` | Admin-only by procedure type |
| `publicMarketing.*`, `content.*` | Public/read-only content |
| `notification.*` | User-scoped |
| `trial.*` | User-scoped |
| `session.*` | User-scoped |
| `support.*` | User-scoped |
| `payment.*` | Webhook handlers — server-to-server, verified by provider signature |

---

## A2. Membership Check Pattern Analysis

### Pattern 1: `requireOrgMember` middleware (Gold Standard — used in 1 router only)

Location: `src/server/trpc/middleware.ts`, line 185.

```typescript
export const requireOrgMember = middleware(async ({ ctx, next }) => {
  const userId = ctx.user!.id;
  const orgId = ctx.user!.organizationId;  // READS FROM SESSION, not from input
  // ...
  const member = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } }
  });
  if (!member) { throw FORBIDDEN; }
  if (member.status !== MemberStatus.ACTIVE) { throw FORBIDDEN; }
  return next({ ctx: { ...ctx, orgMember: member } });
});
```

**Critical structural limitation:** This middleware reads `orgId` from `ctx.user.organizationId` (the session org), NOT from procedure input. It **cannot** catch the confirmed IDORs in `runGapAnalysis` and `generateChecklist`, because those procedures pass a client-supplied `organizationId` to service layer code rather than relying on the session org. Simply applying `requireOrgMember` to those procedures would verify the user is a member of their own org while still allowing the client-supplied orgId to flow through to the database writes.

This is the root reason Phase B requires a new `requireOrgMembership` middleware that reads `organizationId` from validated Zod input rather than from `ctx.user`.

### Pattern 2: `isOrganizationMember` middleware (Insufficient — not a real membership check)

Location: `src/server/trpc/middleware.ts`, line 146.

```typescript
export const isOrganizationMember = middleware(async ({ ctx, input, next }) => {
  const organizationId = (input as any).organizationId;
  if (ctx.user.organizationId !== organizationId && ctx.user.role !== 'ADMIN') {
    throw FORBIDDEN;
  }
  return next({ ctx });
});
```

This middleware only compares `ctx.user.organizationId` (session) to `input.organizationId` — it never queries the `OrganizationMember` table. It blocks cross-tenant orgId injection but does not verify that the user has an **active** membership row. It is currently not applied to any org-scoped procedures.

### Pattern 3: Resource-equality check (Ad-hoc — used in policy router)

```typescript
const hasAccess = policy.organizationId
  ? policy.organizationId === ctx.user!.organizationId
  : policy.userId === ctx.user!.id;
```

Checks whether the fetched resource belongs to the user's org. Does not query `OrganizationMember`. Applied consistently within the `policy` router but absent from `compliance`, `vault`, and `document` routers.

### Pattern 4: Context-only (Weakest — majority of procedures)

```typescript
const orgId = ctx.user.organizationId ?? '';
return vaultModule.listDocuments({ organizationId: orgId, ... });
```

No authorization check beyond the session's `organizationId` field. Used in vault, billing, most analytics, and most compliance procedures.

### Inconsistencies

- `policy.get` and `compliance.exportDocx` check `resource.userId === ctx.user.id` as a fallback for legacy records without an `organizationId`. This is correct but is not a membership check.
- `document.delete` checks only `document.userId !== ctx.user.id` (creator-only), not org membership — an admin or the creator can delete, but no org-level admin can.
- `compliance.exportDocx` checks `analysis.userId !== userId` for ownership but then queries `analysis.organizationId` for the org name in the DOCX. If an attacker wrote a GapAnalysis record under a victim's orgId via the runGapAnalysis IDOR, a member of that victim org could export it.

---

## A3. OrganizationMember Table Audit

**Schema source:** `prisma/schema.prisma` (confirmed present; live database query not available from this engagement — see note below).

### Prisma Schema (confirmed)

```prisma
model OrganizationMember {
  id             String       @id @default(cuid())
  userId         String
  organizationId String
  role           MemberRole   @default(MEMBER)  // OWNER | ADMIN | MEMBER | VIEWER
  invitedBy      String?
  invitedAt      DateTime?
  joinedAt       DateTime     @default(now())
  status         MemberStatus @default(ACTIVE)  // ACTIVE | INVITED | SUSPENDED | REMOVED
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  user         User         @relation("OrganizationMemberUser")
  organization Organization @relation("OrganizationMembers")
  inviter      User?        @relation("OrganizationMemberInviter")

  @@unique([userId, organizationId])          // also serves as the membership lookup index
  @@index([organizationId, status])
  @@index([userId, status])
}
```

### Index Analysis

The unique constraint `@@unique([userId, organizationId])` creates an index on `(userId, organizationId)`. The `requireOrgMember` middleware queries `findUnique({ where: { userId_organizationId: { userId, organizationId } } })` — this hits the unique constraint index. No additional composite index is needed for membership lookups.

The secondary indexes `@@index([organizationId, status])` and `@@index([userId, status])` support list operations (get members of org by status, get orgs a user belongs to by status) and are appropriate.

### Live Database Verification Required

A3 requires operator verification of the following before Batch 1 ships:

1. Confirm table name in Supabase: `organization_members` (Prisma default snake_case mapping)
2. Confirm indexes exist: `EXPLAIN (SELECT * FROM organization_members WHERE user_id = $1 AND organization_id = $2)` should show index scan, not seq scan
3. Confirm row counts are sane relative to known pilot tenants (22 participants)
4. Check for any rows with `status = 'ACTIVE'` for users who have been removed from orgs (data integrity check: does removeMember update OrganizationMember.status or only update User.organizationId?)

**Suspected data integrity issue:** The `organization.addMember` and `organization.removeMember` procedures in `organization.router.ts` update `User.organizationId` directly — they do NOT create or update `OrganizationMember` rows. This means most pilot users likely have no `OrganizationMember` rows at all, having been added via the legacy path. Before deploying `requireOrgMember` broadly, this must be verified and a backfill migration prepared.

---

## A4. RLS Policy Inventory

Direct Supabase database query is not available from this engagement. The Prisma client connects with the Supabase service role key (`SUPABASE_SERVICE_ROLE_KEY` in `appConfig.supabase.serviceRoleKey`), which bypasses RLS for all application queries.

### Tables with `organizationId` that need RLS as defense-in-depth

| Table | Column | RLS State (unknown — requires operator query) |
|-------|--------|----------------------------------------------|
| `policies` | `organization_id` | Unknown |
| `compliance_queries` | `organization_id` | Unknown |
| `checklists` | `organization_id` | Unknown |
| `gap_analyses` | `organization_id` | Unknown |
| `compliance_items` | `organization_id` | Unknown |
| `compliance_score_snapshots` | `organization_id` | Unknown |
| `vault_documents` | `organization_id` | Unknown |
| `compliance_events` | `organization_id` | Unknown |
| `usage_records` | `organization_id` | Unknown |
| `usage_periods` | `organization_id` | Unknown |
| `generated_policies` | `organization_id` | Unknown |
| `payments` | `org_id` | Unknown |

**Required operator pre-flight query before Batch 3:**

```sql
-- Enumerate RLS state for all org-scoped tables
SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies WHERE schemaname = t.schemaname AND tablename = t.tablename) AS policy_count
FROM pg_tables t
WHERE tablename IN (
  'policies', 'compliance_queries', 'checklists', 'gap_analyses',
  'compliance_items', 'compliance_score_snapshots', 'vault_documents',
  'compliance_events', 'usage_records', 'usage_periods',
  'generated_policies', 'payments', 'organization_members'
)
ORDER BY tablename;
```

Until this query runs, RLS state is unknown. Given that the application was migrated to Supabase recently and uses a service-role Prisma connection, it is likely that RLS is disabled or unconfigured on most tables. This is expected for a service-role architecture but means there is no database-layer backstop for any future direct-DB access (analytics tooling, support queries, Supabase Edge Functions).

---

## A5. Audit Log Readiness

### AuditLogV2 Status: NOT IMPLEMENTED

The `prisma/schema.prisma` contains a single `AuditLog` model with no hash-chain fields. The DPA 2019 sprint's `AuditLogV2` model and hash-chain write service are not present in the codebase.

### Legacy AuditLog Model (available for Batch 3)

```prisma
model AuditLog {
  id         String    @id @default(cuid())
  userId     String?
  action     String
  entityType String?
  entityId   String?
  metadata   Json?
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime  @default(now())

  @@index([userId])
  @@index([action])
  @@index([createdAt])
}
```

**Fields missing that Batch 3 will need to add:**
- `targetOrganizationId` — which org was the subject of the authorization decision
- `procedure` — which tRPC procedure triggered the event
- `decision` — GRANTED or DENIED
- `reason` — why the decision was made
- `requestId` — correlation ID for multi-log tracing

These can be stored in the existing `metadata` Json field without a schema migration, keeping Batch 3 non-destructive. The `action` field will carry `'AUTHORIZATION_GRANTED'` or `'AUTHORIZATION_DENIED'`.

**Implication for Batch 3:** The hash-chain write service does not exist. Audit log writes in Batch 3 will use the legacy `AuditLog` model with decision metadata in the `metadata` Json field. The tamper-evident hash-chain feature must be flagged as a follow-up item (pending DPA sprint completion) rather than delivered in Batch 3.

---

## A6. Threat Model Summary

### Realistic Blast Radius

SheriaBot serves approximately 22 pilot participants including entities regulated by CBK, CMA, ODPC, CA, and FRC. The pilot cohort includes both the regulated entities (fintech startups) and the regulators themselves. In this context:

**Scenario 1 — Cross-tenant compliance posture exfiltration via runGapAnalysis (Critical)**  
Any authenticated pilot participant (including a regulator) can submit a `gapAnalysis.runGapAnalysis` mutation with `organizationId` set to a victim fintech startup's org ID. The result is a full AI-generated gap analysis of the uploaded document attributed to the victim's organization. The result is persisted to the database under `GapAnalysis.organizationId = <victim>` and is visible to members of that org. The attacker also learns the gap analysis result — which regulatoryframeworks the document is weak on.

More critically: the dedup cache key is `sheriabot:gapanalysis:dedup:{orgId}:{fileHash}`. If a victim org previously ran a gap analysis on a common document (e.g., their own AML policy, which is a standard form), and the attacker uploads the same document with the victim's orgId, the dedup cache returns the victim's analysis ID directly — leaking the victim's compliance assessment without triggering a new AI call or any write.

**Scenario 2 — Compliance checklist pollution via generateChecklist (High)**  
Same class as Scenario 1. An attacker can create checklist records tagged to a victim org's ID. The checklist appears in the victim org's `listChecklists` response, polluting their compliance history. At pilot scale, this could corrupt a regulator's review of a startup's compliance trajectory.

**Scenario 3 — Suspended member continued access (Medium)**  
A pilot participant whose employment with a fintech startup ended — and whose organization membership should be SUSPENDED or REMOVED — can continue to invoke org-scoped operations if their `User.organizationId` was not cleared. All vault, compliance, policy, analytics, and billing operations remain accessible. At CBK/ODPC pilot scale, this represents a continued data access risk to sensitive regulatory documents stored in the vault.

**Scenario 4 — Organization existence oracle (Low)**  
`organization.get` returns `FORBIDDEN` (vs. `NOT_FOUND`) when the requested org exists but the caller is not a member. This allows an attacker to enumerate whether any CUID-format org ID exists in the database — useful for reconnaissance but low direct impact given CUID unpredictability.

### Top 10 Highest-Risk Procedures (Ranked by Impact × Exploitability)

| Rank | Procedure | Type | Risk | Why |
|------|-----------|------|------|-----|
| 1 | `gapAnalysis.runGapAnalysis` | WRITE | Critical | True cross-tenant IDOR via client-supplied orgId; writes GapAnalysis records under victim org; dedup cache returns victim's prior analysis without a new write; AI quota consumed under victim's billing |
| 2 | `checklist.generateChecklist` | WRITE | High | True cross-tenant IDOR via client-supplied orgId; writes Checklist records under victim org; pollutes compliance history |
| 3 | `vault.confirmUpload` | WRITE | High | Suspended/removed member can upload documents to org vault indefinitely |
| 4 | `billing.createCheckoutSession` | WRITE | High | Suspended member can initiate a Stripe checkout for the org; attaches org as Stripe customer |
| 5 | `compliance.updateRequirement` | WRITE | Medium | Suspended member can update compliance requirement status for the org |
| 6 | `analytics.getOrgDashboard` | READ | Medium | Suspended member reads full org analytics dashboard |
| 7 | `analytics.exportData` | READ | Medium | Suspended member exports org's analytics data (compliance trends, usage) |
| 8 | `vault.list` | READ | Medium | Suspended member reads full document vault listing for the org |
| 9 | `compliance.getScore` | READ | Medium | Suspended member reads org's compliance score and history |
| 10 | `organization.get` | READ | Low | Org existence oracle; FORBIDDEN vs NOT_FOUND leaks whether a given org ID exists |

---

## A7. Migration Plan

### Pre-Condition: Data Integrity Backfill Required

Before Batch 1 or Batch 2 deploys any `requireOrgMembership` enforcement, the operator must verify and resolve the `OrganizationMember` table state. The `organization.addMember` router procedure currently writes only to `User.organizationId` — it does NOT create `OrganizationMember` rows. Pilot users added via this path have no membership row. A Supabase SQL backfill is required to create `OrganizationMember` rows for every pilot user who has `User.organizationId IS NOT NULL`.

**Pre-flight query:**
```sql
-- Count users with organizationId but no OrganizationMember row
SELECT COUNT(*) 
FROM users u
WHERE u.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members om 
    WHERE om.user_id = u.id AND om.organization_id = u.organization_id
  );
```

If this returns > 0, a backfill is required before any `requireOrgMembership` middleware is applied broadly. Without the backfill, Batch 2 would lock all existing pilot users out of every org-scoped operation.

**Backfill SQL (operator applies manually):**
```sql
-- Backfill OrganizationMember rows for all users with a direct org link but no membership row
INSERT INTO organization_members (id, user_id, organization_id, role, status, joined_at, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  u.id,
  u.organization_id,
  'MEMBER',       -- default role; operator should review and promote OWNER/ADMIN as appropriate
  'ACTIVE',
  u.created_at,
  NOW(),
  NOW()
FROM users u
WHERE u.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.user_id = u.id AND om.organization_id = u.organization_id
  )
ON CONFLICT (user_id, organization_id) DO NOTHING;
```

**Post-backfill verification:**
```sql
-- Should return 0 after backfill
SELECT COUNT(*) 
FROM users u
WHERE u.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_members om 
    WHERE om.user_id = u.id AND om.organization_id = u.organization_id
  );
```

---

### Batch 1 — Middleware Foundation + Highest-Risk IDOR Procedures

**Scope:** Build the new `requireOrgMembership` middleware (distinct from the existing `requireOrgMember`) and apply it to the two confirmed IDOR procedures. Ship together because the middleware is validated by its first real consumer.

**Procedures to migrate in Batch 1:**

| Procedure | Why Batch 1 | Change Required |
|-----------|-------------|-----------------|
| `gapAnalysis.runGapAnalysis` | Reported IDOR; Class A; WRITE | Replace protectedProcedure + ad-hoc checks with `orgMemberProcedure`; remove client-supplied `organizationId` from Zod input schema; derive orgId from `ctx.orgMembership.organizationId` |
| `checklist.generateChecklist` | Identical pattern; Class A; WRITE | Same as above |

**New infrastructure to build in Batch 1:**
- `requireOrgMembership` middleware: reads `organizationId` from validated Zod input; queries OrganizationMember; caches result in Redis (`sheriabot:orgmem:{userId}:{organizationId}`, TTL 60s, `redis.set(..., { ex: 60 })`)
- `orgMemberProcedure`: `protectedProcedure.use(requireOrgMembership)`, exported from `src/server/trpc/trpc.ts`
- `orgMemberProcedureWithRole(allowedRoles)`: factory for role-gated variants
- Cache invalidation hooks in the organization module wherever `OrganizationMember` rows are mutated

**What is NOT in Batch 1:** All Class B/C procedures (suspended-member access gaps). These remain unchanged and are tracked via KNOWN_ISSUES.md entry until Batch 2 completes.

---

### Batch 2 — Full Procedure Migration (Class B/C: No Membership Status Check)

**Scope:** All remaining procedures that use `ctx.user.organizationId` without checking `OrganizationMember.status`. This is the larger mechanical sweep.

**Priority order within Batch 2 (highest-impact first):**

1. **Vault writes:** `confirmUpload`, `update`, `updateStatus`, `delete`, `getReplaceUrl`, `confirmReplace` — these mutate org state and are the highest-risk suspended-member attack vectors
2. **Billing mutations:** `createCheckoutSession`, `createPortalSession`, `requestEnterprise`, `updatePaymentMethod`, `initiateMpesaPayment` — billing operations by a suspended member are contractually and financially significant
3. **Compliance writes:** `updateRequirement` — mutates org compliance posture
4. **Analytics reads:** `getOrgDashboard`, `getComplianceTrends`, `generateReport`, `exportData` — sensitive data reads by suspended members
5. **Vault reads:** `getUploadLimits`, `list`, `getById`, `getDownloadUrl`, `getStats` — less urgent than writes but should ship in same batch
6. **Compliance reads:** `getScore`, `getScoreHistory`, `getRecommendations`, `getRequirements`, `getDeadlines`, `getRoadmap` — org-level compliance posture reads
7. **Policy procedures:** `list`, `get`, `generate`, `update`, `delete`, `export`, `refine`, `verifyCitations`, `getStatus`, `getVersionHistory` — resource-check pattern is adequate for cross-tenant IDOR; add membership status check on top
8. **Document procedures:** `getUploadUrl`, `confirmUpload`, `list`, `get`, `getDownloadUrl`, `delete`, `restore`, `getProcessingStatus` — RAG pipeline is sacred; membership check at router boundary only, internal service logic untouched
9. **EnterprisePolicy procedures** — ENTERPRISE-gated, lower pilot risk but should migrate with everything else
10. **Remaining checklist procedures** — `generateChecklistAsync`, `getChecklistStatus`, `listChecklists`, `getChecklistDetail`, `updateChecklistItem`, `getChecklistUsage`, `retryChecklist`

**Procedures to leave on `protectedProcedure` with justification (document in code):**
- `gapAnalysis.getGapAnalyses` — queries `GapAnalysis` by userId, not orgId; user can only see their own analyses regardless of org
- `gapAnalysis.getGapAnalysisResult` — ownership check by userId in service module; org is incidental
- `gapAnalysis.deleteGapAnalysis` — same as above
- `gapAnalysis.getGapAnalysisLimits` — reads plan limits, no org data returned
- `gapAnalysis.getFrameworks` — reads global framework catalog; no org data
- `compliance.submitFeedback`, `getFeedbackStatus` — checks `query.userId === ctx.user.id`; user-scoped, not org-scoped
- `compliance.toggleSave`, `getSavedStatus`, `listSavedResponses` — user-scoped (SavedResponse model keyed on userId)
- All `auth.*`, `user.*`, `notification.*`, `trial.*`, `session.*` — legitimately user-scoped

---

### Batch 3 — Defense in Depth (RLS + Audit Logging)

**Scope:** Database-layer backstop via Supabase RLS on all org-scoped tables; tamper-evident audit logging of authorization decisions.

**RLS:** Apply to all 12 org-scoped tables identified in A4. Policy template:
```sql
CREATE POLICY "members_only" ON <table>
  FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND status = 'ACTIVE'
  ));
```
The `payments` table uses `org_id` (not `organization_id`) — adjust accordingly.

**Audit logging:** Extend `requireOrgMembership` middleware to write to `AuditLog` on every authorization decision. Sample GRANTED at env-configurable rate (default 1%); log 100% of DENIED. Fields in `metadata` JSON: `{ targetOrganizationId, procedure, decision, reason, requestId }`. Hash-chain write service deferred until DPA sprint delivers `AuditLogV2`.

---

## Additional Structural Finding: Duplicate appRouter

**File:** `src/server/routers/router.ts` is a stale, incomplete copy of the production router. It registers only 13 sub-routers. The production `appRouter` is at `src/server/trpc/router.ts` (27 sub-routers).

This creates risk that:
- Future router additions made to `src/server/routers/router.ts` silently go unregistered in production
- Tests or tooling importing `AppRouter` type from `src/server/routers/router.ts` miss 14 routers and their type contracts

**Recommendation (do not implement until operator approves):** Delete `src/server/routers/router.ts` or add a file-level comment marking it as deprecated/unused. Confirm which file the Fastify adapter imports from before deleting.

---

## Phase A Complete

This document constitutes the full Phase A deliverable. No application code was modified during this audit. The confirmed IDOR in `gapAnalysis.runGapAnalysis` is live in production. A second confirmed IDOR in `checklist.generateChecklist` was identified during this audit and is equally live.

**Operator actions required before Phase B can begin:**

1. Review and approve this findings document
2. Run the OrganizationMember backfill verification query (A3) against the live database and share the row count
3. Run the RLS inventory query (A4) and share the results
4. Confirm which `appRouter` file the production Fastify adapter imports from
5. Explicitly authorize Phase B, Batch 1 to proceed

**Phase B will not begin until explicit operator approval is received.**
