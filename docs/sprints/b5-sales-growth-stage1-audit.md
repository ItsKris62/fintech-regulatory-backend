# Phase B - Batch B5 (Sales/Growth Agent) - Stage 1 Read-Only Audit

**Status:** STAGE 1 COMPLETE - awaiting operator approval before Stage 2 implementation.
No code was changed to produce this document. All findings below are grounded in the
current state of the repo as of this audit (2026-07-02, backend `main`, clean working tree,
HEAD includes B3 commit `ae96f5bc` "feat(agent/reg-intel): implement regulatory intelligence
agent" and B4's marketing agent, both already isolated commits).

---

## 1. PostHog integration seam

**Finding: there is no PostHog integration anywhere in this backend - server or client.**

- No file in the repo references `posthog`, `PostHog`, or `posthog-node` (case-insensitive
 search across the full backend tree).
- `package.json` has no `posthog-node` / `posthog-js` dependency. The only analytics/telemetry
 packages present are Sentry (error tracking/tracing) and an in-house `AnalyticsEvent` Prisma
 model (DB-logged events, not PostHog).
- `.env.example` has no `POSTHOG_API_KEY`, `POSTHOG_HOST`, or `POSTHOG_PROJECT_ID`.

**This is a real gap, not a "client-side only" situation** - there is nothing to read from at
all today.

**Minimal read-only addition required** (Stage 2, if approved):
- New dependency: `posthog-node` (server-side SDK). **This triggers the spec's "stop and report
 before proceeding" rule for new dependencies** - flagging now rather than silently adding it
 in Stage 2.
- New env vars: `POSTHOG_API_KEY` (project API key, read scope is sufficient - PostHog's
 server SDK uses the same key for capture and query; no separate "read-only" key concept
 exists in PostHog), `POSTHOG_HOST` (e.g. `https://us.posthog.com` or self-hosted URL),
 `POSTHOG_PROJECT_ID`.
- Minimal capability needed: query `/api/projects/:id/query` (HogQL) or the persons/events
 endpoints for a given `organizationId`/user identifier - e.g. last-seen event timestamp,
 feature-usage event counts, trial-status property. No capture/track calls, no property
 writes.

**Recommended fallback per spec Section 2.2:** ship B5 with `engagement-lookup.service.ts` returning
a typed `{ available: false }` result unconditionally in this first cut, since no read path
exists yet and adding one is a new-dependency decision the operator should make explicitly
(the spec's Stage 2.2 already anticipates and mandates this graceful-degradation path). This
means B5 can proceed today with degraded (lower-priority, no-engagement-claim) outreach
drafting and no new dependency, and the PostHog read integration can be a follow-up decision.

---

## 2. Pilot data model - outreach personalization fields

**`Organization`** (`prisma/schema.prisma` ~lines 150-251) - has a genuine primary-contact
concept, no need to fall back to `User`:
- `name`, `organizationType` (`"regulator" | "startup" | "enterprise"`), `industry`,
 `cbkLicenseNumber`, `website`, `size`
- `contactPerson` (name), `contactPosition` (title), `contactEmail`, `contactPhone` - **this is
 the primary-contact field set for outreach.**
- `plan` (`REGULATOR | STARTUP | BUSINESS | ENTERPRISE`), `subscriptionTier`,
 `subscriptionStatus`, `trialEndsAt`

**`PilotAccess`** (~lines 1530-1557) - per user+org pilot grant:
- `status` (`ACTIVE | EXPIRED | REVOKED | CONVERTED`), `startsAt`, `expiresAt`,
 `extensionCount`, `convertedAt`, `convertedPlan`
- FKs: `userId`, `organizationId`

**`User`** (~lines 9-148) - also carries pilot fields directly (`isPilot`, `pilotCohort`
 - this is where `PILOT_COHORT_001` lives - , `pilotStartedAt`, `pilotExpiresAt`,
`pilotAccessStatus`, `pilotExtensionCount`, `pilotConvertedAt`), plus `email`, `fullName`,
`phone`.

**Conclusion:** `Organization.contactPerson/contactEmail/contactPhone` is the primary
personalization source (matches B3's own `PilotFintechImpact.userEmail`/`userId` shape closely
enough to cross-check). Fall back to the `User` row (via `PilotAccess.userId` or
`Organization.users`) only when `Organization.contactEmail` is null. `pilotCohort` for
PILOT_COHORT_001 tracking lives on `User`, not `PilotAccess` - B8 synthesis note.

---

## 3. B3's `recommendedActions.sales` contract - actual shape (differs from spec's assumed shape)

Source: `src/modules/agents/regulatory-intelligence/types.ts` (~lines 129-152).

```ts
export interface RecommendedAction {
 category: 'marketing' | 'sales' | 'corpus';
 signalId?: string;
 actionType: string;     // e.g. 'targeted_outreach'
 priority: RegulatorySeverity; // 'critical'|'high'|'medium'|'low'|'informational'
 brief: string;
 organizationId?: string;
 sourceUrl?: string;
}

export interface RegIntelRecommendedActionsPayload {
 version: 1;
 generatedAt: string;
 marketing: RecommendedAction[];
 sales: RecommendedAction[];
 corpus: RecommendedAction[];
}
```

**Fields the spec assumed but that do not exist:** `companyName`, `suggestedMessageBrief`.
The real fields are `brief` (not `suggestedMessageBrief`) and no `companyName` - company name
must be resolved by joining `organizationId` -> `Organization.name`.

**Persistence:** `RegIntelRecommendedActionsPayload` is stored whole, as JSON, in
`AgentReport.recommendedActions` (JSONB column, no separate table). It is **write-once** - no
action-level `status` field exists anywhere in this payload.

**"Un-actioned" query:** there is no built-in notion of actioned/un-actioned at the B3 layer.
B5 must determine this itself, and the natural mechanism is exactly B4's own dedup pattern:
compute a `sourceFingerprint` from `(signalId, organizationId)` and rely on a unique DB
constraint on `SalesOutreachDraft` - once a draft exists for that pair, the entry is
implicitly "actioned" from B5's perspective (regardless of B3 report status). No B3 changes
needed; this satisfies the spec's Stage 1 item 5 (dedup design) using the same fingerprint
approach B4 established, extended from `(contentType, sourceFingerprint)` to
`(sourceFingerprint)` alone since B5 only has one draft "type" (outreach draft) rather than
B4's two content types.

**Richer context available on `RegulatorySignal.pilotFintechsAffected`** (JSONB array,
`PilotFintechImpact[]`, defined alongside `RegulatorySignal` in the same types.ts): each entry
carries `organizationId`, `organizationName`, `userId`, `userEmail`, `cohort`, `reason`,
`matchedFields`. **This is a better grounding source for the `triggerReason` than
`RecommendedAction.brief` alone** - B5 should read both: `RecommendedAction` for the
signalId/organizationId/priority pairing, and the matching `PilotFintechImpact` entry (by
`organizationId`) on the referenced `RegulatorySignal.pilotFintechsAffected` for the concrete,
grounded `reason` text and `organizationName`.

**`RegulatorySignal`** full field list confirmed at `prisma/schema.prisma` ~lines 3419-3458:
`id, sourceUrl, normalizedUrl, contentHash, sourceItemId, sourceMonitorId, jurisdiction,
regulatoryBody, documentType, title, summary, severity, affectedSectors, affectedObligations,
effectiveDate, complianceWindowDays, corpusGapDetected, corpusGapDetails,
pilotFintechsAffected, rawContent, agentRunId, status, providerTrace, createdAt, processedAt,
reviewedAt`.

---

## 4. Existing outreach/email template shape

`src/emails/templates/marketing/` (B4-era, Resend-based) has a reusable shape worth mirroring
structurally (not the send path): `ComplianceUpdateEmail.tsx` - badge, greeting, opening
(regulator + title + date), plain-English summary box, "who is affected" section, CTA. Subject
pattern: `"{regulatorName} update: {updateTitle}"`. `MarketingBaseLayout.tsx` requires an
`unsubscribeUrl` for DPA 2019 compliance - **not applicable to B5** since B5 never sends
anything, but the subject+body field shape (`subject: string`, structured body sections) is a
reasonable template for `SalesOutreachDraft.subject`/`.body`.

---

## 5. Dedup design (mirrors B4's `sourceFingerprint`)

B4's pattern (`prisma/manual/20260702_add_marketing_draft.sql`):
`@@unique([contentType, sourceFingerprint])`, fingerprint = sorted-and-joined signal IDs,
insert failures caught as Prisma `P2002` and silently skipped (`persistDraft` returns `null`,
logs `dedup_skipped`).

B5 equivalent: fingerprint = `signalId|organizationId` (single pair, not a sorted list, since
each sales draft always traces to exactly one signal + one org - confirmed by
`RecommendedAction.signalId?`/`organizationId?` both being singular optional fields, not
arrays). `UNIQUE (sourceFingerprint)` directly on `SalesOutreachDraft`, same
catch-P2002-return-null pattern in the orchestrator.

---

## 6. `agentsRouter` structure - where `sales.*` attaches

`src/server/routers/agents.router.ts` currently composes three groups: top-level `agents.run.*`
/ `agents.report.create` (lines ~32-62), `marketing: router({...})` (lines 72-105), and
`regIntel: router({...})` (lines 106-132, added by B3, itself following B4's `marketing`
pattern one-for-one). `sales: router({...})` attaches as a fourth sibling at the same level,
after `regIntel`. Confirmed pattern per sub-router:
- `agentProcedure('agents.sales.draft.create')` -> `runDrafting`
- `agentProcedure('agents.sales.draft.read')` -> `listDrafts`, `getDraft`
- `adminProcedure` (NOT `agentProcedure`) -> `reviewDraft`, reading `ctx.user!.id` for
 `reviewedBy` - exact B4 precedent (`agents.router.ts` lines 93-104).

**Capability allowlist:** `src/modules/agents/agent-credential.service.ts` lines 17-26,
`AGENT_CAPABILITIES` array. Adding `'agents.sales.draft.create'` and
`'agents.sales.draft.read'` is a two-line additive change to that array only. Note: per
existing code (line ~225), the SERVICE credential is granted the *entire* `AGENT_CAPABILITIES`
array undifferentiated - capability *scoping* happens entirely at the router level via which
`agentProcedure('...')` string each endpoint declares, not per-agent-identity filtering. This
confirms B5 needs zero changes to `agentProcedure`/middleware evaluation logic itself, matching
the spec's constraint.

---

## 7. Migration map

**CREATE:**
- `prisma/manual/20260702_add_sales_outreach_draft.sql` - additive DDL for
 `SalesOutreachDraft`, mirroring `20260702_add_marketing_draft.sql`'s shape/comment style
 (Chris runs manually in Supabase; no `prisma migrate`).
- `src/modules/agents/sales/types.ts`
- `src/modules/agents/sales/engagement-lookup.service.ts` (+ `.test.ts`)
- `src/modules/agents/sales/outreach-drafter.service.ts` (+ `.test.ts`)
- `src/modules/agents/sales/sales-growth.agent.ts` (+ `.test.ts`)
- `src/modules/agents/sales/sales.safety.test.ts` (mirrors `marketing.safety.test.ts`'s
 zero-write-path regex scan, adjusted for Organization/User/PilotAccess/CRM/send-path names)
- `src/modules/agents/sales/signal-selector.service.ts` (+ `.test.ts`) - queries un-actioned
 `AgentReport.recommendedActions` sales entries via the fingerprint-based dedup in Section 5, cross
 referencing `RegulatorySignal.pilotFintechsAffected` per Section 3.

**MODIFY (additive only):**
- `prisma/schema.prisma` - add `SalesOutreachDraft` model + back-relation field on `AgentRun`
 (`salesOutreachDrafts SalesOutreachDraft[]`), same as B4 added `marketingDrafts`.
- `src/modules/agents/agent-credential.service.ts` - add two capability strings to
 `AGENT_CAPABILITIES` (lines 17-26).
- `src/server/routers/agents.router.ts` - add `sales: router({...})` sibling after `regIntel`.
- `KNOWN_ISSUES.md` - log the 2 pre-existing `enterprise-policy` router test failures (verified
 live: `enterprise-policy.router.test.ts:91` and one other in the same file/suite, both PDF
 export message assertions) as an already-existing baseline, per verification gate step 3.
 Confirmed not already logged there (no `enterprise-polic` hits in that file today).

**Zero writes confirmed to:** `Organization`, `User`, `PilotAccess`, any CRM-equivalent table,
Resend send path (`src/lib/resend/*`), suppression/consent tables. **No protected surface
touched** (RAG, `document.router.ts`, `LegalDocument`, Pinecone, `compliance-stream.route.ts`,
`src/modules/compliance/orchestrator/*`, R2). **No new dependency required** if the PostHog gap
is handled via the graceful-degradation path in Section 1 (recommended); a dependency addition is
only needed if the operator wants live PostHog reads in this same batch, in which case Stage 2
stops and reports before adding `posthog-node`.

---

## 8. Verification gate baseline (pre-check)

- Exactly one lockfile present: `package-lock.json`. No `pnpm-lock.yaml`/`yarn.lock`.
- Backend working tree is clean; B3 (`ae96f5bc`) and B4 are each isolated prior commits - B5
 starts clean, satisfying the B3/B4 isolation precondition.
- `AgentRun.status` already supports `HALTED_BUDGET`/`HALTED_ITERATIONS` (no schema change
 needed for budget tracking - confirmed in `src/modules/agents/agent-run.service.ts` lines
 16-22).
- Redis pattern confirmed as `redis.set(key, value, { ex: ttl })` throughout (no `setex`
 usage anywhere in the codebase).
- Ran `enterprise-policy.router.test.ts` + `enterprise-policy-frontend-wiring.test.ts` live:
 **2 failed, 18 passed**, both failures are PDF-export message string assertions in
 `enterprise-policy.router.test.ts` - pre-existing, unrelated to any B-batch work, currently
 undocumented in `KNOWN_ISSUES.md`.

---

## Open decision for operator

PostHog: proceed with the graceful-degradation stub (`{ available: false }`, no new dependency,
recommended) in this batch, or approve adding `posthog-node` + three new env vars now so B5
ships with live engagement lookups from day one?
