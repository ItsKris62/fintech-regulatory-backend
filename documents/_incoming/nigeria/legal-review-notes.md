# Legal Review Notes: Nigeria P0 Corpus

## Reviewed Sources
- Central Bank of Nigeria (CBN)
- Securities and Exchange Commission (SEC)
- Nigeria Data Protection Commission (NDPC)
- Nigerian Financial Intelligence Unit (NFIU)
- FCCPC
- Nigerian Communications Commission (NCC)
- NigeriaLII
- Corporate Affairs Commission (CAC)

## Discovery Status
Automated discovery in the current environment failed to retrieve the target P0 regulatory documents due to a lack of live internet access / dynamic scraping capabilities. The discovery engine returned 1 false positive (a meeting communique).

## Approved Documents
- **None**. (The discovered candidate was rejected).

## Rejected Documents
- `Communique Issued at The End of the 109th Board Meeting of the Nigerian Communications Commission Held on May 25, 2026`

## Superseded Documents
- None.

## Documents Needing Further Review
- None.

## Missing P0 Documents
The following critical documents must be discovered and reviewed manually:
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

## Source Reliability Notes
- CBN is authoritative but its document repository uses a dynamic search interface that blocks standard crawlers.
- NDPC and FCCPC are reliable for their respective domains but often issue PDFs without clear machine-readable metadata.

## Known Limitations
- Automated phase blocked on live discovery.

## Recommended Follow-up
- Perform manual downloads of the missing P0 documents.
- Move manually downloaded files to `documents/nigeria/<category>/`.
- Manually construct manifest entries in `documents/nigeria/manifest.json`.
