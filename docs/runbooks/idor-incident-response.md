# Runbook: IDOR / Authorization Incident Response

> **Scope:** SheriaBot Fintech Regulatory Backend (Fastify + tRPC)
> **Applies to:** Suspected or confirmed cross-tenant data access, authorization
> bypass, or unexpected AuditLog denial spikes.
> Last updated: 2026-05-13 (Batch 3, Sprint 2 Phase B)

---

## 1. Detection

### 1.1 Automated signals

| Signal | Source | Threshold to escalate |
|---|---|---|
| `authorization.denied` AuditLog spike | `AuditLog` table (action = 'authorization.denied') | > 20 denials from a single `userId` in 5 minutes |
| Denial rate-limit trigger | Application log `authorization.denied` reason = `denial_rate_limit_exceeded` | Any occurrence (already throttled; still worth tracking) |
| `trpc_request_error` FORBIDDEN spike | Application logs | > 50 in 5 minutes from a single IP |
| Unusual payload shape (org ID in input body) | Code review / PR scan | Any new tRPC input schema introducing `organizationId` as a user-supplied field |

### 1.2 Manual spot-check query (Supabase SQL editor or psql)

```sql
-- Denial count by user in the last 60 minutes
SELECT "userId", metadata->>'reason' AS reason, COUNT(*) AS hits
FROM "AuditLog"
WHERE action = 'authorization.denied'
  AND "createdAt" > now() - interval '60 minutes'
GROUP BY "userId", reason
ORDER BY hits DESC
LIMIT 50;
```

```sql
-- All denials for a specific user
SELECT "createdAt", metadata, "ipAddress", "userAgent"
FROM "AuditLog"
WHERE action = 'authorization.denied'
  AND "userId" = '<suspect-user-id>'
ORDER BY "createdAt" DESC;
```

---

## 2. Triage

**Goal:** Determine within 15 minutes whether this is a probe, accidental
misconfiguration, or active exploitation.

1. Pull AuditLog rows for the suspect `userId`. Note `ipAddress`, `userAgent`, and
   `reason` patterns.
2. Look up the user in the `User` table — check `organizationId`, `role`, `accountStatus`.
3. Check `OrganizationMember` for the user:

   ```sql
   SELECT "organizationId", role, status, "createdAt", "updatedAt"
   FROM "OrganizationMember"
   WHERE "userId" = '<suspect-user-id>';
   ```

4. Look at the tRPC request log (`trpc_request_start` + `trpc_request_error`) for
   the same userId/IP in the same window to see which procedures were called.

5. Classify:
   - **Probe** — sequential distinct `organizationId` values in denial metadata,
     from a single IP/session.
   - **Removed member** — `member_status_removed` denials from a known user;
     likely a UX issue or stale JWT.
   - **IDOR attempt** — any successful `authorization.granted` entry followed by
     data access to an org the user should not belong to.

---

## 3. Containment

### 3.1 Terminate a specific user session

```sql
-- Deactivate the user account
UPDATE "User" SET "accountStatus" = 'SUSPENDED' WHERE id = '<userId>';

-- Invalidate their plan context + org membership caches via Upstash REST API:
-- DELETE sheriabot:planctx:<userId>
-- DELETE sheriabot:orgmem:<userId>:<orgId>
-- (or flush all sheriabot:* keys if scope is unclear — pilot risk acceptable)
```

### 3.2 Revoke org membership immediately

```sql
UPDATE "OrganizationMember"
SET status = 'REMOVED', "updatedAt" = now()
WHERE "userId" = '<userId>' AND "organizationId" = '<orgId>';
```

Then **manually flush the Redis cache key** — the DB update alone does not
invalidate it (60s window):

```
DEL sheriabot:orgmem:<userId>:<orgId>
```

> **TTL exposure note:** This is a known limitation. If a removed member's
> Redis cache entry is still warm (up to 60s), `requireOrgMembership` will
> serve the cached ACTIVE entry and grant access. Always flush the Redis key
> manually for immediate revocation. Future work: add a Supabase DB trigger or
> a dedicated revocation endpoint that invalidates the cache atomically.

---

## 4. Forensics

4.1 Identify all resources the suspect user accessed:

```sql
-- AuditLog grants for this user (sampled, so not complete)
SELECT "createdAt", "entityId" AS "orgId", metadata->>'role' AS role, "ipAddress"
FROM "AuditLog"
WHERE "userId" = '<userId>' AND action = 'authorization.granted'
ORDER BY "createdAt" DESC;
```

4.2 Check org-scoped resources for anomalous access patterns:

```sql
-- Gap analyses created by this user (check orgId matches their known org)
SELECT id, "organizationId", "createdAt", "status"
FROM "GapAnalysis"
WHERE "userId" = '<userId>'
ORDER BY "createdAt" DESC;

-- Checklists
SELECT id, "organizationId", "createdAt"
FROM "Checklist"
WHERE "userId" = '<userId>'
ORDER BY "createdAt" DESC;

-- Compliance queries
SELECT id, "organizationId", "createdAt", "query"
FROM "ComplianceQuery"
WHERE "userId" = '<userId>'
ORDER BY "createdAt" DESC;
```

4.3 Cross-check that all returned `organizationId` values match the user's
legitimate org. Any mismatch is a confirmed IDOR write.

---

## 5. Remediation

### 5.1 Confirmed IDOR write

1. Identify all records written to wrong-org context.
2. Soft-delete or reassign each record after legal/compliance review.
3. Notify affected organization's admin by email (draft via `reactMailer`).
4. File incident report in ODPC disclosure log (required under DPA 2019 Part IV).

### 5.2 Suspected IDOR read (no write evidence)

1. Document the access pattern in the incident log.
2. Determine whether the endpoint served org-scoped data to the caller.
3. If yes, treat as a data breach under DPA 2019 — escalate to DPO within 72h.

---

## 6. Post-Incident Checks

After each incident:

- [ ] Verify the denial rate-limit is still active (`rateLimiter.check` with
      `failClosed: true` on `auth_denial` action).
- [ ] Verify `AUDIT_GRANT_SAMPLE_RATE` is set appropriately in the environment.
- [ ] Review any new tRPC procedures merged since the previous review — confirm
      none introduce a user-supplied `organizationId` input field.
- [ ] Update the KNOWN_ISSUES.md if a new vulnerability class was found.

---

## 7. Standing Follow-Ups (as of 2026-05-13)

### 7.1 Future mutation cache-invalidation requirement

**Any code path that mutates an `OrganizationMember` row must also invalidate
the corresponding Redis cache key.** Currently enforced by `addMember` and
`removeMember` in `organization.router.ts`. This requirement must be
communicated in code review checklist and PR templates. Failure to do so creates
a window (up to 60s) where a newly-removed member retains access.

Pattern to follow:

```typescript
await redis.del(`sheriabot:orgmem:${userId}:${orgId}`);
```

### 7.2 Manual DB update TTL exposure

Direct database edits (Supabase Studio, psql, admin scripts) that change an
`OrganizationMember.status` do not flush the Redis cache. This is the **only**
bypass of the active-membership check short of a Supabase DB trigger or a
dedicated cache-invalidation endpoint. Document all such manual operations in
the ops log and flush the cache key manually (see §3.2 above).

### 7.3 Test coverage as ODPC prerequisite

Automated integration tests for `requireOrgMembership` are **required before
ODPC submission** and before pilot expansion beyond the current cohort. Tests
must cover:

- Active member → 200 OK
- Removed member → 403 FORBIDDEN (and AuditLog denial written)
- No OrganizationMember row → 403 FORBIDDEN
- Denial rate-limit trigger (10 failures in 60s) → 429 TOO_MANY_REQUESTS
- Regression tests for the original A1 (runGapAnalysis) and A2 (generateChecklist)
  IDOR vectors using a second tenant's JWT

Until these tests exist, the security posture is asserted by code review only.

### 7.4 `organization.router.ts` legacy pattern follow-up

10 procedures in `organization.router.ts` still use patterns predating
`orgMemberProcedure` (direct `prisma.organization.findUnique` without the
membership layer, or `protectedProcedure` + manual org checks). These were
scoped out of Batch 2 because they require `updateMemberRole` pattern analysis.
Cleanup sprint is the next priority after the automated test sprint.

### 7.5 Checklist null-org migration plan (tightened)

Two legacy rows in the `Checklist` table have `organizationId = null`:
`cmmnyw4ja00011elcntv9trh8`, `cmmng2jtm00021xhe81gvobq9`.

**Migration sequence (do not run as a single block):**

**Step 1+2 — run as one transaction:**

```sql
BEGIN;

-- Step 1: Reattribute null-org rows to their author's current org
UPDATE "Checklist" c
SET "organizationId" = u."organizationId"
FROM "User" u
WHERE c."userId" = u.id
  AND c."organizationId" IS NULL
  AND u."organizationId" IS NOT NULL;

-- Step 2: If any rows cannot be reattributed (user has no org), soft-retire them
UPDATE "Checklist"
SET "organizationId" = '__retired__'  -- placeholder; handle in application layer
WHERE "organizationId" IS NULL;

COMMIT;
```

**Post-flight verification (run immediately after the transaction):**

```sql
SELECT COUNT(*) FROM "Checklist" WHERE "organizationId" IS NULL;
-- Expected: 0
```

If count > 0, rollback investigation is required before proceeding.

**Step 3 — run separately after verification passes:**

```sql
ALTER TABLE "Checklist"
  ALTER COLUMN "organizationId" SET NOT NULL;
```

**Step 4 — after Step 3 succeeds:**

- Update `prisma/schema.prisma`: change `organizationId String?` to `organizationId String` on the `Checklist` model.
- Remove the `verifyOwnership` fallback in `compliance.module.ts` that handles the null-org case.
- Run `prisma generate` to update the Prisma client.
- Run the full typecheck to confirm 0 errors.
