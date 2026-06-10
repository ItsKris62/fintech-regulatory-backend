# Phase B — Manifest Schema and Backward-Compatible Loader

Date: 2026-06-10

## Summary

Phase B (Phase 2) introduces a manifest-based corpus metadata system with validation, checksum verification, and inventory reporting. The existing hardcoded `DOCUMENT_REGISTRY` ingestion pipeline is preserved unchanged. No documents were moved, renamed, or ingested.

## What Changed

1. **Manifest Schema** — Zod-based schema defining all required and optional fields for corpus document entries, with cross-field validation rules.
2. **Manifest Loader** — Reads, validates, and normalizes `manifest.json` files from each country folder. Supports both flat (Kenya/International) and nested (Malawi/Nigeria) directory structures.
3. **Checksum Utility** — SHA-256 file hashing for integrity verification.
4. **Validation CLI** — `pnpm corpus:validate --country=<name> | --all [--verify-checksums]`.
5. **Inventory CLI** — `pnpm corpus:inventory --country=<name> | --all`.
6. **Scaffold Manifests** — `manifest.json` for all four country folders:
   - Kenya: 41 entries with real checksums, mapped from existing registry.
   - International: 14 entries with real checksums, mapped from existing registry.
   - Malawi: empty entries array (placeholder).
   - Nigeria: empty entries array (placeholder).
7. **Nested Folder Structure** — Malawi and Nigeria subfolders created with `.gitkeep` files.
8. **Tests** — 32 vitest tests covering schema validation, path safety, jurisdiction mapping, APPROVED integrity, and binding consistency.

## Files Added

### Corpus Utilities (`src/scripts/corpus/`)

| File | Purpose |
| --- | --- |
| `manifest.schema.ts` | Zod schema + TypeScript types for manifest entries and manifest file |
| `manifest-loader.ts` | Load, validate, resolve paths, detect duplicates |
| `validate-manifest.ts` | CLI: validate one or all country manifests |
| `inventory.ts` | CLI: summary report across all manifests |
| `checksum.ts` | SHA-256 compute + verify utilities |
| `_generate-initial-manifests.ts` | One-time scratch script that generated Kenya/International manifests from existing DOCUMENT_REGISTRY |

### Manifest Files (`documents/`)

| File | Entries |
| --- | --- |
| `documents/kenya/manifest.json` | 41 entries |
| `documents/international/manifest.json` | 14 entries |
| `documents/malawi/manifest.json` | 0 entries (placeholder) |
| `documents/nigeria/manifest.json` | 0 entries (placeholder) |

### Folder Structure

```
documents/malawi/
  manifest.json
  payments/.gitkeep
  banking/.gitkeep
  microfinance/.gitkeep
  aml-cft/.gitkeep
  data-protection/.gitkeep
  cybersecurity/.gitkeep
  consumer-protection/.gitkeep
  guidance/.gitkeep

documents/nigeria/
  manifest.json
  payments/.gitkeep
  banking/.gitkeep
  aml-cft/.gitkeep
  data-protection/.gitkeep
  digital-lending/.gitkeep
  open-banking/.gitkeep
  capital-markets/.gitkeep
  cybersecurity/.gitkeep
  consumer-protection/.gitkeep
  guidance/.gitkeep
```

### Tests

| File | Tests |
| --- | --- |
| `src/__tests__/manifest.test.ts` | 32 tests |

## Files Modified

| File | Change |
| --- | --- |
| `package.json` | Added `corpus:validate` and `corpus:inventory` scripts |

## How Manifest Validation Works

### Schema Validation (Zod)

Each manifest entry is validated against `CorpusManifestEntrySchema` which enforces:

- **Required fields**: id, country, jurisdictionCode, scope, category, regulator, title, documentType, authorityStatus, isBinding, localPath, sourceUrl, checksumSha256, reviewStatus, priority, tags.
- **Path safety**: localPath must use forward slashes, cannot contain `..`, cannot be absolute, must start with `documents/`.
- **Country/jurisdiction match**: Kenya→KE, Malawi→MW, Nigeria→NG, International→INTL/EU/GLOBAL.
- **APPROVED integrity**: APPROVED entries require non-null sourceUrl, non-null checksumSha256, non-UNKNOWN authorityStatus, and non-UNKNOWN priority.
- **Binding consistency**: DRAFT/CONSULTATION/REPORT statuses reject `isBinding: true`.

### Cross-Entry Validation (Loader)

- Duplicate `id` values are rejected.
- Duplicate `localPath` values are rejected.
- File existence is checked (error for non-PLACEHOLDER, warning for PLACEHOLDER).

### Checksum Verification

When `--verify-checksums` is passed to the validation CLI, the loader computes SHA-256 for every entry that has a `checksumSha256` value and reports mismatches.

## How to Run Validation

```bash
# Validate a single country
pnpm corpus:validate --country=kenya
pnpm corpus:validate --country=international

# Validate all countries
pnpm corpus:validate --all

# Validate with checksum verification
pnpm corpus:validate --all --verify-checksums

# Inventory report
pnpm corpus:inventory --all
pnpm corpus:inventory --country=kenya
```

## Kenya/International Backward Compatibility

- **No files moved**: All 41 Kenya PDFs and 14 International PDFs remain in their original flat locations.
- **No registry changes**: `DOCUMENT_REGISTRY` in `src/scripts/ingest-documents.ts` is untouched.
- **No ingestion changes**: `pnpm ingest` works exactly as before.
- **Manifests are read-only metadata**: The manifest files are consumed only by the new validation and inventory scripts. They are not wired into the ingestion pipeline.
- **Paths preserved**: All `localPath` values in manifests match the existing flat `documents/kenya/<file>.pdf` and `documents/international/<file>.pdf` structure.

## Malawi/Nigeria Nested Folder Support

- Category subfolders created with `.gitkeep` files for git tracking.
- Empty `manifest.json` files with `entries: []` validate successfully.
- When entries are added in Phase 3, they can use nested paths like `documents/malawi/payments/reserve-bank-act.pdf`.
- The loader and schema validate both flat and nested paths without distinction.

## What Remains for Phase 3

1. **Official-Source Discovery and Downloader Automation** — Crawl regulator websites for Malawi/Nigeria documents, download PDFs, compute checksums, populate manifests.
2. **Source URL enrichment** — All 55 current entries have `sourceUrl: null`. Phase 3 should populate official source URLs.
3. **Review status promotion** — Currently all entries are `NEEDS_REVIEW`. Phase 3 should promote verified entries to `APPROVED`.
4. **Priority assignment** — All entries have `priority: UNKNOWN`. Should be triaged to P0/P1/P2.
5. **Manifest-driven ingestion adapter** — Wire manifest entries into the ingestion pipeline as an alternative to `DOCUMENT_REGISTRY`.
6. **Country-aware retrieval filters** — Add jurisdiction/country filters to compliance queries.
7. **Vector metadata enrichment** — Add country code, source URL, regulator to Pinecone vector metadata.

## Known Limitations

- `sourceUrl` is null for all entries — official source URLs were not available from the existing registry.
- `priority` is UNKNOWN for all entries — requires human triage.
- `reviewStatus` is NEEDS_REVIEW — no entries are APPROVED yet.
- The `_generate-initial-manifests.ts` script used heuristic category mapping from the old 6-category system to the new 19-category system. Some mappings may need manual correction (e.g., "ODPC Guidance Note for Digital Credit Providers" was categorized under `banking` because of "credit" keyword — it could also be `data-protection`).
- The insurance-related Bancassurance Regulations entry was categorized under `banking` (it matched "banking" in the title before "insurance") — could be `insurance`.
- Checksum verification is streaming but synchronous per entry in the CLI.

## Safety Notes

- No existing Kenya/International documents were moved, renamed, or deleted.
- No production data was touched.
- No ingestion was run.
- No database migrations were created or applied.
- No Pinecone data was modified.
- `pnpm ingest` continues to work unchanged via `DOCUMENT_REGISTRY`.
- The manifest system is entirely additive and non-invasive.

## Next Phase

Phase C (Official-Source Discovery and Downloader Automation) has been completed. See [phase-c-source-discovery-downloader.md](phase-c-source-discovery-downloader.md).
