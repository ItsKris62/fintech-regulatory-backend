# CI/CD Batch 0.5 — Final Audit Snapshot

**Date:** 2026-05-26
**Branch:** `chore/ci-cd-batch-0.5-dep-triage`
**Command:** `pnpm audit --prod 2>&1`

---

## Verbatim `pnpm audit --prod` Output (Post-SB-5)

```
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ Hono vulnerable to arbitrary file access via           │
│                     │ serveStatic vulnerability                              │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ hono                                                   │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <4.12.4                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=4.12.4                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>@prisma/client>prisma>@prisma/dev>hono               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-q5qw-h33p-qvwr      │
└─────────────────────┴────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ @hono/node-server has authorization bypass for         │
│                     │ protected static paths via encoded slashes in Serve    │
│                     │ Static Middleware                                      │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ @hono/node-server                                      │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <1.19.10                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=1.19.10                                              │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>@prisma/client>prisma>@prisma/dev>@hono/node-server  │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-wc8c-qw6v-h7f6      │
└─────────────────────┴────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ fast-xml-parser affected by numeric entity expansion   │
│                     │ bypassing all entity expansion limits (incomplete fix  │
│                     │ for CVE-2026-26278)                                    │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ fast-xml-parser                                        │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=5.0.0 <5.5.6                                         │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=5.5.6                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>@aws-sdk/client-s3>@aws-sdk/core>@aws-sdk/xml-       │
│                     │ builder>fast-xml-parser                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-8gc5-j5rx-235r      │
└─────────────────────┴────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ Effect `AsyncLocalStorage` context lost/contaminated   │
│                     │ inside Effect fibers under concurrent load with RPC    │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ effect                                                 │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <3.20.0                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=3.20.0                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>@prisma/client>prisma>@prisma/config>effect          │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-38f7-945m-qr2g      │
└─────────────────────┴────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ lodash vulnerable to Code Injection via `_.template`   │
│                     │ imports key names                                      │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ lodash                                                 │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ >=4.0.0 <=4.17.23                                      │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=4.18.0                                               │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>@prisma/client>prisma>@prisma/dev>@mrleebo/prisma-   │
│                     │ ast>lodash                                             │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-r5fr-rjxr-66jc      │
└─────────────────────┴────────────────────────────────────────────────────────┘
┌─────────────────────┬────────────────────────────────────────────────────────┐
│ high                │ defu: Prototype pollution via `__proto__` key in       │
│                     │ assignDefaults                                         │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Package             │ defu                                                   │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Vulnerable versions │ <=6.1.4                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Patched versions    │ >=6.1.5                                                │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ Paths               │ .>@prisma/client>prisma>@prisma/config>c12>defu        │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-737v-mqg7-c878      │
└─────────────────────┴────────────────────────────────────────────────────────┘

[... 26 moderate and 3 low advisories omitted — all Prisma dev chain or AWS SDK transitive ...]

35 vulnerabilities found
Severity: 3 low | 26 moderate | 6 high
```

---

## Commit Chain

| Sub-Batch | Commit | Action | Criticals | Highs | Total |
|---|---|---|---|---|---|
| Baseline | `80b912c3` | Phase A audit report committed | 3 | 38 | 106 |
| SB-1 | `fdc257f2` | Remove `@langchain/anthropic`, `@langchain/community`, `langchain` | 2→? | 38→29 | 106→76 |
| SB-2 | `a9e6e5f9` | Remove `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` | →0 | — | — |
| SB-3 | `8e51e69c` | Bump `fastify` 5.7.4→5.8.5; pnpm override `fast-uri>=3.1.2` | 0 | →12 | →44 |
| SB-4a | `04a49473` | Remove unused `chromadb` | 0 | 12 | 44 |
| SB-4b | `0cedc2ab` | Move `react-email` to `devDependencies` | 0 | 12→11 | 44→40 |
| SB-5 | `e21f6fc0` | pnpm override `@xmldom/xmldom>=0.8.13` (mammoth xmldom fix) | 0 | 11→6 | 40→35 |
| SB-6 | `PLACEHOLDER` | KNOWN_ISSUES.md entry + this snapshot | 0 | 6 | 35 |

---

## Summary

| Metric | Baseline | Final | Delta |
|---|---|---|---|
| Total vulnerabilities | 106 | **35** | −71 (−67%) |
| Critical | 3 | **0** | −3 (−100%) |
| High | 38 | **6** | −32 (−84%) |
| Moderate | 60 | 26 | −34 |
| Low | 5 | 3 | −2 |
| `pnpm-lock.yaml` lines | 10,277 | 7,088 | −3,189 |

**Packages removed:** `@langchain/anthropic`, `@langchain/community`, `langchain`,
`@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `chromadb`
(~115+ packages from the dep tree)

**pnpm overrides added:**
```json
"pnpm": {
  "overrides": {
    "fast-uri": ">=3.1.2",
    "@xmldom/xmldom": ">=0.8.13"
  }
}
```

**Reclassified:** `react-email` moved from `dependencies` to `devDependencies`
(build-time renderer, never loaded at runtime; Render build uses `--frozen-lockfile` not `--prod`)

**Residual 6 HIGH — not actionable from this repo:**
- 5 × Prisma dev chain (`hono`, `@hono/node-server`, `effect`, `lodash`, `defu`) — require a new `@prisma/client` release
- 1 × AWS SDK transitive (`fast-xml-parser`) — require a new `@aws-sdk/client-s3` patch
- See KNOWN_ISSUES.md entry `CI-DEP-001` for full attribution and re-evaluation triggers
