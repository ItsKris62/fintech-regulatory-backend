# Human-Review Backfill Runbook (Pack 1 Stage C3)

This runbook covers rolling out `requiresHumanReview` — from "code deployed,
nothing changed" through "enforcement live" — for an operator running this
outside of an automated pipeline. Every step is manual and requires explicit
operator judgment; none of it happens automatically.

## Background

`BlogArticleSuggestion.requiresHumanReview` has always existed as a Prisma
column with a default value. Before Stage C3, every row silently inherited
that column default — no code ever computed or reasoned about it explicitly.
Stage C3 adds:

1. A pure policy function (`human-review-policy.ts`) that computes whether a
   suggestion should require human review, from whatever evidence is actually
   available at the point it's called.
2. Explicit computation and persistence of that value at suggestion-creation
   time (`suggestion-builder.ts`), gated behind `EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED`.
3. A backfill script (`src/scripts/backfill-editorial-human-review.ts`) to
   recompute the value for **existing** non-terminal suggestions, so the
   column reflects the new policy instead of a stale default.
4. An enforcement gate (`blog-draft.service.ts`) that, when
   `EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED` is on, refuses to
   auto-promote a suggestion to a draft when `requiresHumanReview` is `true`.

**Both flags default to `false`.** Deploying this code changes nothing by
itself.

## Rollout order (do not compress or reorder)

### Step 1 — Deploy with both flags off (already the default)

No action needed beyond a normal deploy. Confirm in the deployed
environment's config that both of these are unset or explicitly `false`:

```
EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED=false
EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED=false
```

At this point, behavior is byte-for-byte identical to before Stage C3.

### Step 2 — Enable policy computation only

```
EDITORIAL_HUMAN_REVIEW_POLICY_ENABLED=true
```

From this point forward, **new** suggestions get an explicit, computed
`requiresHumanReview` value at creation. Enforcement is still off, so this
has no effect on draft auto-promotion yet — it only starts populating the
column correctly going forward. Existing rows are untouched by this step.

### Step 3 — Dry-run the backfill against existing rows

```
pnpm run editorial:backfill-human-review
```

(equivalent to `pnpm tsx src/scripts/backfill-editorial-human-review.ts --dry-run`)

This is read-only — it makes no writes. It only recomputes the policy for
`BlogArticleSuggestion` rows currently in a **non-terminal** status
(`PENDING_REVIEW` or `NEEDS_MORE_SOURCES`); terminal-status rows (already
drafted, dismissed, converted) are never touched, because a suggestion that's
already been acted on cannot be retroactively un-promoted by recomputing a
value after the fact.

The script prints, to stdout:

- `Total suggestions evaluated`
- `Current requiresHumanReview=true` / `=false` (what's stored today)
- `Computed requiresHumanReview=true` / `=false` (what the policy says)
- `Rows changing true -> false` and `Rows changing false -> true` (the two
  directions of disagreement between stored and computed)
- `Rows that could not be evaluated` (plus each row's ID and error, if any)
- A breakdown of every `HumanReviewReason` code triggered, sorted by
  frequency, across all evaluated rows

**Operator review gate**: before proceeding to Step 4, read this output.
Specifically:
- If `Rows changing false -> true` is large or unexpected, understand why —
  read the reason breakdown, and spot-check a few of the affected suggestion
  IDs against their actual source material.
- If `Rows that could not be evaluated` is non-zero, investigate each row
  before proceeding — an uncomputable row is a sign of unexpected data shape,
  not something to route around.
- There is no automated approval gate here — this is a human judgment call by
  design, and this script cannot and does not make it for you.

### Step 4 — Apply the backfill in write mode

Only after Step 3's output has been reviewed and judged acceptable:

```
pnpm run editorial:backfill-human-review:write
```

(equivalent to `--write`)

This updates **only** the rows whose computed value differs from what's
currently stored — rows that already match are left alone (no unnecessary
writes, no `updatedAt` churn on unrelated rows). The script refuses to run in
write mode against a database that `validateEnvironmentSafety` (reused from
`schema-verifier.ts`) identifies as production, unless `--allow-production`
is explicitly passed — this is an intentional hard stop, not something to
route around by default.

Output in write mode adds:

- `Rows updated` (the actual count written)
- `Failures` (count, plus each failed row's ID and error — failures are
  always reported, never silently skipped, and the process exits with a
  non-zero code if any occurred)

**Operator review gate**: confirm `Failures: 0` (or investigate and resolve
any reported before proceeding) before Step 5.

### Step 5 — Enable enforcement

Only after Step 4 has completed with an acceptable failure count:

```
EDITORIAL_HUMAN_REVIEW_ENFORCEMENT_ENABLED=true
```

From this point, `blog-draft.service.ts::createDraftFromCandidate` checks the
suggestion's (now-correct) `requiresHumanReview` value before auto-promoting
to a draft. A suggestion with `requiresHumanReview: true` returns
`{ status: 'human_review_required', suggestionId, reasons }` instead of being
promoted — logged as `automation_blog_draft_human_review_required`. Research
and triage paths are never gated by this flag; only the draft-promotion call
site checks it.

## Rollback

Each step is independently reversible by flipping its flag back to `false` —
no data migration is required to roll back, since the backfill only ever
writes the same `requiresHumanReview: boolean` column that already existed.
Rolling back Step 5 (enforcement off) is always safe and instant. Rolling
back Step 2 (policy computation off) only affects newly created suggestions
going forward; it does not revert already-backfilled rows (nor should it —
those rows are now correctly computed, not stale).

## What this runbook does not cover

- Applying any of the Stage C1 migrations — a separate, already-documented
  deployment action (see `phase-c-rollout-plan.md`).
- Any change to `BLOG_PUBLISH_READINESS_MODE` — see
  `publish-readiness-burn-in-runbook.md`.
