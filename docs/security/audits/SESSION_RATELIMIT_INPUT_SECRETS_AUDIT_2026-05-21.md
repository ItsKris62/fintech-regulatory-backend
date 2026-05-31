# Security Audit â€” Session, Rate Limiting, Input Validation, Secrets

**Date:** 2026-05-21
**Auditor role:** Senior Web Application Security Engineer
**Scope:** Read-only, no code changes.
**Methodology:** OWASP ASVS L2 cross-checked against the SheriaBot trust boundary.

## 0. System Mental Model

The SheriaBot backend relies on Fastify, tRPC, and Prisma, leveraging Supabase Auth to issue JWTs and Upstash Redis for caching and rate limiting. Session enforcement occurs in tRPC middleware via `context.ts` to extract the Supabase user, complemented by custom middleware like `requireOrgMembership` that derives tenant scoping and checks the `OrganizationMember` status. Rate limiting is centrally managed using a sliding-window Redis implementation mapped to IP or authenticated user identifiers across public, API, and global limits. Input validation relies extensively on Zod schemas passed into tRPC `.input()` handlers and webhook route parsers, ensuring type safety before business logic execution. Secrets and API keys are loaded and validated via `app.config.ts` and `env.validator.ts`, with integrations pointing to Pinecone, Anthropic, Stripe, and Cloudflare R2, employing specific header authorizations, though legacy webhook endpoints present signature verification challenges.

## 1. Executive Summary

- Total findings: 9 (C: 0, H: 1, M: 3, L: 4, Info: 1)
- Top 3 risks ranked by exploitability Ã— impact:
  1. **IV-2 (High):** IntaSend Webhook lacks HMAC verification, risking unauthenticated execution paths.
  2. **RL-1 (Medium):** `content.getBySlug` is an unauthenticated endpoint missing rate limits, allowing knowledge base scraping.
  3. **SK-3 (Medium):** Pino logger lacks global PII/secret redaction, risking unstructured token/PII leakage into log aggregators.
- Overall posture: **Adequate**. The system has seen rapid recent hardening (IDOR closures, `requireOrgMembership` normalization, `$queryRawUnsafe` removal, and trial quota race condition fixes). The remaining gaps are largely defense-in-depth, configuration hygiene, and observability deficiencies.

## 2. Workstream 1 â€” Session Management

### SA-2 — No Concurrent Session Cap or Per-Role Fingerprint Enforcement

- **Severity:** Medium
- **CWE:** CWE-613 (Insufficient Session Expiration)
- **Location:** `src/server/routers/auth.router.ts:468-520`, `src/server/trpc/context.ts:75-93`, `src/server/trpc/context.ts:256-314`.
- **Evidence:** Login creates a new `Session` row and fingerprint key, but the flow does not query or cap existing active sessions. `SESSION_FINGERPRINT_MODE` is globally parsed as `off`/`monitor`/`enforce`; in monitor mode, mismatches are logged but not revoked.
- **Risk:** A stolen ADMIN token can operate in parallel with the legitimate admin until token expiry or explicit revocation. For ADMIN accounts, monitoring-only fingerprinting is insufficient because compromise can affect users, organizations, billing, and content surfaces.
- **Recommendation:** Document a concurrent-session policy and evaluate per-role fingerprint enforcement or trusted-device controls for ADMIN accounts.
- **Effort to fix:** M

### Verified Controls (no finding)

- **BE-O-015 Fix:** Verified `updateMemberRole` inside `src/server/routers/organization.router.ts:544-636` correctly drops the `sheriabot:orgmem:{userId}:{organizationId}` cache and keeps `OrganizationMember.role` synced.
- **isOrganizationMember Equality Check:** Verified the brittle equality-only middleware from Phase A (`src/server/trpc/middleware.ts:146`) was removed and replaced by robust `orgMemberProcedure`.

## 3. Workstream 2 â€” Rate Limiting

### RL-1 â€” Public Endpoint `content.getBySlug` Lacks Rate Limiting

- ~~**Severity:** Medium~~
- **Severity:** Low
- **CWE:** CWE-770 (Allocation of Resources Without Limits or Throttling)
- **Location:** `src/server/routers/content.router.ts:391-430`
- **Evidence:**

```typescript
getBySlug: publicProcedure
  .input(z.object({ slug: z.string() }))
  .query(async ({ input, ctx }) => {
    // No rate limiter applied
    // Returns htmlContent and metadata
  });
```

- **Risk:** An unauthenticated attacker can continuously enumerate/scrape published content and create avoidable DB load. The endpoint returns only records whose `contentStatus` is `PUBLISHED`, including `htmlContent`, `content`, SEO metadata, public counts, and author display fields (`src/server/routers/content.router.ts:391-430`). This is public content rather than authenticated, paywalled compliance analysis, so the residual risk is scraping and availability, not data breach.
- **Recommendation:** Apply basic bot protection or a generous per-IP public-content limiter that does not impede normal crawling or browsing.
- **Effort to fix:** S

**Revision note (2026-05-21):** Downgraded from Medium to Low because the procedure returns published content intended for public read access. Rate limiting should be SEO-aware and aimed at abusive automation, not ordinary indexing.

### RL-2 â€” String Coercion Flaw in Trust Proxy Configuration

- **Severity:** Low
- **CWE:** CWE-346 (Origin Validation Error)
- **Location:** `src/app.ts:59`
- **Evidence:**

```typescript
const app = Fastify({
  logger: false,
  trustProxy: process.env.TRUST_PROXY ?? true,
});
```

- **Risk:** If an operator explicitly configures `TRUST_PROXY="false"` in the environment, the string `"false"` evaluates as truthy in JavaScript. Fastify will inadvertently trust all `X-Forwarded-For` headers, allowing trivial client IP spoofing to bypass IP-keyed rate limits like those on `applyForPilot`.
- **Recommendation:** Evaluate strictly: `trustProxy: process.env.TRUST_PROXY === 'false' ? false : (process.env.TRUST_PROXY ?? true)`.
- **Effort to fix:** S

### Public Endpoint Inventory Table

| Endpoint             | Authenticated | Rate Limit | Identifier        | Fail Mode | Notes                                  |
| -------------------- | ------------- | ---------- | ----------------- | --------- | -------------------------------------- |
| `applyForPilot`      | No            | Yes (5/hr) | IP (`ctx.req.ip`) | Closed    | Fixed in Sprint 3 Batch 3 (BE-C-011)   |
| `content.getBySlug`  | No            | No         | N/A               | N/A       | Scraping risk (Finding RL-1)           |
| `auth.*` (login/reg) | No            | Yes        | IP/Email          | Closed    | Verified sliding-window implementation |
| Stripe Webhook       | No            | Yes        | IP/Sig            | Closed    | Verified                               |
| IntaSend Webhook     | No            | Yes        | IP                | Closed    | Lacks HMAC verification (Finding IV-2) |

### Verified Controls (no finding)

- **FREE_TRIAL SSE quota bypass:** Verified that `resolveEffectivePlan` is invoked for `/api/compliance/stream` and properly caps trial users per `FREE_TRIAL_LIMITS` (BE-Z-026 fix from Sprint 3 Batch 1).
- **FollowUp compliance query:** Verified `followUp` applies `.use(checkUsageLimit(...))` with `deferIncrement: true` (BE-X-024 fix).

## 4. Workstream 3 â€” Input Validation

### IV-1 â€” Stripe Webhook Fragile Signature Error Matching

- **Severity:** Low
- **CWE:** CWE-390 (Detection of Error Condition Without Action)
- **Location:** `src/app.ts:117-130`
- **Evidence:**

```typescript
if (err instanceof Error && err.message.includes("No signatures found")) {
  // handle verification error
}
```

- **Risk:** The error distinction relies on exact string matching against the Stripe SDK's error message. If Stripe updates their internal error verbiage, genuine signature failures will fall through to general 500s. Stripe will then exponentially retry failing payloads indefinitely, burying real operational logs.
- **Recommendation:** Assert exact type: `err instanceof stripe.errors.StripeSignatureVerificationError`.
- **Effort to fix:** S

### IV-2 â€” IntaSend Webhook Missing HMAC Verification

- ~~**Severity:** High~~
- **Severity:** Medium
- **CWE:** CWE-345 (Insufficient Verification of Data Authenticity)
- **Location:** `src/lib/intasend/webhook.service.ts:6-9` and `src/app.ts:25-30`
- **Evidence:**

```typescript
// IntaSend does not sign webhook bodies, so we cannot verify authenticity via HMAC.
// On every webhook receipt we re-call intaSendService.getPaymentStatus(invoice_id)
```

- **Risk:** While the SSRF mitigation (checking DB invoice existence before querying IntaSend) prevents rogue outbound data extraction, the endpoint remains entirely unauthenticated to ingress. Attackers can spam forged payloads with enumerated `invoice_id`s, causing the application to issue thousands of outbound HTTP requests to the IntaSend status API.
- **Recommendation:** Apply per-IP rate limiting on the webhook ingress route and enforce the existing IP allowlist/challenge controls consistently in code. Do not recommend additional vendor challenge mechanisms without a current IntaSend documentation citation proving configurability.

**Revision note (2026-05-21):** Downgraded from High to Medium. The evidence states IntaSend does not provide HMAC signatures, and the implementation re-checks invoice existence and upstream payment status before state changes, neutralizing direct forgery and SSRF-style exploitation. The remaining credible risk is outbound-amplification DoS against the application's IntaSend status checks.

- **Effort to fix:** M

### IV-3 — Procedures Missing Explicit Zod Input Boundaries

- **Severity:** High
- **CWE:** CWE-20 (Improper Input Validation)
- **Location:** See Appendix B rows where `Has .input() = NO`.
- **Evidence:** Appendix B enumerates 55 registered tRPC procedures without an explicit `.input()` boundary across admin, analytics, billing, compliance, notification, pilot, trial, usage, user, vault, and other routers.
- **Risk:** Procedures without explicit input schemas rely on handler assumptions and TypeScript-only contracts. Where a handler later starts reading `input`, the API boundary will accept arbitrary runtime payloads unless Zod is added first.
- **Recommendation:** Add explicit `.input(z.void())` for no-input procedures and shared bounded schemas for every procedure that accepts client data.
- **Effort to fix:** M

### IV-4 — High-Volume Schemas Contain Weak or Opaque Field Validators

- **Severity:** Medium
- **CWE:** CWE-20 (Improper Input Validation)
- **Location:** See Appendix E weak-field rows.
- **Evidence:** Appendix E identifies unbounded token strings, non-CUID semantic IDs, unbounded array items, a free-form M-Pesa phone number, and `z.any()` TipTap JSON on high-call-volume or high-impact procedures.
- **Risk:** The weak fields do not directly bypass authorization, but they increase parser, storage, log, and downstream service risk on compliance, billing, vault, marketing, and enterprise-policy flows.
- **Recommendation:** Replace semantic IDs with `.cuid()`/`.uuid()`, add max lengths to token and markdown fields, constrain M-Pesa phone format, bound array items, and replace opaque `z.any()` with a narrow TipTap document schema or explicit size guard.
- **Effort to fix:** M

### Verified Controls (no finding)

- **`$queryRawUnsafe` Removal:** Verified `executeRawQuery` was deleted completely in Sprint 1 Batch 3 (BE-F-005). No unsafe Prisma injections remain.
- **`generateChecklistAsync` RBAC:** Verified explicit `ctx.user!.role === 'REGULATOR'` throw logic was added before the Redis lock (Sprint 1 Batch 2).

## 5. Workstream 4 â€” Secret & API Key Handling

### SK-1 â€” Stale Environment Configuration in Deployment Manifest

- ~~**Severity:** Medium~~
- **Severity:** Low
- **CWE:** CWE-1188 (Insecure Default Initialization of Resource)
- **Location:** `render.yaml:31-43`
- **Evidence:**

```yaml
- key: REDIS_URL
  sync: false
- key: JWT_SECRET
  sync: false
- key: HUGGINGFACE_API_KEY
  sync: false
```

- **Risk:** The canonical infrastructure-as-code configuration maps to the deprecated Railway architecture. A fresh Render instance provisioned using `render.yaml` will fail to inject the correct Upstash/Supabase tokens (`UPSTASH_REDIS_REST_URL`, `SUPABASE_JWT_SECRET`), resulting in immediate application failure during a disaster recovery bootstrap.
- **Recommendation:** Sync the `render.yaml` spec strictly against `src/config/app.config.ts`'s Zod schema requirements.
- **Effort to fix:** S

**Revision note (2026-05-21):** Downgraded from Medium to Low. `render.yaml` is infrastructure-as-code for future/manual provisioning, not an active runtime deployment surface. The risk is disaster-recovery readiness and operational hygiene; CWE-1188 remains appropriate.

### SK-2 â€” Anthropic API Key Weak Validation

- **Severity:** Informational
- **CWE:** CWE-1284 (Improper Validation of Specified Quantity in Input)
- **Location:** `src/config/app.config.ts:40`
- **Evidence:**

```typescript
ANTHROPIC_API_KEY: z.string().startsWith(
  "sk-ant-",
  "Invalid Anthropic API key",
);
```

- **Risk:** The prefix validation does not guarantee key viability. A deactivated or malformed key starting with `sk-ant-` will pass startup validation but cause silent background failures and user-facing 500s when Claude is invoked inside the RAG or gap analysis pipelines.
- **Recommendation:** Execute an active lightweight API ping (e.g., retrieving models) during server bootstrap.
- **Effort to fix:** S

### SK-3 â€” Pino Logger Missing Global PII/Secret Redaction

- **Severity:** Medium
- **CWE:** CWE-532 (Insertion of Sensitive Information into Log File)
- **Location:** `src/utils/logger.ts:8-40`
- **Evidence:**

```typescript
const loggerConfig = {
  level: appConfig.isDevelopment ? "debug" : "info",
  // ... missing redact configuration
};
export const logger = pino(loggerConfig);
```

- **Risk:** By not employing Pino's native `.redact` configuration, structured logs are vulnerable to inadvertently ingesting plaintext credentials, raw emails (e.g., on registration errors), and user IPs. This violates ODPC/DPA 2019 data minimization principles and transmits sensitive data to third-party log aggregators.
- **Recommendation:** Add `redact: { paths: ['email', '*.email', 'token', 'authorization', 'ipAddress'], censor: '[REDACTED]' }` to `loggerConfig`.
- **Effort to fix:** S

### SK-4 â€” Env Validation Leaks Configurations in Error Outputs

- ~~**Severity:** Low~~
- **Severity:** Informational
- **CWE:** CWE-209 (Generation of Error Message Containing Sensitive Information)
- **Location:** `src/config/app.config.ts:108`
- **Evidence:**

```typescript
console.error("âŒ Environment validation failed:\n" + missingVars.join("\n"));
```

- **Risk:** Using `console.error` directly bypasses structured logging pipelines and potentially leaks environment variable internals directly to standard out without trace correlation, aiding infrastructure reconnaissance if logs are misconfigured.
- **Recommendation:** Optional: keep startup-failure output minimal and non-secret; structured logging is not required before process exit.
- **Effort to fix:** S

**Revision note (2026-05-21):** Downgraded from Low to Informational. This path fires once at startup while the process is about to exit. Output lands in Render process logs, not a public client surface, so infrastructure-reconnaissance framing is not justified.

### SK-5 — Runtime Direct Secret Reads Bypass Typed Configuration

- **Severity:** High
- **CWE:** CWE-798 (Use of Hard-coded Credentials) / CWE-20 (Improper Input Validation)
- **Location:** See Appendix C rows marked `CRITICAL`, especially `src/modules/auth/auth.module.ts:169-389`.
- **Evidence:** Legacy auth module code directly reads `process.env.SUPABASE_JWT_SECRET` in token generation and verification paths instead of using the typed configuration surface.
- **Risk:** Runtime request-path secret access makes validation, redaction, rotation analysis, and test isolation harder. It also creates a second JWT-signing configuration path outside the Supabase-admin verification flow used by the active tRPC context.
- **Recommendation:** Route JWT secret access through a typed, boot-validated config singleton and remove the legacy direct-read path if unused.
- **Effort to fix:** M

### Verified Controls (no finding)

- **Stripe Publishable Key Exposure:** Verified `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in `fintech-regulatory-platform/.env.local` was correctly `gitignored` (`.env*.local`) and unreferenced in source code. (Downgraded from Phase A Critical to Low/Safe hygiene).
- **Backend GitHub Secrets:** Verified the incident involving Pinecone, Resend, Cloudflare, and DB keys in `.env` was fully handled (Rotated, history scrubbed).

## 6. Cross-Cutting Observations

- `OrganizationModule.updateMemberRole` / `transferOwnership` appear to be dead code; recommend deletion in a separate cleanup batch.
- **Config validation duality:** The codebase utilizes both `env.validator.ts` and `app.config.ts` for schema declarations and environment loading. These two surfaces introduce drift risk. Consolidate into a single typed config export pattern.
- **Audit Logging Maturity:** `AuditLog` writes are heavily sampled (10% sampling on authz grants) and Vault document lifecycle events (download/delete) omit audit entries. Hash-chaining (`AuditLogV2`) remains completely unimplemented, rendering the system vulnerable to post-breach log tampering.

## 7. Discrepancies Between Claimed and Actual Posture

- **Claim:** "Malware scanning runs on all document uploads."
  **Reality:** `MALWARE_SCAN_ENABLED=false` remains defaulted in the application configuration for the duration of the pilot phase (documented accepted risk).
- **Claim:** "Supabase Row Level Security guards tenant data."
  **Reality:** The backend connects using the `SUPABASE_SERVICE_ROLE_KEY` via Prisma, entirely bypassing RLS logic. The application layer is the sole enforcement boundary.

## 8. Out-of-Scope Items Noticed

- **Referential Integrity on Gap Analysis:** `GapAnalysis.regulatoryFrameworks` stores framework slugs as an untyped JSON array rather than a Foreign Key map. If frameworks are renamed, historical audits will silently break.
- **Vault `contentHash` verification:** The system calculates SHA-256 upon initial R2 upload but does not re-verify the hash against the downloaded object when issuing presigned GET URLs, allowing undetected at-rest tampering.

## 9. Recommended Phase B Sprint Sequencing

**Batch 1 â€” High-Priority Logging & Authentication Hygiene**

- Apply global PII redaction to `pino` logger (`SK-3`).
- Treat `console.error` startup validation output as hygiene-only (`SK-4`).
- Fix the `trustProxy` string coercion to prevent IP spoofing (`RL-2`).

**Batch 2 â€” Endpoint Exposure & Integration Hardening**

- Secure the unauthenticated `content.getBySlug` endpoint by adding rate limiting (`RL-1`).
- Add ingress rate limiting and keep IP/challenge controls enforced on the IntaSend webhook route (`IV-2`).
- Implement precise `StripeSignatureVerificationError` type catching on the Stripe webhook (`IV-1`).

**Batch 3 â€” Infrastructure Configuration & Dead Code**

- Align `render.yaml` to match modern Upstash/Supabase schema configurations (`SK-1`).
- Drop the dead `OrganizationModule.updateMemberRole` / `transferOwnership` helpers in a cleanup batch.
- Inject Anthropic active-ping connection test on startup (`SK-2`).

## 10. Appendix â€” Files Read

- `KNOWN_ISSUES.md` (root and backend variations)
- `audit/phase-a-comprehensive-audit-2026-05-18.md`
- `audit/track-1-incident-runbook-2026-05-18.md`
- `audit/sprint-0-forensic-results-2026-05-18.md`
- `audit/sprint-2-phase-a-2026-05-18.md`
- `audit/sprint-1-phase-a-2026-05-18.md`
- `audit/phase-a-sprint-3-refinement-2026-05-18.md`
- `fintech-regulatory-backend/IDOR_AUDIT_FINDINGS.md`
- `fintech-regulatory-backend/pnpm-lock.yaml`
- `fintech-regulatory-backend/render.yaml`
- `fintech-regulatory-backend/scripts/ci.yml`

## Follow-Up Revision (2026-05-21)

Total findings after Revision 2: 12 (C: 0, H: 2, M: 4, L: 4, Info: 2). Severity revisions: IV-2 High→Medium, RL-1 Medium→Low, SK-1 Medium→Low, SK-4 Low→Informational, and SA-1 removed as non-exploitable dead code. Newly discovered High findings: IV-3 (55 registered procedures missing explicit input boundaries) and SK-5 (runtime direct reads of `SUPABASE_JWT_SECRET` in legacy auth token paths). Top 3 risks are now: IV-3 missing input boundaries, SK-5 runtime secret access outside typed config, and SA-2 concurrent ADMIN sessions with monitor-only fingerprinting. Overall posture shifts from Adequate to **Adequate with incomplete boundary standardization**: authentication and core tenant controls exist, but the full router census shows inconsistent API input-boundary discipline.

## Appendix A — Complete Public Endpoint Inventory

| #   | Endpoint (router.procedure or HTTP path) | File:Line                                            | Authenticated | Rate Limited | Limiter Identifier       | Max / Window     | Fail Mode | Sensitive Data Returned? | Notes                                                                                               |
| --- | ---------------------------------------- | ---------------------------------------------------- | ------------- | ------------ | ------------------------ | ---------------- | --------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | auth.register                            | src/server/routers/auth.router.ts:105-113            | NO            | YES          | email                    | 3 / 1h           | Closed    | YES                      | Creates user/org; returns account/session metadata.                                                 |
| 2   | auth.login                               | src/server/routers/auth.router.ts:341-359            | NO            | YES          | email                    | 5 / 15m          | Closed    | YES                      | Returns authenticated session/profile metadata.                                                     |
| 3   | auth.requestPasswordReset                | src/server/routers/auth.router.ts:656-662            | NO            | YES          | email                    | 3 / 1h           | Closed    | NO                       | Generic response expected; anti-enumeration posture.                                                |
| 4   | auth.resetPassword                       | src/server/routers/auth.router.ts:718-755            | NO            | NONE         | NONE                     | NONE             | N/A       | NO                       | Flag: no visible limiter on token redemption path.                                                  |
| 5   | auth.verifyEmail                         | src/server/routers/auth.router.ts:809-833            | NO            | NONE         | NONE                     | NONE             | N/A       | YES                      | Token redemption updates account state.                                                             |
| 6   | auth.resendVerification                  | src/server/routers/auth.router.ts:888-895            | NO            | YES          | email                    | 3 / 1h           | Closed    | NO                       | Generic resend path.                                                                                |
| 7   | auth.confirmEmailCallback                | src/server/routers/auth.router.ts:963-972            | NO            | NONE         | NONE                     | NONE             | N/A       | YES                      | Accepts bearer-like access token; returns verification result.                                      |
| 8   | auth.refreshToken                        | src/server/routers/auth.router.ts:1035-1045          | NO            | NONE         | NONE                     | NONE             | N/A       | NO                       | Deprecated public helper returns error guidance.                                                    |
| 9   | content.getBySlug                        | src/server/routers/content.router.ts:391-430         | NO            | NONE         | NONE                     | NONE             | N/A       | YES                      | Returns published content, HTML/content body, counters, author id/display fields; RL-1 revised Low. |
| 10  | publicMarketing.validateUnsubscribeToken | src/server/routers/publicMarketing.router.ts:67-85   | NO            | NONE         | NONE                     | NONE             | N/A       | YES                      | Returns contact email when token is valid; token is bearer credential.                              |
| 11  | publicMarketing.unsubscribe              | src/server/routers/publicMarketing.router.ts:94-118  | NO            | NONE         | NONE                     | NONE             | N/A       | YES                      | Token bearer action mutates suppression state.                                                      |
| 12  | publicMarketing.applyForPilot            | src/server/routers/publicMarketing.router.ts:164-177 | NO            | YES          | IP                       | 5 / 10m          | Closed    | YES                      | Accepts applicant PII; returns application result.                                                  |
| 13  | POST /webhooks/stripe                    | src/app.ts:123-154                                   | NO            | NONE         | Stripe signature         | N/A              | Closed    | NO                       | Signature verification is the primary authenticity control; no IP limiter visible.                  |
| 14  | POST /api/webhooks/intasend              | src/app.ts:183-239                                   | NO            | PARTIAL      | IP allowlist + challenge | Vendor/IP policy | Closed    | NO                       | Not HMAC signed; IV-2 revised Medium.                                                               |
| 15  | POST /webhooks/resend                    | src/app.ts:270-300                                   | NO            | NONE         | Resend signature headers | N/A              | Closed    | NO                       | Signature verification path; no IP limiter visible.                                                 |
| 16  | GET /health                              | src/app.ts:345-356                                   | NO            | NONE         | NONE                     | NONE             | N/A       | NO                       | Lightweight public liveness and version/environment metadata.                                       |
| 17  | GET /health/detailed                     | src/app.ts:363-388                                   | YES           | NONE         | NONE                     | NONE             | N/A       | YES                      | Requires bearer admin check; returns service health.                                                |
| 18  | GET /                                    | src/app.ts:450-455                                   | NO            | NONE         | NONE                     | NONE             | N/A       | NO                       | Public service metadata and endpoint list.                                                          |
| 19  | GET /api/alerts/stream                   | src/app.ts:460-501                                   | NO            | YES          | single-use stream token  | 60s TTL token    | Closed    | YES                      | Token-minted SSE bearer credential; returns per-user alert events.                                  |
| 20  | POST /api/compliance/stream              | src/routes/compliance-stream.route.ts:256-280        | YES           | YES          | userId/complianceQuery   | 100 / 15m        | Closed    | YES                      | Uses Authorization header, not query-token SSE; streams compliance analysis.                        |

Reconciliation: §3's original public endpoint table grouped `auth.*` into one row and omitted several public tRPC procedures plus Fastify routes. Appendix A is the authoritative inventory for this revision.

## Appendix B — Zod Coverage Census (All Routers)

| #   | Router              | Procedure                     | File:Line                                               | Procedure Type              | Has `.input()` | Schema Source                          | All Fields Bounded? | Notes                                                                                     |
| --- | ------------------- | ----------------------------- | ------------------------------------------------------- | --------------------------- | -------------- | -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| 1   | admin               | getStats                      | src/server/routers/admin.router.ts:105-105              | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 2   | admin               | listUsers                     | src/server/routers/admin.router.ts:215-215              | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 3   | admin               | updateUser                    | src/server/routers/admin.router.ts:313-313              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 4   | admin               | getSystemHealth               | src/server/routers/admin.router.ts:376-376              | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 5   | admin               | getLogs                       | src/server/routers/admin.router.ts:451-451              | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 6   | admin               | deleteUser                    | src/server/routers/admin.router.ts:502-502              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 7   | admin               | suspendUser                   | src/server/routers/admin.router.ts:576-576              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 8   | admin               | reactivateUser                | src/server/routers/admin.router.ts:631-631              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 9   | admin               | getAllOrganizations           | src/server/routers/admin.router.ts:667-667              | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 10  | admin               | listOrganizations             | src/server/routers/admin.router.ts:717-717              | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 11  | admin               | getOrganizationStats          | src/server/routers/admin.router.ts:750-750              | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 12  | admin               | getOrgMembers                 | src/server/routers/admin.router.ts:781-781              | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 13  | admin               | getOrgDetails                 | src/server/routers/admin.router.ts:799-799              | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 14  | admin               | getOrgAuditLog                | src/server/routers/admin.router.ts:834-834              | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 15  | admin               | suspendOrganization           | src/server/routers/admin.router.ts:852-852              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 16  | admin               | reactivateOrganization        | src/server/routers/admin.router.ts:890-890              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 17  | admin               | getSystemConfig               | src/server/routers/admin.router.ts:924-924              | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 18  | admin               | updateSystemConfig            | src/server/routers/admin.router.ts:954-954              | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 19  | admin               | getFeatureFlags               | src/server/routers/admin.router.ts:998-998              | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 20  | admin               | updateFeatureFlag             | src/server/routers/admin.router.ts:1028-1028            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 21  | admin               | setMaintenanceMode            | src/server/routers/admin.router.ts:1067-1067            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 22  | admin               | getUser                       | src/server/routers/admin.router.ts:1110-1110            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 23  | admin               | getUserActivityLog            | src/server/routers/admin.router.ts:1144-1144            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 24  | admin               | getDetailedHealth             | src/server/routers/admin.router.ts:1166-1166            | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 25  | admin               | createInvitation              | src/server/routers/admin.router.ts:1222-1222            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 26  | admin               | listInvitations               | src/server/routers/admin.router.ts:1302-1302            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 27  | admin               | listPendingUsers              | src/server/routers/admin.router.ts:1351-1351            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 28  | admin               | approveUser                   | src/server/routers/admin.router.ts:1387-1387            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 29  | admin               | rejectUser                    | src/server/routers/admin.router.ts:1446-1446            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 30  | admin               | listPendingOrganizations      | src/server/routers/admin.router.ts:1501-1501            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 31  | admin               | verifyOrganization            | src/server/routers/admin.router.ts:1538-1538            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 32  | admin               | rejectOrganization            | src/server/routers/admin.router.ts:1598-1598            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 33  | admin               | getChecklistMetrics           | src/server/routers/admin.router.ts:1640-1640            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 34  | admin               | createUser                    | src/server/routers/admin.router.ts:1660-1660            | adminProcedure/mutation     | YES            | createAdminUserSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 35  | admin               | forcePasswordReset            | src/server/routers/admin.router.ts:1706-1706            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 36  | admin               | updateUserRole                | src/server/routers/admin.router.ts:1721-1721            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 37  | admin               | impersonateUser               | src/server/routers/admin.router.ts:1745-1745            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 38  | admin               | updateOrganization            | src/server/routers/admin.router.ts:1760-1760            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 39  | admin               | updateOrganizationPlan        | src/server/routers/admin.router.ts:1787-1787            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 40  | admin               | getUserGrowth                 | src/server/routers/admin.router.ts:1819-1819            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 41  | admin               | getRevenueMetrics             | src/server/routers/admin.router.ts:1872-1872            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 42  | admin               | getAIUsageMetrics             | src/server/routers/admin.router.ts:1893-1893            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 43  | admin               | getSubscriptionBreakdown      | src/server/routers/admin.router.ts:1914-1914            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 44  | admin               | getLoginHistory               | src/server/routers/admin.router.ts:1937-1937            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 45  | admin               | listContent                   | src/server/routers/admin.router.ts:1965-1965            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 46  | admin               | updateContentStatus           | src/server/routers/admin.router.ts:1985-1985            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 47  | admin               | deleteContent                 | src/server/routers/admin.router.ts:2003-2003            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 48  | admin               | createContent                 | src/server/routers/admin.router.ts:2018-2018            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 49  | admin               | getSubscriptionOverview       | src/server/routers/admin.router.ts:2038-2038            | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 50  | admin               | getBillingPlanCatalog         | src/server/routers/admin.router.ts:2048-2048            | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 51  | admin               | updateBillingPlanCatalog      | src/server/routers/admin.router.ts:2058-2058            | adminProcedure/mutation     | YES            | billingPlanCatalogUpdateSchema         | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 52  | admin               | getRecentPayments             | src/server/routers/admin.router.ts:2073-2073            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 53  | admin               | getOrgPaymentHistory          | src/server/routers/admin.router.ts:2087-2087            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 54  | admin               | listUserActiveSessions        | src/server/routers/admin.router.ts:2114-2114            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 55  | admin               | signOutUserEverywhere         | src/server/routers/admin.router.ts:2139-2139            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 56  | admin               | bulkUpdateUserStatus          | src/server/routers/admin.router.ts:2161-2161            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 57  | admin               | bulkUpdateUserTier            | src/server/routers/admin.router.ts:2207-2207            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 58  | admin               | getFailedPayments             | src/server/routers/admin.router.ts:2272-2272            | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 59  | admin               | exportAnalyticsCsv            | src/server/routers/admin.router.ts:2330-2330            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 60  | admin               | exportAuditLogs               | src/server/routers/admin.router.ts:2368-2368            | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 61  | adminMarketing      | list                          | src/server/routers/adminMarketing.router.ts:101-101     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 62  | adminMarketing      | getById                       | src/server/routers/adminMarketing.router.ts:120-120     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 63  | adminMarketing      | create                        | src/server/routers/adminMarketing.router.ts:130-130     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 64  | adminMarketing      | update                        | src/server/routers/adminMarketing.router.ts:151-151     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 65  | adminMarketing      | delete                        | src/server/routers/adminMarketing.router.ts:176-176     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 66  | adminMarketing      | requestSendConfirmation       | src/server/routers/adminMarketing.router.ts:185-185     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 67  | adminMarketing      | executeSend                   | src/server/routers/adminMarketing.router.ts:196-196     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 68  | adminMarketing      | cancel                        | src/server/routers/adminMarketing.router.ts:213-213     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 69  | adminMarketing      | getStats                      | src/server/routers/adminMarketing.router.ts:222-222     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 70  | adminMarketing      | getRecentSends                | src/server/routers/adminMarketing.router.ts:230-230     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 71  | adminMarketing      | getJobStatus                  | src/server/routers/adminMarketing.router.ts:242-242     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 72  | adminMarketing      | duplicate                     | src/server/routers/adminMarketing.router.ts:254-254     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 73  | adminMarketing      | list                          | src/server/routers/adminMarketing.router.ts:279-279     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 74  | adminMarketing      | getById                       | src/server/routers/adminMarketing.router.ts:318-318     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 75  | adminMarketing      | create                        | src/server/routers/adminMarketing.router.ts:334-334     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 76  | adminMarketing      | update                        | src/server/routers/adminMarketing.router.ts:376-376     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 77  | adminMarketing      | delete                        | src/server/routers/adminMarketing.router.ts:403-403     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 78  | adminMarketing      | bulkImport                    | src/server/routers/adminMarketing.router.ts:416-416     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 79  | adminMarketing      | recordConsent                 | src/server/routers/adminMarketing.router.ts:496-496     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 80  | adminMarketing      | getEmailHistory               | src/server/routers/adminMarketing.router.ts:516-516     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 81  | adminMarketing      | list                          | src/server/routers/adminMarketing.router.ts:547-547     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 82  | adminMarketing      | getById                       | src/server/routers/adminMarketing.router.ts:569-569     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 83  | adminMarketing      | create                        | src/server/routers/adminMarketing.router.ts:588-588     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 84  | adminMarketing      | update                        | src/server/routers/adminMarketing.router.ts:613-613     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 85  | adminMarketing      | delete                        | src/server/routers/adminMarketing.router.ts:636-636     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 86  | adminMarketing      | addMembers                    | src/server/routers/adminMarketing.router.ts:649-649     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 87  | adminMarketing      | removeMembers                 | src/server/routers/adminMarketing.router.ts:681-681     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 88  | adminMarketing      | previewDynamic                | src/server/routers/adminMarketing.router.ts:699-699     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 89  | adminMarketing      | getMembers                    | src/server/routers/adminMarketing.router.ts:725-725     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 90  | adminMarketing      | list                          | src/server/routers/adminMarketing.router.ts:761-761     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 91  | adminMarketing      | add                           | src/server/routers/adminMarketing.router.ts:783-783     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 92  | adminMarketing      | remove                        | src/server/routers/adminMarketing.router.ts:804-804     | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 93  | adminMarketing      | check                         | src/server/routers/adminMarketing.router.ts:818-818     | adminProcedure/query        | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 94  | adminSupport        | list                          | src/server/routers/adminSupport.router.ts:29-29         | adminProcedure/query        | YES            | adminListTicketsSchema                 | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 95  | adminSupport        | getByTicketNumber             | src/server/routers/adminSupport.router.ts:45-45         | adminProcedure/query        | YES            | getTicketByNumberSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 96  | adminSupport        | updateStatus                  | src/server/routers/adminSupport.router.ts:61-61         | adminProcedure/mutation     | YES            | adminUpdateStatusSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 97  | adminSupport        | addResponse                   | src/server/routers/adminSupport.router.ts:77-77         | adminProcedure/mutation     | YES            | adminAddResponseSchema                 | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 98  | adminSupport        | stats                         | src/server/routers/adminSupport.router.ts:93-93         | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 99  | alert               | createStreamToken             | src/server/routers/alert.router.ts:19-19                | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 100 | alert               | create                        | src/server/routers/alert.router.ts:28-28                | protectedProcedure/mutation | YES            | createAlertSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 101 | alert               | publish                       | src/server/routers/alert.router.ts:41-41                | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 102 | alert               | getAlerts                     | src/server/routers/alert.router.ts:54-54                | orgMemberProcedure/query    | YES            | getAlertsSchema                        | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 103 | alert               | getById                       | src/server/routers/alert.router.ts:70-70                | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 104 | alert               | getUnreadCount                | src/server/routers/alert.router.ts:80-80                | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 105 | alert               | markAsRead                    | src/server/routers/alert.router.ts:90-90                | protectedProcedure/mutation | YES            | markAsReadSchema                       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 106 | alert               | markAllAsRead                 | src/server/routers/alert.router.ts:100-100              | orgMemberProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 107 | alert               | upsertSubscription            | src/server/routers/alert.router.ts:112-112              | orgMemberProcedure/mutation | YES            | upsertSubscriptionSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 108 | alert               | getSubscription               | src/server/routers/alert.router.ts:125-125              | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 109 | alert               | getAdminAlerts                | src/server/routers/alert.router.ts:134-134              | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 110 | analytics           | getUserSummary                | src/server/routers/analytics.router.ts:29-29            | protectedProcedure/query    | YES            | getUserGrowthSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 111 | analytics           | getOrgDashboard               | src/server/routers/analytics.router.ts:70-70            | orgMemberProcedure/query    | YES            | getOrgDashboardSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 112 | analytics           | getOrgComplianceScore         | src/server/routers/analytics.router.ts:122-122          | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 113 | analytics           | getComplianceTrends           | src/server/routers/analytics.router.ts:151-151          | orgMemberProcedure/query    | YES            | getComplianceTrendsSchema              | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 114 | analytics           | getGapAnalysis                | src/server/routers/analytics.router.ts:199-199          | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 115 | analytics           | getDeadlineAlerts             | src/server/routers/analytics.router.ts:237-237          | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 116 | analytics           | getDocumentStats              | src/server/routers/analytics.router.ts:263-263          | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 117 | analytics           | generateReport                | src/server/routers/analytics.router.ts:289-289          | orgMemberProcedure/mutation | YES            | generateReportSchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 118 | analytics           | exportData                    | src/server/routers/analytics.router.ts:346-346          | orgMemberProcedure/mutation | YES            | exportAnalyticsSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 119 | analytics           | getPlatformOverview           | src/server/routers/analytics.router.ts:405-405          | adminProcedure/query        | YES            | getUserGrowthSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 120 | analytics           | getUserGrowth                 | src/server/routers/analytics.router.ts:441-441          | adminProcedure/query        | YES            | getUserGrowthSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 121 | analytics           | getOrgGrowth                  | src/server/routers/analytics.router.ts:477-477          | adminProcedure/query        | YES            | getUserGrowthSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 122 | auth                | register                      | src/server/routers/auth.router.ts:105-105               | publicProcedure/mutation    | YES            | registerSchema                         | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 123 | auth                | login                         | src/server/routers/auth.router.ts:341-341               | publicProcedure/mutation    | YES            | loginSchema                            | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 124 | auth                | logout                        | src/server/routers/auth.router.ts:567-567               | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 125 | auth                | me                            | src/server/routers/auth.router.ts:617-617               | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 126 | auth                | requestPasswordReset          | src/server/routers/auth.router.ts:656-656               | publicProcedure/mutation    | YES            | resetPasswordRequestSchema             | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 127 | auth                | resetPassword                 | src/server/routers/auth.router.ts:718-718               | publicProcedure/mutation    | YES            | resetPasswordSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 128 | auth                | verifyEmail                   | src/server/routers/auth.router.ts:809-809               | publicProcedure/mutation    | YES            | verifyEmailSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 129 | auth                | resendVerification            | src/server/routers/auth.router.ts:888-888               | publicProcedure/mutation    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 130 | auth                | confirmEmailCallback          | src/server/routers/auth.router.ts:963-963               | publicProcedure/mutation    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 131 | auth                | refreshToken                  | src/server/routers/auth.router.ts:1035-1035             | publicProcedure/mutation    | YES            | refreshTokenSchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 132 | billing             | getPlanAndUsage               | src/server/routers/billing.router.ts:68-68              | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 133 | billing             | getPlanCatalog                | src/server/routers/billing.router.ts:197-197            | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 134 | billing             | createCheckoutSession         | src/server/routers/billing.router.ts:212-212            | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 135 | billing             | createPortalSession           | src/server/routers/billing.router.ts:348-348            | orgMemberProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 136 | billing             | requestEnterprise             | src/server/routers/billing.router.ts:393-393            | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 137 | billing             | updatePaymentMethod           | src/server/routers/billing.router.ts:471-471            | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 138 | billing             | initiateMpesaPayment          | src/server/routers/billing.router.ts:545-545            | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 139 | billing             | getMpesaPaymentStatus         | src/server/routers/billing.router.ts:702-702            | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 140 | calendar            | create                        | src/server/routers/calendar.router.ts:29-29             | orgMemberProcedure/mutation | YES            | createComplianceEventSchema            | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 141 | calendar            | list                          | src/server/routers/calendar.router.ts:58-58             | orgMemberProcedure/query    | YES            | listComplianceEventsSchema             | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 142 | calendar            | get                           | src/server/routers/calendar.router.ts:81-81             | orgMemberProcedure/query    | YES            | getComplianceEventSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 143 | calendar            | update                        | src/server/routers/calendar.router.ts:101-101           | orgMemberProcedure/mutation | YES            | updateComplianceEventSchema            | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 144 | calendar            | delete                        | src/server/routers/calendar.router.ts:123-123           | orgMemberProcedure/mutation | YES            | deleteComplianceEventSchema            | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 145 | calendar            | upcoming                      | src/server/routers/calendar.router.ts:143-143           | orgMemberProcedure/query    | YES            | upcomingEventsSchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 146 | checklist           | generateChecklist             | src/server/routers/checklist.router.ts:28-28            | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 147 | checklist           | getUserChecklists             | src/server/routers/checklist.router.ts:93-93            | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 148 | checklist           | getChecklist                  | src/server/routers/checklist.router.ts:113-113          | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 149 | checklist           | updateChecklistProgress       | src/server/routers/checklist.router.ts:139-139          | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 150 | checklist           | deleteChecklist               | src/server/routers/checklist.router.ts:182-182          | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 151 | checklist           | generateChecklistAsync        | src/server/routers/checklist.router.ts:219-219          | orgMemberProcedure/mutation | YES            | generateChecklistAsyncInputSchema      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 152 | checklist           | getChecklistStatus            | src/server/routers/checklist.router.ts:290-290          | orgMemberProcedure/query    | YES            | getChecklistStatusInputSchema          | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 153 | checklist           | listChecklists                | src/server/routers/checklist.router.ts:313-313          | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 154 | checklist           | getChecklistDetail            | src/server/routers/checklist.router.ts:330-330          | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 155 | checklist           | updateChecklistItem           | src/server/routers/checklist.router.ts:352-352          | orgMemberProcedure/mutation | YES            | updateChecklistItemInputSchema         | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 156 | checklist           | getChecklistUsage             | src/server/routers/checklist.router.ts:386-386          | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 157 | checklist           | retryChecklist                | src/server/routers/checklist.router.ts:414-414          | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 158 | complianceDashboard | getComplianceDashboard        | src/server/routers/compliance-dashboard.router.ts:15-15 | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 159 | complianceDashboard | updateDashboardItem           | src/server/routers/compliance-dashboard.router.ts:46-46 | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 160 | complianceDashboard | getChecklistByCategory        | src/server/routers/compliance-dashboard.router.ts:93-93 | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 161 | compliance          | query                         | src/server/routers/compliance.router.ts:40-40           | orgMemberProcedure/mutation | YES            | complianceQuerySchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 162 | compliance          | followUp                      | src/server/routers/compliance.router.ts:252-252         | orgMemberProcedure/mutation | YES            | followUpQuerySchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 163 | compliance          | search                        | src/server/routers/compliance.router.ts:380-380         | protectedProcedure/query    | YES            | searchDocumentsSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 164 | compliance          | history                       | src/server/routers/compliance.router.ts:441-441         | orgMemberProcedure/query    | YES            | getQueryHistorySchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 165 | compliance          | get                           | src/server/routers/compliance.router.ts:515-515         | protectedProcedure/query    | YES            | getQuerySchema                         | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 166 | compliance          | quickCheck                    | src/server/routers/compliance.router.ts:578-578         | protectedProcedure/mutation | YES            | quickCheckSchema                       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 167 | compliance          | getScore                      | src/server/routers/compliance.router.ts:612-612         | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 168 | compliance          | getScoreHistory               | src/server/routers/compliance.router.ts:645-645         | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 169 | compliance          | getRecommendations            | src/server/routers/compliance.router.ts:686-686         | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 170 | compliance          | getRequirements               | src/server/routers/compliance.router.ts:719-719         | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 171 | compliance          | updateRequirement             | src/server/routers/compliance.router.ts:766-766         | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 172 | compliance          | getDeadlines                  | src/server/routers/compliance.router.ts:812-812         | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 173 | compliance          | getRoadmap                    | src/server/routers/compliance.router.ts:853-853         | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 174 | compliance          | submitFeedback                | src/server/routers/compliance.router.ts:896-896         | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 175 | compliance          | getFeedbackStatus             | src/server/routers/compliance.router.ts:964-964         | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 176 | compliance          | toggleSave                    | src/server/routers/compliance.router.ts:989-989         | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 177 | compliance          | getSavedStatus                | src/server/routers/compliance.router.ts:1040-1040       | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 178 | compliance          | listSavedResponses            | src/server/routers/compliance.router.ts:1062-1062       | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 179 | compliance          | logExport                     | src/server/routers/compliance.router.ts:1107-1107       | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 180 | compliance          | exportDocx                    | src/server/routers/compliance.router.ts:1144-1144       | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 181 | compliance          | exportChecklistDocx           | src/server/routers/compliance.router.ts:1265-1265       | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 182 | compliance          | reportGap                     | src/server/routers/compliance.router.ts:1430-1430       | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 183 | content             | create                        | src/server/routers/content.router.ts:29-29              | protectedProcedure/mutation | YES            | createContentSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 184 | content             | update                        | src/server/routers/content.router.ts:136-136            | protectedProcedure/mutation | YES            | updateContentSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 185 | content             | list                          | src/server/routers/content.router.ts:242-242            | protectedProcedure/query    | YES            | listContentSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 186 | content             | get                           | src/server/routers/content.router.ts:346-346            | protectedProcedure/query    | YES            | getContentSchema                       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 187 | content             | getBySlug                     | src/server/routers/content.router.ts:391-391            | publicProcedure/query       | YES            | getContentBySlugSchema                 | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 188 | content             | publish                       | src/server/routers/content.router.ts:448-448            | protectedProcedure/mutation | YES            | publishContentSchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 189 | content             | delete                        | src/server/routers/content.router.ts:521-521            | protectedProcedure/mutation | YES            | deleteContentSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 190 | content             | rate                          | src/server/routers/content.router.ts:570-570            | protectedProcedure/mutation | YES            | rateContentSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 191 | document            | getUploadUrl                  | src/server/routers/document.router.ts:32-32             | orgMemberProcedure/mutation | YES            | getUploadUrlSchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 192 | document            | confirmUpload                 | src/server/routers/document.router.ts:124-124           | orgMemberProcedure/mutation | YES            | confirmUploadSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 193 | document            | list                          | src/server/routers/document.router.ts:242-242           | orgMemberProcedure/query    | YES            | listDocumentsSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 194 | document            | get                           | src/server/routers/document.router.ts:339-339           | orgMemberProcedure/query    | YES            | getDocumentSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 195 | document            | getDownloadUrl                | src/server/routers/document.router.ts:410-410           | orgMemberProcedure/mutation | YES            | getDownloadUrlSchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 196 | document            | delete                        | src/server/routers/document.router.ts:493-493           | orgMemberProcedure/mutation | YES            | deleteDocumentSchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 197 | document            | restore                       | src/server/routers/document.router.ts:592-592           | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 198 | document            | getProcessingStatus           | src/server/routers/document.router.ts:658-658           | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 199 | document            | reingest                      | src/server/routers/document.router.ts:735-735           | adminProcedure/mutation     | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 200 | enterprisePolicy    | createDraft                   | src/server/routers/enterprise-policy.router.ts:44-44    | orgMemberProcedure/mutation | YES            | createDraftSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 201 | enterprisePolicy    | getStatus                     | src/server/routers/enterprise-policy.router.ts:128-128  | orgMemberProcedure/query    | YES            | getStatusSchema                        | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 202 | enterprisePolicy    | getPolicy                     | src/server/routers/enterprise-policy.router.ts:190-190  | orgMemberProcedure/query    | YES            | getPolicySchema                        | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 203 | enterprisePolicy    | listPolicies                  | src/server/routers/enterprise-policy.router.ts:240-240  | orgMemberProcedure/query    | YES            | listPoliciesSchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 204 | enterprisePolicy    | updateSectionContent          | src/server/routers/enterprise-policy.router.ts:312-312  | orgMemberProcedure/mutation | YES            | updateSectionContentSchema             | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 205 | enterprisePolicy    | deletePolicy                  | src/server/routers/enterprise-policy.router.ts:392-392  | orgMemberProcedure/mutation | YES            | deletePolicySchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 206 | gapAnalysis         | getFrameworks                 | src/server/routers/gap-analysis.router.ts:22-22         | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 207 | gapAnalysis         | runGapAnalysis                | src/server/routers/gap-analysis.router.ts:67-67         | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 208 | gapAnalysis         | getGapAnalyses                | src/server/routers/gap-analysis.router.ts:199-199       | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 209 | gapAnalysis         | getGapAnalysisResult          | src/server/routers/gap-analysis.router.ts:216-216       | protectedProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 210 | gapAnalysis         | getGapAnalysisLimits          | src/server/routers/gap-analysis.router.ts:236-236       | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 211 | gapAnalysis         | deleteGapAnalysis             | src/server/routers/gap-analysis.router.ts:248-248       | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 212 | notification        | list                          | src/server/routers/notification.router.ts:26-26         | protectedProcedure/query    | YES            | listNotificationsSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 213 | notification        | getUnreadCount                | src/server/routers/notification.router.ts:61-61         | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 214 | notification        | markAsRead                    | src/server/routers/notification.router.ts:85-85         | protectedProcedure/mutation | YES            | markAsReadSchema                       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 215 | notification        | markAllAsRead                 | src/server/routers/notification.router.ts:129-129       | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 216 | notification        | delete                        | src/server/routers/notification.router.ts:160-160       | protectedProcedure/mutation | YES            | deleteNotificationSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 217 | notification        | deleteAllRead                 | src/server/routers/notification.router.ts:201-201       | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 218 | notification        | getPreferences                | src/server/routers/notification.router.ts:232-232       | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 219 | notification        | updatePreferences             | src/server/routers/notification.router.ts:256-256       | protectedProcedure/mutation | YES            | updateNotificationPreferencesSchema    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 220 | notification        | unreadCountByCategory         | src/server/routers/notification.router.ts:291-291       | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 221 | notification        | getCategoryPreferences        | src/server/routers/notification.router.ts:314-314       | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 222 | notification        | updateCategoryPreference      | src/server/routers/notification.router.ts:338-338       | protectedProcedure/mutation | YES            | updateCategoryPreferenceSchema         | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 223 | notification        | getSystemNotifications        | src/server/routers/notification.router.ts:382-382       | adminProcedure/query        | YES            | listNotificationsSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 224 | organization        | list                          | src/server/routers/organization.router.ts:51-51         | protectedProcedure/query    | YES            | listOrganizationsSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 225 | organization        | get                           | src/server/routers/organization.router.ts:133-133       | protectedProcedure/query    | YES            | getOrganizationSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 226 | organization        | create                        | src/server/routers/organization.router.ts:209-209       | protectedProcedure/mutation | YES            | createOrganizationSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 227 | organization        | update                        | src/server/routers/organization.router.ts:245-245       | protectedProcedure/mutation | YES            | updateOrganizationSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 228 | organization        | delete                        | src/server/routers/organization.router.ts:306-306       | adminProcedure/mutation     | YES            | deleteOrganizationSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 229 | organization        | addMember                     | src/server/routers/organization.router.ts:352-352       | protectedProcedure/mutation | YES            | addMemberSchema                        | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 230 | organization        | removeMember                  | src/server/routers/organization.router.ts:419-419       | protectedProcedure/mutation | YES            | removeMemberSchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 231 | organization        | getMembers                    | src/server/routers/organization.router.ts:472-472       | protectedProcedure/query    | YES            | getMembersSchema                       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 232 | organization        | updateMemberRole              | src/server/routers/organization.router.ts:544-544       | protectedProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 233 | organization        | getSettings                   | src/server/routers/organization.router.ts:658-658       | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 234 | organization        | updateSettings                | src/server/routers/organization.router.ts:717-717       | protectedProcedure/mutation | YES            | updateOrganizationSettingsSchema       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 235 | payment             | list                          | src/server/routers/payment.router.ts:25-25              | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 236 | payment             | getById                       | src/server/routers/payment.router.ts:72-72              | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 237 | payment             | getDetail                     | src/server/routers/payment.router.ts:104-104            | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 238 | pilot               | getStats                      | src/server/routers/pilot.router.ts:23-23                | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 239 | pilot               | listTesters                   | src/server/routers/pilot.router.ts:56-56                | adminProcedure/query        | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 240 | policy              | list                          | src/server/routers/policy.router.ts:32-32               | orgMemberProcedure/query    | YES            | listPoliciesSchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 241 | policy              | get                           | src/server/routers/policy.router.ts:122-122             | orgMemberProcedure/query    | YES            | getPolicySchema                        | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 242 | policy              | generate                      | src/server/routers/policy.router.ts:199-199             | orgMemberProcedure/mutation | YES            | generatePolicySchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 243 | policy              | update                        | src/server/routers/policy.router.ts:425-425             | orgMemberProcedure/mutation | YES            | updatePolicySchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 244 | policy              | delete                        | src/server/routers/policy.router.ts:500-500             | orgMemberProcedure/mutation | YES            | deletePolicySchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 245 | policy              | export                        | src/server/routers/policy.router.ts:572-572             | orgMemberProcedure/mutation | YES            | exportPolicySchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 246 | policy              | refine                        | src/server/routers/policy.router.ts:649-649             | orgMemberProcedure/mutation | YES            | refinePolicySchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 247 | policy              | verifyCitations               | src/server/routers/policy.router.ts:720-720             | orgMemberProcedure/query    | YES            | verifyCitationsSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 248 | policy              | getStatus                     | src/server/routers/policy.router.ts:790-790             | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 249 | policy              | getVersionHistory             | src/server/routers/policy.router.ts:877-877             | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 250 | publicMarketing     | validateUnsubscribeToken      | src/server/routers/publicMarketing.router.ts:67-67      | publicProcedure/query       | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 251 | publicMarketing     | unsubscribe                   | src/server/routers/publicMarketing.router.ts:94-94      | publicProcedure/mutation    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 252 | publicMarketing     | applyForPilot                 | src/server/routers/publicMarketing.router.ts:164-164    | publicProcedure/mutation    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 253 | session             | heartbeat                     | src/server/routers/session.router.ts:24-24              | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 254 | support             | create                        | src/server/routers/support.router.ts:28-28              | protectedProcedure/mutation | YES            | createTicketSchema                     | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 255 | support             | list                          | src/server/routers/support.router.ts:45-45              | protectedProcedure/query    | YES            | listTicketsSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 256 | support             | getByTicketNumber             | src/server/routers/support.router.ts:61-61              | protectedProcedure/query    | YES            | getTicketByNumberSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 257 | support             | addComment                    | src/server/routers/support.router.ts:77-77              | protectedProcedure/mutation | YES            | addCommentSchema                       | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 258 | trial               | activate                      | src/server/routers/trial.router.ts:20-20                | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 259 | trial               | status                        | src/server/routers/trial.router.ts:33-33                | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 260 | usage               | current                       | src/server/routers/usage.router.ts:109-109              | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 261 | usage               | history                       | src/server/routers/usage.router.ts:147-147              | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 262 | usage               | compare                       | src/server/routers/usage.router.ts:194-194              | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 263 | usage               | periodDetail                  | src/server/routers/usage.router.ts:252-252              | orgMemberProcedure/query    | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 264 | user                | getProfile                    | src/server/routers/user.router.ts:40-40                 | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 265 | user                | updateProfile                 | src/server/routers/user.router.ts:107-107               | protectedProcedure/mutation | YES            | updateProfileSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 266 | user                | changePassword                | src/server/routers/user.router.ts:176-176               | protectedProcedure/mutation | YES            | changePasswordSchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 267 | user                | updatePreferences             | src/server/routers/user.router.ts:326-326               | protectedProcedure/mutation | YES            | updatePreferencesSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 268 | user                | getSessions                   | src/server/routers/user.router.ts:365-365               | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 269 | user                | revokeSession                 | src/server/routers/user.router.ts:409-409               | protectedProcedure/mutation | YES            | revokeSessionSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 270 | user                | revokeOtherSessions           | src/server/routers/user.router.ts:445-445               | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 271 | user                | revokeAllSessions             | src/server/routers/user.router.ts:479-479               | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 272 | user                | getTotpStatus                 | src/server/routers/user.router.ts:514-514               | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 273 | user                | setupTotp                     | src/server/routers/user.router.ts:541-541               | protectedProcedure/mutation | YES            | setupTotpSchema                        | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 274 | user                | confirmTotpSetup              | src/server/routers/user.router.ts:581-581               | protectedProcedure/mutation | YES            | confirmTotpSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 275 | user                | disableTotp                   | src/server/routers/user.router.ts:639-639               | protectedProcedure/mutation | YES            | disableTotpSchema                      | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 276 | user                | deleteAccount                 | src/server/routers/user.router.ts:698-698               | protectedProcedure/mutation | YES            | deleteAccountSchema                    | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 277 | user                | getNotificationPreferences    | src/server/routers/user.router.ts:746-746               | protectedProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 278 | user                | getAvatarUploadUrl            | src/server/routers/user.router.ts:812-812               | protectedProcedure/mutation | YES            | getAvatarUploadUrlSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 279 | user                | confirmAvatarUpload           | src/server/routers/user.router.ts:833-833               | protectedProcedure/mutation | YES            | confirmAvatarUploadSchema              | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 280 | user                | deleteAvatar                  | src/server/routers/user.router.ts:853-853               | protectedProcedure/mutation | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 281 | user                | updateNotificationPreferences | src/server/routers/user.router.ts:871-871               | protectedProcedure/mutation | YES            | updateAllNotificationPreferencesSchema | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 282 | vault               | getUploadLimits               | src/server/routers/vault.router.ts:32-32                | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 283 | vault               | getUploadUrl                  | src/server/routers/vault.router.ts:42-42                | orgMemberProcedure/mutation | YES            | vaultGetUploadUrlSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 284 | vault               | confirmUpload                 | src/server/routers/vault.router.ts:71-71                | orgMemberProcedure/mutation | YES            | vaultConfirmUploadSchema               | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 285 | vault               | list                          | src/server/routers/vault.router.ts:108-108              | orgMemberProcedure/query    | YES            | vaultListQuerySchema                   | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 286 | vault               | getById                       | src/server/routers/vault.router.ts:134-134              | orgMemberProcedure/query    | YES            | vaultDocumentIdSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 287 | vault               | getDownloadUrl                | src/server/routers/vault.router.ts:154-154              | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |
| 288 | vault               | update                        | src/server/routers/vault.router.ts:175-175              | orgMemberProcedure/mutation | YES            | vaultUpdateDocumentSchema              | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 289 | vault               | updateStatus                  | src/server/routers/vault.router.ts:202-202              | orgMemberProcedure/mutation | YES            | vaultUpdateStatusSchema                | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 290 | vault               | delete                        | src/server/routers/vault.router.ts:223-223              | orgMemberProcedure/mutation | YES            | vaultDocumentIdSchema                  | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 291 | vault               | getStats                      | src/server/routers/vault.router.ts:243-243              | orgMemberProcedure/query    | NO             | none                                   | NO                  | Missing explicit boundary; add z.void() if no input is intended.                          |
| 292 | vault               | getReplaceUrl                 | src/server/routers/vault.router.ts:259-259              | orgMemberProcedure/mutation | YES            | vaultReplaceDocumentSchema             | PARTIAL             | Shared schema; field-depth verified for high-volume/high-impact procedures in Appendix E. |
| 293 | vault               | confirmReplace                | src/server/routers/vault.router.ts:284-284              | orgMemberProcedure/mutation | YES            | inline                                 | PARTIAL             | Inline schema; promote non-trivial schemas and verify all strings/IDs are bounded.        |

Summary counters:

- Total procedures audited: 293
- Procedures missing `.input()`: 55
- Procedures with PARTIAL / NO bounding: 293
- Procedures using inline (non-shared) schemas: 133

## Appendix C — `process.env` Direct-Access Census

| #   | File:Line                                         | Variable Read                 | Context (1-line excerpt)                                                                                             | Verdict  | Recommendation                                                                      |
| --- | ------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| 1   | src/app.ts:66-66                                  | NODE_ENV                      | `if (process.env.NODE_ENV === 'production') {`                                                                       | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 2   | src/app.ts:67-67                                  | INTASEND_WEBHOOK_ALLOWED_IPS  | `const allowedIps = parseAllowedIps(process.env.INTASEND_WEBHOOK_ALLOWED_IPS \|\| '68.183.180.25,157.245.201.212');` | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 3   | src/app.ts:73-73                                  | INTASEND_WEBHOOK_CHALLENGE    | `if (!process.env.INTASEND_WEBHOOK_CHALLENGE && !appConfig.intasend?.webhookChallenge) {`                            | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 4   | src/app.ts:87-87                                  | TRUST_PROXY                   | `trustProxy: process.env.TRUST_PROXY ?? true,`                                                                       | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 5   | src/app.ts:94-94                                  | FRONTEND_URL                  | `const allowedOrigins = (process.env.FRONTEND_URL \|\| 'http://localhost:3000')`                                     | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 6   | src/app.ts:187-187                                | INTASEND_WEBHOOK_ALLOWED_IPS  | `const allowedIps = parseAllowedIps(process.env.INTASEND_WEBHOOK_ALLOWED_IPS \|\| '68.183.180.25,157.245.201.212');` | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 7   | src/app.ts:207-207                                | INTASEND_WEBHOOK_CHALLENGE    | `const expectedChallenge = process.env.INTASEND_WEBHOOK_CHALLENGE \|\| appConfig.intasend?.webhookChallenge;`        | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 8   | src/app.ts:352-352                                | npm_package_version           | `version: process.env.npm_package_version ?? '1.0.0',`                                                               | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 9   | src/app.ts:353-353                                | NODE_ENV                      | `environment: process.env.NODE_ENV \|\| 'development',`                                                              | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 10  | src/app.ts:435-435                                | npm_package_version           | `version: process.env.npm_package_version ?? '1.0.0',`                                                               | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 11  | src/app.ts:555-555                                | NODE_ENV                      | `process.env.NODE_ENV === 'development'`                                                                             | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 12  | src/config/email.config.ts:121-121                | EMAIL_SUPPORT_ADDRESS         | `supportEmail: process.env.EMAIL_SUPPORT_ADDRESS \|\| 'support@sheriabot.com',`                                      | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 13  | src/config/stripe.config.ts:18-18                 | STRIPE_PRICE_STARTUP_MONTHLY  | `monthly: process.env.STRIPE_PRICE_STARTUP_MONTHLY ?? 'price_startup_monthly',`                                      | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 14  | src/config/stripe.config.ts:21-21                 | STRIPE_PRICE_BUSINESS_MONTHLY | `monthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? 'price_business_monthly',`                                    | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 15  | src/emails/theme.ts:8-8                           | R2_PUBLIC_BUCKET_URL          | `const R2_PUBLIC_URL = process.env.R2_PUBLIC_BUCKET_URL ?? '';`                                                      | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 16  | src/emails/theme.ts:10-10                         | FRONTEND_URL                  | `const FRONTEND_URL = (process.env.FRONTEND_URL \|\| 'https://sheriabot.com').split(',')[0].trim();`                 | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 17  | src/emails/theme.ts:45-45                         | EMAIL_SUPPORT_ADDRESS         | `export const SUPPORT_EMAIL = process.env.EMAIL_SUPPORT_ADDRESS \|\| 'support@sheriabot.com';`                       | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 18  | src/index.ts:1-1                                  | process.env                   | `import 'dotenv/config'; // Must be first - populates process.env before any other import reads it`                  | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 19  | src/index.ts:58-58                                | process.env                   | `if (!process.env[key]) {`                                                                                           | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 20  | src/index.ts:84-84                                | PORT                          | `const port = parseInt(process.env.PORT \|\| '4000', 10);`                                                           | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 21  | src/index.ts:85-85                                | HOST                          | `const host = process.env.HOST \|\| '0.0.0.0';`                                                                      | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 22  | src/index.ts:106-106                              | NODE_ENV                      | `environment: process.env.NODE_ENV \|\| 'development',`                                                              | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 23  | src/index.ts:111-111                              | TRUST_PROXY                   | `trustProxy: process.env.TRUST_PROXY ?? true,`                                                                       | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 24  | src/index.ts:122-122                              | NODE_ENV                      | `║   Environment: ${(process.env.NODE_ENV \|\| 'development').toUpperCase().padEnd(11)}                          ║`  | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 25  | src/lib/email/react-mailer.service.ts:655-655     | NODE_ENV                      | `{ name: 'env',        value: process.env.NODE_ENV ?? 'unknown' },`                                                  | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 26  | src/lib/logger.ts:12-12                           | NODE_ENV                      | `const isProduction = process.env.NODE_ENV === 'production';`                                                        | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 27  | src/lib/logger.ts:13-13                           | LOG_LEVEL                     | `const logLevel = process.env.LOG_LEVEL \|\| (isProduction ? 'info' : 'debug');`                                     | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 28  | src/lib/logger.ts:49-49                           | NODE_ENV                      | `env: process.env.NODE_ENV \|\| 'development',`                                                                      | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 29  | src/lib/prisma/client.ts:55-55                    | DATABASE_URL                  | `connectionString: process.env.DATABASE_URL!,`                                                                       | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 30  | src/lib/rag/client.ts:58-58                       | PINECONE_API_KEY              | `apiKey: process.env.PINECONE_API_KEY \|\| '',`                                                                      | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 31  | src/lib/rag/client.ts:65-65                       | PINECONE_INDEX_NAME           | `return process.env.PINECONE_INDEX_NAME \|\| 'sheriabot-legal-docs';`                                                | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 32  | src/lib/redis/cache.service.ts:417-417            | NODE_ENV                      | `if (process.env.NODE_ENV === 'production') {`                                                                       | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 33  | src/lib/redis/client.ts:14-14                     | UPSTASH_REDIS_REST_URL        | `url: process.env.UPSTASH_REDIS_REST_URL!,`                                                                          | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 34  | src/lib/redis/client.ts:15-15                     | UPSTASH_REDIS_REST_TOKEN      | `token: process.env.UPSTASH_REDIS_REST_TOKEN!,`                                                                      | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 35  | src/lib/redis/client.ts:204-204                   | NODE_ENV                      | `if (process.env.NODE_ENV === 'production') { logger.warn('Refusing to flush Redis in production'); return false; }` | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 36  | src/lib/storage/client.ts:138-138                 | R2_VAULT_BUCKET               | `R2_VAULT_BUCKET: process.env.R2_VAULT_BUCKET,`                                                                      | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 37  | src/lib/storage/client.ts:139-139                 | R2_VAULT_ENDPOINT             | `R2_VAULT_ENDPOINT: process.env.R2_VAULT_ENDPOINT,`                                                                  | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 38  | src/lib/storage/client.ts:140-140                 | R2_VAULT_ACCESS_KEY_ID        | `R2_VAULT_ACCESS_KEY_ID: process.env.R2_VAULT_ACCESS_KEY_ID,`                                                        | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 39  | src/lib/storage/client.ts:141-141                 | R2_VAULT_SECRET_ACCESS_KEY    | `R2_VAULT_SECRET_ACCESS_KEY: process.env.R2_VAULT_SECRET_ACCESS_KEY,`                                                | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 40  | src/lib/storage/README.md:489-489                 | R2_ACCOUNT_ID                 | `accountId: process.env.R2_ACCOUNT_ID,`                                                                              | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 41  | src/lib/storage/README.md:490-490                 | R2_ACCESS_KEY_ID              | `accessKeyId: process.env.R2_ACCESS_KEY_ID,`                                                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 42  | src/lib/storage/README.md:491-491                 | R2_SECRET_ACCESS_KEY          | `secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,`                                                                 | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 43  | src/lib/storage/README.md:492-492                 | R2_BUCKET_NAME                | `bucketName: process.env.R2_BUCKET_NAME,`                                                                            | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 44  | src/lib/storage/README.md:493-493                 | R2_PUBLIC_URL                 | `publicUrl: process.env.R2_PUBLIC_URL,`                                                                              | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 45  | src/lib/supabase.ts:9-9                           | SUPABASE_URL                  | `process.env.SUPABASE_URL!,`                                                                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 46  | src/lib/supabase.ts:10-10                         | SUPABASE_SERVICE_ROLE_KEY     | `process.env.SUPABASE_SERVICE_ROLE_KEY!,`                                                                            | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 47  | src/lib/supabase.ts:25-25                         | SUPABASE_URL                  | `process.env.SUPABASE_URL!,`                                                                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 48  | src/lib/supabase.ts:26-26                         | SUPABASE_ANON_KEY             | `process.env.SUPABASE_ANON_KEY!,`                                                                                    | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 49  | src/lib/supabase.ts:41-41                         | SUPABASE_URL                  | `process.env.SUPABASE_URL!,`                                                                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 50  | src/lib/supabase.ts:42-42                         | SUPABASE_ANON_KEY             | `process.env.SUPABASE_ANON_KEY!,`                                                                                    | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 51  | src/modules/admin/admin.module.ts:934-934         | npm_package_version           | `version: process.env.npm_package_version ?? '1.0.0',`                                                               | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 52  | src/modules/admin/admin.module.ts:1029-1029       | PINECONE_INDEX_NAME           | `indexName: process.env.PINECONE_INDEX_NAME ?? 'sheriabot-legal-docs',`                                              | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 53  | src/modules/admin/admin.module.ts:1041-1041       | PINECONE_INDEX_NAME           | `indexName: process.env.PINECONE_INDEX_NAME ?? 'sheriabot-legal-docs',`                                              | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 54  | src/modules/alert/alert.service.ts:436-436        | FRONTEND_URL                  | `const frontendUrl = (process.env.FRONTEND_URL ?? 'https://sheriabot.com')`                                          | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 55  | src/modules/auth/auth.module.ts:169-169           | SUPABASE_JWT_SECRET           | `const accessToken = generateAccessToken(safeUser, sessionId, (process.env.SUPABASE_JWT_SECRET!));`                  | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 56  | src/modules/auth/auth.module.ts:171-171           | SUPABASE_JWT_SECRET           | `const refreshToken = generateRefreshToken(user.id, refreshTokenId, (process.env.SUPABASE_JWT_SECRET!));`            | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 57  | src/modules/auth/auth.module.ts:268-268           | SUPABASE_JWT_SECRET           | `const accessToken = generateAccessToken(safeUser, sessionId, (process.env.SUPABASE_JWT_SECRET!));`                  | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 58  | src/modules/auth/auth.module.ts:270-270           | SUPABASE_JWT_SECRET           | `const refreshToken = generateRefreshToken(user.id, refreshTokenId, (process.env.SUPABASE_JWT_SECRET!));`            | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 59  | src/modules/auth/auth.module.ts:348-348           | SUPABASE_JWT_SECRET           | `(process.env.SUPABASE_JWT_SECRET!)`                                                                                 | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 60  | src/modules/auth/auth.module.ts:382-382           | SUPABASE_JWT_SECRET           | `(process.env.SUPABASE_JWT_SECRET!)`                                                                                 | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 61  | src/modules/auth/auth.module.ts:389-389           | SUPABASE_JWT_SECRET           | `(process.env.SUPABASE_JWT_SECRET!)`                                                                                 | CRITICAL | Move JWT secret access to boot-validated config and remove direct runtime reads.    |
| 62  | src/modules/trial/trial.service.ts:104-104        | FRONTEND_URL                  | `dashboardUrl: \`${process.env['FRONTEND_URL'] ?? ''}/startup\`,`                                                    | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 63  | src/modules/trial/trial.service.ts:180-180        | FRONTEND_URL                  | `upgradeUrl:   \`${process.env['FRONTEND_URL'] ?? ''}/settings/billing\`,`                                           | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 64  | src/modules/trial/trial.service.ts:348-348        | FRONTEND_URL                  | `upgradeUrl: \`${process.env['FRONTEND_URL'] ?? ''}/settings/billing\`,`                                             | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 65  | src/modules/vault/reconciliation.service.ts:60-60 | VAULT_RECONCILIATION_DRY_RUN  | `return process.env.VAULT_RECONCILIATION_DRY_RUN !== 'false';`                                                       | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 66  | src/plugins/security.plugin.ts:12-12              | NODE_ENV                      | `const isProduction = process.env.NODE_ENV === 'production';`                                                        | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 67  | src/scripts/cleanup-deleted-documents.ts:26-26    | RETENTION_DAYS                | `const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '90', 10);`                                           | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 68  | src/scripts/migrate.ts:15-15                      | DATABASE_URL                  | `if (!process.env.DATABASE_URL) {`                                                                                   | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 69  | src/scripts/migrate.ts:23-23                      | process.env                   | `env: process.env,`                                                                                                  | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 70  | src/scripts/pilot-lifecycle-cron.ts:47-47         | FRONTEND_URL                  | `const FRONTEND_URL = (process.env.FRONTEND_URL \|\| 'https://app.sheriabot.com')`                                   | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 71  | src/scripts/provision-pilot-testers.ts:42-42      | DATABASE_URL                  | `const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });`                                     | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 72  | src/scripts/provision-pilot-testers.ts:46-46      | SUPABASE_URL                  | `process.env.SUPABASE_URL!,`                                                                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 73  | src/scripts/provision-pilot-testers.ts:47-47      | SUPABASE_SERVICE_ROLE_KEY     | `process.env.SUPABASE_SERVICE_ROLE_KEY!,`                                                                            | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 74  | src/scripts/seed-admin.ts:20-20                   | DATABASE_URL                  | `const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });`                                     | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 75  | src/scripts/seed-admin.ts:24-24                   | SUPABASE_URL                  | `process.env.SUPABASE_URL!,`                                                                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 76  | src/scripts/seed-admin.ts:25-25                   | SUPABASE_SERVICE_ROLE_KEY     | `process.env.SUPABASE_SERVICE_ROLE_KEY!,`                                                                            | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 77  | src/scripts/seed-admin.ts:30-30                   | ADMIN_EMAIL                   | `const email = process.env.ADMIN_EMAIL \|\| 'admin@sheriabot.com';`                                                  | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 78  | src/scripts/seed-admin.ts:31-31                   | ADMIN_PASSWORD                | `const password = process.env.ADMIN_PASSWORD \|\| 'SheriaBot-Admin-2024!';`                                          | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 79  | src/scripts/seed-admin.ts:32-32                   | ADMIN_NAME                    | `const fullName = process.env.ADMIN_NAME \|\| 'System Admin';`                                                       | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 80  | src/scripts/seed-marketing-feature-flags.ts:21-21 | DATABASE_URL                  | `const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });`                                     | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 81  | src/scripts/seed-regulatory-frameworks.ts:5-5     | DATABASE_URL                  | `const adapter = new PrismaPg({ consheriabot.comprocess.env.DATABASE_URL! });`                                       | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 82  | src/scripts/seed.ts:18-18                         | ADMIN_EMAIL                   | `const adminEmail = process.env.ADMIN_EMAIL \|\| 'admin@sheriabot.co.ke';`                                           | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 83  | src/scripts/seed.ts:19-19                         | ADMIN_PASSWORD                | `const adminPassword = process.env.ADMIN_PASSWORD \|\| 'SheriaBot-Admin-2024!';`                                     | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 84  | src/scripts/smoke-stream-done.ts:12-12            | PORT                          | `const BACKEND_BASE = \`http://localhost:${process.env.PORT ?? 4000}\`;`                                             | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 85  | src/scripts/smoke-stream-done.ts:15-15            | SMOKE_EMAIL                   | `const email = process.env.SMOKE_EMAIL;`                                                                             | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 86  | src/scripts/smoke-stream-done.ts:16-16            | SMOKE_PASS                    | `const pass  = process.env.SMOKE_PASS;`                                                                              | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 87  | src/scripts/test-ai.ts:70-70                      | ANTHROPIC_API_KEY             | `const hasApiKey = !!process.env.ANTHROPIC_API_KEY;`                                                                 | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 88  | src/scripts/test-email.ts:63-63                   | RESEND_API_KEY                | `const hasApiKey = !!process.env.RESEND_API_KEY;`                                                                    | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 89  | src/scripts/test-email.ts:64-64                   | FROM_EMAIL                    | `const hasFromEmail = !!process.env.FROM_EMAIL;`                                                                     | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 90  | src/scripts/test-email.ts:256-256                 | TEST_EMAIL                    | `const testEmail = process.argv[2] \|\| process.env.TEST_EMAIL;`                                                     | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 91  | src/scripts/test-email.ts:363-363                 | TEST_EMAIL                    | `if (process.argv[2] \|\| process.env.TEST_EMAIL) {`                                                                 | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 92  | src/scripts/test-rag.ts:67-67                     | PINECONE_API_KEY              | `const hasPineconeKey = !!process.env.PINECONE_API_KEY;`                                                             | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 93  | src/scripts/test-rag.ts:68-68                     | PINECONE_INDEX_NAME           | `const hasIndexName = !!process.env.PINECONE_INDEX_NAME;`                                                            | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 94  | src/scripts/test-storage.ts:65-65                 | R2_ACCESS_KEY_ID              | `const hasAccessKey = !!process.env.R2_ACCESS_KEY_ID;`                                                               | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 95  | src/scripts/test-storage.ts:66-66                 | R2_SECRET_ACCESS_KEY          | `const hasSecretKey = !!process.env.R2_SECRET_ACCESS_KEY;`                                                           | REFACTOR | Read through typed config; ensure secret never appears in client responses or logs. |
| 96  | src/scripts/test-storage.ts:67-67                 | R2_ACCOUNT_ID                 | `const hasAccountId = !!process.env.R2_ACCOUNT_ID;`                                                                  | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 97  | src/scripts/test-storage.ts:68-68                 | R2_BUCKET_NAME                | `const hasBucketName = !!process.env.R2_BUCKET_NAME;`                                                                | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 98  | src/server/routers/admin.router.ts:1480-1480      | EMAIL_SUPPORT_ADDRESS         | `supportEmail: process.env.EMAIL_SUPPORT_ADDRESS \|\| 'support@sheriabot.com',`                                      | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 99  | src/server/routers/admin.router.ts:1860-1860      | NODE_ENV                      | `stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,`                                            | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 100 | src/server/routers/auth.router.ts:182-182         | APP_CALLBACK_URL              | `const appCallbackUrl = process.env.APP_CALLBACK_URL \|\| 'https://sheriabot.com/auth/callback';`                    | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 101 | src/server/routers/auth.router.ts:920-920         | APP_CALLBACK_URL              | `const appCallbackUrl = process.env.APP_CALLBACK_URL \|\| 'https://sheriabot.com/auth/callback';`                    | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 102 | src/server/trpc/context.ts:93-93                  | SESSION_FINGERPRINT_MODE      | `const SESSION_FINGERPRINT_MODE = parseSessionFingerprintMode(process.env.SESSION_FINGERPRINT_MODE);`                | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |
| 103 | src/server/trpc/init.ts:62-62                     | NODE_ENV                      | `const isProd = process.env.NODE_ENV === 'production';`                                                              | SAFE     | Non-secret or operational default; keep out of client responses.                    |
| 104 | src/server/trpc/middleware.ts:257-257             | AUDIT_GRANT_SAMPLE_RATE       | `Math.max(0, parseFloat(process.env['AUDIT_GRANT_SAMPLE_RATE'] ?? '0.10')),`                                         | REFACTOR | Route through typed config or a narrow boot-time singleton.                         |

Rows marked CRITICAL are covered by SK-5. No row was observed returning an environment value to a client response.

## Appendix D — `supabaseAdmin` Import Census

Backend repo only; the Vercel frontend repo is out-of-scope for this appendix.

| #   | File:Line                                    | Import Style                                                                                         | Server-Only? | Bundled to Client? | Used For                        | Verdict    |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------ | ------------------ | ------------------------------- | ---------- |
| 1   | src/app.ts:11-11                             | `import { supabaseAdmin } from './lib/supabase';`                                                    | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 2   | src/app.ts:372-372                           | `const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);`              | YES          | NO                 | JWT/user verification           | ACCEPTABLE |
| 3   | src/lib/supabase.ts:8-8                      | `export const supabaseAdmin = createClient(`                                                         | YES          | NO                 | admin/client singleton creation | ACCEPTABLE |
| 4   | src/modules/admin/admin.module.ts:35-35      | `import { supabaseAdmin } from '@/lib/supabase';`                                                    | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 5   | src/modules/admin/admin.module.ts:1383-1383  | `const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({`           | YES          | NO                 | admin user provisioning         | ACCEPTABLE |
| 6   | src/routes/compliance-stream.route.ts:3-3    | `import { supabaseAdmin } from '@/lib/supabase';`                                                    | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 7   | src/routes/compliance-stream.route.ts:56-56  | `const { data, error } = await supabaseAdmin.auth.getUser(token);`                                   | YES          | NO                 | JWT/user verification           | ACCEPTABLE |
| 8   | src/scripts/provision-pilot-testers.ts:45-45 | `const supabaseAdmin = createClient(`                                                                | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 9   | src/scripts/provision-pilot-testers.ts:86-86 | `const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(` | YES          | NO                 | admin user provisioning         | ACCEPTABLE |
| 10  | src/scripts/seed-admin.ts:23-23              | `const supabaseAdmin = createClient(`                                                                | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 11  | src/scripts/seed-admin.ts:50-50              | `const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({`           | YES          | NO                 | admin user provisioning         | ACCEPTABLE |
| 12  | src/scripts/seed-admin.ts:62-62              | `const { data: listData } = await supabaseAdmin.auth.admin.listUsers();`                             | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 13  | src/server/routers/auth.router.ts:21-21      | `import { supabaseAdmin, supabaseClient } from '@/lib/supabase';`                                    | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 14  | src/server/routers/auth.router.ts:187-187    | `const { data: authData, error: authError } = await supabaseAdmin.auth.admin.generateLink({`         | YES          | NO                 | email action-link generation    | ACCEPTABLE |
| 15  | src/server/routers/auth.router.ts:212-212    | `const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({`           | YES          | NO                 | admin user provisioning         | ACCEPTABLE |
| 16  | src/server/routers/auth.router.ts:265-265    | `await supabaseAdmin.auth.admin.deleteUser(supabaseUserId).catch((delErr: any) => {`                 | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 17  | src/server/routers/auth.router.ts:601-601    | `await supabaseAdmin.auth.admin.signOut(supabaseAuthId).catch((signOutErr: unknown) => {`            | YES          | NO                 | admin signOut                   | ACCEPTABLE |
| 18  | src/server/routers/auth.router.ts:714-714    | `* F4.5a  -  error-checks supabaseAdmin.auth.admin.updateUserById().`                                | YES          | NO                 | admin user update               | ACCEPTABLE |
| 19  | src/server/routers/auth.router.ts:755-755    | `const { error: supabaseUpdateError } = await supabaseAdmin.auth.admin.updateUserById(`              | YES          | NO                 | admin user update               | ACCEPTABLE |
| 20  | src/server/routers/auth.router.ts:773-773    | `await supabaseAdmin.auth.admin.signOut(supabaseAuthId).catch((signOutErr: any) => {`                | YES          | NO                 | admin signOut                   | ACCEPTABLE |
| 21  | src/server/routers/auth.router.ts:830-830    | `const { error: supabaseError } = await supabaseAdmin.auth.admin.updateUserById(`                    | YES          | NO                 | admin user update               | ACCEPTABLE |
| 22  | src/server/routers/auth.router.ts:921-921    | `const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({`         | YES          | NO                 | email action-link generation    | ACCEPTABLE |
| 23  | src/server/routers/auth.router.ts:969-969    | `await supabaseAdmin.auth.getUser(input.accessToken);`                                               | YES          | NO                 | JWT/user verification           | ACCEPTABLE |
| 24  | src/server/routers/user.router.ts:22-22      | `import { supabaseAdmin } from '@/lib/supabase';`                                                    | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 25  | src/server/routers/user.router.ts:253-253    | `const { error: supabaseUpdateError } = await supabaseAdmin.auth.admin.updateUserById(`              | YES          | NO                 | admin user update               | ACCEPTABLE |
| 26  | src/server/routers/user.router.ts:272-272    | `await supabaseAdmin.auth.admin.signOut(supabaseAuthId).catch((signOutErr: unknown) => {`            | YES          | NO                 | admin signOut                   | ACCEPTABLE |
| 27  | src/server/trpc/context.ts:6-6               | `import { supabaseAdmin } from '@/lib/supabase';`                                                    | YES          | NO                 | Supabase auth/admin operation   | ACCEPTABLE |
| 28  | src/server/trpc/context.ts:105-105           | `* 2. Verify it via supabaseAdmin.auth.getUser()  -  works for both HS256 and RS256`                 | YES          | NO                 | JWT/user verification           | ACCEPTABLE |
| 29  | src/server/trpc/context.ts:126-126           | `const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);`              | YES          | NO                 | JWT/user verification           | ACCEPTABLE |

No `supabaseAdmin` import appears under frontend `app/`, `components/`, or `hooks/` paths in this backend repository.

## Appendix E — Per-Field Validation Depth

### E.1 — auth.register

File:Line: src/server/routers/auth.router.ts:105-106  
Schema file: src/server/schemas/auth.schema.ts:23-34

| Field          | Zod Type             | Constraints (min/max/regex/enum/uuid/etc.)                                                            | Verdict | Recommendation if applicable                           |
| -------------- | -------------------- | ----------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| email          | emailSchema          | email, trim/lowercase, max 255 (src/utils/validation.ts:8-13)                                         | OK      |                                                        |
| password       | passwordSchema       | min 10, max 128, uppercase/lowercase/digit/special (src/shared/validation/password.schema.ts:175-191) | OK      |                                                        |
| name           | z.string             | min 2, max 100 (src/server/schemas/auth.schema.ts:23-34)                                              | OK      |                                                        |
| role           | z.enum               | REGULATOR/STARTUP/ENTERPRISE (src/server/schemas/auth.schema.ts:23-34)                                | OK      |                                                        |
| companyName    | z.string optional    | min 2, max 200 (src/server/schemas/auth.schema.ts:23-34)                                              | OK      |                                                        |
| organizationId | z.string optional    | no uuid/cuid/max (src/server/schemas/auth.schema.ts:23-34)                                            | WEAK    | Use cuid/uuid or bounded invite/org identifier schema. |
| phone          | phoneSchema optional | Kenyan phone regex + normalization (src/utils/validation.ts:22-42)                                    | OK      |                                                        |

### E.2 — auth.login

File:Line: src/server/routers/auth.router.ts:341-348  
Schema file: src/server/schemas/auth.schema.ts:46-50

| Field    | Zod Type    | Constraints (min/max/regex/enum/uuid/etc.)                    | Verdict | Recommendation if applicable                                                       |
| -------- | ----------- | ------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| email    | emailSchema | email, trim/lowercase, max 255 (src/utils/validation.ts:8-13) | OK      |                                                                                    |
| password | z.string    | min 1 only (src/server/schemas/auth.schema.ts:46-50)          | OK      | Login must not enforce password policy before auth; rate limit covers brute force. |

### E.3 — auth.requestPasswordReset

File:Line: src/server/routers/auth.router.ts:656-662  
Schema file: src/server/schemas/auth.schema.ts:61-63

| Field | Zod Type    | Constraints                    | Verdict | Recommendation if applicable |
| ----- | ----------- | ------------------------------ | ------- | ---------------------------- |
| email | emailSchema | email, trim/lowercase, max 255 | OK      |                              |

### E.4 — auth.resetPassword

File:Line: src/server/routers/auth.router.ts:718-755  
Schema file: src/server/schemas/auth.schema.ts:76-80

| Field       | Zod Type       | Constraints                        | Verdict | Recommendation if applicable                                     |
| ----------- | -------------- | ---------------------------------- | ------- | ---------------------------------------------------------------- |
| token       | z.string       | min 1 only                         | WEAK    | Add expected token length/format max to reduce log/parser abuse. |
| newPassword | passwordSchema | min 10, max 128, composition rules | OK      |                                                                  |

### E.5 — auth.changePassword

File:Line: src/server/routers/user.router.ts:176-253  
Schema file: src/server/schemas/auth.schema.ts:96-106

| Field           | Zod Type       | Constraints                        | Verdict | Recommendation if applicable                               |
| --------------- | -------------- | ---------------------------------- | ------- | ---------------------------------------------------------- |
| currentPassword | z.string       | min 1 only                         | OK      | Current secret is verified, not stored; avoid policy leak. |
| newPassword     | passwordSchema | min 10, max 128, composition rules | OK      |                                                            |
| confirmPassword | z.string       | min 1 + refine equality            | OK      |                                                            |

### E.6 — auth.confirmEmailCallback

File:Line: src/server/routers/auth.router.ts:963-972  
Schema file: inline: src/server/routers/auth.router.ts:963-972

| Field       | Zod Type | Constraints | Verdict | Recommendation if applicable                   |
| ----------- | -------- | ----------- | ------- | ---------------------------------------------- |
| accessToken | z.string | min 1 only  | WEAK    | Add upper bound and JWT/base64url shape guard. |

### E.7 — compliance.query

File:Line: src/server/routers/compliance.router.ts:40-44  
Schema file: src/server/schemas/compliance.schema.ts:20-25

| Field            | Zod Type          | Constraints                          | Verdict | Recommendation if applicable |
| ---------------- | ----------------- | ------------------------------------ | ------- | ---------------------------- |
| question         | z.string          | min 10, max 1000                     | OK      |                              |
| organizationType | z.enum optional   | FINTECH/BANK/TELECOM/INSURANCE/OTHER | OK      |                              |
| industry         | z.string optional | max 100                              | OK      |                              |
| context          | z.string optional | max 2000                             | OK      |                              |

### E.8 — compliance.followUp

File:Line: src/server/routers/compliance.router.ts:252-256  
Schema file: src/server/schemas/compliance.schema.ts:69-72

| Field           | Zod Type | Constraints      | Verdict | Recommendation if applicable           |
| --------------- | -------- | ---------------- | ------- | -------------------------------------- |
| originalQueryId | z.string | no uuid/cuid/max | WEAK    | Use cuid/uuid or bounded DB id schema. |
| question        | z.string | min 10, max 1000 | OK      |                                        |

### E.9 — compliance.search

File:Line: src/server/routers/compliance.router.ts:380-381  
Schema file: src/server/schemas/compliance.schema.ts:32-43

| Field                  | Zod Type          | Constraints               | Verdict | Recommendation if applicable |
| ---------------------- | ----------------- | ------------------------- | ------- | ---------------------------- |
| query                  | z.string          | min 3, max 500            | OK      |                              |
| limit                  | z.number          | min 1, max 50, default 10 | OK      |                              |
| filter.documentType    | z.string optional | no enum/max               | WEAK    | Enum or bounded string.      |
| filter.regulatoryArea  | z.string optional | no enum/max               | WEAK    | Enum or max length.          |
| filter.dateFrom/dateTo | z.date optional   | date type                 | OK      |                              |

### E.10 — vault.requestUploadUrl (implemented as vault.getUploadUrl)

File:Line: src/server/routers/vault.router.ts:42-58  
Schema file: src/server/schemas/vault.schema.ts:58-71

| Field            | Zod Type               | Constraints                               | Verdict | Recommendation if applicable |
| ---------------- | ---------------------- | ----------------------------------------- | ------- | ---------------------------- |
| name             | custom string          | trimmed, no controls, 1..255              | OK      |                              |
| description      | custom string optional | max 1000, control-char rejection          | OK      |                              |
| expiryDate       | datetime optional      | ISO datetime, future                      | OK      |                              |
| declaredFilename | safe filename          | 1..255, no path/control chars             | OK      |                              |
| declaredMimeType | enum                   | VAULT_MIME_TYPES                          | OK      |                              |
| declaredSize     | number                 | int, min configured, max plan entitlement | OK      |                              |
| category         | enum                   | fixed vault categories                    | OK      |                              |
| tags             | array                  | max 20, item regex + max 50               | OK      |                              |

### E.11 — vault.confirmUpload

File:Line: src/server/routers/vault.router.ts:71-79  
Schema file: src/server/schemas/vault.schema.ts:77-79

| Field      | Zod Type | Constraints              | Verdict | Recommendation if applicable                      |
| ---------- | -------- | ------------------------ | ------- | ------------------------------------------------- |
| documentId | z.string | regex /^c[a-z0-9]{8,}$/i | OK      | Better as cuid if Prisma IDs are guaranteed CUID. |

### E.12 — vault.requestDownloadUrl (implemented as vault.getDownloadUrl)

File:Line: src/server/routers/vault.router.ts:154-166  
Schema file: inline: src/server/routers/vault.router.ts:154-155

| Field | Zod Type | Constraints | Verdict | Recommendation if applicable                      |
| ----- | -------- | ----------- | ------- | ------------------------------------------------- |
| id    | z.string | min 1 only  | WEAK    | Use shared vaultDocumentIdSchema with CUID/regex. |

### E.13 — payment.createCheckoutSession (implemented as billing.createCheckoutSession)

File:Line: src/server/routers/billing.router.ts:212-219  
Schema file: inline: src/server/routers/billing.router.ts:214-218

| Field    | Zod Type | Constraints                     | Verdict | Recommendation if applicable |
| -------- | -------- | ------------------------------- | ------- | ---------------------------- |
| plan     | z.enum   | STARTUP/BUSINESS                | OK      |                              |
| interval | z.enum   | monthly/yearly, default monthly | OK      |                              |

### E.14 — payment.initiateMpesaPayment (implemented as billing.initiateMpesaPayment)

File:Line: src/server/routers/billing.router.ts:545-551  
Schema file: inline: src/server/routers/billing.router.ts:546-550

| Field       | Zod Type          | Constraints        | Verdict | Recommendation if applicable                             |
| ----------- | ----------------- | ------------------ | ------- | -------------------------------------------------------- |
| plan        | z.nativeEnum      | SubscriptionPlan   | OK      |                                                          |
| phoneNumber | z.string optional | no phone regex/max | WEAK    | Reuse Kenyan phone schema or strict M-Pesa E.164 schema. |

### E.15 — checklist.generateChecklistAsync

File:Line: src/server/routers/checklist.router.ts:219-224  
Schema file: src/modules/compliance/checklist.types.ts:63-69

| Field              | Zod Type          | Constraints                    | Verdict | Recommendation if applicable |
| ------------------ | ----------------- | ------------------------------ | ------- | ---------------------------- |
| productType        | z.string          | min 1, max 100                 | OK      |                              |
| businessStage      | z.string          | min 1, max 100                 | OK      |                              |
| targetSegments     | z.array(z.string) | array 1..10, item min 1 no max | WEAK    | Add item max, e.g. 100.      |
| servicesOffered    | z.array(z.string) | array 1..20, item min 1 no max | WEAK    | Add item max, e.g. 100.      |
| additionalConcerns | z.string optional | max 1000                       | OK      |                              |

### E.16 — gapAnalysis.runGapAnalysis

File:Line: src/server/routers/gap-analysis.router.ts:67-80  
Schema file: inline: src/server/routers/gap-analysis.router.ts:72-80

| Field                | Zod Type                   | Constraints                              | Verdict | Recommendation if applicable |
| -------------------- | -------------------------- | ---------------------------------------- | ------- | ---------------------------- |
| fileName             | z.string                   | min 1, max 255                           | OK      |                              |
| fileType             | z.enum                     | pdf/docx/doc/txt                         | OK      |                              |
| fileContent          | z.string                   | min 1, max GAP_ANALYSIS_MAX_BASE64_CHARS | OK      |                              |
| regulatoryFrameworks | z.array(z.string)          | array 1..10, item no max/slug regex      | WEAK    | Add slug regex and item max. |
| analysisDepth        | z.enum                     | quick/standard/deep                      | OK      |                              |
| focusAreas           | z.array(z.string) optional | array max 10, item no max                | WEAK    | Add item max.                |

### E.17 — enterprisePolicy.createDraft

File:Line: src/server/routers/enterprise-policy.router.ts:44-55  
Schema file: src/server/schemas/enterprise-policy.schema.ts:26-55

| Field                | Zod Type          | Constraints              | Verdict | Recommendation if applicable |
| -------------------- | ----------------- | ------------------------ | ------- | ---------------------------- |
| policyType           | z.enum            | fixed policy types       | OK      |                              |
| title                | z.string          | min 3, max 255           | OK      |                              |
| description          | z.string optional | max 2000                 | OK      |                              |
| targetAudience       | z.string optional | max 500                  | OK      |                              |
| organizationType     | z.string optional | max 255                  | OK      |                              |
| regulatoryFrameworks | z.array(z.string) | array 1..10, item 1..100 | OK      |                              |
| jurisdiction         | z.string          | max 100, default Kenya   | OK      |                              |
| sourceGapAnalysisId  | z.string optional | cuid                     | OK      |                              |
| sourceGapId          | z.string optional | max 100                  | OK      |                              |

### E.18 — enterprisePolicy.updateSectionContent

File:Line: src/server/routers/enterprise-policy.router.ts:312-366  
Schema file: src/server/schemas/enterprise-policy.schema.ts:93-105

| Field           | Zod Type          | Constraints        | Verdict | Recommendation if applicable                      |
| --------------- | ----------------- | ------------------ | ------- | ------------------------------------------------- |
| policyId        | z.string          | cuid               | OK      |                                                   |
| sectionId       | z.string          | min 1, max 50      | OK      |                                                   |
| content         | z.any             | opaque TipTap JSON | WEAK    | Add document schema or explicit byte/shape guard. |
| contentMarkdown | z.string optional | no max             | WEAK    | Add max length.                                   |

### E.19 — publicMarketing.applyForPilot

File:Line: src/server/routers/publicMarketing.router.ts:164-177  
Schema file: inline: src/server/routers/publicMarketing.router.ts:169-177

| Field       | Zod Type          | Constraints        | Verdict | Recommendation if applicable    |
| ----------- | ----------------- | ------------------ | ------- | ------------------------------- |
| firstName   | z.string          | min 1, max 100     | OK      |                                 |
| lastName    | z.string          | min 1, max 100     | OK      |                                 |
| email       | z.string          | email              | WEAK    | Add max 255 and trim/lowercase. |
| companyName | z.string          | min 1, max 200     | OK      |                                 |
| jobTitle    | z.string          | min 1, max 100     | OK      |                                 |
| phone       | z.string optional | no phone regex/max | WEAK    | Reuse phoneSchema or max.       |
| message     | z.string optional | max 1000           | OK      |                                 |

### E.20 — publicMarketing.confirmUnsubscribe (implemented as publicMarketing.unsubscribe)

File:Line: src/server/routers/publicMarketing.router.ts:94-101  
Schema file: inline: src/server/routers/publicMarketing.router.ts:94-95

| Field | Zod Type | Constraints | Verdict | Recommendation if applicable          |
| ----- | -------- | ----------- | ------- | ------------------------------------- |
| token | z.string | min 1 only  | WEAK    | Add expected token length/format max. |

WEAK rows above are covered by IV-4 unless explicitly rate-limit/session related.

## Appendix F — `auth.logout` Failure-Mode Analysis

Logout sequence: Prisma session deletion (src/server/routers/auth.router.ts:573-575), JTI blocklist write (src/server/routers/auth.router.ts:578-583), Redis user/B3/B5 cleanup (src/server/routers/auth.router.ts:585-595), Supabase admin signOut (src/server/routers/auth.router.ts:601-607).

| #   | What Fails                                            | What Succeeds                                           | Resulting State                                                                                          | Half-Logged-Out? | Risk                                            | Acceptable? | Recommendation                                                                                  |
| --- | ----------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| 1   | Prisma `session.deleteMany` throws                    | None after throw                                        | Procedure aborts before JTI/cache/signOut; DB session remains live                                       | YES              | Token remains usable                            | NO          | Reorder to blocklist first or continue cleanup after DB failure.                                |
| 2   | JTI blocklist write throws                            | Prisma session deleted                                  | Context DB lookup rejects once cache is evicted, but current cache may persist until deleted             | YES              | Short replay window if cache cleanup also fails | NO          | Treat blocklist write as critical and continue cache/signOut cleanup before returning failure.  |
| 3   | Redis user/B3/B5 cleanup throws                       | Prisma delete + JTI blocklist succeeded                 | Token should be rejected by JTI blocklist; stale cache may remain until TTL                              | PARTIAL          | Low if JTI write succeeded                      | YES         | Keep warning, consider delete retry queue.                                                      |
| 4   | Supabase admin signOut throws                         | Prisma delete + JTI blocklist + Redis cleanup succeeded | App-layer token is blocked; Supabase provider session may remain                                         | PARTIAL          | Token cannot pass app context if JTI checked    | YES         | Keep non-fatal but alert on repeated failures.                                                  |
| 5   | Supabase signOut throws after JTI blocklist succeeded | Prisma delete + JTI blocklist + Redis cleanup succeeded | Token cannot be used through tRPC/context; Supabase session may still exist externally                   | PARTIAL          | Low for this backend                            | YES         | Monitor and retry provider signOut asynchronously.                                              |
| 6   | JTI blocklist throws after Supabase signOut succeeds  | Prisma delete may have succeeded                        | If Supabase revocation propagation lags and cache remains, token may work until cache/DB checks converge | YES              | Medium replay window                            | NO          | Make cache eviction and DB session enforcement independent and prioritize blocklist durability. |
| 7   | Redis cache eviction throws but all else succeeds     | Prisma delete + JTI blocklist + Supabase signOut        | Next request hits JTI blocklist first in context (src/server/trpc/context.ts:134-143) and rejects        | NO               | Low                                             | YES         | No immediate remediation beyond retry/logging.                                                  |

Non-acceptable permutations are documented here for Phase B prioritization. The main actionable session-policy finding added by this revision is SA-2.

## Appendix G — Concurrent Session Policy

1. Current state: login creates a new `Session` row with `ctx.prisma.session.create` and stores per-session B5 fingerprint data (src/server/routers/auth.router.ts:468-520). No query in this flow counts active `Session` rows, deletes oldest sessions, or applies a per-role cap. The Prisma model indexes sessions by user but has no uniqueness/cap constraint (prisma/schema.prisma:169-182).

2. By-role analysis: ADMIN is highest risk because a stolen token can be used in parallel while the legitimate admin continues working; admin procedures cover users, orgs, billing, content, exports, and sign-out operations. REGULATOR compromise grants visibility into organization compliance posture and should have stricter anomaly response than STARTUP. STARTUP/ENTERPRISE can tolerate broader concurrency, but ENTERPRISE pilots should have a documented cap, e.g. max 10 active tester sessions, as an operational SLA.

3. Interaction with B5 fingerprint mode: `SESSION_FINGERPRINT_MODE` is parsed globally from env (src/server/trpc/context.ts:75-93). In monitor mode, mismatch events are logged, but only enforce mode writes the JTI blocklist and rejects the request (src/server/trpc/context.ts:256-314). Therefore, a stolen token used from a second IP/UA is observable but not automatically revoked while monitor mode is active.

4. Recommendation: document max concurrent sessions by role and evaluate per-role fingerprint enforcement for ADMIN. A trusted-devices model would reduce false positives before enforcing revocation globally.

Finding: SA-2 records the Medium ADMIN-role risk for no cap, no per-role differentiation, and monitor-only fingerprinting.

## Appendix H — SSE Stream-Token Analysis

### /api/alerts/stream

1. Token issuance: `alert.createStreamToken` mints the token through `createAlertStreamToken(ctx.user!.id)` (src/server/routers/alert.router.ts:16-24).
2. Token storage: token is random 32 bytes, base64url-encoded, SHA-256 hashed into Redis key `alerts:stream-token:<hash>`, TTL 60 seconds (src/lib/alerts/stream-token.ts:4-34).
3. Token verification: `consumeAlertStreamToken` validates token shape, loads Redis payload, and deletes the key after consume (src/lib/alerts/stream-token.ts:38-48). It is single-use unless Redis delete fails; delete failure is swallowed.
4. Replay window: after successful consume, a retry must obtain a fresh token. If the SSE connection drops mid-stream, client reuse of the original token should receive 401 because the key has been deleted (src/app.ts:469-480).
5. Scope: token payload contains `userId`; it is still a bearer credential because anyone holding the token can consume that user's stream during the 60-second window (src/lib/alerts/stream-token.ts:8-25).
6. CORS / Origin: SSE response mirrors the app's explicit `FRONTEND_URL` allowlist for `Access-Control-Allow-Origin` (src/app.ts:99-111, src/app.ts:485-501).

### /api/compliance/stream

1. Token issuance: none. The route uses `Authorization: Bearer <Supabase JWT>`, not a query-param stream token (src/routes/compliance-stream.route.ts:51-60, src/routes/compliance-stream.route.ts:256-264).
2. Token storage: none beyond normal Supabase/JTI/session cache handling.
3. Token verification: `resolveAuth` calls `supabaseAdmin.auth.getUser(token)`, checks token revocation, loads user/org membership, and enforces plan context (src/routes/compliance-stream.route.ts:51-90).
4. Replay window: normal bearer-token replay window applies; no separate stream-token replay issue exists.
5. Scope: bound to authenticated Supabase user and org membership through backend checks (src/routes/compliance-stream.route.ts:71-90).
6. CORS / Origin: stream response uses the same allowed-origin list before writing SSE headers (src/routes/compliance-stream.route.ts:317-335).

Residual risk: if an alert stream token leaks via browser history, server logs, referrer propagation, or shared screenshots, the worst case is one successful connection to that user's alert event stream within 60 seconds. The token is single-use and user-bound in payload, but it is bearer by possession; the consumer does not need the original Supabase JWT. No SA finding is added because TTL is exactly 60 seconds, the token is single-use, and the route CORS-scopes successful browser reads.

--- PHASE A COMPLETE (REVISION 2) — AWAITING APPROVAL BEFORE ANY REMEDIATION ---
