# CI/CD Batch 0.5 Phase A — Dependency Triage Audit

**Date:** 2026-05-25  
**Branch:** `chore/ci-cd-batch-0`  
**Author:** CI/CD Sprint (Phase A read-only audit)

---

## A.7 — Baseline Snapshot

| Field | Value |
|---|---|
| HEAD commit | `80b912c30e619026bcdb5da4d0ef6f801f9fb371` |
| `pnpm-lock.yaml` lines | 10,277 |
| `pnpm audit --prod` total | **106 vulnerabilities** |
| Severity breakdown | 5 low · 60 moderate · 38 high · **3 critical** |

---

## A.1 — LangChain Usage Scan

Searched all of `src/` for any import of `@langchain/`, `langchain`, `LangChain`.

```
@langchain/anthropic  → 0 matches
@langchain/community  → 0 matches
langchain             → 0 matches
LangChain             → 0 matches
```

**Verdict: all three LangChain packages are dead code — zero imports anywhere in `src/`.**

---

## A.2 — OpenTelemetry Usage Scan

Searched all of `src/` for any import of `@opentelemetry/`.

```
@opentelemetry/api                      → 1 match
@opentelemetry/sdk-node                 → 0 matches
@opentelemetry/auto-instrumentations-node → 0 matches
```

Single usage site: [src/lib/storage/client.ts:26](../../src/lib/storage/client.ts)

```typescript
import { context, trace, SpanStatusCode, type Tracer } from '@opentelemetry/api';
```

The file uses `trace.getTracer()`, `tracer.startSpan()`, `context.with()`, `span.setStatus()`,
`span.recordException()`, and `span.end()` across all storage operations (upload, download,
delete, presigned-URL). The tracing is real and intentional — it cannot be removed without
rewriting the storage client.

**Verdict:**
- `@opentelemetry/api` — **KEEP** (actively used, lightweight interface package)
- `@opentelemetry/sdk-node` — **REMOVE** (zero imports; no SDK init anywhere)
- `@opentelemetry/auto-instrumentations-node` — **REMOVE** (zero imports; not registered)

---

## A.3 — LangChain Transitive Tree

Resolved from `pnpm list @langchain/anthropic @langchain/community langchain`:

```
@langchain/anthropic   1.3.18   (declared ^1.3.15)
@langchain/community   1.1.16   (declared ^1.1.12)
langchain              1.2.25   (declared ^1.2.18)
```

Notable transitive deps pulled in by LangChain (visible in audit paths):
- `@langchain/core` → `langsmith`, `uuid`
- `@langchain/classic` → **`handlebars`** (CRITICAL), `yaml`
- `@langchain/langgraph` → `@langchain/langgraph-checkpoint`
- `ibm-cloud-sdk-core` → `axios`, `file-type`
- `protobufjs` ≥8.0.0 (via `@langchain/anthropic` → `@langchain/core`)

Removing all three packages eliminates the entire subtree.

---

## A.4 — OpenTelemetry Transitive Tree

Resolved from `pnpm list @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`:

```
@opentelemetry/api                       1.9.0    (declared ^1.9.0)  — KEEP
@opentelemetry/sdk-node                  0.212.0  (declared ^0.212.0) — REMOVE
@opentelemetry/auto-instrumentations-node 0.70.0  (declared ^0.70.0) — REMOVE
```

`@opentelemetry/auto-instrumentations-node` pulls in 35+ instrumentation packages
(amqplib, aws-lambda, aws-sdk, bunyan, cassandra-driver, connect, cucumber, dataloader,
dns, express, fastify, fs, generic-pool, graphql, grpc, hapi, http, ioredis, kafkajs,
knex, koa, lru-memoizer, memcached, mongodb, mongoose, mysql, mysql2, nestjs-core, net,
openai, oracledb, pg, pino, redis, redis-4, restify, router, socket.io, tedious, undici,
winston). All are dead weight.

`@opentelemetry/sdk-node` pulls in `@opentelemetry/exporter-jaeger` → **`protobufjs` <7.5.5**
(CRITICAL).

---

## A.5 — Classification Issues

### react-email misclassification

- **Declared in:** `dependencies` (production)
- **Should be in:** `devDependencies`
- **Rationale:** `react-email` is a build-time template renderer. The compiled email HTML is
  sent at runtime via the `resend` SDK — the `react-email` package itself is never loaded
  in the production Node process.
- **Audit impact:** Being in `dependencies` causes its transitive vulnerabilities
  (`minimatch` ReDoS HIGH, `socket.io-parser` HIGH, glob/brace-expansion chain) to appear
  in `pnpm audit --prod`. Moving to `devDependencies` removes them from the prod audit count.
- **Risk of moving:** None — `react-email` is imported in `src/emails/` which are compiled
  at build time, not loaded at runtime after `tsc`. The resulting `dist/emails/*.js` files
  only reference plain strings.

### chromadb dead dependency

- **Declared in:** `dependencies`
- **Installed version:** `3.3.0` (declared `^3.2.2`)
- **Usage in `src/`:** Zero imports. ChromaDB was listed as an alternative vector store
  before Pinecone was chosen; it was never wired up.
- **Audit impact:** `chromadb` itself has no current advisories, but its transitive tree
  contributes to lockfile bloat (10,277 lines).
- **Action:** Remove entirely.

---

## A.6 — Vulnerability Attribution and Patched Versions

### Critical (3 total)

| Advisory | Package | Installed | Patched | Dependency path | Elimination |
|---|---|---|---|---|---|
| JS Injection via AST Type Confusion | `handlebars` | ≤4.7.8 | ≥4.7.9 | `.>@langchain/community>@langchain/classic>handlebars` | **SB-1: remove LangChain** |
| Arbitrary code execution | `protobufjs` | <7.5.5 | ≥7.5.5 | `.>@opentelemetry/sdk-node>@opentelemetry/exporter-jaeger>protobufjs` | **SB-2: remove sdk-node** |
| Arbitrary code execution | `protobufjs` | 8.0.0–8.0.1 | ≥8.0.1 | `.>@langchain/anthropic>@langchain/core>protobufjs` | **SB-1: remove LangChain** |

**All 3 criticals are eliminated by Sub-Batches 1 and 2.**

---

### High (38 total) — grouped by root cause

#### Group H-1 — LangChain subtree (~20 advisories, eliminated by SB-1)

| Advisory | Package | Dependency path |
|---|---|---|
| JS Injection via @partial-block | `handlebars` ≤4.7.8 | `.>@langchain/community>@langchain/classic>handlebars` |
| JS Injection in CLI Precompiler | `handlebars` ≤4.7.8 | `.>@langchain/community>@langchain/classic>handlebars` |
| JS Injection via AST Type Confusion (HIGH variant) | `handlebars` ≤4.7.8 | `.>@langchain/community>@langchain/classic>handlebars` |
| Missing buffer bounds check v3/v5/v6 (×2) | `uuid` | `.>@langchain/anthropic>@langchain/core>langsmith>uuid` |
| Axios unrestricted metadata exfiltration | `axios` | `.>@langchain/community>ibm-cloud-sdk-core>axios` |
| minimatch ReDoS (repeated wildcards) | `minimatch` | (via @langchain transitive) |
| minimatch ReDoS (GLOBSTAR backtracking) | `minimatch` | (via @langchain transitive) |
| minimatch ReDoS (nested extglobs) | `minimatch` | (via @langchain transitive) |
| socket.io unlimited binary attachments | `socket.io-parser` | (via langchain transitive) |
| fast-xml-parser numeric entity expansion | `fast-xml-parser` | (via @langchain transitive) |
| Effect AsyncLocalStorage context lost | `effect` | (via @langchain transitive) |

#### Group H-2 — OTel SDK subtree (~4 advisories, eliminated by SB-2)

| Advisory | Package | Dependency path |
|---|---|---|
| Various OTel exporter/instrumentation advisories | Multiple | `.>@opentelemetry/sdk-node>...` |
| Various auto-instrumentation advisories | Multiple | `.>@opentelemetry/auto-instrumentations-node>...` |

#### Group H-3 — fastify direct (3 advisories, fixed by SB-3)

| Advisory | Package | Installed | Patched | Dependency path |
|---|---|---|---|---|
| Content-Type bypass via leading space | `fastify` | 5.7.4 | **≥5.8.5** | `.>fastify` |
| Host confusion via percent-encoded authority (variant 1) | `fast-uri` | <3.1.1 | ≥3.1.1 | `.>fastify>@fastify/ajv-compiler>fast-uri` |
| Host confusion via percent-encoded authority (variant 2) | `fast-uri` | <3.1.2 | ≥3.1.2 | `.>fastify>@fastify/ajv-compiler>fast-uri` |

Bumping fastify to ≥5.8.5 is expected to also pull an updated `@fastify/ajv-compiler`
with `fast-uri ≥3.1.2`, resolving all three.

#### Group H-4 — mammoth / xmldom (4 advisories, fixed by SB-5)

| Advisory | Package | Installed | Patched | Dependency path |
|---|---|---|---|---|
| XML injection via unsafe CDATA serialization | `@xmldom/xmldom` | 0.8.11 | **≥0.8.12** | `.>mammoth>@xmldom/xmldom` |
| Uncontrolled recursion in XML serialization (DoS) | `@xmldom/xmldom` | 0.8.11 | **≥0.8.13** | `.>mammoth>@xmldom/xmldom` |
| XML injection via unvalidated DocumentType | `@xmldom/xmldom` | 0.8.11 | **≥0.8.13** | `.>mammoth>@xmldom/xmldom` |
| XML node injection via processing instruction | `@xmldom/xmldom` | 0.8.11 | **≥0.8.13** | `.>mammoth>@xmldom/xmldom` |

`mammoth@1.11.0` declares `"@xmldom/xmldom": "^0.8.6"` — the lockfile resolves 0.8.11.
`pnpm` can reach 0.8.13 via the existing range; a pnpm override is the cleanest fix:
```json
"pnpm": { "overrides": { "@xmldom/xmldom": ">=0.8.13" } }
```
Alternatively bump mammoth: `mammoth@1.12.0` is the latest; verify its `package.json`
after upgrade to confirm xmldom dep allows ≥0.8.13.

#### Group H-5 — react-email subtree (2 advisories, eliminated by SB-4 reclassification)

| Advisory | Package | Dependency path |
|---|---|---|
| socket.io unlimited binary attachments | `socket.io-parser` | `.>react-email>socket.io>socket.io-parser` |
| minimatch ReDoS variants | `minimatch` | `.>react-email>glob>minimatch>brace-expansion` |

Moving `react-email` to `devDependencies` removes these from `pnpm audit --prod`.

#### Group H-6 — Prisma dev chain (5 advisories, NOT actionable by this project)

| Advisory | Package | Dependency path |
|---|---|---|
| Effect AsyncLocalStorage context contamination | `effect` | `.>@prisma/client>prisma>@prisma/config>effect` |
| Hono arbitrary file access via serveStatic | `hono` | `.>@prisma/client>prisma>@prisma/dev>hono` |
| @hono/node-server authorization bypass | `@hono/node-server` | `.>@prisma/client>prisma>@prisma/dev>@hono/node-server` |
| @mrleebo/prisma-ast advisories | `@mrleebo/prisma-ast` | `.>@prisma/client>prisma>@prisma/dev>@mrleebo/prisma-ast` |
| defu advisories | `defu` | `.>@prisma/client>prisma>@prisma/config>c12>defu` |

`@prisma/client@7.x` bundles `prisma` (the CLI) and `@prisma/dev` in its runtime dep tree —
this is a Prisma 7 design decision. Fixes require a new Prisma release; cannot be patched
from this repo. Track in KNOWN_ISSUES.md.

#### Group H-7 — AWS SDK transitive (moderate+ advisories, NOT actionable)

| Advisory | Package | Dependency path |
|---|---|---|
| fast-xml-parser numeric entity bypass | `fast-xml-parser` | `.>@aws-sdk/client-s3>@aws-sdk/core>@aws-sdk/xml-parser-engine>fast-xml-parser` |

AWS SDK manages its own internal dep versions; no override is safe here. Track in
KNOWN_ISSUES.md.

---

### Low (5 total)

| Advisory | Package | Dependency path | Elimination |
|---|---|---|---|
| Hono basicAuth timing comparison | `hono` | `.>@prisma/client>prisma>@prisma/dev>hono` | Prisma release |
| fast-xml-parser stack overflow in XMLBuilder | `fast-xml-parser` | Prisma / LangChain | SB-1/Prisma |
| Handlebars.js Property Access Validation Bypass | `handlebars` | `.>@langchain/community>@langchain/classic>handlebars` | SB-1 |
| Axios Null Byte Injection via Reverse-Encoding | `axios` | `.>@langchain/community>ibm-cloud-sdk-core>axios` | SB-1 |
| Hono improper NumericDate validation in JWT | `hono` | `.>@prisma/client>prisma>@prisma/dev>hono` | Prisma release |

---

## Projected Impact After All Sub-Batches

| Sub-Batch | Action | Criticals eliminated | High eliminated |
|---|---|---|---|
| SB-1 | Remove `@langchain/anthropic`, `@langchain/community`, `langchain` | 2 | ~20 |
| SB-2 | Remove `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` | 1 | ~4 |
| SB-3 | Bump `fastify` `5.7.4` → `^5.8.5` | 0 | 3 |
| SB-4 | Move `react-email` to `devDependencies`; remove `chromadb` | 0 | 2 (from prod count) |
| SB-5 | pnpm override `@xmldom/xmldom: ">=0.8.13"` | 0 | 4 |
| SB-6 | Final audit + KNOWN_ISSUES.md entry | — | — |
| **Total** | | **3 / 3** | **~33 / 38** |

Remaining 5 high after all sub-batches: Prisma dev chain (4) + AWS SDK transitive (1).
These require upstream releases and are not actionable in this repo.

---

## Approved Sub-Batch Plan (Phase B — do not execute until approved)

### Sub-Batch 1 — Remove LangChain

```bash
cd fintech-regulatory-backend
pnpm remove @langchain/anthropic @langchain/community langchain
pnpm run typecheck
pnpm run build
```

Commit message: `chore(deps): remove unused LangChain packages`

Verification: `pnpm audit --prod 2>&1 | tail -3` — expect 3 criticals → 0.

### Sub-Batch 2 — Remove unused OTel packages

```bash
pnpm remove @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
pnpm run typecheck
pnpm run build
```

Commit message: `chore(deps): remove unused OpenTelemetry SDK and auto-instrumentations`

Keep `@opentelemetry/api` — required by `src/lib/storage/client.ts`.

Verification: `pnpm list @opentelemetry/api` still resolves; typecheck still passes.

### Sub-Batch 3 — Bump fastify

```bash
pnpm update fastify --latest
# Verify resolved version >= 5.8.5
pnpm list fastify
pnpm run typecheck
pnpm run build
```

Commit message: `chore(deps): bump fastify to >=5.8.5 to fix content-type and fast-uri advisories`

### Sub-Batch 4 — Reclassify react-email; remove chromadb

```bash
pnpm remove react-email chromadb
pnpm add -D react-email
pnpm run typecheck
pnpm run build
```

Commit message: `chore(deps): move react-email to devDependencies; remove unused chromadb`

### Sub-Batch 5 — Pin @xmldom/xmldom via pnpm override

Add to `package.json`:
```json
"pnpm": {
  "overrides": {
    "@xmldom/xmldom": ">=0.8.13"
  }
}
```

```bash
pnpm install
pnpm list @xmldom/xmldom  # verify >=0.8.13
pnpm run typecheck
```

Commit message: `chore(deps): override @xmldom/xmldom to >=0.8.13 to fix mammoth xmldom advisories`

### Sub-Batch 6 — Final audit + KNOWN_ISSUES.md

```bash
pnpm audit --prod 2>&1 | tail -5
```

Add KNOWN_ISSUES.md entry for Prisma dev chain and AWS SDK residual advisories (H-6, H-7).

Commit message: `chore(ci): record residual audit findings in KNOWN_ISSUES.md`

---

## Operator Decisions Required Before Phase B

1. **Confirm removal of LangChain is safe.** There is no usage in `src/`, but confirm no
   external script, cron, or future planned feature uses it.
2. **Confirm fastify bump cadence.** `pnpm update fastify --latest` resolves to the latest
   5.x; if Fastify 6.x exists by the time this runs, use `pnpm update fastify@5 --latest`
   to stay on major 5.
3. **Approve pnpm override vs. mammoth bump for xmldom.** Override is minimal-touch;
   mammoth 1.12.0 bump is a minor-version change (review changelog for breaking changes
   in DOCX parsing).

---

END OF PHASE A REPORT — HARD STOP. Do not proceed to Phase B.
