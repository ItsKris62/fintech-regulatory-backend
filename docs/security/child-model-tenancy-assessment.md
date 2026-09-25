# Child Model Tenant Isolation Assessment (SEC-13)

## Architectural Tenancy Policy for Child Models

To prevent cross-tenant data leakage and eliminate IDOR risks across child entities of tenant-scoped parents, SheriaBot enforces **Policy B**:

- **Policy B (Mandatory Parent Relation Scoping)**:  
  All child model queries and mutations must navigate through the verified parent relation scoped by tenant organization (e.g., `where: { id, parent: { organizationId: orgId } }` or loading via `ctx.tenantPrisma.<parent>.include: { <children>: true }`). Direct, unscoped primary key access via `ctx.prisma.<childModel>.findUnique` or `findFirst` is strictly prohibited in non-admin procedures and will be enforced via ESLint AST rules.
  
*(Note: Schema denormalization of `organizationId` onto child models is deferred to Phase 4).*

---

## Severity Framing

All severity ratings in this assessment reflect **the inherent risk to tenant isolation if a new user-facing endpoint or procedure is introduced without explicit parent-organization verification**.

- **High**: The entity contains critical legal/statutory filings, regulator correspondence, financial data, or already exhibits an un-scoped `findUnique({ where: { id } })` pattern in service code.
- **Medium-High**: The entity contains sensitive intellectual property or complete versioned history of enterprise legal policies.
- **Medium**: General child entity containing operational telemetry, citations, or dormant entities (with High impact if exposed).

---

## Child Model Tenancy Audit Matrix

| Child Model | Parent Model & Tenant Field | Router Direct Fetch by ID (`findUnique`/`findFirst`) | Contains Sensitive Data? | Severity (Risk if New Unscoped Endpoint Added) | Recommended Policy |
|---|---|---|---|---|---|
| `ChecklistItem` | `Checklist` (`organizationId`) via `checklistId` | **Partially Present** in `checklist.service.ts:1061` (`findUnique({ where: { id: input.itemId } })`). Service resolves parent `checklist` and calls `verifyOwnership(checklist, userId, orgId)` on line 1079 before mutating. | **High** (Compliance action items, deadlines, statutory penalties, internal audit notes) | **High** | **Apply Policy B**: Require queries and mutations to scope via `checklist: { organizationId: orgId }`. |
| `ApplicationDocument` | `RegulatoryApplication` (`organizationId`) via `applicationId` | **None**. `application.router.ts:179` creates records only after `assertApplicationAccess`. | **Critical** (Statutory license application attachments, confidential corporate filings) | **High** | **Apply Policy B**: Require all document accesses to route through parent `RegulatoryApplication` with verified `organizationId`. |
| `ApplicationRegulatorFeedback` | `RegulatoryApplication` (`organizationId`) via `applicationId` | **None**. `application.router.ts:197` creates feedback records only after `assertApplicationAccess`. | **Critical** (Official regulator correspondence, deficiency notices, statutory directives) | **High** | **Apply Policy B**: Require regulator feedback accesses to route through parent `RegulatoryApplication` with verified `organizationId`. |
| `GeneratedPolicySectionVersion` | `GeneratedPolicy` (`organizationId`) via `generatedPolicyId` | **Safe Pattern**. `enterprise-policy.router.ts:436, 543, 627` fetches versions with `where: { generatedPolicyId: policy.id }`, where `policy` is pre-validated via `getAccessiblePolicy`. | **High** (Complete version history, policy diffs, draft revisions, editor identities) | **Medium-High** | **Apply Policy B**: Maintain strict relation scoping requiring verified `generatedPolicyId` on parent `GeneratedPolicy`. |
| `ApplicationFee` | `RegulatoryApplication` (`organizationId`) via `applicationId` | **None**. `application.router.ts:188` creates fee records only after `assertApplicationAccess`. | **High** (Regulatory licensing fees, currency, payment status) | **Medium** | **Apply Policy B**: Require queries to route through parent `RegulatoryApplication` with verified `organizationId`. |
| `ApplicationTimelineEvent` | `RegulatoryApplication` (`organizationId`) via `applicationId` | **None**. `application.router.ts:163` creates events only after calling `assertApplicationAccess`. | **High** (Regulatory filing milestones, statutory submission events) | **Medium** | **Apply Policy B**: Require timeline queries to route through parent `RegulatoryApplication` with verified `organizationId`. |
| `ComplianceQueryRun` | `ComplianceQuery` (`organizationId`) via `complianceQueryId` | **Safe Pattern**. `compliance.router.ts:405` queries `complianceQueryId: query.id`. `compliance.router.ts:2283` queries `findFirst({ where: { id: input.runId, complianceQueryId: input.queryId } })` after verifying `complianceQuery`. | **High** (RAG telemetry, model verdicts, generated sub-queries, routing verdicts, jurisdiction resolution) | **Medium** | **Apply Policy B**: Maintain query scoping requiring verified `complianceQueryId` on parent `ComplianceQuery`. |
| `ComplianceAnswerClaim` | `ComplianceQuery` (`organizationId`) via `complianceQueryId` | **None**. Internal to `claim-verification.ts`, operated by parent query ID. | **High** (Extracted claims and assertions from legal and regulatory analysis) | **Medium** | **Apply Policy B**: Access exclusively through parent `ComplianceQuery` relation; cascade delete on query cleanup. |
| `ComplianceClaimCitation` | `ComplianceAnswerClaim` → `ComplianceQuery` (`organizationId`) via `claimId` | **None**. Created and accessed exclusively via parent claim context. | **Medium** (Verbatim excerpts, verification verdicts, confidence levels) | **Medium** | **Apply Policy B**: Access exclusively through parent `ComplianceAnswerClaim` and `ComplianceQuery`. |
| `Citation` | `Policy`, `ComplianceQuery`, `LegalDocument` (`organizationId`) via `policyId`, `complianceQueryId`, `documentId` | **None**. Created via pipelines; queried by parent ID (`findMany({ where: { policyId } })`). | **Medium** (Statutory citations, verified legal excerpts, confidence scores) | **Medium** | **Apply Policy B**: Require parent relation filtering on `organizationId` in all read queries. |
| `DocumentChunk` | `LegalDocument` (`organizationId`) via `documentId` | **None**. Only accessed via `count({ where: { documentId } })` in `document.router.ts:748` after parent access is asserted. | **High** (Full text chunks and vector embeddings of confidential corporate and legal documents) | **Medium** | **Apply Policy B**: Enforce that chunk queries always traverse parent `LegalDocument`. |
| `DocumentShare` | `LegalDocument` (`organizationId`) via `documentId` | **None** currently in user-facing routers (dormant model). | **High** (External share tokens, download metrics, access revocations) | **Medium** *(High if exposed)* | **Apply Policy B**: Validate share tokens strictly against parent `LegalDocument.organizationId`. |
| `Comment` | `Policy` (`organizationId`) via `policyId` | **None** in active routers (dormant model). | **High** (Internal policy review commentary, legal opinions, user discussions) | **Medium** *(High if exposed)* | **Apply Policy B**: Require policy commentary endpoints to query via parent `Policy` relation scoped by `organizationId`. |
| `GeneratedPolicyCitation` | `GeneratedPolicy` (`organizationId`) via `generatedPolicyId` | **None**. Pipeline operations only; purged and recreated by `generatedPolicyId`. | **Medium** (Legal citations, statutory references in generated policies) | **Medium** | **Apply Policy B**: Maintain strict cascading scoping through parent `GeneratedPolicy`. |
| `GeneratedPolicySourceSnapshot` | `GeneratedPolicy` (`organizationId`) via `generatedPolicyId` | **None**. Pipeline creation only. | **Medium** (Source text extracts, snapshots of regulatory acts) | **Medium** | **Apply Policy B**: Scope exclusively via parent `GeneratedPolicy`. |
| `GeneratedPolicyGenerationEvent`| `GeneratedPolicy` (`organizationId`) via `generatedPolicyId` | **None**. Generation telemetry events logged during pipeline execution. | **Low** (Pipeline progress logs, step execution timing) | **Medium** | **Apply Policy B**: Keep child relation to `GeneratedPolicy`. |
| `GapAnalysisFramework` | `GapAnalysis` (`organizationId`) via `gapAnalysisId` | **None**. `gap-analysis.router.ts:280` creates records using `result.id` right after creating `GapAnalysis` with `organizationId`. | **Medium** (Regulatory framework alignment for enterprise customer) | **Medium** | **Apply Policy B**: Retain parent scoping via `GapAnalysis`. |
| `AiJobEvent` | `AiJob` (`organizationId`) via `jobId` | **None**. Logged internally during job worker execution. | **Medium** (AI task execution events, system progress, error stack traces) | **Medium** | **Apply Policy B**: Maintain foreign key scoping through `AiJob` (`organizationId`). |
| `PilotEvent` | `PilotAccess` (`organizationId`) via `userId` | **Admin Aggregation Only** (`pilot.router.ts:574` calls `ctx.prisma.pilotEvent.count()` in `adminProcedure`). No user-facing read by ID. | **Medium** (User telemetry, pilot testing activity, feature usage) | **Medium** | **Apply Policy B**: Scope telemetry accesses through parent `PilotAccess` entity by `userId` and `organizationId`. |

---

## Summary of Findings & Next Steps

1. **Current Security Posture**:
   No active IDOR or cross-tenant leaks exist in the current router codebase. All child models with user-facing write/read endpoints are either verified upstream via parent checks (`assertApplicationAccess`, `getAccessiblePolicy`, `verifyOwnership`) or scoped by verified foreign keys (`complianceQueryId: query.id`).
2. **Implementation Schedule**:
   Per the Phase 1.1 Scope Freeze, no schema migrations or router modifications are performed in this pass. Implementation of Policy B AST guardrails and any subsequent Phase 4 denormalization will follow established milestone schedules.
