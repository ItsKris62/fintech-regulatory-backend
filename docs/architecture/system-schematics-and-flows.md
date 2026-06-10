# SheriaBot System Schematics and Flows

## Executive Summary

SheriaBot is a two-repository system: `fintech-regulatory-platform` is the Next.js frontend hosted on Vercel, and `fintech-regulatory-backend` is the Fastify/tRPC TypeScript backend hosted on Render. The backend exposes the root tRPC API at `/trpc` and also registers an SSE endpoint at `/api/compliance/stream` for streaming compliance answers. Authentication is based on Supabase-issued JWT bearer tokens, with Prisma/PostgreSQL as the application database, Upstash Redis for cache/session/rate-limit/usage counters, Pinecone-backed RAG for legal corpus retrieval, Cloudflare R2 for object storage, Anthropic/Claude for AI generation, and email/payment providers wired through backend services.

The diagrams below are based on code evidence only. Items that are configured or referenced but not fully verifiable from the inspected code are marked as needs verification.

## 1. System Context Diagram

```mermaid
flowchart LR
  subgraph Actors["Users and roles"]
    Startup["Startup user"]
    Enterprise["Enterprise user"]
    Regulator["Regulator"]
    PlatformAdmin["Platform admin"]
    OrgAdmin["Organization admin"]
  end

  subgraph Vercel["Vercel"]
    Frontend["Next.js frontend\nfintech-regulatory-platform"]
  end

  subgraph Render["Render"]
    Backend["Fastify + tRPC backend\n/trpc and /api/compliance/stream"]
  end

  DB["Supabase/PostgreSQL\nPrisma models"]
  Redis["Upstash Redis\ncache, rate limits, sessions, quotas"]
  Pinecone["Pinecone/vector DB\nRAG legal corpus"]
  R2["Cloudflare R2\nvault, docs, exports"]
  Claude["Anthropic/Claude\nAI generation"]
  Email["Email provider\nReact mailer/templates"]
  Payments["Payment providers\nStripe and M-Pesa/IntaSend"]

  Startup --> Frontend
  Enterprise --> Frontend
  Regulator --> Frontend
  PlatformAdmin --> Frontend
  OrgAdmin --> Frontend

  Frontend -->|"tRPC AppRouter types + Bearer JWT"| Backend
  Frontend -->|"SSE compliance stream"| Backend
  Backend --> DB
  Backend --> Redis
  Backend --> Pinecone
  Backend --> R2
  Backend --> Claude
  Backend --> Email
  Backend --> Payments
```

Evidence:
- `/trpc` is registered in `fintech-regulatory-backend/src/app.ts` via `fastifyTRPCPlugin` at lines around 390-392.
- `/api/compliance/stream` is registered by `registerComplianceStreamRoute` in `fintech-regulatory-backend/src/app.ts` and implemented in `src/routes/compliance-stream.route.ts`.
- The frontend tRPC client imports `AppRouter` from `@sheriabot/api-types` and sends `Authorization: Bearer ...` in `fintech-regulatory-platform/lib/trpc.ts`.
- Context injects Prisma, Redis, AI, RAG, storage, and mailer services in `fintech-regulatory-backend/src/server/trpc/context.ts`.
- Stripe and M-Pesa/IntaSend are inferred from code fields and routers (`payment.router.ts`, `billing.router.ts`, `PaymentProvider`, organization payment fields); exact production provider configuration needs verification.

## 2. Backend System Schematic

```mermaid
flowchart TB
  HTTP["Fastify HTTP server"]
  TRPC["tRPC root router\nappRouter"]
  Context["createContext\nBearer JWT, user, services"]

  subgraph Middleware["Access and control middleware"]
    Auth["protectedProcedure\nisAuthenticated"]
    Org["orgMemberProcedure\nactive org membership"]
    Plan["withPlanContext\nrequirePlanFeature"]
    Quota["checkUsageLimit\nRedis/trial counters"]
    Rate["rateLimited\nRedis limiter"]
    Admin["adminProcedure\nADMIN role"]
  end

  subgraph Routers["Mounted domain routers"]
    Core["auth, user, organization"]
    Compliance["compliance, complianceDashboard"]
    GapChecklist["gapAnalysis, checklist"]
    VaultDocs["vault, document, content"]
    Billing["billing, payment, usage, trial"]
    Enterprise["enterprisePolicy, customFramework, enterpriseContract"]
    Ops["calendar, notification, analytics, admin, alert, support"]
    RegOps["application, license, framework, pilot, marketing"]
  end

  subgraph Services["Shared services"]
    Prisma["Prisma client"]
    Redis["Redis client/cache/rate limiter"]
    RAG["RAG service"]
    AI["AI service/Claude client"]
    Storage["Cloudflare R2 storage service"]
    Export["DOCX/export services"]
    Audit["Logger + AuditLog writes"]
  end

  HTTP --> TRPC
  HTTP --> Stream["Compliance SSE route"]
  TRPC --> Context
  Context --> Middleware
  Middleware --> Routers
  Routers --> Services
  Stream --> Context
  Stream --> RAG
  Stream --> AI
  Stream --> Prisma
```

Evidence:
- `appRouter` mounts `auth`, `user`, `organization`, `policy`, `compliance`, `document`, `content`, `admin`, `notification`, `analytics`, `vault`, `billing`, `payment`, `support`, `adminSupport`, `calendar`, `usage`, `trial`, `session`, `pilot`, `checklist`, `complianceDashboard`, `gapAnalysis`, `framework`, `alert`, `adminMarketing`, `publicMarketing`, `enterprisePolicy`, `application`, `license`, `customFramework`, and `enterpriseContract` in `fintech-regulatory-backend/src/server/trpc/router.ts`.
- Middleware is defined in `src/server/trpc/trpc.ts` and `src/server/trpc/middleware.ts`: `protectedProcedure`, `adminProcedure`, `orgMemberProcedure`, `withPlanContext`, `requirePlanFeature`, `checkUsageLimit`, `rateLimited`.
- Shared context services are attached by `createContext` in `src/server/trpc/context.ts`.

## 3. Frontend System Schematic

```mermaid
flowchart TB
  App["Next.js App Router"]
  Public["Public routes\n/, pricing, blog, knowledge base, legal, pilot apply"]
  AuthRoutes["Auth routes\nlogin, register, verify, reset, callback"]
  Dashboard["Dashboard layout\nAuthGuard + sidebars"]
  PlanProvider["PlanProvider\nbilling.getPlanAndUsage"]
  FeatureGate["FeatureGate\nclient plan gating"]
  TRPCClient["tRPC React client\nAppRouter types"]
  AuthStore["Zustand auth store\naccess token + user"]

  subgraph Startup["Startup and enterprise workspace"]
    StartupHome["/startup"]
    ComplianceQuery["/startup/compliance-query"]
    GapAnalysis["/startup/gap-analysis"]
    Checklist["/startup/checklists"]
    Documents["/startup/documents"]
    Calendar["/startup/calendar"]
    CustomFrameworks["/startup/custom-frameworks"]
    Licenses["/startup/licenses"]
  end

  subgraph RegulatorArea["Regulator area"]
    RegulatorHome["/regulator"]
    LegalCorpus["legal corpus"]
    Frameworks["frameworks"]
    PolicyGenerator["policy generator"]
    RegAnalytics["analytics"]
  end

  subgraph AdminArea["Platform admin"]
    AdminHome["/admin"]
    UsersOrgs["users, organizations"]
    AdminBilling["billing, enterprise contracts"]
    AdminAnalytics["analytics, feedback"]
    AuditLogs["audit logs, security, system"]
    AdminContent["content, marketing, alerts, support"]
  end

  App --> Public
  App --> AuthRoutes
  App --> Dashboard
  Dashboard --> AuthStore
  Dashboard --> PlanProvider
  PlanProvider --> FeatureGate
  FeatureGate --> Startup
  FeatureGate --> RegulatorArea
  Dashboard --> AdminArea
  AuthStore --> TRPCClient
  TRPCClient --> Backend["Backend /trpc\nand stream endpoint"]
```

Evidence:
- Route inventory comes from `fintech-regulatory-platform/app/**/page.tsx`.
- `AuthGuard` redirects unauthenticated users and role-mismatched users in `fintech-regulatory-platform/components/auth-guard.tsx`.
- `PlanProvider` calls `trpc.billing.getPlanAndUsage` and exposes `hasFeature` in `fintech-regulatory-platform/lib/plan-context.tsx`.
- `FeatureGate` renders gated children or locked CTA fallback in `fintech-regulatory-platform/components/plan/feature-gate.tsx`.
- Streaming and tRPC compliance hooks coexist in `fintech-regulatory-platform/hooks/use-compliance.ts`.

## 4. Compliance Query Flow Diagram

```mermaid
sequenceDiagram
  actor User
  participant UI as Frontend compliance page
  participant Hook as useComplianceStream
  participant API as Backend /api/compliance/stream
  participant Auth as Supabase JWT + session checks
  participant Redis as Redis quotas/rate limits
  participant RAG as RAG/Pinecone retrieval
  participant Claude as Claude stream
  participant Orch as Router/Grader/Verifier
  participant DB as PostgreSQL/Prisma

  User->>UI: Enter compliance question
  UI->>Hook: submit(question)
  Hook->>API: POST /api/compliance/stream\nBearer access token
  API->>Auth: Verify JWT and resolve Prisma user/session
  API->>Redis: Enforce rate/plan/trial quota
  API->>RAG: Retrieve legal corpus context
  API->>DB: Create ComplianceQuery(status processing)
  API-->>Hook: SSE connected(queryId)
  API->>Claude: Stream grounded answer from prompt + RAG context
  Claude-->>Hook: SSE chunk events
  API-->>Hook: synthesis_complete
  API->>DB: Update ComplianceQuery(response, metadata)
  API->>Orch: Run router, grader, verifier when enabled
  Orch->>DB: Persist ComplianceQueryRun trace
  API->>DB: Update verified citations JSON
  API->>Redis: Increment successful usage
  API-->>Hook: done(route, grounded, abstained, citations, runId)
  Hook->>UI: Render answer, citations, feedback and abstain states
```

Legacy/non-streaming path:
- `trpc.compliance.query` exists in `fintech-regulatory-backend/src/server/routers/compliance.router.ts` and is exposed through `useComplianceQuery` in `fintech-regulatory-platform/hooks/use-compliance.ts`. The current `/startup/compliance-query` page imports and uses `useComplianceStream`, so the SSE route is the active wired path; the tRPC mutation is retained as the non-streaming fallback/legacy path.

Evidence:
- Frontend stream hook: `useComplianceStream` in `fintech-regulatory-platform/hooks/use-compliance.ts`.
- Frontend page wiring: `fintech-regulatory-platform/app/(dashboard)/startup/compliance-query/page.tsx` imports and calls `useComplianceStream`.
- Backend stream route: `registerComplianceStreamRoute` in `fintech-regulatory-backend/src/routes/compliance-stream.route.ts`.
- tRPC fallback mutation: `complianceRouter.query` in `src/server/routers/compliance.router.ts`.
- Orchestrator: `runOrchestrator` in `src/modules/compliance/orchestrator/orchestrator.ts`, with `ComplianceQueryRun` persistence.
- Feedback: `submitFeedback`, `getFeedback`, and saved-response procedures in `src/server/routers/compliance.router.ts`; frontend feedback components live under `fintech-regulatory-platform/components/compliance/`.

## 5. Gap Analysis Flow Diagram

```mermaid
sequenceDiagram
  actor User
  participant UI as Frontend gap analysis page
  participant API as tRPC gapAnalysis.runGapAnalysis
  participant MW as Auth/org/plan/quota middleware
  participant DB as PostgreSQL/Prisma
  participant R2 as Cloudflare R2
  participant Extract as Text extraction
  participant RAG as RAG/Pinecone retrieval
  participant Claude as Claude JSON analysis
  participant Zod as Zod parse/repair
  participant Export as DOCX export service

  User->>UI: Upload PDF/DOCX/DOC/TXT and select frameworks
  UI->>API: tRPC mutation with base64 file, frameworks, benchmarks
  API->>MW: Validate active org, plan features, usage quota
  API->>DB: Validate framework tier and benchmark documents
  API->>DB: Create GapAnalysis(status QUEUED/UPLOADING)
  API->>R2: Upload original file via storage service
  API-->>UI: Return analysis record for polling
  API->>Extract: Extract PDF/DOCX/DOC/TXT text
  Extract-->>API: Text or scanned/empty safety error
  API->>RAG: Retrieve framework and benchmark context
  API->>API: Sanitize prompt injection patterns
  API->>Claude: Single-pass or chunked gap analysis
  Claude->>Zod: Parse/repair/validate structured JSON
  API->>RAG: Post-hoc citation verification
  API->>DB: Save results, score, status COMPLETED/FAILED
  UI->>API: Poll getGapAnalysisResult/listGapAnalyses
  UI->>API: Request export
  API->>Export: Generate DOCX report
  Export->>R2: Upload generated report
  API-->>UI: Return report/download data
```

Evidence:
- tRPC entry: `gapAnalysisRouter.runGapAnalysis` in `fintech-regulatory-backend/src/server/routers/gap-analysis.router.ts`.
- Middleware gates: `withPlanContext`, `requirePlanFeature('gapAnalysis')`, `requirePlanFeature('benchmarkDocuments')`, and `checkUsageLimit(BillingMetric.GAP_ANALYSES, { deferIncrement: true })`.
- Pipeline: `ComplianceModule.runGapAnalysis` and `executeGapAnalysisPipeline` in `src/modules/compliance/compliance.module.ts`.
- Extraction: `extractPdfText` and `mammoth.extractRawText` in `executeGapAnalysisPipeline`.
- Safety: empty/scanned document guard and `sanitizePolicyText` from `src/lib/ai/prompts/gap-analysis.ts`.
- Structured validation/repair: `parseGapAnalysisOutput` and retry paths in `src/lib/ai/ai.service.ts`.
- Export: `gapAnalysisExportService.generateGapAnalysisDocx` in `src/services/gap-analysis-export.service.ts`; upload helper `storageService.uploadGapAnalysisExport`.

## 6. Document Vault / Upload Flow

```mermaid
sequenceDiagram
  actor User
  participant UI as UploadDocumentModal
  participant TRPC as tRPC vault router
  participant Vault as VaultModule
  participant Redis as Redis pending upload
  participant R2 as Cloudflare R2 vault bucket
  participant DB as PostgreSQL/Prisma
  participant Cron as Reconciliation cron

  User->>UI: Choose vault document
  UI->>TRPC: vault.getUploadUrl(metadata, declared size/type)
  TRPC->>Vault: generateUploadPresignedUrl
  Vault->>Vault: Enforce plan, MIME, file size, total quota
  Vault->>Redis: Store pending upload with TTL
  Vault-->>UI: Presigned PUT URL + required headers + documentId
  UI->>R2: Direct PUT file to R2
  UI->>TRPC: vault.confirmUpload(documentId)
  TRPC->>Vault: createDocument/confirm upload
  Vault->>Redis: Load pending upload
  Vault->>R2: HEAD metadata/size/type verification
  Vault->>R2: Compute SHA-256 content hash
  Vault->>R2: Malware scan object
  Vault->>DB: Create VaultDocument(uploadStatus VERIFIED)
  Vault->>Redis: Delete pending upload
  UI->>TRPC: vault.getDownloadUrl(id)
  TRPC->>R2: Generate presigned GET URL
  Cron->>R2: Scan vault prefix for orphan objects
  Cron->>DB: Scan VaultDocument rows for missing/hash-mismatched objects
```

Evidence:
- Frontend direct upload: `UploadDocumentModal` in `fintech-regulatory-platform/components/vault/upload-document-modal.tsx`.
- tRPC router: `fintech-regulatory-backend/src/server/routers/vault.router.ts`.
- Presign, pending state, confirmation, metadata verification, hashing, malware scan, DB write: `VaultModule.generateUploadPresignedUrl`, `storePendingUpload`, `loadPendingUpload`, `verifyVaultObjectBeforeConfirm`, `createDocument` in `src/modules/vault/vault.module.ts`.
- Reconciliation: `runVaultReconciliation` in `src/modules/vault/reconciliation.service.ts` and cron wrapper `src/scripts/vault-reconciliation-cron.ts`.

## 7. Auth and Authorization Flow

```mermaid
flowchart TB
  Register["auth.register\nrate-limit + password policy"]
  SupabaseCreate["Supabase admin\ncreate user / generate verification link"]
  UserRow["Prisma User\nOrganization / OrganizationMember"]
  EmailVerify["Verification email\nverifyEmail or confirmEmailCallback"]
  Login["auth.login\nSupabase signInWithPassword"]
  Session["Prisma Session\nRedis lastSeen/sessionStart/fingerprint"]
  Token["Access token + refresh token returned"]
  FrontendStore["Zustand auth store\nsetAccessToken"]
  Request["tRPC request\nAuthorization: Bearer"]
  Context["createContext\nSupabase getUser + cache lookup"]
  AuthZ["Authorization middleware"]
  Role["Role checks\nADMIN/REGULATOR/STARTUP/ENTERPRISE"]
  OrgMember["Org membership checks\nOrganizationMember ACTIVE"]
  Plan["Plan and entitlement checks"]
  AdminOnly["adminProcedure only"]

  Register --> SupabaseCreate --> UserRow --> EmailVerify
  Login --> Session --> Token --> FrontendStore --> Request
  Request --> Context --> AuthZ
  AuthZ --> Role
  AuthZ --> OrgMember
  AuthZ --> Plan
  Role --> AdminOnly
```

Evidence:
- Registration/login/logout/email verification/refresh deprecation: `fintech-regulatory-backend/src/server/routers/auth.router.ts`.
- Token validation and session enforcement: `createContext` in `src/server/trpc/context.ts`.
- Protected/admin/org/role middleware: `src/server/trpc/trpc.ts` and `src/server/trpc/middleware.ts`.
- Frontend token storage and tRPC header injection: `fintech-regulatory-platform/lib/auth-store.ts` and `lib/trpc.ts`.
- Refresh-token endpoint is explicitly deprecated in backend comments; frontend should use Supabase refresh (`auth.router.ts`, `refreshToken` procedure).

## 8. Data Model Relationship Schematic

```mermaid
erDiagram
  User ||--o{ OrganizationMember : has_memberships
  Organization ||--o{ OrganizationMember : has_members
  Organization ||--o{ User : legacy_primary_org
  User ||--o{ Session : has_sessions
  Organization ||--o{ UsageRecord : tracks_usage
  Organization ||--o{ Payment : has_payments
  Organization ||--o{ EnterpriseContract : has_contracts
  EnterpriseContract ||--o{ EnterprisePlanOverride : defines_overrides

  User ||--o{ ComplianceQuery : asks
  ComplianceQuery ||--o{ ComplianceQueryRun : has_traces
  ComplianceQuery ||--o{ QueryFeedback : receives_feedback
  User ||--o{ QueryFeedback : submits_feedback

  User ||--o{ Checklist : generates
  Organization ||--o{ Checklist : owns
  Checklist ||--o{ ChecklistItem : contains

  User ||--o{ GapAnalysis : runs
  GapAnalysis ||--o{ GapAnalysisFramework : snapshots_frameworks
  RegulatoryFramework ||--o{ GapAnalysisFramework : referenced_by

  User ||--o{ VaultDocument : uploads
  Organization ||--o{ VaultDocument : owns

  LegalDocument ||--o{ DocumentChunk : has_chunks
  User ||--o{ LegalDocument : authors

  Organization ||--o{ CustomFramework : owns
  CustomFramework ||--o{ CustomFrameworkSection : has_sections
  CustomFramework ||--o{ CustomFrameworkControl : has_controls
  CustomFramework ||--o{ CustomFrameworkVersion : versions

  User ||--o{ GeneratedPolicy : creates
  Organization ||--o{ GeneratedPolicy : owns
  GapAnalysis ||--o{ GeneratedPolicy : source_for
  GeneratedPolicy ||--o{ GeneratedPolicyCitation : cites
  GeneratedPolicy ||--o{ GeneratedPolicySourceSnapshot : captures_sources
  GeneratedPolicy ||--o{ GeneratedPolicyExportLog : exports
  GeneratedPolicy ||--o{ GeneratedPolicySectionVersion : section_versions
  GeneratedPolicy ||--o{ GeneratedPolicyGenerationEvent : generation_events

  Organization ||--o{ ComplianceEvent : schedules
  ComplianceEvent ||--o{ Notification : notifies
  User ||--o{ Notification : receives
  User ||--o{ AuditLog : actor
```

Evidence:
- Prisma schema models and relations are in `fintech-regulatory-backend/prisma/schema.prisma`.
- Important line anchors: `User` around line 9, `Organization` around 134, `ComplianceQuery` around 419, `ComplianceQueryRun` around 453, `Checklist` around 593, `GapAnalysis` around 657, `QueryFeedback` around 1205, `UsageRecord` around 1343, `CustomFramework` around 1387, `Payment` around 1597, `ComplianceEvent` around 1628, `VaultDocument` around 1789, `RegulatoryFramework` around 1839, `GeneratedPolicy` around 2366, `OrganizationMember` around 2568.
- `Subscription` is not a separate Prisma model in the inspected schema. Subscription state is stored mostly on `Organization` fields (`plan`, `subscriptionStatus`, Stripe IDs, M-Pesa fields), with `Payment`, `UsageRecord`, `EnterpriseContract`, and `EnterprisePlanOverride` supporting billing and entitlement state.
- The user prompt mentions `LegalDocument / DocumentChunk`; the schema also contains `RegulatoryDocument / RegulatoryDocumentChunk` for regulatory corpus content. Both are present; the ER diagram keeps `LegalDocument / DocumentChunk` to match the requested main entities and notes the regulatory corpus models as present.

## 9. Deployment Schematic

```mermaid
flowchart LR
  Browser["Browser/client"]
  Vercel["Vercel\nNext.js frontend"]
  RenderAPI["Render Web Service\nFastify/tRPC backend"]
  RenderCron["Render Cron Jobs\nvault, pilot, cleanup, marketing"]
  Supabase["Supabase/PostgreSQL\nPrisma datasource"]
  Upstash["Upstash Redis"]
  Pinecone["Pinecone vector DB"]
  R2["Cloudflare R2"]
  Anthropic["Anthropic API"]
  Email["Email provider\nReact mailer"]
  Stripe["Stripe\nneeds verification"]
  Mpesa["M-Pesa/IntaSend\nneeds verification"]

  Browser --> Vercel
  Vercel -->|"NEXT_PUBLIC_API_URL /trpc"| RenderAPI
  Vercel -->|"API compliance stream"| RenderAPI
  RenderAPI --> Supabase
  RenderAPI --> Upstash
  RenderAPI --> Pinecone
  RenderAPI --> R2
  RenderAPI --> Anthropic
  RenderAPI --> Email
  RenderAPI --> Stripe
  RenderAPI --> Mpesa
  RenderCron --> Supabase
  RenderCron --> Upstash
  RenderCron --> R2
```

Evidence:
- Backend server start uses `PORT` in `fintech-regulatory-backend/src/index.ts`.
- Render proxy assumptions are commented in `fintech-regulatory-backend/src/app.ts` and `src/plugins/security.plugin.ts`.
- Render cron references exist in `src/scripts/vault-reconciliation-cron.ts`, `pilot-lifecycle-cron.ts`, `cleanup-deleted-documents.ts`, `cleanup-compliance-snapshots.ts`, `bulk-send-cron.ts`, and `soft-bounce-cron.ts`.
- Frontend backend URL is `NEXT_PUBLIC_API_URL || http://localhost:4000/trpc` in `fintech-regulatory-platform/lib/trpc.ts`; the stream hook strips `/trpc` to call `/api/compliance/stream`.

## Assumptions / Needs Verification

- Hosting: code comments and request context indicate Vercel for frontend and Render for backend; deployment dashboards were not inspected.
- Pinecone: RAG service file names and behavior indicate vector retrieval, but specific Pinecone environment/index configuration was not inspected in this pass.
- Payment provider specifics: Stripe IDs and M-Pesa/IntaSend fields/procedures are present, but active production provider selection and webhook configuration need environment verification.
- Email provider: React email and mailer services are present, but the concrete provider credentials/configuration need environment verification.
- Frontend production path for compliance query is currently the SSE hook on `/startup/compliance-query`; the older `trpc.compliance.query` hook remains available and should stay behaviorally aligned if retained.
- `Subscription` is not a separate Prisma model; subscription state is embedded on `Organization` and related billing/payment models.

## Key Risks / Fragile Areas

- Compliance query has two live-capable paths: streaming SSE and tRPC mutation. Both need synchronized behavior for citations, quota increments, orchestration, and response shape.
- Plan and quota enforcement exists in middleware, but some frontend gates are only UX gates. The backend remains the source of truth; new procedures must use `withPlanContext`, `requirePlanFeature`, and `checkUsageLimit` consistently.
- Gap analysis returns before the background pipeline completes. Status recovery exists for stale jobs, but failed or partially completed jobs depend on polling and clear user feedback.
- Vault upload security depends on the Redis pending-upload TTL and successful confirmation. Reconciliation mitigates orphaned R2 objects and missing DB rows, but dry-run configuration must be verified before deletion is enabled.
- Organization access has both legacy `requireOrgMember` and newer `requireOrgMembership` middleware patterns. New code should prefer the cached/audited `orgMemberProcedure` path unless a specific legacy route requires otherwise.
- `ComplianceQuery.citations` stores JSON while a `Citation` relation also exists. Comments in the router note a TODO to migrate query citations to the `Citation` table.

## Recommended Next Diagrams

- Detailed entitlement and usage-metering state machine across free trial, pilot, paid plan, grace period, and enterprise overrides.
- RAG ingestion and legal corpus lifecycle diagram, including `RegulatoryDocument`, chunking, embeddings, and authority metadata updates.
- Billing/payment lifecycle diagram for Stripe and M-Pesa/IntaSend, including webhook paths and renewal cron jobs.
- Admin operations map covering audit logs, system config, feature flags, AI jobs, and platform analytics.
- Notification/eventing map showing notification creation, category preferences, email templates, SSE alerts, and background jobs.
