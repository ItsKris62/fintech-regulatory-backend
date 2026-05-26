# CI/CD Pipeline Sprint -- Phase A Audit

Date: 2026-05-26
Auditor: Claude (IDE session)
Repo HEAD: d792f4a0b2b9b1a8ce1c59336f0fb89d3830b20f
Repo remote: https://github.com/ItsKris62/fintech-regulatory-backend.git

## Summary

The backend codebase is largely in good shape for CI/CD installation. TypeScript strict mode
is on, the `typecheck` and `lint:ci` scripts exist with the right names, `build:prod` aligns
with what both the existing `checks.yml` workflow and `render.yaml` already use, and no
hardcoded secrets were found in source files. Two issues require Phase B to address before
the pipeline can run green: (1) there is no ESLint config file -- `eslint.config.js` must be
created, otherwise the lint job errors on first run under ESLint 9.39.2 flat-config mode;
(2) the codebase contains non-ASCII bytes in 113 source files and 1 Prisma schema file,
which will cause the non-ASCII CI job to fail unless the job scope is narrowed to exclude
intentionally Unicode-rich email templates. Additionally, two existing workflows (`checks.yml`
and `deploy.yml`) already cover the same jobs as the planned `backend-ci.yml` -- Phase B
must replace or consolidate rather than add a third workflow that runs duplicate jobs. The
`deploy.yml` still references Railway (pre-Render migration) and should be deleted or
converted.

## Blocking discoveries

None. No finding invalidates any of the architectural decisions listed in the sprint prompt.
All issues identified below are prerequisites or scoping decisions for Phase B, not
architecture changes.

---

## Task findings

### Task 1 -- package.json inventory

File: `package.json` (repo root, i.e., `fintech-regulatory-backend/package.json`)

**1.1. engines.node:** NOT PRESENT in `package.json`. No `engines` key at all. Node version
evidence comes from `nixpacks.toml` line 2: `nixPkgs = ["nodejs_20"]`. The workflow's
`NODE_VERSION` env should be pinned to `20`.

**1.2. engines.pnpm / packageManager:** NEITHER PRESENT in `package.json`. No `packageManager`
field. pnpm version is implied by the lockfile header: `pnpm-lock.yaml` line 1 reads
`lockfileVersion: '9.0'`, which requires pnpm 9.x. The existing `checks.yml` and `deploy.yml`
both pin `pnpm/action-setup@v4` with `version: 9`. The workflow's `PNPM_VERSION` env should
be pinned to `9`.

**1.3. Script inventory:**

| Script name | Present | Invocation |
|---|---|---|
| `build` | YES | `tsc` (plain emit to `dist/`) |
| `build:prod` | YES | `tsc -p tsconfig.prod.json && tsc-alias -p tsconfig.prod.json` |
| `lint` | YES | `eslint . --ext .ts` |
| `lint:ci` | YES | `eslint . --ext .ts --max-warnings 0` |
| `typecheck` | YES | `tsc --noEmit` |
| `generate` | YES | `prisma generate` (also in `postinstall`) |
| `test` | YES | `vitest run` |
| `test:ci` | YES | `vitest run --reporter=verbose` |

NOTE: The CI-intended lint script is `lint:ci`, not `lint`. The existing `checks.yml` already
calls `pnpm run lint:ci`. The new `backend-ci.yml` should use `lint:ci` not `lint`.

NOTE: The CI-intended build script is `build:prod`, not `build`. The `build:prod` script uses
`tsc-alias` to resolve `@/` path aliases in the compiled output; plain `build` does not. The
existing `checks.yml` and `render.yaml` both use `build:prod`. The new workflow should match.

**1.4. prisma key in package.json:** NOT PRESENT. No custom schema path is configured.
Default path `prisma/schema.prisma` applies; the workflow does not need an explicit path.

---

### Task 2 -- pnpm lockfile and workspace layout

**2.1. pnpm-lock.yaml:** PRESENT at `pnpm-lock.yaml` (repo root). Line count: 10,277 lines.

WARNING: `package-lock.json` is ALSO present at `package-lock.json` (513 KB). This dual-
lockfile state means both npm and pnpm have been used to manage dependencies at some point.
Only `pnpm-lock.yaml` is relevant to the CI workflow. The presence of `package-lock.json`
is harmless in CI as long as the workflow uses `pnpm install --frozen-lockfile`, but it
creates confusion and should be removed in a cleanup commit.

**2.2. Workspace layout:** Single-package repo. No `pnpm-workspace.yaml` at any level.
Confirmed: not a pnpm workspace.

**2.3.** N/A -- single package; no working-directory scoping needed.

---

### Task 3 -- TypeScript configuration

**3.1. tsconfig.json location:** `tsconfig.json` at repo root. It does NOT extend another
config (no `extends` field). Additionally, `tsconfig.prod.json` (also at repo root) extends
`./tsconfig.json` for production builds.

**3.2. Strict mode:** `strict: true` IS present. Additional strict-mode flags also active:
`noUnusedLocals: true`, `noUnusedParameters: true`, `noImplicitReturns: true`,
`noFallthroughCasesInSwitch: true`. Strictest mode in effect. No tightening needed.

**3.3. Build mode:** `noEmit` is NOT in `tsconfig.json`. The `typecheck` script passes
`--noEmit` on the CLI (`tsc --noEmit`), so the typecheck job does not emit files. The `build`
and `build:prod` scripts DO emit files. These are two separate operations and the CI workflow
correctly uses `typecheck` for type-checking and `build:prod` for the build verification.

**3.4. Build script implementation:** `pnpm build` runs plain `tsc`. `pnpm build:prod` runs
`tsc -p tsconfig.prod.json && tsc-alias -p tsconfig.prod.json`. No bundler (tsup, esbuild,
swc) involved -- TypeScript compiler only, with `tsc-alias` as a post-step to rewrite `@/`
path aliases in the emitted `.js` files. The CI build job must use `build:prod` (not `build`)
to produce a correctly-aliased artifact.

**3.5. Build output directory:** `dist/` (from `tsconfig.json` `outDir: ./dist`). If the
workflow uploads a build artifact, the path is `dist/`. The `dist/` directory IS gitignored.

---

### Task 4 -- ESLint configuration

**CRITICAL FINDING: No ESLint config file exists.**

**4.1.** Neither flat config (`eslint.config.js`, `eslint.config.mjs`, `eslint.config.cjs`,
`eslint.config.ts`) nor legacy config (`.eslintrc.js`, `.eslintrc.json`, `.eslintrc.yaml`,
`.eslintrc.yml`) was found in the repository. No `eslintConfig` key in `package.json`.

The installed ESLint version is `9.39.2` (flat config mode by default). In ESLint 9 flat
config mode, running `eslint .` without a `eslint.config.js` in the directory tree will
result in either an error ("Could not find config file") or a vacuous pass with 0 rules
evaluated. The `--ext .ts` flag passed by both `lint` and `lint:ci` scripts is not valid in
ESLint 9 flat config mode (that flag was removed in ESLint 9; it belongs to ESLint 8 legacy
config mode). Running `pnpm run lint:ci` in the current state will fail or produce no
meaningful output.

`@typescript-eslint/eslint-plugin@8.54.0` and `@typescript-eslint/parser@8.54.0` are in
`devDependencies` but unused without a config file.

**Phase B MUST create `eslint.config.js` before the lint job can provide signal.** The
`lint:ci` script must also be updated to remove the invalid `--ext .ts` flag (ESLint 9 flat
config uses file patterns in the config, not on the command line).

**4.2.** The `lint:ci` script already includes `--max-warnings 0`. The workflow should call
`pnpm run lint:ci` without additional flags (the zero-warnings gate is already baked in).

**4.3.** No `lint:fix` or auto-fix script. `prettier@3.8.1` is in `devDependencies` but no
`prettier` script or `.prettierrc` config was found -- Prettier appears installed but unused.
The workflow does not need to reference it.

---

### Task 5 -- Prisma layout

**5.1.** `prisma/schema.prisma` EXISTS. First lines confirmed:

```
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
```

No `url` or `directUrl` fields in the datasource block -- these are supplied via
`prisma.config.ts` which reads `process.env.DATABASE_URL` and `process.env.DIRECT_URL`.

**5.2. `pnpm prisma validate` and database connection:** The datasource has no inline
connection string. `prisma validate` performs static schema analysis and does NOT require
a database connection. The workflow's `prisma validate` step is safe to run without any
database-related secrets.

NOTE: `prisma generate` DOES require a valid schema but NOT a database connection. The
typecheck job must run `pnpm exec prisma generate` first to generate the Prisma client types
before `tsc --noEmit` can succeed. The existing `checks.yml` already does this correctly
(line 25: `pnpm exec prisma generate`).

**5.3. Schema formatting assessment:** The schema file is 1,946 lines. Field alignment
appears broadly consistent within model blocks (manual space-padding to align types and
attributes in columns). However, the schema mixes alignment styles: the `User` model has
consistent 24-space padding for most fields but the appended "free trial fields" (lines 55-58)
and "pilot testing fields" (lines 60-67) sections use shorter padding. Similarly, the
`Organization` model shows inconsistent padding widths between its main block and its
relation fields (lines 144-162).

WITHOUT running `prisma format`, I cannot confirm the schema is a format no-op. The likely
outcome is that `prisma format --check` (if used as a CI step) will find differences in
column alignment. Phase B should run `prisma format` and commit the result as a pre-pipeline
cleanup commit, or exclude the format-check step from the workflow until that is done.

**5.4. Custom Prisma generators:** None found. Generator is `prisma-client-js` (default).
The `src/generated/prisma` path in `.gitignore` suggests the generated client may be
configured to output there (via a Prisma config option), but the schema generator block
has no `output` field. The default output (`node_modules/.prisma/client`) will be used by
`prisma generate`. No workflow adjustment needed.

---

### Task 6 -- Existing .github directory

**6.1.** `.github/` EXISTS at `.github/` (repo root, i.e., `fintech-regulatory-backend/.github/`).
The backend IS the GitHub repository (remote: `https://github.com/ItsKris62/fintech-regulatory-backend.git`).
Contents: `workflows/` directory only. No `CODEOWNERS`, no `dependabot.yml`, no PR template,
no issue templates.

**6.2. Existing workflow files:**

File: `.github/workflows/checks.yml`

```
name: PR Checks
on: pull_request (branches: [main, staging])
concurrency: checks-{{ github.head_ref }}, cancel-in-progress: true
Jobs: typecheck, lint (zero warnings), build, audit
```

File: `.github/workflows/deploy.yml`

```
name: Deploy
on: push (branches: [main, staging])
concurrency: deploy-{{ github.ref }}, cancel-in-progress: true
Jobs: typecheck, lint, build, deploy-staging (Railway), deploy-production (Railway)
```

File: `scripts/ci.yml` (NOT in .github/workflows -- GitHub will not execute this)

This file is at `scripts/ci.yml`. It is named "Frontend CI Pipeline" and references Next.js
cache patterns. It is misplaced and irrelevant to this backend repo. It should be deleted.

**6.3. Conflict analysis:**

| Planned job in backend-ci.yml | Covered by checks.yml | Covered by deploy.yml | Conflict? |
|---|---|---|---|
| typecheck | YES (on PR) | YES (on push) | YES |
| lint (zero warnings) | YES via lint:ci | YES via lint:ci | YES |
| build:prod | YES | YES | YES |
| dependency audit | YES (continue-on-error) | NO | PARTIAL |
| secret scan (Gitleaks) | NO | NO | NO (new) |
| non-ASCII audit | NO | NO | NO (new) |
| CodeQL | NO | NO | NO (new file) |

If `backend-ci.yml` is added without removing or merging the existing workflows, all four
core jobs (typecheck, lint, build, audit) will run TWICE on every PR -- once from
`checks.yml` and once from `backend-ci.yml`. This wastes GitHub Actions minutes and creates
confusing duplicate status checks on pull requests.

RECOMMENDATION FOR OPERATOR DECISION: Phase B should DELETE `checks.yml` and REPLACE
`deploy.yml` with the new workflow set. The existing workflows are superseded. However, the
decision to delete vs. merge is deferred to the operator per sprint ground rules.

KEY ISSUE IN deploy.yml: The `deploy-staging` and `deploy-production` jobs in `deploy.yml`
use `railwayapp/nixpacks@v1` and `railway up` with `RAILWAY_TOKEN`. The project has migrated
from Railway to Render. These deploy jobs will fail unless a `RAILWAY_TOKEN` secret is set
in GitHub Secrets. The new workflow (Render auto-deploy stays on) drops these jobs entirely
-- Render deploys automatically on push, no workflow step needed. Phase B should delete
`deploy.yml` and replace it with `backend-ci.yml` (which has the typecheck/lint/build jobs
for push-to-main without a deploy step).

**6.4. dependabot.yml:** NOT PRESENT. Phase B creates it fresh.

**6.5. CODEOWNERS / PR template / ISSUE_TEMPLATE:** NONE PRESENT. Out of scope but noted.

---

### Task 7 -- Render configuration cross-check

**7.1. render.yaml** EXISTS at `render.yaml`.

| Setting | render.yaml | CI workflow plan | Match? |
|---|---|---|---|
| Build command | `pnpm install --frozen-lockfile && pnpm run build:prod` | `pnpm install --frozen-lockfile` then `pnpm run build:prod` | YES |
| Start command | `pnpm run start:prod` | N/A (CI does not start the server) | N/A |
| Node version | NOT SET in render.yaml (uses Render dashboard) | Planned: `NODE_VERSION: 20` | UNKNOWN -- operator must verify |
| pnpm version | NOT SET in render.yaml (uses latest in Render env) | Planned: `PNPM_VERSION: 9` | UNKNOWN -- operator must verify |
| Auto-deploy | NOT SET in render.yaml (controlled by Render dashboard) | Parallel CI, auto-deploy stays on (architectural decision) | Accepted |
| prisma migrate | Implicit via `prestart:prod` lifecycle hook | Forbidden in CI (architectural decision) | Consistent |

The Render build (`pnpm install --frozen-lockfile && pnpm run build:prod`) matches the CI
plan exactly. Render's `pnpm install --frozen-lockfile` will trigger the `postinstall` hook
which runs `prisma generate` automatically. Render's start command triggers `prestart:prod`
which runs `prisma migrate deploy` before the server starts.

NOTE: The `nixpacks.toml` file in the repo root still references Railway/Nixpacks build
configuration. It specifies `nodejs_20` and installs pnpm via `npm i -g pnpm` (no version
pin). This file is likely a Railway legacy artifact and is NOT used by Render. It does
confirm the intended Node version (20.x).

**7.2.** No dashboard-only caveat needed -- render.yaml IS present. But Node and pnpm versions
are not set in render.yaml, so the operator must confirm these in the Render dashboard.

---

### Task 8 -- Secret and environment-variable inventory

File: `src/config/app.config.ts` (Zod schema + validation at lines 11-102)

**8.1.** All required environment variables are declared as a Zod schema in `app.config.ts`.
Validation runs at module-load time via `validateEnv()` with `process.exit(1)` on failure.

**8.2. Count of required env vars (no default, must be supplied at runtime):**

| Category | Variables | Count |
|---|---|---|
| App | APP_URL, FRONTEND_URL | 2 |
| Database | DATABASE_URL | 1 |
| Redis | UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN | 2 |
| Supabase | SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET | 4 |
| Email | RESEND_API_KEY, FROM_EMAIL | 2 |
| AI | ANTHROPIC_API_KEY | 1 |
| Pinecone | PINECONE_API_KEY | 1 |
| R2 private | R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL | 4 |
| R2 public | R2_PUBLIC_ACCESS_KEY_ID, R2_PUBLIC_SECRET_ACCESS_KEY, R2_PUBLIC_BUCKET_NAME | 3 |
| Stripe | STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET | 3 |
| Marketing | RESEND_WEBHOOK_SECRET, MARKETING_TOKEN_HMAC_SECRET, APP_PUBLIC_URL | 3 |
| **TOTAL** | | **26** |

Optional env vars (have defaults in schema): approximately 25 additional vars covering
NODE_ENV, PORT, DIRECT_URL, SUPPORT_EMAIL_RECIPIENT, ANTHROPIC_MODEL, PINECONE_ENVIRONMENT,
PINECONE_INDEX_NAME, R2_BUCKET_NAME, MALWARE_SCAN_ENABLED, ORCHESTRATOR_ENABLED,
RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, all INTASEND_* vars (optional with empty defaults),
RESEND_MARKETING_FROM_EMAIL, RESEND_MARKETING_FROM_NAME, ADMIN_NOTIFICATION_EMAIL,
PILOT_INVITATION_EXPIRY_DAYS.

Memory reference of "30+ required secrets" is imprecise -- the exact number is 26 required
(no default) and ~51 total unique env var names.

NOTE: `render.yaml` includes a `LOG_LEVEL` env var set to `info` and
`VAULT_RECONCILIATION_DRY_RUN` set to `true`. Neither of these appears in the Zod schema
in `app.config.ts`. They are likely consumed by other parts of the application (pino logger,
vault cron script) via direct `process.env` reads, not through the centralized config object.

NOTE: The default model in `app.config.ts` line 41 is `claude-3-haiku-20240307` (a deprecated
model ID). `render.yaml` overrides this at runtime with `ANTHROPIC_MODEL=claude-sonnet-4-6`.
The default in `app.config.ts` should be updated to a current model ID, but this is not
CI-blocking.

**8.3. Build-time env var requirements for CI jobs:** NONE. The `tsc` compiler does not
execute the compiled code; `app.config.ts`'s `validateEnv()` call and `process.exit(1)` only
run at Node.js runtime, not at compile time. The typecheck job (`tsc --noEmit`) and build
job (`tsc -p tsconfig.prod.json && tsc-alias`) do not need any env vars to succeed.

**8.4. Hardcoded secrets scan:** No hardcoded credentials found in `src/`. All pattern
matches returned were: comments referencing API key shapes (e.g., "starts with sk_live_"),
documentation strings, or test fixture placeholders (e.g., `sk-ant-1234567890abcdef` in
`src/lib/system-config.test.ts` -- clearly a fake placeholder, not a real key). No real
secrets found in source files.

---

### Task 9 -- Non-ASCII audit

**9.1. Scan result:** The `LC_ALL=C grep -rnP '[\x80-\xFF]'` command returned 0 results in
the bash environment (likely due to Windows/Git-bash limitations with LC_ALL overrides).
A PowerShell byte-level scan was used instead.

Result: **113 TypeScript/TSX files** contain bytes with value > 0x7F. **1 Prisma schema file**
(`prisma/schema.prisma` line 1923) contains one non-ASCII byte sequence.

Full list of affected files:

```
src/config/email-analytics.constants.ts:36
src/config/email.config.ts:130
src/emails/components/EmailSignature.tsx:37
src/emails/components/MarketingEmailButton.tsx:8,12,13
src/emails/templates/account/OrgVerifiedEmail.tsx:27
src/emails/templates/auth/WelcomeEmail.tsx:80
src/emails/templates/billing/FreeTrialActivatedEmail.tsx:30,61,67
src/emails/templates/billing/FreeTrialExpiredEmail.tsx:33,57,67
src/emails/templates/billing/FreeTrialExpiringEmail.tsx:38,44,64,82
src/emails/templates/billing/PaymentDueEmail.tsx:58
src/emails/templates/billing/PaymentFailedEmail.tsx:25,58
src/emails/templates/billing/PaymentReceiptEmail.tsx:33,101
src/emails/templates/billing/PlanActivatedEmail.tsx:11,34,45,54,64,80,88,89
src/emails/templates/billing/PlanDowngradedEmail.tsx:23,40,55,59,62,83,90
src/emails/templates/billing/SubscriptionCancelledEmail.tsx:11,29,43,73,80
src/emails/templates/billing/TrialEndingReminderEmail.tsx:43,55,61,62,89
src/emails/templates/marketing/ (7 files, em dashes and box-drawing)
src/emails/templates/pilot/ (6 files, em dashes)
src/emails/templates/support/ (4 files, em dashes)
src/lib/ai/prompts/checklist-generation.ts
src/lib/ai/prompts/compliance-query.ts
src/lib/ai/prompts/policy-generation.ts
src/lib/ai/ai.service.ts
src/lib/ai/client.ts
src/lib/email/ (5 files)
src/lib/rag/chunking.ts
src/lib/rag/rag.service.ts
src/lib/redis/test-redis.ts
src/lib/resend/webhook.service.ts
src/lib/tokens/signed-token.util.ts
src/lib/csv-export.util.ts
src/modules/billing/resolve-effective-plan.ts
src/modules/compliance/orchestrator/ (5 files)
src/modules/compliance/ (4 files)
src/modules/marketing/ (8 files)
src/modules/notification/notification.module.ts
src/modules/policy/ (4 files)
src/modules/user/ (2 files)
src/scripts/ (approximately 30 files)
src/server/routers/ (4 files)
src/server/schemas/enterprise-policy.schema.ts
src/services/ (2 files)
src/utils/token-revocation.ts
```

**9.2. Character categories identified:**

| Byte sequence | Unicode codepoint | Character | Count / Notes |
|---|---|---|---|
| E2 80 94 | U+2014 | EM DASH | Most common -- ~100+ occurrences across all file categories |
| C2 A9 | U+00A9 | COPYRIGHT SIGN | 1 occurrence (email.config.ts:130) |
| F0 9F 8E 89 | U+1F389 | PARTY POPPER emoji | 1 occurrence (FreeTrialActivatedEmail.tsx:67) |
| E2 9C 93 | U+2713 | CHECK MARK | 1 occurrence (PlanActivatedEmail.tsx:54) |
| E2 86 92 | U+2192 | RIGHTWARDS ARROW | 1 occurrence (PlanDowngradedEmail.tsx:40) |
| E2 94 80 (repeated) | U+2500 | BOX DRAWINGS LIGHT HORIZONTAL | Multiple (MarketingBaseLayout.tsx lines 86,98,103 -- long divider strings) |

**Categorization by intent:**

- Email templates (`src/emails/**/*.tsx`): ~40 files. Em dashes in email copy, copyright
  symbol, check mark, emoji, box-drawing dividers. These are INTENTIONAL -- email templates
  use Unicode for visual formatting. Applying a blanket non-ASCII check to these files would
  require either removing content that is by design, or excluding the email tree.

- Non-email `.ts` files: approximately 70 files. Em dashes appear in comments, prompt
  strings, log messages, and inline documentation. Many of these are candidates for ASCII
  replacement (`--` for em dash).

- `prisma/schema.prisma` line 1923: em dash in a comment ("onDelete: Restrict -- user
  deletion..."). Can be replaced with `--`.

**KNOWN_ISSUES.md entry BE-I-024 cross-reference:** BE-I-024 states that
`src/server/trpc/middleware.ts` lines ~248 and ~370 contain non-ASCII characters, deferred
to Sprint 4. The PowerShell byte scan of this session found ZERO non-ASCII bytes in
`src/server/trpc/middleware.ts`. The entry appears to have been silently remediated in a
prior sprint. Phase B should mark BE-I-024 as RESOLVED in `KNOWN_ISSUES.md`.

**Impact on CI:** The non-ASCII CI job as designed (scanning `src/` and `prisma/`) would
fail on first run with 113+ files flagged. Phase B must choose one of:

Option A (recommended): Scope the check to `src/**/*.ts` only, excluding `src/**/*.tsx`.
This still catches ~70 non-email `.ts` files but accepts that React Email templates are
intentionally Unicode-rich.

Option B: Define an allowlist of files or directories to exclude from the check.

Option C: Perform a full cleanup commit before the check goes live (this is the largest
pre-Phase-B work item and may alter email copy).

---

### Task 10 -- KNOWN_ISSUES.md state

File: `KNOWN_ISSUES.md` (repo root, `fintech-regulatory-backend/KNOWN_ISSUES.md`)
File size: large (800+ lines, multiple sprints and stages)

NOTE: There is a SEPARATE `KNOWN_ISSUES.md` at the parent workspace root
(`c:/Users/USER/Videos/Sheria-Bot-SaaS/KNOWN_ISSUES.md`). The CI-relevant one is the
backend's own file.

**CI-relevant findings from KNOWN_ISSUES.md:**

| Issue | Status | CI impact |
|---|---|---|
| BE-M-023 (140+ tsc errors from middleware context regression) | RESOLVED (Sprint 2 Batch 1.5a) | None -- typecheck passing |
| BE-I-024 (non-ASCII in middleware.ts) | DEFERRED to Sprint 4 | Stale -- middleware.ts is now clean per this session's scan. The 113-file non-ASCII scope is broader than what BE-I-024 describes. |
| C9 (FREE_TRIAL plan in streaming endpoint) | DEFERRED to Stage 3 | No tsc or lint impact |
| BE-S3-001 through BE-S3-005 | OPEN (deferred sprint 4/5) | These are logic/design issues, not tsc errors or ESLint violations |
| All Class A (IDOR critical) | RESOLVED | None |
| All Class B (authorization hardening) | RESOLVED | None |

**Pre-existing tsc errors that would block typecheck CI job:** NONE. The KNOWN_ISSUES.md
records state typecheck is PASSING with 0 errors. The most recent resolution entry
(Sprint 3 Batch 2 Approval, 2026-05-20) confirms "0 findings" across targeted files.

**Pre-existing ESLint violations that would block lint CI job:** NONE listed. The missing
ESLint config (Task 4) is the blocker, not pre-existing violations.

**High-severity dependency advisories from `pnpm audit`:** CANNOT DETERMINE without running
`pnpm audit`. The existing `checks.yml` runs this with `continue-on-error: true`, which
means it does not block PRs. The new workflow should maintain this same non-blocking posture
until a dedicated vulnerability triage has been done.

---

### Task 11 -- Public security-policy claims

Not applicable to this repo. The security policy content component
(`components/legal/security-policy-content.tsx`) is a frontend repo file. No equivalent
file exists in `fintech-regulatory-backend/`. This task is not relevant to the backend repo.

---

### Task 12 -- Repository hygiene

**12.1. .gitignore entries:**

| Pattern | Present? | Notes |
|---|---|---|
| `dist/` | YES | Line 18 |
| `node_modules/` | YES | Line 15 |
| `.env*` | YES | Lines 2-5, with `!.env.example` whitelist |
| `*.tsbuildinfo` | NOT explicit | Covered implicitly: `tsconfig.prod.json` sets `tsBuildInfoFile: ./dist/.tsbuildinfo`, which falls under the `dist/` exclusion. No gap. |
| `coverage/` | YES | Line 19 |

The `.gitignore` is adequate. No missing CI-relevant exclusions.

**12.2. .npmrc:** NOT PRESENT at repo root. No registry auth tokens, no `node-linker`
overrides, no `strict-peer-dependencies` setting. The `pnpm-lock.yaml` `settings` block
shows `autoInstallPeers: true` and `excludeLinksFromLockfile: false` (these are pnpm
workspace settings, not auth). No registry tokens in any config file. Clean.

**12.3. LICENSE file:** NOT PRESENT at repo root. This is noted; it is not a CI blocker
for private repositories, but some GitHub App policies and action allowlists may require
it for compliance purposes. Recommended addition in a future housekeeping commit.

---

## Recommended Phase B adjustments

| Decision | Assessment |
|---|---|
| Node version: 20.x | Matches `nixpacks.toml` `nodejs_20`. Proceed as planned. |
| pnpm version: 9 | Matches lockfile format `9.0` and existing workflows. Proceed as planned. |
| Build script: `build:prod` | Both `checks.yml` and `render.yaml` use `build:prod`. Proceed as planned. |
| Typecheck script: `typecheck` | Present, runs `tsc --noEmit`. Proceed as planned. |
| Lint script: `lint:ci` | Present with `--max-warnings 0` gate. ADJUSTMENT NEEDED: must remove the `--ext .ts` flag (invalid in ESLint 9 flat config) and create `eslint.config.js`. |
| Build output: `dist/` | Matches `tsconfig.json outDir`. Proceed as planned. |
| `prisma generate` before typecheck | Already in `checks.yml`. Must be in `backend-ci.yml`. |
| `prisma migrate` forbidden in CI | Consistent with current setup. Proceed as planned. |
| Test job: scaffolded, commented out | `test` and `test:ci` scripts both exist. Scaffolding accurate. |
| Dependabot timezone: Africa/Nairobi | Not yet present. Phase B creates it fresh. |
| CodeQL: security-extended | Not yet present. Phase B creates it fresh. |
| Parallel CI, Render auto-deploy stays on | `render.yaml` confirms Render is the deployment target. `deploy.yml` still references Railway and will fail. Phase B must delete `deploy.yml`. Parallel CI posture accepted. |
| Non-ASCII job scope | ADJUSTMENT NEEDED: the planned scope covering `src/` and `prisma/` will fail on 113+ intentionally Unicode-rich email template files. Recommend narrowing to `src/**/*.ts` only, or adding `src/emails/**` to an exclusion list. Operator decision required before Phase B writes the job. |
| Secret scan (Gitleaks) | No secrets found in codebase. Job can be added without blocking concerns. |
| Env vars for CI jobs | NONE required for typecheck/build/lint. `app.config.ts` validates env at runtime, not compile time. |
| Prisma schema format | ADJUSTMENT NEEDED: schema has inconsistent column alignment. `prisma format` will likely produce changes. A pre-pipeline format commit is recommended to prevent the format-check CI step from failing immediately. |
| GitHub Actions location | CORRECT: `fintech-regulatory-backend/.github/workflows/` IS the GitHub repo root. No working-directory overrides needed. |

---

## Phase B prerequisites checklist

1. Create `eslint.config.js` at repo root with `@typescript-eslint` flat config rules and
   update `lint:ci` script to remove `--ext .ts` (REQUIRED -- lint job cannot run without
   this)

2. Decide non-ASCII job scope: either exclude `src/emails/**` from the check, or scope
   the check to `src/**/*.ts` only (REQUIRED -- Operator decision, then Phase B implements)

3. Run `prisma format` on `prisma/schema.prisma` and commit the result before the
   format-check CI step goes live (REQUIRED if format-check job is included in Phase B;
   may be deferred if format-check is omitted from the initial workflow)

4. Decide fate of existing workflows before Phase B adds `backend-ci.yml`:
   a. Delete `checks.yml` -- superseded by `backend-ci.yml` (REQUIRED to avoid duplicate jobs)
   b. Delete `deploy.yml` -- Railway deploy jobs are stale (post-Render migration); superseded
      by `backend-ci.yml` push job (REQUIRED)
   (Operator must confirm deletion vs. merge per sprint ground rules)

5. Delete `scripts/ci.yml` -- misplaced "Frontend CI Pipeline" draft, not a GitHub workflow,
   causes confusion (RECOMMENDED, not blocking)

6. Delete or ignore `package-lock.json` -- dual lockfile with `pnpm-lock.yaml` is confusing
   (RECOMMENDED, not CI-blocking)

7. `pnpm-lock.yaml` present and valid (DONE)

8. `tsconfig.json strict: true` (DONE)

9. `typecheck` script present (DONE)

10. `build:prod` script present and uses `tsc` + `tsc-alias` (DONE)

11. `prisma generate` in `postinstall` (DONE)

12. No hardcoded secrets in source files (DONE)

13. No pre-existing tsc errors blocking typecheck job (DONE -- typecheck passing 0 errors)

14. Confirm KNOWN_ISSUES.md BE-I-024 is now resolved (middleware.ts non-ASCII is clean per
    this session's scan) and update the entry (REQUIRED, low priority)

15. Update `app.config.ts` default `ANTHROPIC_MODEL` from deprecated `claude-3-haiku-20240307`
    to a current model ID (RECOMMENDED, not CI-blocking -- render.yaml overrides it at runtime)

---

## Open questions for the operator (Chris)

1. Render dashboard Node version: `render.yaml` does not specify a Node version. The workflow
   will pin Node 20.x per `nixpacks.toml` evidence. Confirm the Render dashboard is also set
   to Node 20.x before the first CI-gated deploy. (Cannot be inspected from the codebase.)

2. Render dashboard pnpm version: `render.yaml` does not specify a pnpm version. Confirm
   whether Render uses pnpm 9.x or defaults to a different version. If Render installs a
   different pnpm major, there could be lockfile drift. (Cannot be inspected from the
   codebase.)

3. Non-ASCII job scope decision (required before Phase B writes the non-ASCII job): Should
   the non-ASCII check exclude `src/emails/**/*.tsx` (which contains intentional Unicode in
   email copy) and focus only on `.ts` logic files? Or should the full codebase be cleaned
   up first? This decision determines whether Phase B includes a pre-pipeline cleanup commit
   (Option C) or a scoped job definition (Option A/B).

4. ESLint rule set for `eslint.config.js`: The devDependencies include
   `@typescript-eslint/eslint-plugin@8.54.0` and `@typescript-eslint/parser@8.54.0`. Should
   Phase B create a minimal config (just `@typescript-eslint/recommended` rules) or a
   stricter config (e.g., `@typescript-eslint/recommended-type-checked` with `parserOptions`
   pointing to `tsconfig.json`)? The stricter option catches more bugs but may surface
   existing violations that delay Phase B. Recommend starting with `recommended` (non-typed)
   to avoid blocking the sprint, then upgrading later.

5. Dependabot target branch: The existing `checks.yml` and `deploy.yml` both target
   `[main, staging]`. The sprint prompt specifies Monday morning batches. Should the
   Dependabot PR target branch be `main` only, or should a separate PR target `staging`?
   (Cannot determine from codebase -- operator preference.)

6. `package-lock.json` removal: `package-lock.json` (513 KB) coexists with `pnpm-lock.yaml`.
   Is it safe to delete `package-lock.json`? It would be if no CI, deployment, or tooling
   currently relies on npm install. The `nixpacks.toml` and `render.yaml` both use pnpm.
   (Confirm before Phase B cleanup commit.)

7. Workflow file disposition for `checks.yml` and `deploy.yml`: Phase B will add
   `backend-ci.yml`. The operator must decide: delete both existing files, or fold their
   unique content (the `continue-on-error` audit job from `checks.yml`) into the new file
   and delete the old ones. Phase B cannot proceed without this decision.

---
END OF PHASE A REPORT -- HARD STOP. Do not proceed to Phase B.
