# Phase D — Legal Corpus Review

Date: 2026-06-10

## Summary
Phase 4 executes the legal corpus review and P0 country population workflow for Malawi and Nigeria. Due to environment limitations preventing live network scraping of dynamic regulatory sites, automated document discovery yielded only false positives. This phase documents the limitation, marks the false positives as REJECTED, and lays out the instructions for manual discovery and ingestion.

## What Changed
- Ran `pnpm corpus:discover` for Malawi and Nigeria.
- Reviewed and rejected 5 irrelevant candidates that were scraped.
- Attempted download via `pnpm corpus:download --approved-only` which correctly skipped the rejected candidates.
- Produced gap reports and legal review notes detailing the missing P0 corpus documents.
- Prepared templates for manual P0 document population.

## Review Workflow
1. Automated discovery generates `candidate-manifest.json`.
2. A legal reviewer assesses each candidate.
3. Relevant P0 documents are marked `APPROVED`.
4. Irrelevant, outdated, or duplicate documents are marked `REJECTED`, `SUPERSEDED`, or `DUPLICATE`.
5. *Current limitation:* Because automated discovery failed, reviewers must manually download documents, move them to the respective `documents/<country>/<category>/` folder, and manually update the production `manifest.json`.

## Candidate Decision Rules
- **APPROVED**: Official/current documents that belong in the P0 corpus.
- **NEEDS_REVIEW**: Uncertain documents.
- **REJECTED**: Unofficial, irrelevant, broken, or non-regulatory material.
- **SUPERSEDED**: Older instruments replaced by newer versions.
- **DUPLICATE**: Where a better candidate already exists.

## Download Workflow
- The `pnpm corpus:download --approved-only` script strictly downloads only APPROVED candidates. It computes SHA-256 checksums and updates candidate manifests.

## Manifest Update Workflow
Once documents are approved and downloaded:
1. Copy the verified entry into the production `documents/<country>/manifest.json`.
2. Ensure `sourceUrl`, `checksumSha256`, and `localPath` are valid and present.
3. Validate with `pnpm corpus:validate --country=<name> --verify-checksums`.

## Safety Notes
- No automated ingestions are run.
- Production manifests for Kenya and International remain completely untouched.
- No vectors or Pinecone data modified.
- No auto-approval of unreviewed documents.
- All failed discovery candidates were explicitly `REJECTED`.

## What Was Intentionally Not Done
- No fake or mocked URLs were inserted.
- No documents were ingested into RAG.
- No front-end product exposure was added.

## Validation Results
- Validation and inventory scripts passed cleanly. All existing manifests (Kenya, International) and the empty Malawi/Nigeria manifests passed validation. Checksums were verified where applicable.

## Remaining Risks
- The entire P0 corpus for Malawi and Nigeria must now be populated manually, which is labor-intensive and prone to human error (e.g., typos in JSON, incorrect checksum generation).

## Recommendation for Phase 5
Phase 5 (Country-Aware Ingestion, RAG Filtering, and Smoke Tests) is currently blocked on the manual completion of Phase 4. Once reviewers manually gather and manifest the P0 documents, Phase 5 can proceed to wire these new country manifests into the `DOCUMENT_REGISTRY` and update retrieval filters.
