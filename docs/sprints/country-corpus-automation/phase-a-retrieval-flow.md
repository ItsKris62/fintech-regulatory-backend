# Phase A Retrieval Flow

Date: 2026-06-10

## Compliance Query Flow

Primary tRPC flow:

1. `src/server/routers/compliance.router.ts`
2. `query` mutation validates input with `complianceQuerySchema`.
3. Calls `searchAndGetContext(input.question, { topK: 10, minScore: 0.7 })`.
4. `searchAndGetContext` in `src/lib/rag/rag.service.ts` builds a Redis cache key including query, topK, minScore, filter, and namespace.
5. Calls `ragService.searchWithReranking`.
6. `ragService.searchWithReranking` doubles topK, calls `ragService.search`, then applies simple lexical/citation/section reranking.
7. `ragService.search` calls `queryVectors`.
8. `queryVectors` calls Pinecone `searchRecords`.
9. Results become prompt context and citation JSON.
10. AI answer is generated through `ctx.aiService.answerComplianceQuery`.
11. Citations are stored inline in `ComplianceQuery.citations`.

Filtering: none by default. No country, framework, document ID, or category filter is applied in the primary compliance query path.

Streaming flow:

- `src/routes/compliance-stream.route.ts` follows the same `searchAndGetContext(input.question, { topK: 10, minScore: 0.7 })` pattern before streaming.

## Compliance Search Flow

`src/server/routers/compliance.router.ts` exposes `search`:

- calls `ctx.ragService.searchWithReranking(input.query, { topK: input.limit, minScore: 0.7, filter: input.filter })`
- schema permits `documentType`, `regulatoryArea`, `dateFrom`, and `dateTo`
- no country filter is exposed

Note: the schema uses `regulatoryArea`, while vector metadata commonly uses `regulatoryArea`, `category`, and sometimes `frameworkSlug`; caller/filter alignment should be verified in Phase 2.

## Gap Analysis Flow

1. `src/server/routers/gap-analysis.router.ts`
2. Validates uploaded file, selected `regulatoryFrameworks`, optional `benchmarkDocumentIds`, and plan access.
3. Resolves framework slugs from `RegulatoryFramework`.
4. Validates selected benchmark documents through `src/server/services/benchmark-document.service.ts`.
5. Calls `complianceModule.runGapAnalysis`.
6. `src/modules/compliance/compliance.module.ts` executes the pipeline.
7. For each selected framework, builds a RAG query: `${framework} Kenya regulatory compliance obligations ...`.
8. Applies strict filter:
   - `frameworkSlug` when available
   - `documentId` with `$in` when benchmark documents are selected
9. If strict results are too few, fallback relaxes to framework-only.

Filtering: framework/document filters are present for gap analysis, but no country/jurisdiction filter is enforced. Kenya is in the query text, not the Pinecone filter.

## Benchmark Document Handling

`src/server/services/benchmark-document.service.ts` lists authorized benchmark documents from:

- `LegalDocument` where content is published/indexed or organization/user-scoped
- active `RegulatoryDocument`

For `RegulatoryDocument`, `frameworkSlug` is normalized to `doc.category`, not a specific framework slug. For `LegalDocument`, `frameworkSlug` is `doc.category`.

Selected benchmark IDs are used as Pinecone `documentId` filters during gap analysis. This is helpful for narrowing retrieval, but it does not solve country filtering unless benchmark IDs are selected.

## Reranking And Source Verification

Reranking exists but is lightweight:

- doubles initial topK
- boosts query term matches
- boosts chunks with citations
- boosts relevant section labels

Source verification exists in the compliance orchestrator path through accepted chunk handling and verifier/grader agents, but primary retrieval itself does not verify source country or official provenance.

Citations are normalized into response JSON objects in `compliance.router.ts`, with fields such as document title, section, snippet, score, authority status, binding status, source, and version.

## International Mixing

International documents are mixed into the same default Pinecone namespace and retrieved alongside Kenya documents unless a caller supplies a metadata filter. The primary compliance paths do not filter, so International, Kenya, and any future Malawi/Nigeria documents can mix based on semantic similarity.

## Can Retrieval Be Constrained To A Country Today?

The low-level RAG service supports arbitrary Pinecone filters, and regulatory vectors include `jurisdiction`. Therefore country-like filtering is technically possible for vectors produced by `document-processor.ts`.

However, country filtering is not wired into the primary compliance/gap-analysis user flows, schemas, cache keys at the router level, or product UX. It is also inconsistent for older `LegalDocument` vectors, which may not carry `jurisdiction`.

