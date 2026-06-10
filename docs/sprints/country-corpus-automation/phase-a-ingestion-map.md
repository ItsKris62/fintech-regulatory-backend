# Phase A Ingestion Map

Date: 2026-06-10

## Current Architecture

The current ingestion setup is mixed:

- Live regulatory corpus ingestion is registry-based and path-hardcoded in `src/scripts/ingest-documents.ts`.
- Processing is service-based in `src/lib/ingestion/document-processor.ts`.
- Vector indexing is Pinecone integrated-embedding based via `src/lib/rag/client.ts`.
- Older/general document indexing exists through `src/modules/document/document.module.ts` and writes `LegalDocument` style content into Pinecone.

It is not manifest-driven, database-discovery driven, or folder-scanning driven today.

## Relevant Files

| File | Purpose | Entry command | Active/legacy | Folder assumption | Writes |
| --- | --- | --- | --- | --- | --- |
| `package.json` | Defines scripts. `ingest` maps to `tsx src/scripts/ingest-documents.ts`; `regdoc:authority` maps to authority metadata refresh. | `pnpm ingest`, `pnpm regdoc:authority` | Active | n/a | n/a |
| `documents/README.md` | Operator instructions for adding corpus documents. Mentions `kenya/` and `international/`, registry matching, and `pnpm ingest`. | n/a | Active docs, partly stale filenames | Flat folders | n/a |
| `src/scripts/ingest-documents.ts` | Main regulatory corpus ingestion runner. Contains `DOCUMENT_REGISTRY` with exact `fileName`, title, source, category, jurisdiction, document type, effective date, version, authority status, and binding flags. | `pnpm ingest` | Active | Hardcoded relative paths; can technically include nested paths if explicitly written, but does not discover them | Calls processor; writes DB, R2, Pinecone |
| `src/lib/ingestion/document-processor.ts` | Validates file, computes checksum, extracts text, uploads original to R2, chunks text, upserts Pinecone vectors, creates `RegulatoryDocument` and `RegulatoryDocumentChunk` rows. | Called by ingestion script and authority script | Active | Receives one explicit `filePath`; no folder discovery | DB, R2, Pinecone |
| `src/lib/ingestion/ingest-documents.ts` | Barrel export for ingestion service. | n/a | Active helper | none | none |
| `src/lib/pdf/extract-text.ts` | PDF text extraction wrapper around `pdf-parse` v2 `PDFParse`. | Called by processor and other modules | Active | none | none |
| `src/lib/rag/chunking.ts` | Section-aware and sentence-aware chunking utilities. | Called by ingestion and document modules | Active | none | none |
| `src/lib/rag/client.ts` | Pinecone client, default index selection, upsert/search/delete helpers. Uses default namespace unless caller passes one. | Called by RAG service and processor | Active | none | Pinecone |
| `src/lib/rag/rag.service.ts` | General RAG indexing/search service. Used by compliance, gap analysis, policy, and document modules. | Library | Active | none | Pinecone |
| `src/scripts/update-regulatory-document-authority.ts` | Updates `RegulatoryDocument` authority metadata and refreshes Pinecone vector records for a document. | `pnpm regdoc:authority` | Active admin utility | none | DB and Pinecone |
| `src/scripts/seed-regulatory-frameworks.ts` | Seeds/upserts `RegulatoryFramework` rows. Frameworks are Kenya-oriented and tiered. | `pnpm seed:frameworks` | Active seed | n/a | DB |
| `src/modules/document/document.module.ts` | User/admin document management and older `LegalDocument` processing. Extracts text from stored files and indexes via `ragService.indexDocument`. | Router/service calls | Active for document CMS/benchmark docs, separate from filesystem corpus | no local corpus discovery | DB, R2, Pinecone |
| `src/server/services/benchmark-document.service.ts` | Lists and authorizes benchmark documents from both `LegalDocument` and active `RegulatoryDocument`. | Gap-analysis router/service | Active | n/a | Reads DB |
| `src/scripts/cleanup-deleted-documents.ts` | Hard-deletes expired soft-deleted `LegalDocument` records and R2 files. | `pnpm cleanup:documents` | Active but destructive | n/a | DB and R2 deletes |
| `src/server/routers/document.router.ts` | Document upload/download/reingest/delete endpoints; includes vector deletion by document ID. | tRPC | Active, not filesystem corpus ingestion | n/a | DB, R2, Pinecone |

## Discovery Behavior

Current live corpus ingestion does not scan folders. `src/scripts/ingest-documents.ts` iterates a static `DOCUMENT_REGISTRY` and resolves each entry with:

- `DOCS_ROOT = path.resolve(process.cwd(), 'documents')`
- `path.join(DOCS_ROOT, entry.fileName)`

Only files present in the registry are considered. Files in `documents/` that are not listed in the registry are ignored.

## Nested Folder Support

The current resolver could resolve a nested path if a registry entry used a value such as `malawi/data-protection/act.pdf`. However:

- There is no recursive folder discovery.
- There is no manifest parser.
- There is no category inference from folder names.
- There is no validation that nested paths remain under `documents/`.
- Operational docs and existing registry assumptions are flat.

So nested Malawi/Nigeria folders are not supported as an automated workflow today. They require Phase 2 loader work.

## Hardcoded Country Or Framework Assumptions

- `src/scripts/ingest-documents.ts` hardcodes Kenya, International, and EU jurisdiction labels in registry entries.
- `src/scripts/seed-regulatory-frameworks.ts` is Kenya-centric and seeds Kenya fintech framework slugs.
- `src/lib/rag/compliance-rag.ts` auto-detects `Kenya` and `EU`, but not Malawi or Nigeria.
- `src/modules/compliance/compliance.module.ts` gap analysis queries append `Kenya regulatory compliance obligations`.
- Prompts in `src/lib/ai/prompts/*` contain Kenya-specific examples and wording.

## Metadata Written By Ingestion

Regulatory ingestion writes:

- `title`
- `fileName`
- `fileType`
- `source`
- `category`
- `jurisdiction`
- `documentType`
- `effectiveDate`
- `version`
- `authorityStatus`
- `isBinding`
- `storageKey`
- `status`
- `checksum`
- `chunkCount`
- `totalCharacters`
- `processedAt`
- chunk `content`, `section`, `tokenCount`, `pineconeId`

It does not write official source URL, regulator as a separate field, country code, category slug beyond enum category, local file path, publication date, or manifest metadata.

