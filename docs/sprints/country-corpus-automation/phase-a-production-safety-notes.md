# Phase A Production Safety Notes

Date: 2026-06-10

## What Must Remain Untouched

- Existing files in `documents/kenya/`.
- Existing files in `documents/international/`.
- Existing filenames and relative paths referenced by `src/scripts/ingest-documents.ts`.
- Existing Pinecone index and default namespace records.
- Existing `RegulatoryDocument`, `RegulatoryDocumentChunk`, `LegalDocument`, and `DocumentChunk` data.
- Existing Prisma schema and migrations until Phase 2 decisions are approved.
- Current Kenya-oriented `RegulatoryFramework` seed behavior.

## Live Assumptions

- Operators run `pnpm ingest` from the backend project root.
- The ingestion script expects files under `documents/` and uses exact registry relative paths.
- Kenya and International are flat live folders.
- Pinecone default namespace `__default__` contains mixed corpus vectors.
- The default Pinecone index name is `sheriabot-legal-docs` when `PINECONE_INDEX_NAME` is not set.
- Regulatory ingestion skips duplicate content by SHA-256 checksum.
- Compliance query RAG cache keys include the low-level filter and namespace, but product flows commonly call retrieval with no filter.

## Scripts That Should Not Be Run Casually

- `pnpm ingest`: uploads originals to R2, creates DB rows, chunks documents, and upserts Pinecone vectors.
- `pnpm regdoc:authority`: updates regulatory document authority metadata and refreshes Pinecone records.
- `pnpm cleanup:documents`: hard-deletes expired soft-deleted `LegalDocument` rows and R2 files.
- `src/scripts/cleanup-deleted-vault-documents.ts`: deletes vault objects/records.
- Any Prisma migration or reset command.
- Any ad hoc `deleteByFilter`, `deleteVectors`, or namespace deletion call.
- Any document module reprocessing path: deletes existing vectors/chunks before re-indexing.

## Re-Ingestion Risks

- If filenames move or registry entries change, ingestion may skip files as missing or create new records for changed binaries.
- Checksum dedupe prevents exact duplicate binaries, but not semantically duplicate documents with different binary encodings.
- Authority metadata updates re-upsert all chunks for a document.
- `ragService.deleteDocument(documentId)` deletes Pinecone records by metadata filter; incorrect IDs or filters would remove live retrieval context.
- Failed ingestion can leave `RegulatoryDocument` rows with `FAILED` status.

## Path And Cache Risks

- Local file path is not persisted, so registry path remains an operational dependency rather than a DB fact.
- Redis RAG context cache includes filter and namespace in the hash, which is good, but country filters must be present in retrieval options for the cache key to distinguish country-specific retrieval.
- Existing unfiltered cache entries may continue to serve mixed-corpus results until expiry after country filters are introduced.

## Migration And Data-Loss Risks

- A migration is not required to keep Phase 1 safe.
- Adding mandatory country/source fields without backfill would be risky because existing rows lack normalized country codes/source URLs.
- Data-loss commands such as `prisma migrate reset` must not be used.
- Destructive cleanup scripts should be disabled from Phase 2 validation workflows unless explicitly scoped to non-production fixtures.

