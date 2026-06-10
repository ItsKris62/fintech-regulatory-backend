# Phase D2 — Nigeria P0 Corpus

Date: 2026-06-10

## Manual Sourcing Status
- Manual intake structured and successfully ingested 23 P0 entries into `candidate-manifest.json` as `NEEDS_REVIEW`.
- **Approved & Downloaded:** 0 documents.
- **Production Status:** 0 documents in `documents/nigeria/manifest.json`.

## Target Documents Tracked in Intake
- CBN Act
- Banks and Other Financial Institutions Act 2020
- Payments System Management framework/law
- CBN PSP licence categorisation
- CBN new licence requirements for payment systems
- Framework and Guidelines on Mobile Money Services
- Supervisory Framework for Payment Service Banks
- Regulatory Framework for Agent Banking
- Operational Guidelines for Open Banking
- Regulatory Sandbox Framework
- Guidelines for Contactless Payments
- Money Laundering Prevention and Prohibition Act 2022
- Terrorism Prevention and Prohibition Act 2022
- NFIU Act 2018
- CBN AML/CFT/CPF regulations or guidelines
- Nigeria Data Protection Act 2023
- Nigeria Data Protection Regulation 2019
- NDPA implementation guidance where applicable
- FCCPC DEON Consumer Lending Regulations 2025
- FCCPC DEON Consumer Lending Guidelines 2025
- SEC Rules on Crowdfunding
- SEC Rules on Robo-Advisory
- SEC Rules on Digital Sub-Brokers

## Next Steps
A human operator must find the official PDFs (from CBN, NDPC, NFIU, FCCPC, SEC), download them, copy the URLs to `manual-source-intake.json`, mark `reviewStatus` as `APPROVED`, and re-run:
1. `pnpm corpus:intake --country=nigeria --force`
2. `pnpm corpus:download --country=nigeria --approved-only`
