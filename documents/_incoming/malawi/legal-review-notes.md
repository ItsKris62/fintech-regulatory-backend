# Legal Review Notes: Malawi P0 Corpus

## Reviewed Sources
- Reserve Bank of Malawi (RBM)
- Financial Intelligence Authority (FIA)
- MACRA
- MalawiLII
- Malawi Parliament
- Malawi Stock Exchange

## Discovery Status
Automated discovery in the current environment failed to retrieve the target P0 regulatory documents due to a lack of live internet access / dynamic scraping capabilities. The discovery engine returned false positives (e.g., service delivery charters, non-regulatory forms).

## Approved Documents
- **None**. (All 4 discovered candidates were rejected as false positives).

## Rejected Documents
- `Reserve Bank of Malawi Access to Information Manual`
- `Access to Information Act, 2017`
- `Reserve Bank of Malawi - Access to Information Request Form`
- `FIA SERVICE DELIVERY CHARTER`

## Superseded Documents
- None.

## Documents Needing Further Review
- None.

## Missing P0 Documents
The following critical documents must be discovered and reviewed manually:
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

## Source Reliability Notes
- The official RBM and FIA websites are authoritative but rely on dynamic content delivery that blocked our regex-based link discovery.
- MalawiLII is an excellent fallback for Acts (e.g., Banking Act) but regulations are often out of date compared to the RBM site.

## Known Limitations
- Automated phase blocked on live discovery.

## Recommended Follow-up
- Perform manual downloads of the missing P0 documents.
- Move manually downloaded files to `documents/malawi/<category>/`.
- Manually construct manifest entries in `documents/malawi/manifest.json`.
