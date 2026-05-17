# Orchestrator Rollback Runbook

**Created:** 2026-05-17  
**Applies to:** Stage 2 production cutover — `ORCHESTRATOR_ENABLED=true` flip  
**Owner:** Engineering lead

---

## Context

Stage 2 shipped two components that can be rolled back independently:

1. **The orchestrator** — activated by `ORCHESTRATOR_ENABLED=true` in the Render environment. When enabled, the SSE route and tRPC `compliance.query` mutation run the Router → Grader → Verifier pipeline synchronously and write `ComplianceQueryRun` rows with `shadow=false`.
2. **The streaming SSE frontend** — the compliance query page (`startup/compliance-query/page.tsx`) uses `useComplianceStream` to consume `/api/compliance/stream` instead of the legacy `useComplianceQuery` tRPC mutation. This is a frontend deployment change, separate from the env var.

These two layers have separate rollback procedures.

---

## Rollback 1 — Kill switch: env-flip (primary, fastest)

**When to use:** Error rate spikes on `/api/compliance/stream`, ComplianceQueryRun rows not writing, or orchestrator errors visible in Render logs. This is the first response to any backend regression.

**What it reverts:**
- The orchestrator pipeline (router, grader, verifier) is disabled. The SSE route falls back to the legacy grounded path: RAG retrieval → answer synthesis → fire-and-forget shadow orchestrator. The `done` event is emitted immediately after synthesis without waiting for orchestrator verdict.
- The tRPC `compliance.query` mutation reverts to its legacy grounded-query path.

**What it does NOT revert:**
- The streaming SSE route (`POST /api/compliance/stream`) remains active and continues serving users. The route URL, event shape, and frontend hook are unchanged.
- `ComplianceQueryRun` rows written during the live period (`shadow=false`) persist in the database — they are not deleted or modified by the rollback.
- New queries during the rollback period produce `ComplianceQueryRun` rows with `shadow=true` (fire-and-forget shadow path on the legacy grounded response).

**Procedure:**
1. In Render dashboard → SheriaBot Backend service → Environment → set `ORCHESTRATOR_ENABLED=false`
2. Trigger a manual redeploy (or wait for Render auto-deploy if the var change triggers one)
3. Verify within ~2 minutes: `GET /health` returns 200; confirm backend log shows `orchestratorEnabled: false` in the startup log (`type: "app_config_loaded"`)
4. Monitor `/api/compliance/stream` error rate for 5 minutes post-redeploy

**Time to recovery:** ~2–3 minutes (Render redeploy).

---

## Rollback 2 — Frontend revert (deeper, use only if streaming itself is broken)

**When to use:** The SSE streaming endpoint (`/api/compliance/stream`) is inherently broken (e.g., SSE transport issue, heartbeat failure causing Render idle-timeout disconnects, or browser EventSource compatibility regression) AND the env-flip alone does not resolve user-facing errors. The tRPC `compliance.query` mutation continues to work.

**What it reverts:**
- The compliance query page is reverted from `useComplianceStream` (SSE hook) to `useComplianceQuery` (tRPC mutation). Users see the legacy UX: single-request/response, no streaming, no live typing effect.
- This is a **frontend deployment** (Vercel / Next.js). It does not change any backend env vars.

**What it does NOT revert:**
- The `/api/compliance/stream` SSE endpoint remains deployed and active on the backend. It continues accepting requests but the frontend page no longer calls it.
- `ComplianceQueryRun` rows written during the live period persist. After the frontend revert, the tRPC mutation still fires the fire-and-forget shadow orchestrator (if `ORCHESTRATOR_ENABLED=true` remains), so rows continue writing with `shadow=true`.
- The orchestrator itself may still be active (`ORCHESTRATOR_ENABLED=true`) — this is independent. You may combine the frontend revert with the env-flip if both need to go down.

**Procedure:**
1. In `fintech-regulatory-platform/app/(dashboard)/startup/compliance-query/page.tsx`, revert the import and usage from `useComplianceStream` back to `useComplianceQuery`.
2. Remove the `AbstainCard`, `UngroundedBanner`, and streaming-state renders; restore the legacy mutation-based render path.
3. Deploy the frontend to Vercel: `git push` or trigger Vercel redeploy.
4. Verify: compliance query page submits via tRPC mutation and renders a complete response (no streaming).

**Time to recovery:** ~5–10 minutes (frontend build + Vercel deploy).

---

## Data state during rollback

| State | ComplianceQueryRun rows |
|-------|------------------------|
| Pre-cutover (shadow mode) | `shadow=true` from fire-and-forget |
| Post-cutover, ORCHESTRATOR_ENABLED=true | `shadow=false` — primary orchestrator writes |
| After env-flip rollback | New rows: `shadow=true` from fire-and-forget on legacy path; prior `shadow=false` rows unchanged |
| After frontend revert | Same as env-flip; tRPC mutation fires shadow orchestrator if enabled |

Existing `shadow=false` rows written during the live production period are **never deleted or modified** by any rollback. They remain available for analysis and for the Stage 2.5 `vectorId` citation fix.

---

## Decision tree: which rollback to use

```
User reports broken compliance query page
          │
          ▼
Is /api/compliance/stream returning errors?  (check Render logs + /health)
    │                         │
   YES                        NO
    │                         │
    ▼                         ▼
Rollback 1 (env-flip)     Is the streaming UX broken client-side?
Monitor 5 min             (broken chunks, no done event, blank page)
    │                         │
Did errors clear?            YES
    │                         │
   YES → Done            Rollback 2 (frontend revert)
    │                    Monitor 5 min
    NO                        │
    │                    Did errors clear?
    ▼                         │
Investigate further      YES → Done
(not env-related)             │
                             NO → Escalate; check Render infra
```

**Rule:** Never attempt to debug forward through a live regression. If Rollback 1 does not clear errors within 5 minutes, proceed immediately to Rollback 2 while simultaneously escalating.

---

## Monitoring targets during 30-minute production window

| Signal | Source | Threshold |
|--------|--------|-----------|
| Error rate on `/api/compliance/stream` | Render logs | Any 5xx sustained >2 min |
| Error rate on `compliance.query` tRPC | Render logs | Any 5xx sustained >2 min |
| `ComplianceQueryRun` rows with `shadow=false` | Supabase table | Should be writing; verify at 5 min mark |
| p95 latency | Render monitoring / logs | Alert if sustained >60s (2× staging p95) |
| User-reported issues | Support channels | Any report of blank query page or infinite loading |

---

## Cross-references

- `KNOWN_ISSUES.md` — Stage 2 completion section → points to this runbook
- `KNOWN_ISSUES.md` §C9 — FREE_TRIAL plan not resolved in SSE auth (Stage 3 fix; not a rollback trigger)
- `KNOWN_ISSUES.md` §C11 — Citation join fallback (Stage 2.5 fix; not a rollback trigger)
- `KNOWN_ISSUES.md` §C12 (if present) — SSE abstain-route synthesis waste (Stage 2.5 fix; not a rollback trigger)
