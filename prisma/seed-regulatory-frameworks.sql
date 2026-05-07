-- RegulatoryFramework seed — idempotent via ON CONFLICT (slug) DO UPDATE SET
-- Safe to run on an already-populated table. Existing rows get descriptions updated.
-- Run: paste directly into Supabase SQL Editor.

INSERT INTO "RegulatoryFramework"
  (id, slug, name, category, description, tier, "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES

  -- ─── STARTUP Tier ──────────────────────────────────────────────────────────
  (gen_random_uuid()::text, 'dpa-2019',
    'Data Protection Act 2019',
    'Data Protection',
    'Kenya''s primary data protection law establishing obligations for data controllers and processors, including lawful basis for processing, data subject rights (access, rectification, erasure, portability), cross-border transfer restrictions, and mandatory breach notification to the ODPC.',
    'STARTUP', true, 1, NOW(), NOW()),

  (gen_random_uuid()::text, 'odpc-regs-2021',
    'ODPC Data Protection Regulations 2021',
    'Data Protection',
    'Secondary regulations under the DPA 2019 detailing registration requirements for data controllers and processors, DPIA obligations, enforcement procedures, exemptions, and the complaints resolution framework administered by the Office of the Data Protection Commissioner.',
    'STARTUP', true, 2, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-prudential',
    'CBK Prudential Guidelines',
    'Banking Supervision',
    'Central Bank of Kenya''s comprehensive prudential framework governing capital adequacy, liquidity management, asset quality classification, loan provisioning, risk governance, large exposure limits, related-party transaction controls, and internal audit requirements for licensed financial institutions.',
    'STARTUP', true, 3, NOW(), NOW()),

  (gen_random_uuid()::text, 'nps-2011',
    'National Payment System Act 2011',
    'Payments',
    'Foundational legislation governing the designation, oversight, and regulation of payment systems and services in Kenya, establishing CBK''s mandate to license payment service providers, set interoperability standards, designate systemically important payment systems, and protect payment system integrity.',
    'STARTUP', true, 4, NOW(), NOW()),

  (gen_random_uuid()::text, 'nps-regs-2014',
    'National Payment System Regulations 2014',
    'Payments',
    'Detailed implementing regulations under the NPS Act covering licensing categories (payment service providers, payment system operators), minimum capital requirements by tier, trust account and float management obligations, consumer protection standards, dispute resolution timelines, and interoperability requirements.',
    'STARTUP', true, 5, NOW(), NOW()),

  (gen_random_uuid()::text, 'pocamla',
    'Proceeds of Crime and Anti-Money Laundering Act',
    'AML/CFT',
    'Kenya''s primary AML/CFT legislation establishing mandatory customer due diligence (CDD), enhanced due diligence (EDD) for high-risk relationships, transaction monitoring obligations, suspicious transaction reporting (STR) and cash transaction reporting (CTR) to the Financial Reporting Centre, and minimum five-year record-keeping requirements.',
    'STARTUP', true, 6, NOW(), NOW()),

  (gen_random_uuid()::text, 'pocamla-regs-2013',
    'POCAMLA Regulations 2013',
    'AML/CFT',
    'Secondary regulations implementing POCAMLA, specifying CDD thresholds (KES 1M cash), PEP identification and enhanced monitoring procedures, correspondent banking due diligence standards, wire transfer information requirements, and prescribed FRC reporting formats for STRs and CTRs.',
    'STARTUP', true, 7, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-kyc',
    'CBK Know Your Customer Requirements',
    'AML/CFT',
    'CBK guidelines establishing minimum KYC standards for customer identification and verification across all delivery channels, tiered account risk classification (simplified/standard/enhanced due diligence), beneficial ownership verification for legal persons and arrangements, and ongoing monitoring and periodic review obligations.',
    'STARTUP', true, 8, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-cyber',
    'CBK Cybersecurity Guidance Note',
    'Cybersecurity',
    'CBK''s cybersecurity framework covering board-level governance and accountability, technical controls (encryption standards, access management, patch management, network segmentation), threat intelligence sharing obligations, cyber incident response and mandatory CBK reporting timelines, third-party risk management, and annual cybersecurity self-assessment requirements.',
    'STARTUP', true, 9, NOW(), NOW()),

  (gen_random_uuid()::text, 'computer-misuse-2018',
    'Computer Misuse and Cybercrimes Act 2018',
    'Cybersecurity',
    'Kenya''s cybercrime legislation establishing criminal offences for unauthorized computer access, data interference, phishing, identity theft, and cyber fraud — creating direct criminal liability for security control failures and imposing incident disclosure obligations relevant to fintech security governance.',
    'STARTUP', true, 10, NOW(), NOW()),

  (gen_random_uuid()::text, 'companies-act-2015',
    'Companies Act 2015',
    'Corporate Governance',
    'Kenya''s primary corporate law governing company incorporation, directorship duties and personal liabilities, shareholder rights, beneficial ownership register requirements, financial reporting obligations, annual returns filing with the Registrar of Companies, and restructuring and winding-up procedures applicable to all fintech legal entities.',
    'STARTUP', true, 11, NOW(), NOW()),

  (gen_random_uuid()::text, 'frc-guidelines',
    'Financial Reporting Centre AML Guidelines',
    'AML/CFT',
    'FRC operational guidelines for reporting institutions covering STR mechanics, CTR thresholds, currency transaction report requirements, AML/CFT compliance programme design expectations, FRC examination methodology, and obligations of Money Remittance Providers and digital credit providers.',
    'STARTUP', true, 12, NOW(), NOW()),

  (gen_random_uuid()::text, 'consumer-protection-act-2012',
    'Consumer Protection Act 2012',
    'Consumer Protection',
    'Kenya''s consumer rights legislation establishing fair trading practices, prohibition of unfair and unconscionable contract terms, right to refunds and returns, product liability standards, distance selling obligations relevant to app-based services, and consumer redress mechanisms applicable to all fintech consumer-facing products.',
    'STARTUP', true, 13, NOW(), NOW()),

  -- ─── BUSINESS Tier ─────────────────────────────────────────────────────────
  (gen_random_uuid()::text, 'dcpr-2022',
    'Digital Credit Providers Regulations 2022',
    'Digital Credit',
    'CBK regulations requiring digital credit providers to obtain a DCP licence, mandating transparent pricing disclosures (APR, total cost of credit), prohibiting unethical debt collection including unauthorized access to borrower contacts, requiring mandatory credit bureau reporting, and establishing 5-business-day consumer grievance resolution timelines.',
    'BUSINESS', true, 14, NOW(), NOW()),

  (gen_random_uuid()::text, 'consumer-protection',
    'CBK Consumer Protection Guidelines',
    'Consumer Protection',
    'CBK conduct-of-business framework covering plain-language fee and product disclosure standards, complaint handling timelines (72-hour acknowledgement, 30-day resolution), vulnerable customer identification and protection policies, mis-selling prohibitions, and annual consumer protection compliance audit requirements.',
    'BUSINESS', true, 15, NOW(), NOW()),

  (gen_random_uuid()::text, 'mobile-money-guidelines',
    'CBK Mobile Money Transfer Services Guidelines',
    'Mobile Money',
    'CBK''s regulatory framework for mobile money services covering licence tiers, mandatory 100% float backing held in commercial bank trust accounts, per-transaction and daily wallet limits by tier, agent network governance and vetting standards, interoperability obligations between providers, dormant account management, and e-money safeguarding requirements.',
    'BUSINESS', true, 16, NOW(), NOW()),

  (gen_random_uuid()::text, 'agent-banking-guidelines',
    'CBK Agent Banking Guidelines',
    'Payments',
    'CBK framework governing bank agent networks covering agent vetting, training, and certification standards, permissible and excluded agent activities, mandatory real-time host connectivity requirements, liability allocation between bank and agent, required consumer disclosures at agent premises, exclusivity restrictions, and agent performance monitoring frameworks.',
    'BUSINESS', true, 17, NOW(), NOW()),

  (gen_random_uuid()::text, 'credit-reference-regs-2013',
    'Credit Reference Bureau Regulations 2013',
    'Credit & Lending',
    'Regulations governing CRB licensing, mandatory credit information sharing for all regulated lenders, data accuracy and correction obligations, consumer dispute resolution procedures and timelines, free annual credit report entitlement, and blacklisting/delisting standards including the consent requirement for negative listing.',
    'BUSINESS', true, 18, NOW(), NOW()),

  (gen_random_uuid()::text, 'cma-act',
    'Capital Markets Authority Act',
    'Capital Markets',
    'Primary legislation governing Kenya''s capital markets, establishing licensing requirements for securities exchanges, central depositories, fund managers, investment advisors, stockbrokers, investment banks, and collective investment schemes. Relevant to fintechs offering wealth management, robo-advisory, or retail investment distribution.',
    'BUSINESS', true, 19, NOW(), NOW()),

  (gen_random_uuid()::text, 'cma-cis-regs',
    'CMA Collective Investment Schemes Regulations 2001',
    'Capital Markets',
    'CMA regulations governing the licensing, constitution, investment restrictions, pricing, distribution, and disclosure requirements for unit trusts, money market funds, and other collective investment schemes — relevant to fintech platforms distributing or managing retail investment or savings products.',
    'BUSINESS', true, 20, NOW(), NOW()),

  (gen_random_uuid()::text, 'insurance-act',
    'Insurance Act Cap 487',
    'Insurance',
    'Primary legislation governing Kenya''s insurance industry under IRA supervision, covering licensing classes (life, general, composite, reinsurance), minimum paid-up capital requirements, actuarial valuation obligations, policyholder protection and solvency margin requirements, premium payment timelines, and reinsurance treaty obligations relevant to embedded insurance and insurtech models.',
    'BUSINESS', true, 21, NOW(), NOW()),

  (gen_random_uuid()::text, 'ira-digital-guidelines',
    'IRA Digital Insurance Guidelines',
    'Insurance',
    'IRA guidance for digital insurance and insurtech models covering product approval requirements, digital distribution standards, premium collection via mobile money, electronic policy document standards, claims settlement timelines, identity verification via NIIMS/Huduma Namba, and regulatory treatment of index-based and microinsurance products.',
    'BUSINESS', true, 22, NOW(), NOW()),

  (gen_random_uuid()::text, 'kica',
    'Kenya Information and Communications Act',
    'Telecommunications',
    'ICT sector legislation establishing CA''s regulatory mandate over telecommunications providers and internet service providers — relevant to fintech USSD service providers, SMS OTP channels, digital service delivery quality-of-service obligations, type approval requirements for devices, and cross-border data roaming considerations.',
    'BUSINESS', true, 23, NOW(), NOW()),

  (gen_random_uuid()::text, 'microfinance-2006',
    'Microfinance Act 2006',
    'Microfinance & SACCO',
    'Legislation establishing the regulatory framework for deposit-taking microfinance institutions (DTMs) under CBK supervision, covering licensing requirements, minimum core capital (KES 60M), liquidity ratio requirements, loan classification and provisioning standards, single-obligor limits, and branching requirements.',
    'BUSINESS', true, 24, NOW(), NOW()),

  (gen_random_uuid()::text, 'sacco-act-2008',
    'SACCO Societies Act 2008',
    'Microfinance & SACCO',
    'Legislation establishing the SASRA regulatory framework for deposit-taking SACCOs, covering registration and licensing requirements, minimum institutional capital, prudential ratios (core capital ≥8% of total assets, liquidity ≥15%), non-performing loan limits, governance and board composition standards, and external audit and SASRA reporting obligations.',
    'BUSINESS', true, 25, NOW(), NOW()),

  (gen_random_uuid()::text, 'movable-property-2017',
    'Movable Property Security Rights Act 2017',
    'Credit & Lending',
    'Legislation establishing Kenya''s unified notice-based framework for creating, perfecting (via Kenya Collateral Registry), and enforcing security interests in movable property — including inventory, receivables, equipment, livestock, and intellectual property — enabling asset-backed and invoice/supply-chain financing by alternative lenders.',
    'BUSINESS', true, 26, NOW(), NOW()),

  (gen_random_uuid()::text, 'competition-act-2010',
    'Competition Act 2010',
    'Corporate Governance',
    'Competition Authority of Kenya''s enabling legislation prohibiting anti-competitive agreements, abuse of dominant market position (>50% market share), and restrictive trade practices — relevant to platform pricing strategies, data-sharing agreements, exclusivity arrangements with payment networks, and merger notification thresholds (KES 1B combined turnover).',
    'BUSINESS', true, 27, NOW(), NOW()),

  (gen_random_uuid()::text, 'tax-procedures-2015',
    'Tax Procedures Act 2015',
    'Tax & Compliance',
    'KRA''s unified tax procedures law governing PIN registration, electronic filing timelines, eTIMS electronic invoicing for B2B transactions, withholding tax obligations (commissions, interest, dividends, management fees), transfer pricing documentation for related-party transactions, penalty and interest computation, and KRA audit access rights.',
    'BUSINESS', true, 28, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-fraud-risk',
    'CBK Fraud Risk Management Guidelines',
    'Operational Risk',
    'CBK guidance on fraud prevention covering MFA standards for digital channels, real-time transaction monitoring requirements, mandatory fraud incident reporting timelines to CBK (within 24 hours of confirmed fraud), customer notification obligations, post-incident root cause analysis requirements, and annual fraud loss reporting.',
    'BUSINESS', true, 29, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-bancassurance',
    'CBK Bancassurance Guidelines',
    'Insurance',
    'CBK guidelines governing bancassurance models where licensed financial institutions act as corporate insurance agents — covering joint CBK/IRA approval requirements, staff training and certification, premium remittance timelines to underwriters, conflict of interest management, sales suitability and disclosure standards, and segregation of banking and insurance activities.',
    'BUSINESS', true, 30, NOW(), NOW()),

  -- ─── ENTERPRISE Tier ───────────────────────────────────────────────────────
  (gen_random_uuid()::text, 'cbk-capital-adequacy',
    'CBK Capital Adequacy Guidelines',
    'Banking Supervision',
    'CBK''s Basel III-aligned capital framework covering Tier 1 and Tier 2 capital definitions and deductions, credit/market/operational risk-weighted asset computation methodologies, minimum total CAR of 14.5%, capital conservation buffer, counter-cyclical buffer, and Internal Capital Adequacy Assessment Process (ICAAP) requirements for commercial banks.',
    'ENTERPRISE', true, 31, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-liquidity-risk',
    'CBK Liquidity Risk Management Guidelines',
    'Banking Supervision',
    'CBK framework covering board-approved liquidity risk appetite, minimum statutory liquidity ratio (20% of short-term liabilities), LCR computation and minimum thresholds, NSFR expectations, intraday liquidity monitoring, maturity mismatch limits, and Contingency Funding Plan requirements for commercial banks.',
    'ENTERPRISE', true, 32, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-operational-risk',
    'CBK Operational Risk Management Guidelines',
    'Operational Risk',
    'CBK guidelines for identifying, measuring, monitoring, and controlling operational risks — covering IT system failure, human error, process failures, internal/external fraud, legal and compliance risk, and third-party/vendor risk — with KRI dashboard, operational loss event database, and board-level risk appetite statement requirements.',
    'ENTERPRISE', true, 33, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-outsourcing',
    'CBK Outsourcing Guidelines',
    'Operational Risk',
    'CBK requirements for regulated institutions engaging material third-party providers, covering prior CBK notification, supplier due diligence (financial strength, operational resilience, regulatory standing), minimum contractual protections (audit rights, data residency, SLAs, step-in rights), subcontracting restrictions, ongoing monitoring, and documented exit and transition planning.',
    'ENTERPRISE', true, 34, NOW(), NOW()),

  (gen_random_uuid()::text, 'cbk-stress-testing',
    'CBK Stress Testing Guidelines',
    'Banking Supervision',
    'CBK requirements for regular stress tests covering credit risk (sector concentration shocks, borrower default cascades), market risk (interest rate and FX shocks), and liquidity risk (deposit run-off scenarios), with mandatory submission of results, management actions, and board-approved capital remediation plans to CBK.',
    'ENTERPRISE', true, 35, NOW(), NOW()),

  (gen_random_uuid()::text, 'cma-sandbox',
    'CMA Regulatory Sandbox Framework',
    'Innovation & Digital Assets',
    'CMA''s innovation sandbox programme enabling fintech firms to test novel capital markets products under controlled conditions with time-limited (12-24 month) authorizations, relaxed licence conditions, enhanced supervisory engagement, defined client and exposure caps, and a structured exit pathway to full CMA licensing.',
    'ENTERPRISE', true, 36, NOW(), NOW()),

  (gen_random_uuid()::text, 'cma-digital-assets',
    'CMA Digital Assets Guidelines',
    'Innovation & Digital Assets',
    'CMA''s emerging regulatory framework for digital assets covering token classification (security vs. utility vs. payment token), prospectus and disclosure requirements for public token sales, digital asset exchange and custody licensing, mandatory AML/CFT integration for VASP activities, and retail investor protection standards.',
    'ENTERPRISE', true, 37, NOW(), NOW()),

  (gen_random_uuid()::text, 'fatf-recommendations',
    'FATF 40 Recommendations',
    'AML/CFT',
    'The Financial Action Task Force''s international AML/CFT/CPF standard covering the risk-based approach, beneficial ownership transparency, FIU powers and information sharing, international mutual legal assistance, VASP and fintech guidance (Recommendation 15), and Kenya''s mutual evaluation performance obligations under the ESAAMLG regime.',
    'ENTERPRISE', true, 38, NOW(), NOW()),

  (gen_random_uuid()::text, 'basel-iii',
    'Basel III Capital and Liquidity Framework',
    'Banking Supervision',
    'BIS Basel Committee''s post-2008 capital standard covering CET1 minimum of 4.5%, Additional Tier 1, Tier 2 capital, capital conservation buffer (2.5%), leverage ratio floor (3%), Liquidity Coverage Ratio (LCR ≥100%), and Net Stable Funding Ratio (NSFR ≥100%) — implemented in Kenya through CBK Capital Adequacy and Liquidity Risk Management Guidelines.',
    'ENTERPRISE', true, 39, NOW(), NOW()),

  (gen_random_uuid()::text, 'iso-27001',
    'ISO/IEC 27001 — Information Security Management',
    'International Standards',
    'International standard for establishing, implementing, maintaining, and improving an ISMS, covering risk assessment methodology, Annex A control selection (93 controls), Statement of Applicability, and third-party certification by an accredited body. Required by CBK as evidence of cybersecurity maturity and by enterprise B2B clients in vendor due diligence.',
    'ENTERPRISE', true, 40, NOW(), NOW()),

  (gen_random_uuid()::text, 'pci-dss',
    'PCI-DSS — Payment Card Industry Data Security Standard',
    'International Standards',
    'PCI Security Standards Council data security standard (v4.0) for organizations that process, store, or transmit payment card data — mandatory for Visa/Mastercard/Amex network participation. Covers 12 control domains including network segmentation, cardholder data encryption, access control, vulnerability management, penetration testing, and annual QSA assessment.',
    'ENTERPRISE', true, 41, NOW(), NOW()),

  (gen_random_uuid()::text, 'gdpr',
    'EU General Data Protection Regulation',
    'Data Protection',
    'EU data protection regulation with extraterritorial effect applicable to Kenyan fintechs processing EU residents'' personal data — establishing lawful basis requirements, data subject rights, DPO designation obligations, cross-border transfer mechanisms (Standard Contractual Clauses), mandatory 72-hour breach notification, and fines up to 4% of global annual turnover.',
    'ENTERPRISE', true, 42, NOW(), NOW()),

  (gen_random_uuid()::text, 'swift-csp',
    'SWIFT Customer Security Programme',
    'International Standards',
    'SWIFT''s mandatory cybersecurity assurance framework for all SWIFT-connected institutions requiring annual attestation against 32 mandatory and 11 advisory controls — covering logical access, malware detection, credential management, anomaly detection on SWIFT interfaces, and secure configuration of operator workstations.',
    'ENTERPRISE', true, 43, NOW(), NOW()),

  (gen_random_uuid()::text, 'soc2-type-ii',
    'SOC 2 Type II — Service Organization Controls',
    'International Standards',
    'AICPA trust service criteria framework (Security, Availability, Processing Integrity, Confidentiality, Privacy) with Type II reports covering operating effectiveness over a 6-12 month audit period — required by Kenyan commercial banks, regulated institutions, and enterprise B2B clients as a baseline fintech vendor assurance requirement in procurement.',
    'ENTERPRISE', true, 44, NOW(), NOW())

ON CONFLICT (slug) DO UPDATE SET
  "name"        = EXCLUDED."name",
  category      = EXCLUDED.category,
  description   = EXCLUDED.description,
  tier          = EXCLUDED.tier,
  "isActive"    = EXCLUDED."isActive",
  "sortOrder"   = EXCLUDED."sortOrder",
  "updatedAt"   = NOW();
