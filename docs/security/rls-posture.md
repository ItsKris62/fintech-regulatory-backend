# RLS Posture — SheriaBot Fintech Regulatory Backend

**Last verified:** 2026-05-07  
**Auditor:** Phase B pipeline hardening sprint

---

## Access architecture

All client access to Supabase is proxied through the Fastify tRPC backend using the **Supabase service role key** (`SUPABASE_SERVICE_ROLE_KEY`). No frontend code queries Supabase directly. The service role bypasses RLS on all tables. RLS on application tables is therefore **defense-in-depth** — it prevents accidental direct-client exposure but is not the primary authorization layer.

Primary authorization is enforced at the tRPC procedure layer:
- `protectedProcedure` — requires a valid Supabase JWT
- `withPlanContext` — resolves the user's effective plan and attaches it to `ctx`
- `requirePlanFeature` — blocks access to procedures the user's plan does not include
- RBAC checks within each procedure (owner-or-ADMIN, org membership, etc.)

---

## Table-level RLS posture

### `RegulatoryFramework`

| Property | Value |
|----------|-------|
| RLS enabled | Yes |
| Policies defined | **None** |
| Effective posture | DENY ALL for non-service-role principals |
| Backend impact | None — service role bypasses RLS |
| Direct-client impact | Zero rows returned silently (no error) |
| Classification | **YELLOW** |

**Why YELLOW and not GREEN:** RLS is enabled and the table is protected, but there is no explicit SELECT policy documenting the intended access pattern. The denial of direct-client reads is implicit (zero policies = deny all), not explicit. This is safe in current architecture but creates a footgun for any future developer who attempts a direct Supabase client query — they will get empty results with no diagnostic error.

**Recommended policy (not applied in Phase B — separate sprint):**

```sql
-- Explicit deny-all SELECT policy for non-service-role reads.
-- Documents intent: this table is backend-only.
CREATE POLICY "framework_select_service_role_only"
ON "RegulatoryFramework"
FOR SELECT
USING (auth.role() = 'service_role');
```

This is additive — it makes the implicit denial explicit and self-documenting. Only apply after verifying no legitimate authenticated-user direct reads exist.

---

### General guidance for new tables

When adding a new global reference table (no `organizationId`, no `userId`):

1. **Decide access pattern first:** service-role-only vs. authenticated direct reads.
2. **If service-role-only:** Enable RLS, add an explicit `USING (auth.role() = 'service_role')` SELECT policy.
3. **If authenticated direct reads are needed:** Add `USING (auth.role() = 'authenticated')` or a more specific predicate.
4. **Document the posture here** before merging.

When adding a tenant-scoped table (has `organizationId`):

```sql
-- Standard tenant isolation pattern
CREATE POLICY "tenant_isolation"
ON "YourTable"
FOR ALL
USING (
  "organizationId" IN (
    SELECT "organizationId" FROM "OrganizationMember"
    WHERE "userId" = auth.uid()
  )
);
```

---

## Known posture gaps (open)

| Table | Issue | Tracked in |
|-------|-------|------------|
| `RegulatoryFramework` | RLS enabled, no explicit SELECT policy — implicit deny is undocumented | This file + KNOWN_ISSUES.md |
| `GapAnalysis` | `organizationId` written without membership verification in `runGapAnalysis` — IDOR risk | KNOWN_ISSUES.md |
