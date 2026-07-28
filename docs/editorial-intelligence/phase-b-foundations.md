# SheriaBot Pack 1 — Phase B: Foundations

Status: design proposal, not implemented. No migrations applied, no code changed by this document.

This document specifies five backend foundations that every later Pack 1 workflow
(W-CONTENT-04..07) depends on. Each foundation is designed to extend an existing
system, not replace it. All line numbers below were verified directly against
`fintech-regulatory-backend` on 2026-07-27 and must be re-checked before implementation
if time has passed.

---

## Foundation A — `RegulatorySignal` → `BlogSourceItem` relationship

### Current state (verified)

- `RegulatorySignal.sourceItemId` is `String?` (schema.prisma:3427), **not** a Prisma
  relation field. No `@relation` exists between `RegulatorySignal` and `BlogSourceItem`.
- `BlogSourceItem.id` is `String @id @default(cuid())` (schema.prisma:3078) — a `cuid()`
  string, same type family as `RegulatorySignal.sourceItemId`, so a same-type FK is a
  straightforward additive column change (no type coercion needed).
- No index currently exists on `RegulatorySignal.sourceItemId` (only `normalizedUrl`,
  `jurisdiction`, `regulatoryBody`, `severity`, `status`, `corpusGapDetected`,
  `agentRunId`, `createdAt` are indexed — schema.prisma:3454-3461).
- **The value is reliably populated today, from a single writer.** Traced the full
  path: `signal-classifier.service.ts:119,146` builds candidates with
  `sourceItemId: item.id` where `item` is a `BlogSourceItem` row scanned by the
  reg-intel pipeline; line 79 defensively coerces any non-string to `''` and line 86
  filters out empty values before classification proceeds. `reg-intel.agent.ts:142`
  then writes `sourceItemId: signal.sourceItem.id` when constructing the
  `RegulatorySignal` insert, and the raw SQL insert at `reg-intel.agent.ts:366`
  includes `"sourceItemId"` as a literal column, sourced from the same object. There
  is **no other writer** of `RegulatorySignal` in the codebase (confirmed by
  full-tree grep for `regulatorySignal.create` / raw signal inserts). So every
  `RegulatorySignal` row with a non-null `sourceItemId` should already reference a
  real `BlogSourceItem.id` — this is a data-hygiene fact to verify empirically
  (§ pre-migration check), not an assumption to skip.
- `AutomationContentService.getRecentHighImpactRegulatoryItems` (`content.service.ts:218-244`)
  reads `sourceItemId` straight off `RegulatorySignal` and passes it through
  unchanged into `RegulatoryItem.sourceItemId` (content.service.test.ts:146-156
  explicitly asserts this passthrough exists "so W-CONTENT-01 can hand a real
  sourceItemId to queueContentCandidate"). W-CONTENT-01 then forwards it as the
  `sourceItemId` field of the `queueContentCandidate` webhook payload
  (`n8n_W-CONTENT-01_regulatory_change_monitor.json`), which W-CONTENT-02's
  `createDraftFromCandidate` (`agents.router.ts:354-359`) treats as a hard
  `BlogSourceItem.id` lookup key (`suggestion-builder.ts:16-19`, throws `Source item
  not found` if it doesn't resolve). **This means the FK is only formalizing an
  assumption three call sites already silently depend on** — it isn't introducing a
  new constraint on previously-unconstrained data.

### Migration proposal

```sql
-- Pre-migration checks (run manually against a read replica or inside a
-- transaction that is rolled back — do not apply as part of the migration file):

-- 1. Row count baseline
SELECT count(*) FROM "RegulatorySignal";
SELECT count(*) FROM "RegulatorySignal" WHERE "sourceItemId" IS NOT NULL;

-- 2. Orphan detection — sourceItemId values with no matching BlogSourceItem
SELECT rs.id, rs."sourceItemId", rs."createdAt"
FROM "RegulatorySignal" rs
LEFT JOIN "BlogSourceItem" bsi ON bsi.id = rs."sourceItemId"
WHERE rs."sourceItemId" IS NOT NULL AND bsi.id IS NULL;

-- 3. Confirm no code path assumes sourceItemId can be an arbitrary non-cuid string
--    (already confirmed via grep: no writer other than reg-intel.agent.ts exists)
```

If the orphan query returns zero rows, the FK is a pure additive constraint. If it
returns rows, each one is a genuine data-integrity finding predating this migration
(likely a `BlogSourceItem` that was hard-deleted rather than soft-deleted, or a
historical signal from before the reg-intel pipeline stabilized) — those rows must
be nulled or the FK add will fail. **This decision (null the orphans vs. investigate
each one) is a product decision to make after the orphan query result is known, not
something to pre-decide here.**

```sql
-- Migration: prisma/migrations/<TIMESTAMP>_regulatory_signal_source_item_fk/migration.sql
-- Additive only. Apply manually (per this project's convention — no `prisma migrate`),
-- then run `prisma generate` to sync the client.
--
-- sourceItemId remains nullable and unchanged in type (String). This migration only
-- adds referential integrity and an index; it does not touch existing values, except
-- that any pre-existing orphan value (see pre-migration check) must be nulled first
-- or this ALTER TABLE will fail.

-- If the orphan query found rows, null them first (example — do not run blindly,
-- confirm the exact IDs from the orphan query above):
-- UPDATE "RegulatorySignal" SET "sourceItemId" = NULL WHERE id IN (...);

ALTER TABLE "RegulatorySignal"
  ADD CONSTRAINT "RegulatorySignal_sourceItemId_fkey"
  FOREIGN KEY ("sourceItemId") REFERENCES "BlogSourceItem"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "RegulatorySignal_sourceItemId_idx" ON "RegulatorySignal"("sourceItemId");
```

Prisma schema change (additive, no other field touched):

```prisma
model RegulatorySignal {
  // ...unchanged fields...
  sourceItemId String?

  agentRun   AgentRun        @relation(fields: [agentRunId], references: [id], onDelete: Cascade, onUpdate: NoAction)
  sourceItem BlogSourceItem? @relation("RegulatorySignalSourceItem", fields: [sourceItemId], references: [id], onDelete: SetNull)
  // ...

  @@index([sourceItemId])
}

model BlogSourceItem {
  // ...unchanged fields...
  regulatorySignals RegulatorySignal[] @relation("RegulatorySignalSourceItem")
}
```

- **FK name**: `RegulatorySignal_sourceItemId_fkey` (matches this codebase's
  `<Table>_<column>_fkey` convention, e.g. `BlogSuggestionSource_sourceItemId_fkey`
  in `schema-verifier.ts:328`).
- **Index name**: `RegulatorySignal_sourceItemId_idx`.
- **`ON DELETE SET NULL`**: as specified — a `BlogSourceItem` removal (soft-delete is
  the norm via `deletedAt`, but a hard delete is possible via admin tooling) must
  never cascade into deleting historical regulatory-signal audit rows.
- **Idempotent re-apply**: wrap the `ADD CONSTRAINT` in the project's existing
  `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` guard (seen
  in `20260726_phase0_content_marketing_agent_schema_reconciliation/migration.sql:10-38`)
  if this migration might run against a database where a partial prior attempt
  already added it. A first-time apply doesn't need it, but the project convention
  favors idempotent migration files over exactly-once ones.
- **Rollback**: `ALTER TABLE "RegulatorySignal" DROP CONSTRAINT "RegulatorySignal_sourceItemId_fkey"; DROP INDEX "RegulatorySignal_sourceItemId_idx";` — safe at any time since the column type/nullability never changed.
- **Post-migration verification**: re-run the orphan query (should return 0 rows);
  confirm `prisma generate` produces a `sourceItem` relation on the `RegulatorySignal`
  Prisma Client type; run `signal-classifier.service.test.ts` and
  `content.service.test.ts` unchanged (they should still pass — the FK doesn't change
  any read/write shape, only adds a constraint).

### Code impact

| Call site | Reads/writes `sourceItemId` | Impact |
|---|---|---|
| `reg-intel.agent.ts:142,366` | Writes | None — already always CUID-shaped from a real `BlogSourceItem`, per trace above. FK will not reject any current write. |
| `signal-classifier.service.ts:79,86` | Filters upstream | None — already drops empty-string candidates before they reach the writer. |
| `content.service.ts:218-244` (`getRecentHighImpactRegulatoryItems`) | Reads, passes through as optional | None — `sourceItemId: signal.sourceItemId ?? undefined` already null-handles; a FK-nulled orphan just becomes `undefined` here, same as today's legitimately-null rows. |
| `content.service.test.ts:129-156` | Test fixtures assert both null and populated cases | No test changes required; add one new test asserting a `sourceItem` relation can be `.select()`-ed if any new procedure needs it (see Foundation A's consumer in Domain Contract §10, triage). |
| W-CONTENT-01 (`n8n_W-CONTENT-01_regulatory_change_monitor.json`) | Forwards `sourceItemId` into `queueContentCandidate` | None — wire shape unchanged; this is a backend-only constraint. |
| `createDraftFromCandidate` / `suggestion-builder.ts:16-19` | Already treats `sourceItemId` as a hard `BlogSourceItem` FK via manual lookup | None — the FK formalizes a constraint this code already silently enforces at runtime with a thrown error instead of a DB constraint. |

No caller needs new null-handling: every existing consumer already treats
`sourceItemId` as optional/nullable.

---

## Foundation B — Structured AI output layer

Full design (interfaces, extraction algorithm, error classes, security rules, test
plan) is in `phase-b-structured-ai-design.md`. Summary of what's being built and why:

- **Gap**: `LLMGateway.complete()` (`llm-gateway.ts:158-261`) returns raw
  `LLMCompletionResult.content: string`. JSON compliance today is enforced by exactly
  one fixed prompt fragment, `aiConfig.systemPrompts.jsonOutput` (`ai.config.ts:196`):
  *"Always respond with valid JSON. Do not include any text before or after the JSON
  object."* — a convention, never validated. No caller in the codebase parses that
  output through a schema; `ai-draft-generation.service.ts` and
  `blog-verification.service.ts`'s dormant `useAiReview` branch both would need to
  hand-roll `JSON.parse` + manual field checks today.
- **New module**: `src/lib/ai/structured/completeStructured.ts`, layered strictly on
  top of `llmGateway.complete()` — it never bypasses cost tracking, budget checks,
  retry/timeout, or fallback logic, all of which stay exactly where they are inside
  `LLMGateway`.
- Every Pack 1 AI call (triage, research synthesis, claim verification, freshness
  analysis) is required to go through this layer. No Pack 1 procedure may call
  `llmGateway.complete()` directly and hand-parse JSON.

---

## Foundation C — Persisted `ContentOpsAlert`

### Current state (verified)

- `ContentOpsAlertService.sendAlert()` (`content-ops-alert.service.ts:38-58`) is a
  stateless, fire-and-forget email to `appConfig.marketing.adminNotificationEmail`.
  No DB write occurs; a send failure is caught and only logged
  (`content_ops_alert_failed`), never surfaced to the caller.
- Called from exactly two places today: `blog-draft.service.ts:172-178`
  (HIGH/URGENT auto-drafted suggestion) and `blog-draft.service.ts:260-265` (draft
  ready for verification).
- No `ContentOpsAlert` Prisma model exists.
- **A near-identical, already-proven persistence pattern exists**:
  `AutomationIncident` / `AutomationIncidentOccurrence` (schema.prisma:3621-3715).
  It already has `severity` (`AutomationIncidentSeverity`: INFO/LOW/MEDIUM/HIGH/CRITICAL),
  `status` (`AutomationIncidentStatus`: OPEN/ACKNOWLEDGED/RESOLVED/IGNORED),
  `firstSeenAt`/`lastSeenAt`/`occurrenceCount`, `workflowKey`, `correlationId`,
  `metadata Json?`, and a child `*Occurrence` table with its own
  `idempotencyKey String? @unique`. It is scoped to n8n/backend operational
  reliability incidents (`AutomationIncidentSource`: N8N/BACKEND/WEBHOOK), not
  editorial content events — reusing the same table would conflate "n8n workflow
  threw an error" with "an editorial candidate needs human attention," which have
  different owners, different dashboards, and different retention needs. **Decision:
  build `ContentOpsAlert` as a structural sibling that reuses its two existing enums
  directly, rather than inventing new ones for the same two concepts.**

### Model proposal

```prisma
enum ContentOpsAlertNotificationStatus {
  NOT_REQUIRED
  PENDING
  SENT
  FAILED
  SUPPRESSED
}

model ContentOpsAlert {
  id       String                     @id @default(cuid())
  type     String                     // e.g. "research_pack_gap_detected", "verification_blocked", "revision_recommended" — see §8 event list. Free-text like AutomationIncident.category, not an enum: Pack 1's event vocabulary will grow across W-CONTENT-04..07 and a closed enum would need a migration per new event type.
  severity AutomationIncidentSeverity // reused enum: INFO | LOW | MEDIUM | HIGH | CRITICAL
  status   AutomationIncidentStatus   @default(OPEN) // reused enum: OPEN | ACKNOWLEDGED | RESOLVED | IGNORED

  title   String
  summary String @db.Text // short operator-facing summary only — see guardrail below

  workflowKey String? // W-CONTENT-04..07, nullable because some alerts originate from admin actions, not a workflow run
  executionId String?

  entityType String // "BlogArticleSuggestion" | "BlogPost" | "BlogResearchPack" | "BlogVerificationRun" | "BlogFreshnessReview" | "BlogRevisionRequest"
  entityId   String

  occurrenceCount Int      @default(1)
  firstSeenAt     DateTime @default(now())
  lastSeenAt      DateTime @default(now())

  notificationStatus     ContentOpsAlertNotificationStatus @default(NOT_REQUIRED)
  notificationAttempts   Int                                @default(0)
  lastNotificationAt     DateTime?

  acknowledgedById String?
  acknowledgedAt   DateTime?
  resolvedById     String?
  resolvedAt       DateTime?
  resolutionNote   String? @db.Text

  metadata Json? // small structured pointers only (ids, counts, scores) — never article bodies, prompts, or credentials; see guardrail

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  acknowledgedBy User? @relation("ContentOpsAlertAcknowledgedBy", fields: [acknowledgedById], references: [id])
  resolvedBy      User? @relation("ContentOpsAlertResolvedBy", fields: [resolvedById], references: [id])

  @@index([status, severity])
  @@index([entityType, entityId])
  @@index([workflowKey, lastSeenAt])
  @@index([createdAt])
  // NOTE: the actual dedupe uniqueness constraint is NOT declared here as a Prisma
  // @@unique — see "Dedupe behavior" below (corrected). Prisma's schema DSL cannot
  // express the COALESCE-based expression unique index this requires, so it is
  // applied only in raw migration SQL and enforced by the service via a raw upsert.
}
```

**Enum decision**: `severity`/`status` reuse `AutomationIncidentSeverity` /
`AutomationIncidentStatus` verbatim rather than minting `ContentOpsAlertSeverity`
(INFO/WARNING/HIGH/CRITICAL, dropping LOW) / `ContentOpsAlertStatus`
(OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED, renaming IGNORED→SUPPRESSED) as the
illustrative brief proposed. The four-value severity scale and four-value status
scale already exist, already have a Postgres enum type, and already map cleanly onto
what a content alert needs, and introducing a second near-duplicate enum pair for
the sole reason of a label preference is exactly the kind of unnecessary-enum-
proliferation the audit brief itself warns against. `notificationStatus` **is** a
new enum (`ContentOpsAlertNotificationStatus`) because nothing in the codebase
already models "was a notification for this row sent" as an enum — the closest
precedent, `AutomationApproval.status` / `BlogSuggestionStatus`, model different
lifecycles.

**`status: IGNORED` vs. `notificationStatus: SUPPRESSED` — two different axes,
clarified explicitly (per required correction)**: these are easy to conflate
because both use "no action taken" vocabulary, but they answer different
questions and are set independently:
- `ContentOpsAlert.status = IGNORED` (reused `AutomationIncidentStatus` value) is
  a **human content decision**: a reviewer looked at the underlying editorial
  issue and decided it doesn't warrant action — this is a terminal content-review
  outcome, set only via an explicit admin action (functionally identical to
  "acknowledge and dismiss," reusing `IGNORED` rather than adding a redundant
  `DISMISSED` alongside `RESOLVED`).
- `ContentOpsAlert.notificationStatus = SUPPRESSED` is a **delivery-mechanics
  decision**: the alert itself is still `OPEN` (or any other status) and still
  represents a real, unresolved editorial issue — only the *email notification*
  for this particular occurrence was withheld, because the notification cooldown
  window (see below) hadn't elapsed since the last send. It is set automatically
  by `createOrIncrementAlert`, never by a human action, and never implies the
  underlying alert was reviewed or dismissed.
A row can legitimately be `status: OPEN, notificationStatus: SUPPRESSED`
(unreviewed, no new email sent because of cooldown) or `status: IGNORED,
notificationStatus: SENT` (a human dismissed it after having been emailed about
it) — the two fields are never conflated or derived from each other.

### Dedupe behavior (corrected)

Natural key: `(type, entityType, entityId, workflowKey)` — still not a computed
`dedupeKey` hash column, for the same reason as originally designed:
`ContentOpsAlert`'s cause is always already a structured tuple, unlike
`AutomationIncident.fingerprint`'s need to normalize free-text n8n error
messages.

**The original design's plain `@@unique([type, entityType, entityId,
workflowKey])` was wrong**: Postgres unique indexes treat `NULL` as
*distinct from every other value, including other `NULL`s* — so two separate
`ContentOpsAlert` rows with identical `(type, entityType, entityId)` but both
`workflowKey IS NULL` (e.g. two admin-originated alerts of the same type against
the same post) would **not** collide and would **not** dedupe, silently defeating
the entire point of this constraint for every non-workflow-originated alert.

Two fixes were possible; **the COALESCE expression-index approach is chosen**,
over making `workflowKey` non-null with `ADMIN`/`SYSTEM` sentinel values:

- ❌ **Rejected: non-null `workflowKey` with sentinel values.** This would
  overload `workflowKey`'s meaning — it is used elsewhere (operational events,
  `phase-b-procedure-contracts.md`) to mean specifically "which n8n workflow
  (`W-CONTENT-04..07`) produced this," and every future query filtering "show
  alerts from workflow X" or "show alerts NOT tied to any workflow" would have to
  know to special-case the `ADMIN`/`SYSTEM` literals rather than checking
  `IS NULL`. It also risks an accidental real collision if a future workflow is
  ever literally named `ADMIN` or `SYSTEM`.
- ✅ **Chosen: a raw SQL expression unique index using `COALESCE`.** `workflowKey`
  stays a true, semantically meaningful `String?` (null means "not
  workflow-originated," queryable directly via `IS NULL`). The uniqueness
  constraint is instead declared in migration SQL as:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS "ContentOpsAlert_dedupe_key"
    ON "ContentOpsAlert" ("type", "entityType", "entityId", (COALESCE("workflowKey", '')));
  ```
  Prisma's schema DSL cannot express an expression-based unique index (confirmed:
  `@@unique` only accepts column names, not expressions), so this constraint is
  **not** declared as a Prisma `@@unique` in `schema.prisma` at all — it exists
  only in the raw migration SQL (see `phase-b-migration-plan.md`). Because this
  project already applies migrations by hand rather than via `prisma migrate
  dev`/`deploy`, an index Prisma doesn't know about is not at risk of being
  silently dropped by any Prisma-driven schema diff.
  **Consequence for the service layer**: `createOrIncrementAlert` cannot use
  Prisma Client's typed `.upsert()` (which targets a Prisma-known unique
  constraint) to hit this index — it must issue the upsert as a raw query
  (`prisma.$executeRaw` with `INSERT ... ON CONFLICT (type, "entityType",
  "entityId", (COALESCE("workflowKey",''))) DO UPDATE SET ...`), documented here
  explicitly since it's the one place in Pack 1 that can't use Prisma Client's
  normal typed query builder.

- **Reopen rule**: `createOrIncrementAlert` upserts on the (COALESCE-based) unique
  key above. If the
  existing row's `status` is `RESOLVED` or `IGNORED` and a new occurrence of the same
  `(type, entityType, entityId, workflowKey)` arrives, it **reopens** to `OPEN` and
  resets `acknowledgedAt`/`resolvedAt` to null (an editorial issue recurring after
  resolution is new information, not a duplicate of the closed one) — while
  preserving `occurrenceCount`/`firstSeenAt` as a running history.
- **Occurrence increment**: `occurrenceCount += 1`, `lastSeenAt = now()` on every
  upsert hit, whether the row is open or being reopened.
- **Notification cooldown**: to avoid re-alerting on every single occurrence of a
  chronically-recurring issue, `sendAlert` is only invoked when
  `notificationStatus` is `NOT_REQUIRED`/`FAILED` **or** `lastNotificationAt` is
  older than a fixed cooldown (reuse the existing dedupe-TTL pattern from
  `blog-notification.service.ts`'s per-event TTLs, e.g. 12h for `verification_blocked`-class
  alerts, 24h for lower-severity ones — exact values are a product/ops tuning
  decision, not a Phase B blocker).
- **Acknowledgement**: sets `status = ACKNOWLEDGED`, `acknowledgedById`,
  `acknowledgedAt`; does not touch `occurrenceCount`/notification fields.
- **Resolution**: sets `status = RESOLVED`, `resolvedById`, `resolvedAt`,
  `resolutionNote`; a resolved alert can still be reopened per the rule above if the
  same underlying condition recurs.

### Service methods

Following the existing service-class + `Dependencies` constructor-injection pattern
used throughout `src/modules/agents/automation/*.service.ts` (see
`AutomationApprovalService`, `AutomationContentService` above):

```ts
export class ContentOpsAlertService {
  // existing method, unchanged signature — now internally persists before/around sending
  async sendAlert(input: ContentOpsAlertInput): Promise<void>;

  // new
  async createOrIncrementAlert(input: CreateOrIncrementAlertInput): Promise<ContentOpsAlert>;
  async acknowledgeAlert(input: { alertId: string; by: string }): Promise<ContentOpsAlert>;
  async resolveAlert(input: { alertId: string; by: string; resolutionNote?: string }): Promise<ContentOpsAlert>;
  async listOpenAlerts(input: ListOpenAlertsInput): Promise<ListOpenAlertsResult>;
  async getAlert(alertId: string): Promise<ContentOpsAlert | null>;
  async markNotificationResult(input: { alertId: string; status: 'SENT' | 'FAILED' }): Promise<void>;
}
```

### Integration: fire-and-forget email → persist-then-notify

```
createOrIncrementAlert(type, severity, entityType, entityId, workflowKey?, title, summary, metadata?)
  → upsert ContentOpsAlert row (dedupe/reopen/increment per rules above)
  → determine notification policy:
      - if notificationStatus is NOT_REQUIRED or (FAILED/SENT and cooldown elapsed):
          → call sendAlert() [existing email logic, unchanged]
          → markNotificationResult('SENT' | 'FAILED') based on outcome
      - else: notificationStatus stays as-is, no email sent (cooldown suppression)
  → return the persisted alert row (always succeeds independently of §notification outcome)
```

`sendAlert`'s existing signature and behavior (best-effort, catches and logs, never
throws) are preserved unchanged — `createOrIncrementAlert` wraps it, it doesn't
replace it. The two existing call sites in `blog-draft.service.ts` are migrated to
call `createOrIncrementAlert` instead of `sendAlert` directly, gaining persistence
with no behavior change to the email path itself. **Alert persistence must never be
rolled back because email delivery failed** — the DB write happens first, in its own
statement, before the notification attempt.

**Guardrail (per governing instructions, non-negotiable)**: `summary`/`metadata`
must never contain full article bodies, source documents, credentials, recipient
lists, or rendered prompts. `metadata` is typed as small structured pointers only
(ids, counts, scores, enum values) — the same discipline the existing
`AutomationIncident.metadata` and W-SHARED-ERR's redaction pass already enforce for
operational data (see `phase-b-security-review.md`).

---

## Foundation D — Shared publication-readiness evaluator

### Current state (verified — three independent implementations, not two)

1. **`blog.router.ts::adminSetStatus`** (lines 291-353, admin dashboard direct
   publish): requires `title`, `slug`, `excerpt`, **`content`**, `category`; ≥1
   source; category-specific official-source rule; blocks if latest verification is
   `BLOCKED`; blocks if latest AI draft (`draftGenerationRuns[0].createdAt`, **any**
   run regardless of whether it was ever applied) postdates the latest verification.
   Does **not** check `post.updatedAt` vs. verification time.
2. **`content.service.ts::publishContent`** (lines 107-167, agent/n8n pipeline
   publish): requires `title`, `slug`, `excerpt`, `category` — **`content` is
   deliberately not required** (comment at lines 90-99 explains publishing must
   never touch/require re-validating `content` to avoid clobbering a human edit).
   Same ≥1-source rule, same category rule, same verification-`BLOCKED` block, same
   AI-draft-vs-verification staleness block. Also does not check `post.updatedAt`.
   **This is a real, load-bearing behavioral difference from #1, not just duplicated
   code** — the two paths disagree on whether `content` must be non-empty to publish.
3. **`blog-automation.router.ts::adminGetLatestBlogVerification`** (lines 650-699,
   read-only display for the admin verification panel): computes `isStale` from
   `post.updatedAt > verificationTime` **or** any `source.updatedAt > verificationTime`,
   and computes `isAiStale` from the **latest draft-generation run's `createdAt`**
   (again, regardless of `appliedToPost`) postdating verification — setting `isStale
   = true` too whenever `isAiStale` is true. This is informational only; nothing
   currently uses it as a publish gate.
4. **`blog-staleness.ts::calculateBlogStaleness`** (lines 9-40) is a **fourth,
   currently-unused definition** — its `isAiStale` only counts a draft run where
   `run.appliedToPost && run.appliedAt` is set and postdates verification (i.e., a
   run that was actually applied to the post), which is stricter and more correct
   than #3's "any draft run exists" check. It is exercised only by
   `blog-staleness.test.ts`; grepping the full `src/` tree found no non-test caller.

**This is a genuine inconsistency, not a stylistic one**: publishing the exact same
post through the admin UI vs. the agent pipeline can produce different accept/reject
outcomes today (an empty-`content` post is rejected by #1 but would be accepted by
#2), and the "is this post stale" signal shown to a human reviewer (#3) uses a
looser definition of AI-staleness than the one already written and tested but never
wired in (#4).

**Corrected policy direction**: the shared evaluator converges on the *stricter*
of the two existing behaviors for the `content`-required check — #1's rule
(`content` must be non-empty to publish) is retained as the target policy for
**both** paths, not relaxed to #2's looser behavior as the original design
proposed. This means `content.service.ts::publishContent` (the agent/n8n path) is
the one that changes, gaining the `content`-required blocker it currently lacks —
`blog.router.ts::adminSetStatus` does not change. This is the opposite direction
from the original draft of this document, corrected because publishing an
empty-content post through the agent pipeline is a real defect, not a feature to
preserve for parity's sake — the original "keep the looser path's behavior" choice
was picked for the wrong reason (matching whichever path happened to be less
strict) rather than for the right one (what should actually be allowed to
publish). The evaluator remains **read-only** — it computes `ready`/`blockers`/
`warnings` and never itself mutates `BlogPost.content` or any other field; this
was already true in the original design and is unchanged.

### Required interface

```ts
// src/server/utils/publish-readiness.ts

export interface PublishReadinessFinding {
  code: string; // stable machine-readable code, e.g. 'MISSING_TITLE', 'VERIFICATION_BLOCKED'
  message: string;
}

export interface PublishReadinessResult {
  ready: boolean;
  blockers: PublishReadinessFinding[];
  warnings: PublishReadinessFinding[];
  evaluatedAt: Date;
  latestVerificationRunId?: string;
  isStale: boolean;
  isAiStale: boolean;
}

export async function evaluateBlogPublishReadiness(
  prisma: PrismaClient | Prisma.TransactionClient,
  blogPostId: string,
): Promise<PublishReadinessResult>;
```

### Consolidated checks (with the explicit behavior decision each one requires)

| Check | Source of truth today | Decision for the shared evaluator |
|---|---|---|
| title/slug/excerpt/category present | #1 and #2 agree | Keep as blockers. |
| `content` non-empty | #1 requires it, #2 doesn't | **Blocker on both paths (corrected).** Keep #1's stricter semantics: missing/empty `content` blocks publication everywhere. This changes #2's current behavior (`content.service.ts::publishContent`, the agent/n8n path, gains a check it currently lacks) — `blog.router.ts::adminSetStatus` is unchanged. Flagged as a deliberate, tested change to the agent path, not a silent one; see the burn-in rollout below, which surfaces every real post that would newly fail this gate before the check goes live. |
| ≥1 source | #1 and #2 agree | Keep as blocker. |
| category-specific official-source rule | #1 and #2 agree | Keep as blocker. |
| verification `BLOCKED` | #1 and #2 agree | Keep as blocker. |
| AI draft newer than verification | #1 and #2 agree, but both use "any draft run" (looser) instead of "applied draft run" (`calculateBlogStaleness`'s definition) | **Behavior decision required**: switch to `calculateBlogStaleness`'s stricter, already-tested `appliedToPost && appliedAt` definition. This can only ever make the gate *less* strict (an unapplied draft run — e.g., a generation the reviewer discarded — no longer blocks), which is a safe direction to move, but is still a behavior change from both #1 and #2 today. |
| `post.updatedAt`/source `updatedAt` staleness (`isStale`) | Only #3 computes it, and only for display | Expose as `isStale` on the result, **as a warning, not a blocker** — matches current behavior (neither live publish gate enforces it today) and avoids surprise regressions from a check that has never been load-bearing. |
| human-review requirement | Not checked anywhere today | New blocker — see Foundation E. |
| unresolved BLOCKING `BlogVerificationIssue` rows | Implicit in "verification status BLOCKED" today (status is derived from issue severities in `blog-verification.service.ts:257-263`) | Keep implicit via status; do not re-check issues directly to avoid a second source of truth. |
| unresolved critical/high `ContentOpsAlert` tied to this post | Doesn't exist today | New: only a blocker if an open `ContentOpsAlert` row has `entityType: 'BlogPost'`, `entityId: blogPostId`, and an explicit `metadata.blocksPublication: true` flag — **never** a blocker merely by virtue of severity, per the governing instruction ("Do not make ContentOpsAlert a publication blocker unless the alert is explicitly tied to the BlogPost and marked as blocking"). |
| future semantic verification state (Pack 1 Domain Contract §12) | Doesn't exist today | New blocker once implemented: any `BlogVerificationIssue` with `claimVerificationStatus IN ('UNSUPPORTED','CONTRADICTED')` and `severity IN ('BLOCKING')` — already covered by the "unresolved BLOCKING issue" rule above once semantic issues are persisted as `BlogVerificationIssue` rows (Domain Contract §12 reuses this table), so **no new blocker logic is needed**, only new issue rows flowing into the existing status computation. |

### Reuse points and safe refactor plan

1. Implement `evaluateBlogPublishReadiness` fresh in `src/server/utils/publish-readiness.ts`,
   composing `calculateBlogStaleness` (finally wiring the orphaned helper into
   production) rather than re-deriving staleness inline a fifth time.
2. Add a feature-flagged call from both `blog.router.ts::adminSetStatus` and
   `content.service.ts::publishContent` **alongside** their existing inline checks
   first (log-only: compute both, log a warning if they'd disagree, keep the old
   inline logic as the actual gate). This surfaces every real-world case where the
   two would diverge before the switch, without changing behavior yet.
3. After a burn-in period with zero unexplained divergences (or all divergences
   explicitly reviewed against the table above), replace each router/service's
   inline block with a call to `evaluateBlogPublishReadiness`, deleting the inline
   duplicate logic.
4. Wire into `adminGetLatestBlogVerification` (replacing its own third inline
   computation) and into `AutomationBlogDraftService`/future Pack 1 verification
   flow as a pre-approval check (`agents.automation.verifyBlogPostClaims` —
   note the flat tRPC path; see `phase-b-procedure-contracts.md` for the
   path-vs-capability distinction).
5. Add regression tests asserting the *documented* new behavior (`content`
   required as a blocker on the agent path specifically — the behavior change is
   one-directional, tightening `content.service.ts::publishContent`, not loosening
   `adminSetStatus`; plus applied-draft-only AI-staleness) for both admin and agent
   publish paths before deleting the old inline code, so the intentional behavior
   changes above are pinned by tests rather than discovered by an operator later.

---

## Foundation E — Enforce `requiresHumanReview`

### Current state (verified)

`BlogArticleSuggestion.requiresHumanReview` defaults `true` (schema.prisma:3320) and
is set by `relevance-scoring.service.ts` (always `item.sourceType !== 'OFFICIAL'`
via the `requiresOfficialSource` field it's conflated with — actually the scoring
service never sets `requiresHumanReview` explicitly, so every suggestion is created
with the Prisma column default of `true`, per `suggestion-builder.ts:62-84`'s create
call, which omits `requiresHumanReview` entirely). It is read **nowhere** in the
codebase outside its own field definition — confirmed by grep, and explicitly
documented as a known gap in `blog-draft.service.ts:81-83`'s comment: *"defaults true
but is not read/enforced anywhere else in this codebase."* Today,
`AutomationBlogDraftService.createDraftFromCandidate` auto-promotes every suggestion
from implicit `PENDING_REVIEW` straight to `APPROVED_FOR_DRAFT` regardless of this
flag (lines 142-149).

### Policy

`requiresHumanReview` becomes `true` when any of:

- No official source exists where the category requires one (mirrors the existing
  `requiresOfficialSource` computation already in `relevance-scoring.service.ts`,
  now also gating progression, not just informing the reviewer).
- `sourceQuality` is below `HIGH` for a HIGH/URGENT-priority suggestion.
- Conflicting sources are recorded in a linked research pack (Domain Contract §2).
- Any linked `BlogVerificationIssue` has `claimCategory` set (i.e., a semantic legal
  claim was extracted) and `claimVerificationStatus` is not `VERIFIED`.
- Verification status is `NEEDS_REVIEW` or `BLOCKED`.
- Jurisdiction is outside the supported set (`KE`/`MW`/`RW`/`NG`/`REGIONAL`/`GLOBAL` —
  reuses `BlogJurisdiction`; anything not in this enum can't occur post-Pack-1 since
  it's now a typed field, but this rule stays relevant for `RegulatorySignal`-derived
  candidates, which carry `jurisdiction` as a plain `String`).
- A linked research pack has unresolved `evidenceGaps`.
- A structured AI output's own confidence (Foundation B) is below a configured
  policy threshold for the use case (initial default: 0.7, tunable via
  `SystemConfig`, same pattern as `aiDailyCostLimit`).

### Computation policy (corrected — a shared function, computed and persisted, not recomputed ad hoc)

The original design left it implicit that each enforcement point (below) would
recompute this policy from scratch at the moment it runs. **Corrected**: a single
shared server-side function,
`computeRequiresHumanReview(suggestion, { researchPack?, verificationRun?,
triageRun? }): { value: boolean; reasons: string[] }`, is the **only** place this
policy is evaluated. It is called, and its result **explicitly persisted** onto
`BlogArticleSuggestion.requiresHumanReview` (an existing column — this is not a new
field), at two points:

1. **Suggestion creation** (`suggestion-builder.ts::createSuggestionFromSourceItem`)
   — computed once from the scoring result and source data available at creation
   time, replacing the current behavior of silently taking the Prisma column
   default (`true`) with no actual computation.
2. **Suggestion update**, whenever a signal the policy depends on changes — a
   linked `BlogResearchPack` completes, a `BlogVerificationRun`/`BlogEditorialTriageRun`
   completes, or an admin manually re-scores/re-links sources. Each of these call
   sites re-invokes `computeRequiresHumanReview` and persists the (possibly
   changed) result, rather than each enforcement point below independently
   re-deriving its own opinion of whether human review is required.

This gives one auditable, queryable, explicitly-set value (with a `reasons: string[]`
list persisted into `BlogArticleSuggestion` — either a new small `requiresHumanReviewReasons
String[] @default([])` column, or folded into existing free-text `reason`/
`suggestedNextAction` fields; **treated as an open, non-blocking implementation
choice**, not a Phase B blocker) rather than N independently-computed,
potentially-inconsistent answers to "does this need human review" scattered across
enforcement points.

**Backfill plan for existing suggestions**: every existing `BlogArticleSuggestion`
row today has `requiresHumanReview = true` **only** because that's the column
default — it was never actually computed by any of the policy triggers above (none
of them existed before Pack 1). Before the enforcement gate (below) is enabled:

1. A one-time backfill script runs `computeRequiresHumanReview` against every
   existing suggestion in a **non-terminal** status (`PENDING_REVIEW`,
   `NEEDS_MORE_SOURCES`) using whatever data already exists for it (current
   sources, any existing verification run), and persists the recomputed value.
2. Suggestions already in a **terminal** status (`APPROVED_FOR_DRAFT`,
   `DRAFT_CREATED`, `DISMISSED`, `DUPLICATE`) are **left untouched** — recomputing
   and retroactively flagging `requiresHumanReview=true` on a suggestion whose
   draft was already created (or dismissed) cannot undo an action that already
   happened, and would only produce a confusing, actionless flag on a closed
   record.
3. **The enforcement gate described below must not be turned on (feature-flagged
   off by default) until step 1 completes** — enabling enforcement against a
   population of suggestions whose `requiresHumanReview` value is still just the
   unconditional column default would either (a) block everything if the default
   is enforced literally, or (b) be meaningless if enforcement code accidentally
   ignores unbackfilled rows. This ordering requirement is a hard prerequisite,
   not a nice-to-have: **rollout order is backfill script → verify backfill
   completeness → enable enforcement**, never the reverse.

### Enforcement points (server-side, not UI-side)

**Corrected scope**: `requiresHumanReview=true` blocks exactly three actions —
automatic draft promotion, automatic approval creation, and publication. It does
**not** block research-pack generation; research is how the evidence needed for a
human decision gets gathered in the first place, so gating it on the very flag it
helps resolve would be circular (a suggestion could never accumulate the evidence
that might eventually clear the flag).

| Point | Where |
|---|---|
| Suggestion → research | **Not gated (corrected).** `createResearchPack` proceeds regardless of `requiresHumanReview` — research is explicitly allowed, and expected, to run on a suggestion still requiring human review, since its purpose is to gather the evidence a human needs to decide. The original design's refusal-to-start check is removed. |
| Draft creation | `AutomationBlogDraftService.createDraftFromCandidate` gains a check: if the suggestion's persisted `requiresHumanReview=true` (per the computation policy above — read, not recomputed, at this point), it stops at `PENDING_REVIEW` (current admin-review UI already exists for this) instead of auto-promoting to `APPROVED_FOR_DRAFT`. This is the one behavior change to an existing function, and it is exactly the gap Pack 1 is asked to close. |
| Research completion | A completed `BlogResearchPack` with `confidence` below threshold or non-empty `evidenceGaps`/`contradictions` triggers a re-invocation of `computeRequiresHumanReview`, persisting an updated value on the linked suggestion (if it changed) — this is research *feeding into* the shared computation, not a separate ad hoc check. |
| Approval creation | `AutomationApprovalService.createApproval` (unchanged signature) — callers (n8n workflows) must not call `createApproval` for a `BlogPost` whose latest suggestion still has persisted `requiresHumanReview=true` and no recorded human decision; this is enforced in `AutomationContentService.publishContent`'s pre-check (added), not by rewriting `createApproval` itself, since `createApproval` is a generic cross-department primitive. |
| Publication readiness | `evaluateBlogPublishReadiness` (Foundation D) adds a blocker if the linked suggestion has persisted `requiresHumanReview=true` and no `approvedById`/human decision is recorded. |
| Freshness → revision | `runFreshnessReview` sets `requiresHumanReview` semantics on the resulting `BlogRevisionRequest` (its own `status` starts at `PENDING_REVIEW`, never auto-`APPROVED`) whenever the freshness `action` is `URGENT_REVISION`, `ARCHIVE_RECOMMENDED`, or `HUMAN_REVIEW_REQUIRED`. |

### State transitions

The existing `BlogSuggestionStatus` enum (`PENDING_REVIEW → APPROVED_FOR_DRAFT →
DRAFT_CREATED`, plus `DISMISSED`/`DUPLICATE`/`NEEDS_MORE_SOURCES`) is **sufficient
and is not being replaced.** The illustrative lifecycle in the governing brief
(`PENDING_REVIEW → APPROVED_FOR_RESEARCH → RESEARCH_COMPLETE → APPROVED_FOR_DRAFT →
DRAFT_CREATED → VERIFICATION_REQUIRED → READY_FOR_APPROVAL`) was evaluated and
rejected: it would require a breaking enum migration across every existing
`BlogArticleSuggestion` row and every place that already switches on
`BlogSuggestionStatus` (the admin suggestions list/detail pages, `blog-notification.service.ts`,
`blog-editorial-digest.service.ts`'s counters). Instead:

- Research-pack progress is tracked on `BlogResearchPack.status`
  (`DRAFT`/`COMPLETE`/`SUPERSEDED`/`FAILED` — Domain Contract §11), a **separate**
  model from the suggestion, so the suggestion's own status vocabulary doesn't need
  to grow to represent "research in progress."
- Verification progress is already tracked on `BlogVerificationRun.status`
  (unchanged).
- The suggestion's `status` only needs to gain the *human-review gate* described
  above (staying at `PENDING_REVIEW` when it would otherwise auto-advance), not new
  states. `requiresHumanReview` plus the existing `approvedById`/`approvedAt` pair is
  sufficient to represent "blocked pending a human decision" without a new enum
  value.

**Justification for not introducing new statuses**: every intermediate state in the
illustrative lifecycle already has a home in an existing or newly-proposed *model*
(`BlogResearchPack.status`, `BlogVerificationRun.status`, `ContentOpsAlert.status`)
rather than needing to be folded into `BlogArticleSuggestion.status` as well —
doing so would make one enum responsible for three independent lifecycles
simultaneously, which is the kind of coupling the "reuse existing conventions"
guardrail argues against, not for.
