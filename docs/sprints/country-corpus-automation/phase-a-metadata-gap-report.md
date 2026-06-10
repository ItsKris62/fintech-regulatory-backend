# Phase A Metadata Gap Report

Date: 2026-06-10

## What Exists Today

For `RegulatoryDocument`:

- title
- file name/type
- source label
- enum category
- jurisdiction label
- document type
- effective date
- version
- authority status
- binding flag
- R2 storage key
- status
- checksum
- chunk count and total characters
- processed timestamp

For Pinecone vectors created by regulatory ingestion:

- document ID/title/type
- chunk text/index/section
- jurisdiction
- category/regulatory area
- effective year
- authority status
- binding flag
- source label
- version
- corpus status

For `LegalDocument`/benchmark-style content:

- title/act name
- document type
- regulatory body
- category/subcategory/tags
- content status/type
- file URL/storage reference
- content version
- chunks and full text

## Missing For Safe Malawi/Nigeria Expansion

- normalized country code
- distinction between country, jurisdiction, region, and international scope
- normalized regulator/issuing authority
- official source URL
- retrieval/download date
- publication date/gazette date
- checksum provenance in manifest
- document family/version lineage
- framework slug mapping
- category taxonomy compatible across Kenya/Malawi/Nigeria
- source authority status review notes
- whether a document is binding, draft, consultation, guidance, strategy, or superseded with human review evidence
- per-vector country code and jurisdiction code
- retrieval filters in product flows

## Must Be Added In Phase 2

Minimum backward-compatible manifest metadata:

- `id` or stable slug
- `countryCode`
- `jurisdiction`
- `scope`
- `category`
- `documentType`
- `title`
- `regulator`
- `sourceLabel`
- `sourceUrl`
- `localPath`
- `authorityStatus`
- `isBinding`
- `version`
- `effectiveDate`
- `publicationDate`
- `checksum`
- `frameworkSlugs`

Minimum vector metadata:

- `countryCode`
- `jurisdiction`
- `scope`
- `category`
- `documentType`
- `regulator`
- `sourceUrl`
- `authorityStatus`
- `isBinding`
- `version`
- `effectiveDate` or year
- `frameworkSlug`/`frameworkSlugs`
- `documentId`
- `documentTitle`

## Can Be Inferred From Current Files

- folder-level rough scope for Kenya and International
- file extension
- possible year/version from filename
- draft signals from filenames beginning with `Draft`
- some category hints from filename terms such as `Data Protection`, `Cyber`, `POCAMLA`, `Payment`, `AI`, `Cloud`, `Finance`

These should be treated as hints, not authoritative metadata.

## Requires Manual Review

- binding status
- authority status
- regulator/issuing body
- effective date
- publication/gazette date
- supersession relationships
- whether a strategy/policy/guidance document should be treated as binding
- whether duplicate-looking documents are true duplicates or different versions
- framework/category mapping for gap analysis

## Must Come From Official Source URLs

- official publication URL
- issuing regulator/authority
- publication date
- current version
- source checksum/download provenance
- revocation/supersession status where available

## Must Be Attached To Pinecone Vectors

Country-safe retrieval requires at least:

- `countryCode`
- `jurisdiction`
- `scope`
- `documentId`
- `documentTitle`
- `category`
- `documentType`
- `frameworkSlug` or searchable equivalent
- `authorityStatus`
- `isBinding`
- `source`
- `sourceUrl`
- `version`
- `corpusStatus`

Without these fields and corresponding filters, Malawi/Nigeria expansion can produce wrong-country citations in primary compliance answers.

