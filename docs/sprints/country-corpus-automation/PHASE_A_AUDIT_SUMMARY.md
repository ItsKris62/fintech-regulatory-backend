# Phase A Audit Summary

Date: 2026-06-10

## Executive Summary

Phase A found that SheriaBot's live filesystem corpus is flat for Kenya and International, while ingestion is driven by a hardcoded TypeScript registry rather than folder discovery or manifests. The processing pipeline has solid baseline mechanics: checksum dedupe, text extraction, legal chunking, R2 upload, PostgreSQL records, and Pinecone integrated embeddings. The main blocker for Malawi/Nigeria expansion is not storage; it is metadata and retrieval isolation.

## Current State

- `documents/kenya/`: 41 PDFs plus `.gitkeep`, flat.
- `documents/international/`: 14 PDFs plus `.gitkeep`, flat.
- `documents/malawi/`, `documents/nigeria/`, `documents/rwanda/`: empty placeholders.
- Current live ingestion entrypoint: `pnpm ingest`.
- Current ingestion source of truth: `DOCUMENT_REGISTRY` in `src/scripts/ingest-documents.ts`.
- Current vector namespace: default Pinecone namespace unless explicitly overridden.

## Key Findings

1. Kenya and International can and should remain flat. Current registry paths depend on exact flat relative paths, and changing them would create avoidable ingestion risk.
2. Malawi and Nigeria can use nested category folders in a future phase only if the loader becomes manifest-aware or otherwise recursively resolves declared paths. Current ingestion does not discover nested folders automatically.
3. Manifest-driven ingestion is not currently supported. Phase 2 needs a manifest schema, validator, and backward-compatible loader.
4. Current retrieval does not reliably prevent wrong-country leakage. Primary compliance query and streaming flows search the mixed corpus without country filters.
5. An immediate DB migration is not strictly required if Phase 2 stores only existing fields, but durable country/source auditability will need either new fields or a structured metadata JSON strategy.
6. Pinecone regulatory vectors include useful `jurisdiction`, `category`, `authorityStatus`, and `isBinding` metadata, but they lack normalized country code, source URL, regulator, publication date, checksum, and framework slug.

## Current Document Layout

| Folder | Status | Structure |
| --- | --- | --- |
| `documents/kenya/` | live | flat |
| `documents/international/` | live | flat |
| `documents/malawi/` | empty | no files |
| `documents/nigeria/` | empty | no files |
| `documents/rwanda/` | empty | no files |

## Current Ingestion Architecture

The ingestion process is registry-based and mixed with service-based processing:

- `src/scripts/ingest-documents.ts` hardcodes all live corpus entries.
- `src/lib/ingestion/document-processor.ts` processes explicit file paths.
- `src/lib/rag/client.ts` writes vectors using Pinecone integrated embeddings.
- `src/lib/rag/rag.service.ts` provides general indexing/search for other product areas.

It is not database-driven, manifest-driven, or folder-scan driven.

## Current Metadata Support

Strong today:

- title, source label, category, jurisdiction label, document type
- effective date, version
- authority status and binding flag for `RegulatoryDocument`
- checksum and R2 storage key

Weak or missing:

- country code
- source URL
- normalized regulator
- publication date
- manifest provenance
- local path persistence
- framework slug on `RegulatoryDocument`
- structured source/audit metadata

## Current Pinecone/Vector Metadata Support

Regulatory vectors include:

- document ID/title/type
- chunk text/index/section
- jurisdiction
- category/regulatory area
- year
- authority status
- binding flag
- source label
- version
- corpus status

They do not include country code, source URL, regulator, publication date, checksum, local path, or framework slug.

## Current Retrieval Filtering Support

The low-level RAG service supports arbitrary Pinecone filters. Product flows use this inconsistently:

- Primary compliance query: no filter.
- Streaming compliance query: no filter.
- Compliance document search: caller filter, no country.
- Gap analysis: framework slug and selected benchmark document filters, but no country filter.
- Enhanced compliance RAG helper: can auto-detect Kenya/EU/category, but is not the main router path.

## Nested Malawi/Nigeria Readiness

Nested Malawi/Nigeria folders are not supported as an automated ingestion workflow today. A single explicit nested file path would resolve if hardcoded in the registry, but that is not sufficient for safe corpus automation.

Needed:

- manifest schema
- path validation under `documents/`
- recursive or manifest-declared path support
- category/country metadata validation
- country-aware retrieval filters

## Risks

- Moving Kenya/International files breaks registry resolution.
- Adding Malawi/Nigeria vectors without country filters allows wrong-country citations.
- Missing source URLs and publication dates weaken auditability.
- Duplicate-looking documents can bypass checksum dedupe if binaries differ.
- Cleanup/reprocess scripts can delete DB/R2/Pinecone data and should not be used in corpus expansion validation.

## Recommended Phase 2 Implementation Plan

Proceed to Phase 2: Manifest Schema and Backward-Compatible Loader.

Recommended sequence:

1. Define manifest schema with country code, jurisdiction, source URL, regulator, authority status, binding status, category, framework slugs, dates, checksum, and local path.
2. Add a read-only manifest validator and inventory reporter first.
3. Build a backward-compatible loader that preserves current Kenya/International registry behavior.
4. Add Malawi/Nigeria manifests and nested folders without moving Kenya/International.
5. Add country/jurisdiction metadata to vectors during future ingestion.
6. Add retrieval filters and tests before ingesting Malawi/Nigeria into shared production Pinecone.

## Files Inspected

- `documents/`
- `documents/README.md`
- `package.json`
- `prisma/schema.prisma`
- `src/scripts/ingest-documents.ts`
- `src/lib/ingestion/document-processor.ts`
- `src/lib/ingestion/ingest-documents.ts`
- `src/lib/pdf/extract-text.ts`
- `src/lib/rag/client.ts`
- `src/lib/rag/rag.service.ts`
- `src/lib/rag/chunking.ts`
- `src/lib/rag/compliance-rag.ts`
- `src/server/routers/compliance.router.ts`
- `src/routes/compliance-stream.route.ts`
- `src/server/routers/gap-analysis.router.ts`
- `src/server/services/benchmark-document.service.ts`
- `src/modules/compliance/compliance.module.ts`
- `src/modules/document/document.module.ts`
- `src/server/schemas/compliance.schema.ts`
- `src/scripts/seed-regulatory-frameworks.ts`
- `src/scripts/update-regulatory-document-authority.ts`
- `src/scripts/cleanup-deleted-documents.ts`

## Files Created

- `docs/sprints/country-corpus-automation/phase-a-document-inventory.md`
- `docs/sprints/country-corpus-automation/phase-a-ingestion-map.md`
- `docs/sprints/country-corpus-automation/phase-a-data-model-audit.md`
- `docs/sprints/country-corpus-automation/phase-a-vector-metadata-audit.md`
- `docs/sprints/country-corpus-automation/phase-a-retrieval-flow.md`
- `docs/sprints/country-corpus-automation/phase-a-production-safety-notes.md`
- `docs/sprints/country-corpus-automation/phase-a-metadata-gap-report.md`
- `docs/sprints/country-corpus-automation/PHASE_A_AUDIT_SUMMARY.md`

## No-Code-Change Confirmation

No source code, document files, schema files, migrations, environment files, ingestion logic, Pinecone data, or database data were changed. Only audit documentation was created.

## Open Questions

- Should Phase 2 add first-class DB columns for country/source metadata, or use a `metadata Json` field on `RegulatoryDocument` first?
- Should Malawi/Nigeria initially ingest into a separate Pinecone namespace for validation before sharing the default namespace?
- Should `RegulatoryFramework` become country-scoped before Malawi/Nigeria gap analysis is exposed?
- Should existing Kenya/International documents be backfilled with official source URLs before adding new countries?

## Next Phase

Phase B (Manifest Schema and Backward-Compatible Loader) has been completed. See [phase-b-manifest-loader.md](phase-b-manifest-loader.md).
