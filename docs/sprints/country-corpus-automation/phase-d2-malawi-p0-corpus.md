# Phase D2 — Malawi P0 Corpus

Date: 2026-06-10

## Manual Sourcing Status
- Manual intake structured and successfully ingested 16 P0 entries into `candidate-manifest.json` as `NEEDS_REVIEW`.
- **Approved & Downloaded:** 0 documents.
- **Production Status:** 0 documents in `documents/malawi/manifest.json`.

## Target Documents Tracked in Intake
- Financial Services Act
- Banking Act
- Payment Systems Act 2016
- Payment Systems Regulations
- E-money rules
- Financial Crimes Act
- Financial Crimes Amendment Act 2023
- Financial Crimes Money Laundering Regulations 2020
- Financial Crimes Suppression of Terrorist Financing / Proliferation Financing Regulations
- National AML/CFT/CPF Policy
- Data Protection Act
- Electronic Transactions and Cybersecurity Act
- Microfinance Act
- Consumer protection / financial consumer protection rules
- RBM licensing guidelines/checklists
- RBM payments strategy or payment systems oversight guidance

## Next Steps
A human operator must find the official PDFs (from RBM, FIA, or Malawi Parliament), download them, copy the URLs to `manual-source-intake.json`, mark `reviewStatus` as `APPROVED`, and re-run:
1. `pnpm corpus:intake --country=malawi --force`
2. `pnpm corpus:download --country=malawi --approved-only`
