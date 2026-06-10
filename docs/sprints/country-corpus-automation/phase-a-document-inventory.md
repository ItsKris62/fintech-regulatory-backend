# Phase A Document Inventory

Date: 2026-06-10

Scope: read-only inventory of `fintech-regulatory-backend/documents/`.

## Summary

| Folder | Direct files | Total files | Subdirectories | Extensions | Current role |
| --- | ---: | ---: | ---: | --- | --- |
| `documents/kenya/` | 42 | 42 | 0 | `.pdf`: 41, `.gitkeep`: 1 | Live Kenya corpus |
| `documents/international/` | 15 | 15 | 0 | `.pdf`: 14, `.gitkeep`: 1 | Live international corpus |
| `documents/malawi/` | 0 | 0 | 0 | none | Empty placeholder |
| `documents/nigeria/` | 0 | 0 | 0 | none | Empty placeholder |
| `documents/rwanda/` | 0 | 0 | 0 | none | Empty placeholder |

The live document structure is flat for both Kenya and International. No nested category folders exist in either live folder.

## Kenya Folder Notes

`documents/kenya/` contains 41 PDFs and one `.gitkeep`. Filenames indicate categories such as:

- Data protection and ODPC guidance.
- Cybersecurity, ICT, AI, cloud, and computer misuse.
- Payment systems and PSP cybersecurity.
- Banking, digital credit, VASP, capital markets, insurance, consumer protection, finance/tax, and green fiscal policy.
- AML/CFT and POCAMLA.

The current ingestion registry references Kenya documents using exact relative paths such as `kenya/TheDataProtectionAct__No24of2019.pdf`. Moving, renaming, or nesting these files would break the registry unless every registry entry is updated and revalidated.

Potential duplicate/same-instrument risk:

- `Computer Misuse and Cybercrimes (Amendment) Act, 2025.pdf`
- `Computer-Misuse-and-Cybercrimes-Amendment-Act-2025.pdf`

The ingestion code relies on SHA-256 checksum deduplication, so identical binary content should be skipped, but different scans/exports of the same instrument may still ingest as separate documents.

## International Folder Notes

`documents/international/` contains 14 PDFs and one `.gitkeep`. Filenames indicate standards and cross-border frameworks such as NIST CSF, ISO 27001/27000/27701, PCI DSS, GDPR, EU AI Act, NIST AI RMF, SOC 2, PCI overview, secure software guidance, and WCAG.

The current registry references International documents using exact relative paths such as `international/NIST.CSWP.29.pdf`. International is not structurally different from Kenya at the folder level; it is only differentiated by registry metadata such as `jurisdiction: 'International'` or `jurisdiction: 'EU'`.

## Other Existing Folder Notes

`documents/malawi/`, `documents/nigeria/`, and `documents/rwanda/` exist but are empty. No live ingestion behavior was observed for these folders.

## Unsupported Or Unreadable Extensions

Only `.pdf` files are present in the live corpus, apart from `.gitkeep` placeholders. The ingestion processor supports `.pdf`, `.docx`, `.doc`, and `.txt`; `.gitkeep` is unsupported but not referenced by the registry and therefore not ingested.

## Risks If Folder Paths Are Changed

- `src/scripts/ingest-documents.ts` is hardcoded to exact file paths relative to `documents/`.
- The ingestion README instructs operators to place files in `kenya/` or `international/` and match the registry filename.
- Database records do not persist the original local path, but the registry remains the operational source of file discovery.
- Moving existing files would not update previously indexed DB or Pinecone records, and future ingestion runs would skip files as missing.

## Recommendation

Keep Kenya and International flat in Phase 2. Introduce nested Malawi/Nigeria support only through a backward-compatible loader that can resolve both:

- Existing flat registry paths for Kenya/International.
- Future manifest entries that may point to nested category paths for Malawi/Nigeria.

