# Organization Membership Backfill Runbook

## Purpose

`src/scripts/backfill-organization-memberships.ts` repairs legacy users that still have `User.organizationId` set but do not have a matching `OrganizationMember` row. Newer RBAC and entitlement checks use `OrganizationMember` as the source of truth, so these legacy gaps can deny valid organization access.

## Safety Model

Dry-run is the default and is safe for production review:

```bash
pnpm tsx src/scripts/backfill-organization-memberships.ts
pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run
pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run --limit=100
```

Apply mode requires an explicit flag:

```bash
pnpm tsx src/scripts/backfill-organization-memberships.ts --apply
pnpm tsx src/scripts/backfill-organization-memberships.ts --apply --limit=100
```

Useful filters:

```bash
pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run --organizationId=<orgId>
pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run --userId=<userId>
pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run --json
pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run --verbose
```

## Classification

The script creates a membership only when all of these are true:

- `User.organizationId` is set.
- The referenced organization exists.
- No `OrganizationMember` exists for the same `userId` and `organizationId`.
- The user does not already have an active membership in another organization.

Created rows use:

```ts
{
  role: MemberRole.MEMBER,
  status: MemberStatus.ACTIVE,
}
```

The script skips and reports ambiguous cases:

- Missing organization.
- Matching membership exists but is not `ACTIVE`.
- Multiple matching memberships are observed defensively.
- Active membership exists in a different organization.

## Cache Invalidation

Apply mode invalidates these keys after each successful create:

```txt
sheriabot:orgmem:{userId}:{organizationId}
sheriabot:planctx:{userId}
```

Dry-run mode does not write to the database and does not invalidate caches.

If cache invalidation fails after a database create, the script reports the failure and does not roll back the new membership. Manually delete the affected keys or flush the relevant user/org cache entries before declaring the repair complete.

## What Not To Do

Do not run `--apply` in production without approval and a reviewed dry-run report.

Do not modify this backfill to assign `OWNER` or `ADMIN` unless there is explicit, reliable source data for that role. `User.role` and `OrganizationMember.role` are separate role systems.

Do not clear `User.organizationId`, delete users, delete organizations, delete memberships, or reactivate removed/suspended/invited memberships as part of this backfill.

## Expected Output

```txt
Organization membership backfill report

Mode: DRY RUN
Users scanned: 243
Users with organizationId: 243
Existing active memberships: 103
Existing non-active memberships: 2
Missing memberships: 12
Ambiguous cases: 2
Would create memberships: 12
Created OrganizationMember rows: 0
Skipped: 4
Caches invalidated: 0
Cache invalidation failures: 0

No database changes were made.
```

## Production Approval

Before production apply:

1. Run dry-run with `--json` or `--verbose`.
2. Review ambiguous cases.
3. Confirm the database target is production intentionally.
4. Get explicit production approval.
5. Run `--apply` with a conservative `--limit` first if the dry-run report is large.
