# Database Seeding

## Overview

Seeds populate reference data that the application requires at runtime but that is not created
by user actions. All seeds use upsert logic and are safe to run on a populated database.

The production seed pipeline is:

```
pnpm db:seed:prod
  └── tsx src/scripts/seed.ts          (admin user, feature flags, system configs)
  └── pnpm seed:frameworks             (RegulatoryFramework reference data)
```

See `KNOWN_ISSUES.md` → [DEVOPS — MEDIUM] for the open work to chain `seed:domains` and
`seed:admin` into this pipeline.

---

## Running seeds

| Command | What it seeds |
|---|---|
| `pnpm db:seed:prod` | Full production pipeline (admin + frameworks) |
| `pnpm seed:frameworks` | `RegulatoryFramework` table only — idempotent |
| `pnpm seed:domains` | `EmailDomainWhitelist` — regulator email domains |
| `pnpm seed:admin` | Admin user in Supabase Auth + Prisma |

All seeds are idempotent. Running any of them twice produces the same final state.

---

## Adding a new regulatory framework

### Step 1 — Add the framework to the TypeScript seed

Open [src/scripts/seed-regulatory-frameworks.ts](../src/scripts/seed-regulatory-frameworks.ts)
and add a new entry to the `frameworks` array. Follow the existing structure exactly:

```typescript
{
  slug: 'your-unique-slug',        // lowercase, hyphenated — used as the stable ID in gap analyses
  name: 'Full Framework Name',
  category: 'Category Name',       // must match an existing category or introduce a new consistent one
  description:
    'One detailed paragraph describing the framework, its regulatory scope, key obligations, ' +
    'and why it is relevant to Kenyan fintechs. Include the administering authority, ' +
    'key thresholds or limits, and which product types it applies to.',
  tier: 'STARTUP',                 // STARTUP | BUSINESS | ENTERPRISE
  isActive: true,
  sortOrder: 45,                   // increment from the current highest sortOrder
},
```

**Tier guidance:**
- `STARTUP` — foundational obligations every Kenya fintech must address from day one
- `BUSINESS` — sector-specific or growth-stage requirements as product lines expand
- `ENTERPRISE` — advanced banking supervision, international standards, complex product obligations

**Slug rules:**
- Must be globally unique across the `RegulatoryFramework` table (`slug` is a `@unique` index)
- Once a slug is used in a live `GapAnalysis`, renaming it breaks historical audit references
  (see `KNOWN_ISSUES.md` → [ARCHITECTURE — MEDIUM] for the long-term fix)
- Prefer the format `authority-shortname-year` (e.g. `cbk-forex-2019`, `cma-reit-regs-2002`)

### Step 2 — Add the matching SQL INSERT

Open [prisma/seed-regulatory-frameworks.sql](../prisma/seed-regulatory-frameworks.sql) and add
the corresponding row inside the `VALUES` block, before the `ON CONFLICT` clause:

```sql
(gen_random_uuid()::text, 'your-unique-slug',
  'Full Framework Name',
  'Category Name',
  'Same description as the TypeScript entry.',
  'STARTUP', true, 45, NOW(), NOW()),
```

The SQL seed uses `ON CONFLICT (slug) DO UPDATE SET`, so it is safe to run on a populated DB
and will update descriptions on existing rows.

### Step 3 — Run locally

```bash
pnpm seed:frameworks
```

Expected output confirms the new framework upserted with 0 errors, and the total count
increases by 1.

### Step 4 — Verify

```sql
SELECT slug, name, tier, "isActive"
FROM "RegulatoryFramework"
WHERE slug = 'your-unique-slug';
-- Expected: 1 row
```

### Step 5 — Deploy to production

**Option A (preferred):** The next deploy automatically runs `pnpm db:seed:prod`, which chains
`seed:frameworks`. No manual action needed.

**Option B (immediate, without a deploy):** Paste the SQL INSERT block from Step 2 directly into
the Supabase SQL Editor. The `ON CONFLICT (slug) DO UPDATE SET` clause makes it safe to run
even if the row already exists.

---

## RLS posture for RegulatoryFramework

The `RegulatoryFramework` table has RLS enabled with no explicit SELECT policy (YELLOW posture).
All reads are proxied through the Fastify tRPC backend using the Supabase service role key, which
bypasses RLS. Direct client-side reads return zero rows silently.

See [docs/security/rls-posture.md](security/rls-posture.md) for the full posture documentation
and the recommended explicit policy for a future sprint.

---

## Seed idempotency contract

Every seed in this project must satisfy the following contract before being added to
`db:seed:prod`:

1. **No errors on re-run against a populated DB.** Use `upsert` (TS) or `ON CONFLICT DO UPDATE`/
   `DO NOTHING` (SQL) — never bare `INSERT` or `create`.
2. **No count-based skip guards.** A `if (count > 0) return` guard is not idempotent at the
   record level — a partially completed seed will silently leave missing rows on re-run.
3. **Prisma 7 adapter pattern.** All seed scripts must initialize PrismaClient with the
   `PrismaPg` adapter:
   ```typescript
   import 'dotenv/config';
   import { PrismaClient } from '@prisma/client';
   import { PrismaPg } from '@prisma/adapter-pg';

   const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
   const prisma = new PrismaClient({ adapter });
   ```
4. **No `any` types.** Use typed Prisma accessors directly (e.g. `prisma.regulatoryFramework`).
   Run `prisma generate` if a newly added model is not yet typed.
5. **`tsc --noEmit` passes** after adding the seed script.
