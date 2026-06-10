# Phase A Data Model Audit

Date: 2026-06-10

## Corpus-Related Models

| Model                     | Current role                                                  | Country/jurisdiction                              | Category/framework                                                          | Authority/binding                                     | Source/version/dates                                                                             | File/path/checksum                                                                            | Notes                                                                            |
| ---------------------------| ---------------------------------------------------------------| ---------------------------------------------------| -----------------------------------------------------------------------------| -------------------------------------------------------| --------------------------------------------------------------------------------------------------| -----------------------------------------------------------------------------------------------| ----------------------------------------------------------------------------------|
| `RegulatoryDocument`      | Primary live filesystem corpus model                          | `jurisdiction String` only; no country code/scope | `category RegulatoryDocumentCategory`; no framework slug                    | `authorityStatus`, `isBinding`                        | `source`, `version`, `effectiveDate`; no `sourceUrl`, `publicationDate`, or separate `regulator` | `fileName`, `fileType`, `storageKey`, `checksum`; no local path                               | Best current home for Phase 2 metadata, but may need new fields or metadata JSON |
| `RegulatoryDocumentChunk` | Chunk rows for `RegulatoryDocument`                           | Inherited only through relation                   | Inherited only through relation                                             | Inherited only through relation                       | no per-chunk source fields except relation                                                       | `pineconeId`, `content`, `section`, `tokenCount`                                              | Pinecone metadata carries more retrieval fields than chunk table                 |
| `LegalDocument`           | Older/general CMS, benchmark, and organization document model | No country/jurisdiction field                     | `category`, `subcategory`, `contentType`; no framework slug field           | no authority/binding fields                           | `regulatoryBody`, `version Int`, dates; no source URL                                            | `originalFilename`, `fileUrl`, `fileSize`, `mimeType`; no checksum                            | Used for benchmark docs and content/knowledge base indexing                      |
| `DocumentChunk`           | Chunk rows for `LegalDocument`                                | none                                              | `sectionNumber`, no category/framework                                      | none                                                  | none                                                                                             | stores `embedding Float[]` but current Pinecone integrated flow does not use local embeddings | Legacy shape differs from current Pinecone integrated metadata                   |
| `RegulatoryFramework`     | Framework catalog for gap analysis choices                    | none                                              | `slug`, `name`, `category`, `tier`                                          | none                                                  | no source/version/effective dates                                                                | none                                                                                          | Kenya-centric seed data; no country dimension                                    |
| `GapAnalysis`             | User gap analysis run                                         | no explicit country                               | `regulatoryFrameworks Json`; related `GapAnalysisFramework` snapshots slugs | no corpus authority fields except inside JSON results | uploaded document fields, report tracking                                                        | `documentUrl` for uploaded user doc                                                           | Retrieval provenance mostly in JSON results/metadata                             |
| `GapAnalysisFramework`    | Snapshot of selected frameworks                               | none                                              | `slug`, `name`, `category`, `tier`                                          | none                                                  | `capturedAt`                                                                                     | none                                                                                          | Captures framework selection but not jurisdiction                                |
| `ComplianceQuery`         | User compliance query record                                  | no explicit country                               | `regulatoryAreas Json`, metadata JSON                                       | citations JSON may include authority/binding from RAG | citations JSON may include source/version                                                        | no corpus file fields                                                                         | Country intent not first-class                                                   |
| `ComplianceQueryRun`      | Agentic run telemetry                                         | no explicit country                               | retrieval query/chunk JSON                                                  | accepted chunk JSON may contain whatever agents store | telemetry only                                                                                   | no corpus fields                                                                              | Good for audit trail but not corpus metadata                                     |
| `Citation`                | Polymorphic citation record                                   | none observed for corpus country                  | raw/source metadata possible through `rawSource`                            | not first-class                                       | citation text/url fields depending relation                                                      | none                                                                                          | Compliance query currently stores citations inline JSON, not this table          |

## Metadata Coverage Checklist

| Metadata | Current support |
| --- | --- |
| Country | Not first-class. `RegulatoryDocument.jurisdiction` stores human labels like `Kenya`, `International`, `EU`. |
| Jurisdiction code | Missing. |
| Scope | Missing, except implied by folder/registry and category. |
| Category | Present for `RegulatoryDocument` enum and `LegalDocument.category`. |
| Regulator | Not first-class. Often stored in `RegulatoryDocument.source` or `LegalDocument.regulatoryBody`. |
| Document type | Present. |
| Authority status | Present on `RegulatoryDocument`; missing on `LegalDocument`. |
| Binding status | Present on `RegulatoryDocument`; missing on `LegalDocument`. |
| Source URL | Missing on `RegulatoryDocument` and `LegalDocument`; source URL fields elsewhere are unrelated alert/policy fields. |
| Version | Present on `RegulatoryDocument` as string; `LegalDocument` has integer content version. |
| Effective date | Present on `RegulatoryDocument`; present on `LegalDocument`. |
| Publication date | Missing. |
| Checksum | Present on `RegulatoryDocument`; missing on `LegalDocument`. |
| Local file path | Not persisted. |
| Framework slug | Present in Pinecone metadata for some `LegalDocument` indexing and gap-analysis filters; not first-class on `RegulatoryDocument`. |
| Document status | Present. |
| Created/updated timestamps | Present. |

## Manifest Ingestion Fit

Phase 2 can start backward-compatibly without an immediate migration if the manifest maps onto existing `RegulatoryDocument` fields and stores only existing metadata:

- title
- source
- category
- jurisdiction
- documentType
- effectiveDate
- version
- authorityStatus
- isBinding

However, safe country expansion and auditability will be limited without fields or a structured metadata JSON for:

- country code (`MW`, `NG`, `KE`, `INT`, `EU`)
- jurisdiction/scope distinction
- regulator/issuing authority separate from source label
- official source URL
- publication date
- content checksum provenance
- source retrieval/download metadata
- framework slug/category mapping

## Auditability Risk

The largest auditability gap is source provenance. The system can say a document came from a source label such as `Central Bank of Kenya`, but it cannot currently prove official URL, retrieval date, publication date, or source checksum lineage in a structured way. For Malawi and Nigeria, this creates review burden and increases the risk of mixing official, draft, outdated, or unofficial documents.

