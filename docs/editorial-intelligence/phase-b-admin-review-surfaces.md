# SheriaBot Pack 1 — Phase B: Admin Review Surface Proposal

Status: design proposal. No frontend code has been written. This is intentionally
minimal — Phase B scope is design only; implementation is a later, explicitly
approved phase.

## What already exists (verified, `fintech-regulatory-platform/`)

- Full reviewer surface for the current blog pipeline already lives under
  `app/(dashboard)/admin/content/blog/`: suggestions list/detail, source-items list
  with a detail drawer, sources (monitor) CRUD, a full post editor with an embedded
  verification panel (staleness warnings, issue list, "Run Verification" button),
  and editorial digests list/detail.
- A separate, generic `automation/approvals` page already implements the
  confirm-dialog-with-reason + server-authorized-mutation + tRPC-invalidate-on-success
  pattern this proposal reuses verbatim.
- Every write action across both surfaces is an `adminProcedure` mutation deriving
  the actor from the session — no client-only state, no optimistic "approved" flash.
- Design system: shadcn/ui (`components.json`: style "default", neutral base,
  lucide icons), `sonner` toasts, `date-fns`.
- Two known, pre-existing defects to be aware of, not fixed by this proposal unless
  a new surface directly depends on them:
  - `content/blog/suggestions/[id]/page.tsx:187-196` has three quick-action buttons
    (Approve/Needs-More-Sources/Dismiss) with no `onClick` handler — dead UI. The
    triage detail page below reuses this page's layout conventions but must not
    copy this defect forward.
  - Tables are inconsistently hand-rolled `<table>` vs. shadcn `Table` primitives
    across existing pages — new pages should use the shadcn `Table` component
    consistently, not match whichever inconsistency happens to be nearest.

## What's missing

No admin surface exists for `agents.regIntel.*`/`agents.productBi.*`/
`agents.securityOps.*` output, and none exists for raw `AgentRun`/`AgentReport`
records, or for anything Pack 1 introduces (`BlogEditorialTriageRun`,
`BlogResearchPack`, semantic verification issues, `BlogFreshnessReview`,
`BlogRevisionRequest`, `ContentOpsAlert`). All of the following are net-new pages,
not extensions of an existing route.

## Proposed surfaces (minimum viable, per governing instruction "do not redesign the whole admin dashboard")

| Page | Route | Purpose | Backed by |
|---|---|---|---|
| Editorial triage queue | `admin/content/editorial/triage` | List `BlogEditorialTriageRun` rows, filterable by `recommendation`/`status`, sorted by `finalScore` desc | `getEditorialTriage`-equivalent **admin** query (new `blogAutomationRouter.adminListEditorialTriageRuns`, not the agent-facing procedure — admin pages call admin-scoped procedures per existing convention, never the `agentProcedure`-gated automation endpoints directly) |
| Triage detail | `admin/content/editorial/triage/[id]` | Full triage row: deterministic vs. AI score breakdown, rationale, recommendation, linked source item/suggestion | `adminGetEditorialTriageRun` |
| Research-pack detail | `admin/content/editorial/research/[id]` | Objective, executive summary, source list with trust category/availability/contradiction badges, evidence gaps, version history (prior superseded versions linked) | `adminGetResearchPack`, `adminListResearchPackVersions` |
| Verification report | Extends existing `content/blog/[id]/page.tsx` verification panel | Add semantic-claim rows (category, verification status, confidence, evidence link) alongside existing structural issues in the same list — **not** a new page, since a verification report is meaningless without the post it's about, and the panel already exists | `adminGetLatestBlogVerification` (extended to include the new `claimCategory`/`claimVerificationStatus`/`confidence` fields on returned issues — additive response shape change, no breaking change to existing consumers since fields are additive) |
| Freshness review queue | `admin/content/editorial/freshness` | List `BlogFreshnessReview` rows due/overdue, filterable by `action`/`riskTier` | `adminListFreshnessReviews` |
| Revision recommendation detail | `admin/content/editorial/revisions/[id]` | Reason, evidence, recommended changes, assign/accept/dismiss actions | `adminGetRevisionRequest`, `adminAssignRevisionRequest`, `adminResolveRevisionRequest`, `adminDismissRevisionRequest` |
| ContentOpsAlert list/detail | `admin/content/editorial/alerts` | Open alerts, filterable by `severity`/`type`/`entityType`; acknowledge/resolve actions. Displays `status` (content-review outcome: OPEN/ACKNOWLEDGED/RESOLVED/IGNORED) and `notificationStatus` (delivery-mechanics outcome: NOT_REQUIRED/PENDING/SENT/FAILED/SUPPRESSED) as two **separate** badges — never conflated into one, since a row can legitimately be `OPEN` + `SUPPRESSED` (unreviewed, email withheld by cooldown) at the same time (see `phase-b-foundations.md` Foundation C) | `adminListContentOpsAlerts`, `adminAcknowledgeContentOpsAlert`, `adminResolveContentOpsAlert` |

All seven are grouped under a new "Editorial Intelligence" section in
`admin-sidebar.tsx`'s existing "Content" nav group (alongside Blog/Blog
Sources/Source Items/Blog Suggestions/Blog Digests), not a new top-level nav
section — this is additive to an existing, already-approved navigation grouping.

## Reuse points (all confirmed patterns, none invented)

- `adminProcedure` for every new query/mutation, matching all 29 existing
  `blogAutomationRouter` endpoints.
- shadcn `Table`, `Card`, `Badge`, `Dialog`/`AlertDialog`, `Sheet` (for detail
  drawers, matching `source-items/page.tsx`'s pattern), `Textarea` for reason
  fields.
- Server-derived reviewer identity: every acknowledge/resolve/assign/dismiss
  mutation takes only an id and reads `ctx.user!.id` server-side for the
  `acknowledgedById`/`resolvedById`/`assignedToId` — never a client-supplied user
  id, matching `recordApprovalDecision`'s `by: ctx.user!.id` pattern exactly.
- Confirmation dialogs with a reason field for resolve/dismiss actions (min-length
  validated), matching the suggestions page's dismiss-reason pattern
  (`suggestions/page.tsx:293`, ≥5 chars).
- `utils.<router>.<query>.invalidate()` on every mutation success — no optimistic
  local state.

## Required fix carried forward

If the triage detail page's design is modeled on
`content/blog/suggestions/[id]/page.tsx` (a reasonable starting template, since
both are "AI-scored candidate awaiting a human decision" pages), the three inert
quick-action buttons on that page (lines 187-196) should be fixed as part of
implementing the triage page, not copied forward as a second instance of the same
defect. This is scoped as a one-line addition (wire the existing dialogs already
present on the page to their obviously-intended `onClick` handlers) — flagged here
per the governing instruction to recommend the fix if Pack 1 work depends on that
page's pattern.

## Explicitly out of scope for this proposal

- No redesign of the existing suggestions/sources/digests pages.
- No new design-system components — everything above is composed from the 50
  existing shadcn primitives already in `components/ui/`.
- No changes to `automation/approvals` — Pack 1's human-review gates (Foundation E)
  surface through the *existing* `BlogArticleSuggestion` admin pages (which already
  show `requiresHumanReview`-adjacent state) and the new pages above, not through
  the generic automation-approval queue, which remains scoped to the
  publish/newsletter/outreach approval gate it already serves.
