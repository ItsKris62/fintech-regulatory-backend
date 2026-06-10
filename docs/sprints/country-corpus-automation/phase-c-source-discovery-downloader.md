# Phase C — Official-Source Discovery and Downloader Automation

Date: 2026-06-10

## Summary

Phase C (Phase 3) introduces an automation layer for discovering, reviewing, and downloading regulatory documents for Malawi and Nigeria from official sources. It builds on the manifest schema from Phase B without modifying production data, ingestion pipelines, or retrieval behavior.

## What Changed

1. **Source Registry Schema** — Zod-based schema for official regulator/authority website definitions with country/jurisdiction validation and domain allowlists.
2. **Source Registry Loader** — Loads, validates, and filters enabled sources from JSON registry files.
3. **Candidate Manifest Schema** — Zod-based schema for discovered candidate documents with NEEDS_REVIEW/APPROVED/REJECTED/SUPERSEDED/DUPLICATE decision workflow and path safety validation.
4. **Candidate Manifest Loader** — Load, validate, write, and detect duplicate candidates.
5. **URL Utilities** — Safe URL resolution, domain allowlist enforcement, HTML document link extraction, file extension parsing.
6. **Filename Utilities** — Title normalization, filename normalization, category/document-type/authority-status suggestion heuristics, safe local path generation, slug utilities.
7. **Discovery CLI** — `pnpm corpus:discover --country=<name> | --all [--dry-run]` scans source registries, extracts document links, and writes candidate manifests + reports.
8. **Download CLI** — `pnpm corpus:download --country=<name> | --all --approved-only [--dry-run] [--force]` downloads only APPROVED candidates, computes checksums, and updates entries.
9. **Discovery Report Generator** — Produces structured markdown reports from discovery and download results.
10. **Source Registries** — Malawi (6 sources) and Nigeria (8 sources) JSON files with official regulator URLs and domain allowlists.
11. **Candidate Manifest Scaffolds** — Empty candidate manifests and placeholder reports for both countries.
12. **Tests** — 68 new tests covering source registry validation, candidate schema, URL utilities, filename utilities, domain enforcement, path safety, download constraints, and duplicate detection.

## Source Registry Format

```json
{
  "version": 1,
  "country": "Malawi",
  "jurisdictionCode": "MW",
  "sources": [
    {
      "id": "mw-rbm",
      "country": "Malawi",
      "jurisdictionCode": "MW",
      "regulator": "Reserve Bank of Malawi",
      "sourceType": "REGULATOR",
      "baseUrl": "https://www.rbm.mw/regulatorydocuments/",
      "allowedDomains": ["rbm.mw", "www.rbm.mw"],
      "categories": ["banking", "payments", "microfinance"],
      "crawlMode": "link-discovery",
      "priority": "P0",
      "enabled": true,
      "notes": "Primary financial regulator"
    }
  ]
}
```

### Malawi Sources (6)

| ID | Regulator | Type | Priority |
| --- | --- | --- | --- |
| mw-rbm | Reserve Bank of Malawi | REGULATOR | P0 |
| mw-fia | Financial Intelligence Authority | FIU | P0 |
| mw-macra | MACRA | REGULATOR | P1 |
| mw-malawilii | MalawiLII | LEGAL_DATABASE | P1 |
| mw-parliament | Malawi Parliament | GOVERNMENT_PORTAL | P2 |
| mw-mse | Malawi Stock Exchange | SECURITIES_REGULATOR | P2 |

### Nigeria Sources (8)

| ID | Regulator | Type | Priority |
| --- | --- | --- | --- |
| ng-cbn | Central Bank of Nigeria | REGULATOR | P0 |
| ng-sec | Securities and Exchange Commission | SECURITIES_REGULATOR | P0 |
| ng-ndpc | Nigeria Data Protection Commission | DATA_PROTECTION_AUTHORITY | P0 |
| ng-nfiu | Nigerian Financial Intelligence Unit | FIU | P0 |
| ng-fccpc | FCCPC | CONSUMER_PROTECTION_AUTHORITY | P1 |
| ng-ncc | Nigerian Communications Commission | REGULATOR | P1 |
| ng-nigerialii | NigeriaLII | LEGAL_DATABASE | P1 |
| ng-cac | Corporate Affairs Commission | GOVERNMENT_PORTAL | P2 |

## Candidate Manifest Format

```json
{
  "version": 1,
  "country": "Malawi",
  "jurisdictionCode": "MW",
  "discoveredAt": "2026-06-10T12:00:00Z",
  "entries": [
    {
      "id": "mw-candidate-reserve-bank-act-001",
      "country": "Malawi",
      "jurisdictionCode": "MW",
      "discoveredTitle": "Reserve Bank of Malawi Act",
      "normalizedTitle": "Reserve Bank of Malawi Act",
      "sourceUrl": "https://www.rbm.mw/docs/rbm-act.pdf",
      "sourcePageUrl": "https://www.rbm.mw/regulations/",
      "regulator": "Reserve Bank of Malawi",
      "suggestedCategory": "banking",
      "suggestedDocumentType": "ACT",
      "suggestedAuthorityStatus": "UNKNOWN",
      "suggestedIsBinding": null,
      "priority": "UNKNOWN",
      "decision": "NEEDS_REVIEW",
      "discoveredAt": "2026-06-10T12:00:00Z",
      "tags": []
    }
  ]
}
```

## Discovery Command Usage

```bash
# Discover for a single country
pnpm corpus:discover --country=malawi

# Discover for all countries
pnpm corpus:discover --all

# Dry run (no network requests, no file writes)
pnpm corpus:discover --country=malawi --dry-run
pnpm corpus:discover --all --dry-run
```

Discovery will:
- Load the source registry for the specified country
- Skip `manual-only` sources and disabled sources
- Fetch HTML from each enabled source page
- Extract links to `.pdf`, `.doc`, `.docx`, `.txt` files
- Resolve relative URLs and enforce domain allowlists
- Normalize titles and suggest categories/document types
- Default decision to `NEEDS_REVIEW` (never auto-approves)
- Detect duplicate URLs and titles
- Write candidate manifest to `documents/_incoming/<country>/candidate-manifest.json`
- Write discovery report to `documents/_incoming/<country>/discovery-report.md`

## Downloader Command Usage

```bash
# Download approved candidates (required: --approved-only)
pnpm corpus:download --country=malawi --approved-only

# Download for all countries
pnpm corpus:download --all --approved-only

# Dry run
pnpm corpus:download --country=malawi --approved-only --dry-run

# Force overwrite existing files
pnpm corpus:download --country=malawi --approved-only --force
```

Downloader will:
- Load the candidate manifest
- **Only** download entries where `decision === "APPROVED"`
- Skip NEEDS_REVIEW, REJECTED, SUPERSEDED, DUPLICATE
- **Refuse to run** without `--approved-only` flag
- Save files under the proposed country/category path
- Compute SHA-256 checksums after download
- Update candidate entries with `downloadedLocalPath`, `checksumSha256`, `contentType`
- Write download report to `documents/_incoming/<country>/download-report.md`

## Review Workflow

1. **Discovery**: Run `pnpm corpus:discover --country=malawi` to find candidate documents.
2. **Review**: Open `documents/_incoming/malawi/candidate-manifest.json` and review candidates:
   - Change `decision` from `NEEDS_REVIEW` to `APPROVED`, `REJECTED`, `DUPLICATE`, or `SUPERSEDED`
   - Add `decisionReason`, `reviewedBy`, `reviewedAt`
   - Set `proposedLocalPath` for APPROVED entries (required)
   - Add `priority` assignment
3. **Download**: Run `pnpm corpus:download --country=malawi --approved-only` to download approved files.
4. **Verify**: Check the download report at `documents/_incoming/malawi/download-report.md`.
5. **Promote** (Phase 4): Move approved entries to the production manifest.

## Safety Rules

- Discovery never auto-approves candidates
- Download requires `--approved-only` flag
- All local paths validated for traversal attacks
- Only allowed domains are fetched (per source registry)
- No existing Kenya/International files are touched
- No production manifests are modified
- No ingestion is run
- No Pinecone data is touched
- No Prisma migrations are created
- No retrieval behavior is changed
- No frontend UI is added

## What Is Intentionally Not Done in Phase 3

- No live network requests were made for discovery (dry-run only in this environment)
- No candidate documents were actually populated (manifests are empty scaffolds)
- No manifest promotion (moving candidates to production manifests)
- No ingestion of Malawi/Nigeria documents
- No country-aware retrieval filters
- No vector metadata enrichment
- No frontend exposure of Malawi/Nigeria
- Candidate promotion CLI (`pnpm corpus:promote-candidates`) deferred to Phase 4

## How This Prepares Phase 4

Phase 4 (Legal Corpus Review and P0 Country Population) can:

1. Run `pnpm corpus:discover --country=malawi` and `--country=nigeria` live to populate candidate manifests
2. Review and approve high-priority candidates
3. Run `pnpm corpus:download --approved-only` to download approved documents
4. Build a `promote-candidates` CLI to safely move approved+downloaded candidates to production manifests
5. Add country-aware ingestion and retrieval filters
6. Enrich vector metadata with jurisdiction codes and source URLs

## Known Limitations

- **No live discovery was run**: This environment does not have internet access. Discovery must be run locally where network access is available.
- **Empty candidate manifests**: No candidates have been discovered yet (manifests contain 0 entries).
- **HTML parsing is regex-based**: The link extractor uses regex, not a full HTML parser. It handles standard `<a href>` patterns but may miss JavaScript-rendered links or complex HTML structures.
- **Category suggestion is heuristic**: Title-keyword matching may misclassify some documents. Human review is required.
- **No pagination handling**: The discovery engine fetches a single page per source URL. Multi-page publication listings require additional crawl logic or multiple source entries.
- **No authentication**: Some regulator sites may require login or cookies for document access.

## Verification Results

- `pnpm corpus:discover --country=malawi --dry-run`: **PASS** ✅
- `pnpm corpus:discover --country=nigeria --dry-run`: **PASS** ✅
- `pnpm corpus:download --country=malawi --approved-only --dry-run`: **PASS** ✅
- `pnpm corpus:download --country=nigeria --approved-only --dry-run`: **PASS** ✅
- `pnpm corpus:validate --all`: **PASS** ✅ (55 entries, 4 manifests)
- `pnpm corpus:inventory --all`: **PASS** ✅ (55 entries, 0 missing files)
- tests: **PASS** ✅
- typecheck: **PASS** ✅

## Files Added

### Corpus Utilities (`src/scripts/corpus/`)

| File | Purpose |
| --- | --- |
| `source-registry.schema.ts` | Zod schema for source registry entries |
| `source-registry-loader.ts` | Load and validate source registries |
| `candidate.schema.ts` | Zod schema for candidate manifest entries |
| `candidate-loader.ts` | Load, validate, write candidate manifests |
| `url-utils.ts` | URL resolution, domain enforcement, link extraction |
| `filename-utils.ts` | Title/filename normalization, category suggestion |
| `discover-sources.ts` | CLI: `pnpm corpus:discover` |
| `download-approved.ts` | CLI: `pnpm corpus:download` |
| `discovery-report.ts` | Markdown report generators |

### Source Registries (`scripts/corpus/sources/`)

| File | Sources |
| --- | --- |
| `malawi.sources.json` | 6 sources (2 P0, 2 P1, 2 P2) |
| `nigeria.sources.json` | 8 sources (4 P0, 3 P1, 1 P2) |

### Candidate Manifests (`documents/_incoming/`)

| File | Status |
| --- | --- |
| `malawi/candidate-manifest.json` | Empty scaffold |
| `malawi/discovery-report.md` | Placeholder |
| `malawi/download-report.md` | Placeholder |
| `nigeria/candidate-manifest.json` | Empty scaffold |
| `nigeria/discovery-report.md` | Placeholder |
| `nigeria/download-report.md` | Placeholder |

### Tests

| File | Tests |
| --- | --- |
| `src/__tests__/corpus-discovery.test.ts` | 68 tests |

## Files Modified

| File | Change |
| --- | --- |
| `package.json` | Added `corpus:discover` and `corpus:download` scripts |
