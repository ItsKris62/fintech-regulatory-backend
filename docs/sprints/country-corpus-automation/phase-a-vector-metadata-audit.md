# Phase A Vector Metadata Audit

Date: 2026-06-10

## Pinecone Setup

Pinecone access is centralized in `src/lib/rag/client.ts`.

- SDK: `@pinecone-database/pinecone` v7.
- Index name: `process.env.PINECONE_INDEX_NAME || 'sheriabot-legal-docs'`.
- Embedding mode: Pinecone integrated embeddings via `index.searchRecords` and `index.upsertRecords`.
- Default namespace: `__default__`.
- Namespaces are supported by helper signatures but current regulatory ingestion does not pass a custom namespace.

## Metadata Attached By Regulatory Ingestion

`src/lib/ingestion/document-processor.ts` attaches these fields to each vector:

| Field | Present | Source |
| --- | --- | --- |
| `id` | yes | `${documentId}-chunk-${chunkIndex}` |
| `chunk_text` | yes | chunk text, truncated for metadata size |
| `documentId` | yes | `RegulatoryDocument.id` |
| `documentTitle` | yes | `RegulatoryDocument.title` |
| `documentType` | yes | registry input |
| `chunkIndex` | yes | generated |
| `section` | yes, optional | chunking |
| `jurisdiction` | yes | registry input |
| `category` | yes | registry enum |
| `year` | optional | effective date year |
| `regulatoryArea` | yes | category |
| `authorityStatus` | yes | registry/default |
| `isBinding` | yes | registry/default |
| `source` | yes | registry input |
| `version` | optional | registry input |
| `corpusStatus` | yes | active/superseded state |

Not attached today:

- country code
- source URL
- publication date
- regulator as a separate normalized field
- checksum
- local file path
- manifest ID
- framework slug for regulatory documents
- storage key

## Metadata Attached By General `ragService.indexDocument`

The older/general indexing path attaches:

- `documentId`
- `documentTitle`
- `documentType`
- `chunkIndex`
- `section`
- `subsection`
- `citation`
- `actName`
- `year`
- `regulatoryArea`
- `authorityStatus`
- `isBinding`
- `source`
- `version`
- `framework`
- `frameworkSlug`
- `legalDocumentId`

This path does not attach `jurisdiction` or `category` unless caller-specific metadata is extended. `src/modules/document/document.module.ts` passes `category` in metadata, but `rag.service.ts` does not copy `metadata.category` to the vector record except as `frameworkSlug`.

## Search And Filters

`queryVectors(queryText, topK, namespace, filter)` forwards `filter` to Pinecone `searchRecords`.

Current callers:

- Compliance query and streaming query call `searchAndGetContext` with no metadata filter.
- Compliance search endpoint accepts a limited filter object but does not expose country.
- Gap analysis applies `frameworkSlug` and optional selected `documentId` filters, with framework-only fallback.
- Document module search filters by `organizationId`, `contentType`, and `category` for `LegalDocument` style content.
- `src/lib/rag/compliance-rag.ts` can auto-detect `category` and `jurisdiction`, but it is not the primary tRPC compliance query path.

## Wrong-Country Leakage Risk

Wrong-country leakage is possible if Malawi and Nigeria are added to the same index/default namespace without country-aware filters. The primary compliance query path retrieves from the whole corpus with no jurisdiction filter. Gap analysis also appends `Kenya` in query text but does not enforce a `jurisdiction` filter.

Adding Malawi and Nigeria safely requires:

- normalized country/jurisdiction metadata on every vector
- country-aware retrieval filters in compliance query, streaming query, gap analysis, checklist/policy generation, and document search where relevant
- cache keys that include country/filter inputs
- tests proving Kenya queries do not retrieve Malawi/Nigeria chunks unless explicitly cross-jurisdictional

