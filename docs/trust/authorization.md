# Authorization Model — SheriaBot Fintech Regulatory Backend

> **Status: DRAFT — Not published. For internal review only.**
> Last updated: 2026-05-13 (Batch 3, Sprint 2 Phase B)

---

## Overview

Every tRPC request passes through a layered middleware chain before reaching a
route handler. Authorization is enforced in three distinct stages:

```
JWT validation (isAuthenticated)
        ↓
Org membership verification (requireOrgMembership)
        ↓
Role enforcement (requireOrgMembershipRole) [optional, per-procedure]
```

No handler that reads or writes org-scoped data is reachable without an ACTIVE
`OrganizationMember` row verified on every request.

---

## Middleware Chain

### 1. `isAuthenticated`

Verifies the Bearer token is a valid Supabase JWT signed with `SUPABASE_JWT_SECRET`.
Populates `ctx.user` from the session cache (Upstash Redis, 60s TTL) or the
`User` table directly. Throws `UNAUTHORIZED` on failure.

### 2. `requireOrgMembership` (powering `orgMemberProcedure`)

Checks that an **ACTIVE** `OrganizationMember` row exists for
`(ctx.user.id, ctx.user.organizationId)`.

Key properties:

| Property | Detail |
|---|---|
| Cache | Redis key `sheriabot:orgmem:{userId}:{orgId}` — 60s TTL |
| Cache population | Only ACTIVE rows are cached; SUSPENDED/REMOVED/INVITED never cached |
| Denial rate limit | 10 denials per 60s per userId, fail-closed (throws `TOO_MANY_REQUESTS` on breach) |
| Error homogeneity | All failures return `FORBIDDEN` — callers cannot distinguish "no org" from "wrong org" from "inactive member" |
| Audit logging — denials | **100%** — every denial writes a row to the `AuditLog` table (fire-and-forget) |
| Audit logging — grants | **Sampled** — rate controlled by env var `AUDIT_GRANT_SAMPLE_RATE` (default 0.10 during pilot, target 0.01 post-pilot) |

#### Denial audit log schema

```json
{
  "userId": "<uid>",
  "action": "authorization.denied",
  "entityType": "Organization",
  "entityId": "<orgId or null>",
  "metadata": { "reason": "no_organization | no_membership | member_status_suspended | denial_rate_limit_exceeded" },
  "ipAddress": "<client IP>",
  "userAgent": "<UA string, max 500 chars>"
}
```

#### Grant audit log schema

```json
{
  "userId": "<uid>",
  "action": "authorization.granted",
  "entityType": "Organization",
  "entityId": "<orgId>",
  "metadata": { "role": "VIEWER | MEMBER | ADMIN | OWNER" },
  "ipAddress": "<client IP>",
  "userAgent": "<UA string, max 500 chars>"
}
```

### 3. `requireOrgMembershipRole` (optional)

Factory middleware that enforces a minimum `MemberRole` level on the membership
resolved by step 2. Role hierarchy (ascending): `VIEWER < MEMBER < ADMIN < OWNER`.

Procedures requiring elevated privilege use:

```typescript
orgMemberProcedureWithRole([MemberRole.ADMIN, MemberRole.OWNER])
```

---

## Procedure Inventory

### Procedures using `orgMemberProcedure` (as of 2026-05-13)

All procedures below enforce an ACTIVE membership check before the handler runs.

| Router | Procedure(s) |
|---|---|
| `billing.router` | `getPlanAndUsage`, `cancelSubscription`, `getUsageStats` |
| `payment.router` | `list`, `getById`, `getDetail` |
| `vault.router` | `list`, `upload`, `delete`, `getDownloadUrl` |
| `analytics.router` | `getOverview`, `getEventStream` |
| `usage.router` | `getCurrent`, `getHistory` |
| `policy.router` | `list`, `get`, `generate`, `delete` |
| `compliance.router` | `getComplianceDashboard`, `updateChecklistItem`, `getChecklistByCategory`, `getComplianceOrgPosture`, (others) |
| `gap-analysis.router` | `run`, `getResult`, `list`, `delete` |
| `checklist.router` | `generate`, `getUserChecklists`, `getChecklist`, `updateProgress`, `delete` |
| `document.router` | `list`, `get`, `delete`, `share` |
| `enterprise-policy.router` | All procedures |
| `alert.router` | `subscribe`, `getHistory` |
| `calendar.router` | All procedures |

### Procedures using `adminProcedure`

`admin.router.*`, `admin.organization.*` — accessible only to `role = ADMIN` users.
These bypass `requireOrgMembership` by design (admins manage cross-org resources).

### Procedures using `protectedProcedure` (user-scoped, no org resource)

`auth.router.*`, `user.router.*`, `trial.router.*` — read/write only the
calling user's own record. No org resource is touched.

---

## Cache Invalidation Contract

Any future mutation of an `OrganizationMember` row **must** invalidate the
corresponding Redis cache key. Currently enforced by:

- `organization.addMember` → upserts row + invalidates `sheriabot:orgmem:{userId}:{orgId}`
- `organization.removeMember` → sets `status = REMOVED` + invalidates cache

**Known limitation:** Manual DB updates (e.g. direct Supabase Studio edits or
psql commands) do not invalidate the Redis cache. The stale entry will be served
for up to 60s before the TTL expires. During the 60s window a removed member
retains access. Mitigation: operations that require immediate revocation must
also flush the Redis key directly.

---

## Org-Scoped Resource Access Model

All org-scoped resources carry an `organizationId` (or `orgId`) foreign key.
Handlers never derive the `organizationId` from user-supplied input — they always
use `ctx.orgMembership.organizationId` (set by the middleware) or
`ctx.user.organizationId!` where `requireOrgMembership` has already asserted
it is non-null.

This structural constraint makes cross-tenant IDOR via crafted payloads
impossible through the current tRPC layer.

---

## Open Follow-Ups

| Item | Status |
|---|---|
| Automated test coverage: Vitest integration tests for `requireOrgMembership` paths | Next sprint — prerequisite for ODPC submission |
| RLS on Supabase PostgreSQL | Deferred — design work required (Prisma uses service role) |
| `organization.router.ts` legacy pattern cleanup (10 procedures) | Next sprint |
| Checklist null-org migration (make `organizationId` NOT NULL) | Pending — see runbook |
| `AuditLogV2` hash-chain delivery | Deferred to DPA 2019 sprint |
