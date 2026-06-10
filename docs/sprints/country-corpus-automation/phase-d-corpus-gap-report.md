# Phase D — Corpus Gap Report

Date: 2026-06-10

## Summary
During Phase 4 (Legal Corpus Review and P0 Country Population), automated discovery failed to retrieve the target P0 regulatory documents for Malawi and Nigeria due to live internet access limitations and dynamic crawler blocks. Consequently, 100% of the target P0 documents for both countries are missing from the automated pipeline and must be populated manually.

## Which P0 Malawi documents were found and approved?
- None.

## Which P0 Malawi documents are missing or still need review?
All target P0 documents are missing:
- Financial Services Act
- Banking Act
- Payment Systems Act
- Payment Systems Regulations
- E-money / mobile money rules where available
- Financial Crimes Act
- Financial Crimes Amendment Act 2023
- Financial Crimes Money Laundering Regulations 2020
- Financial Crimes Suppression of Terrorist Financing / Proliferation Financing Regulations
- National AML/CFT/CPF policy
- Data Protection Act
- Electronic Transactions and Cybersecurity Act
- Microfinance Act
- Consumer protection / financial consumer protection rules
- RBM licensing guidelines/checklists
- RBM payments strategy or payment systems oversight guidance

## Which P0 Nigeria documents were found and approved?
- None.

## Which P0 Nigeria documents are missing or still need review?
All target P0 documents are missing:
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

## Which sources failed to produce documents?
All sources failed to yield P0 regulatory documents via automated scraping:
**Malawi:** Reserve Bank of Malawi, Financial Intelligence Authority, MACRA, MalawiLII, Parliament, MSE.
**Nigeria:** Central Bank of Nigeria, Securities and Exchange Commission, NDPC, NFIU, FCCPC, NCC, NigeriaLII, CAC.

## Which documents need manual legal verification?
All of the missing documents listed above will need manual discovery, manual download, and manual legal verification before being added to the production manifests.

## Which documents may be superseded?
None identified via automation. During manual review, older iterations of the CBN Mobile Money Guidelines and early NDPA drafts should be carefully checked to avoid including superseded versions.

## Which documents should be P1/P2 later?
Additional sectoral guidelines (e.g., specific insurance tech guidelines, crypto asset frameworks if newly released, cross-border payment MOU details) should be classified as P1 or P2 once the P0 corpus is manually verified and ingested.
