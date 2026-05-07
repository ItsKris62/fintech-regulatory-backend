import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const frameworks = [
  // ─── STARTUP Tier ─────────────────────────────────────────────────────────
  // Core foundational obligations every Kenya fintech must address from day one.
  {
    slug: 'dpa-2019',
    name: 'Data Protection Act 2019',
    category: 'Data Protection',
    description:
      "Kenya's primary data protection law establishing obligations for data controllers and processors, including lawful basis for processing, data subject rights (access, rectification, erasure, portability), cross-border transfer restrictions, and mandatory breach notification to the ODPC.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 1,
  },
  {
    slug: 'odpc-regs-2021',
    name: 'ODPC Data Protection Regulations 2021',
    category: 'Data Protection',
    description:
      'Secondary regulations under the DPA 2019 detailing registration requirements for data controllers and processors, data protection impact assessment (DPIA) obligations, enforcement procedures, exemptions, and the complaints resolution framework administered by the Office of the Data Protection Commissioner.',
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 2,
  },
  {
    slug: 'cbk-prudential',
    name: 'CBK Prudential Guidelines',
    category: 'Banking Supervision',
    description:
      "Central Bank of Kenya's comprehensive prudential framework governing capital adequacy, liquidity management, asset quality classification, loan provisioning, risk governance, large exposure limits, related-party transaction controls, and internal audit requirements for licensed financial institutions.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 3,
  },
  {
    slug: 'nps-2011',
    name: 'National Payment System Act 2011',
    category: 'Payments',
    description:
      "Foundational legislation governing the designation, oversight, and regulation of payment systems and services in Kenya, establishing CBK's mandate to license payment service providers, set interoperability standards, designate systemically important payment systems, and protect payment system integrity.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 4,
  },
  {
    slug: 'nps-regs-2014',
    name: 'National Payment System Regulations 2014',
    category: 'Payments',
    description:
      'Detailed implementing regulations under the NPS Act covering licensing categories (payment service providers, payment system operators), minimum capital requirements by tier, trust account and float management obligations, consumer protection standards, dispute resolution timelines, and interoperability requirements.',
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 5,
  },
  {
    slug: 'pocamla',
    name: 'Proceeds of Crime and Anti-Money Laundering Act',
    category: 'AML/CFT',
    description:
      "Kenya's primary AML/CFT legislation establishing mandatory customer due diligence (CDD), enhanced due diligence (EDD) for high-risk relationships, transaction monitoring obligations, suspicious transaction reporting (STR) and cash transaction reporting (CTR) to the Financial Reporting Centre, and minimum five-year record-keeping requirements.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 6,
  },
  {
    slug: 'pocamla-regs-2013',
    name: 'POCAMLA Regulations 2013',
    category: 'AML/CFT',
    description:
      'Secondary regulations implementing POCAMLA, specifying CDD thresholds (KES 1M cash), politically exposed persons (PEP) identification and enhanced monitoring procedures, correspondent banking due diligence standards, wire transfer information requirements, and prescribed FRC reporting formats for STRs and CTRs.',
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 7,
  },
  {
    slug: 'cbk-kyc',
    name: 'CBK Know Your Customer Requirements',
    category: 'AML/CFT',
    description:
      'CBK guidelines establishing minimum KYC standards for customer identification and verification across all delivery channels, tiered account risk classification (simplified/standard/enhanced due diligence), beneficial ownership verification requirements for legal persons and arrangements, and ongoing monitoring and periodic review obligations.',
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 8,
  },
  {
    slug: 'cbk-cyber',
    name: 'CBK Cybersecurity Guidance Note',
    category: 'Cybersecurity',
    description:
      "CBK's cybersecurity framework for regulated institutions covering board-level governance and accountability, technical controls (encryption standards, access management, patch management, network segmentation), threat intelligence sharing obligations, cyber incident response and mandatory CBK reporting timelines, third-party risk management, and annual cybersecurity self-assessment requirements.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 9,
  },
  {
    slug: 'computer-misuse-2018',
    name: 'Computer Misuse and Cybercrimes Act 2018',
    category: 'Cybersecurity',
    description:
      "Kenya's cybercrime legislation establishing criminal offences for unauthorized computer access, data interference, false publications, phishing, identity theft, and cyber fraud — creating direct criminal liability for security control failures and imposing incident disclosure obligations relevant to fintech security governance.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 10,
  },
  {
    slug: 'companies-act-2015',
    name: 'Companies Act 2015',
    category: 'Corporate Governance',
    description:
      "Kenya's primary corporate law governing company incorporation, directorship duties and personal liabilities, shareholder rights, beneficial ownership register requirements, financial reporting obligations, annual returns filing with the Registrar of Companies, and restructuring and winding-up procedures applicable to all fintech legal entities.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 11,
  },
  {
    slug: 'frc-guidelines',
    name: 'Financial Reporting Centre AML Guidelines',
    category: 'AML/CFT',
    description:
      "FRC's operational guidelines for reporting institutions covering the mechanics of suspicious transaction reporting (STR), cash transaction reporting (CTR) with applicable thresholds, currency transaction report requirements, AML/CFT compliance programme design expectations, FRC examination methodology, and obligations of Money Remittance Providers and digital credit providers.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 12,
  },
  {
    slug: 'consumer-protection-act-2012',
    name: 'Consumer Protection Act 2012',
    category: 'Consumer Protection',
    description:
      "Kenya's consumer rights legislation establishing fair trading practices, prohibition of unfair and unconscionable contract terms, right to refunds and returns, product liability standards, distance selling obligations relevant to app-based services, and consumer redress mechanisms applicable to all fintech consumer-facing products.",
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 13,
  },

  // ─── BUSINESS Tier ────────────────────────────────────────────────────────
  // Sector-specific and growth-stage obligations as product lines expand.
  {
    slug: 'dcpr-2022',
    name: 'Digital Credit Providers Regulations 2022',
    category: 'Digital Credit',
    description:
      'CBK regulations requiring all digital credit providers to obtain a DCP licence, mandating transparent pricing disclosures (APR, total cost of credit), prohibiting unethical debt collection practices including unauthorized access to borrower phone contacts, requiring mandatory credit bureau reporting, and establishing 5-business-day consumer grievance resolution timelines.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 14,
  },
  {
    slug: 'consumer-protection',
    name: 'CBK Consumer Protection Guidelines',
    category: 'Consumer Protection',
    description:
      "CBK's conduct-of-business framework for all regulated financial institutions covering plain-language fee schedules and product disclosure standards, complaint handling timelines (72-hour acknowledgement, 30-day resolution), vulnerable customer identification and protection policies, mis-selling prohibitions, and annual consumer protection compliance audit requirements.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 15,
  },
  {
    slug: 'mobile-money-guidelines',
    name: 'CBK Mobile Money Transfer Services Guidelines',
    category: 'Mobile Money',
    description:
      "CBK's regulatory framework for mobile money transfer services covering licence tiers and requirements, mandatory 100% float backing held in commercial bank trust accounts, per-transaction and daily wallet limits by tier, agent network governance and vetting standards, interoperability obligations between providers, dormant account management, and e-money safeguarding requirements.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 16,
  },
  {
    slug: 'agent-banking-guidelines',
    name: 'CBK Agent Banking Guidelines',
    category: 'Payments',
    description:
      'CBK framework governing bank agent networks covering agent vetting, training, and certification standards, permissible and excluded agent activities, mandatory real-time host connectivity requirements, liability allocation between principal bank and agent, required consumer disclosures at agent premises, exclusivity restrictions, and agent performance monitoring frameworks.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 17,
  },
  {
    slug: 'credit-reference-regs-2013',
    name: 'Credit Reference Bureau Regulations 2013',
    category: 'Credit & Lending',
    description:
      'Regulations governing CRB licensing, mandatory credit information sharing obligations for all regulated lenders (including digital credit providers post-DCPR 2022), data accuracy and correction obligations, consumer dispute resolution procedures and timelines, free annual credit report entitlement, and blacklisting/delisting standards including the consent requirement for negative listing.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 18,
  },
  {
    slug: 'cma-act',
    name: 'Capital Markets Authority Act',
    category: 'Capital Markets',
    description:
      "Primary legislation governing Kenya's capital markets administered by CMA, establishing licensing requirements for securities exchanges, central depositories, fund managers, investment advisors, stockbrokers, investment banks, and collective investment schemes. Relevant to fintechs offering wealth management, robo-advisory, or retail investment distribution products.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 19,
  },
  {
    slug: 'cma-cis-regs',
    name: 'CMA Collective Investment Schemes Regulations 2001',
    category: 'Capital Markets',
    description:
      'CMA regulations governing the licensing, constitution, investment restrictions, pricing, distribution, and disclosure requirements for unit trusts, money market funds, and other collective investment schemes in Kenya — relevant to fintech platforms distributing, wrapping, or managing retail investment or savings products.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 20,
  },
  {
    slug: 'insurance-act',
    name: 'Insurance Act Cap 487',
    category: 'Insurance',
    description:
      "Primary legislation governing Kenya's insurance industry under IRA supervision, covering licensing classes (life, general, composite, reinsurance), minimum paid-up capital requirements, actuarial valuation obligations, policyholder protection and solvency margin requirements, premium payment timelines, and reinsurance treaty obligations relevant to embedded insurance and insurtech models.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 21,
  },
  {
    slug: 'ira-digital-guidelines',
    name: 'IRA Digital Insurance Guidelines',
    category: 'Insurance',
    description:
      'IRA guidance for digital insurance products and insurtech business models covering product approval requirements for digital channels, digital distribution standards, premium collection via mobile money, electronic policy document standards, claims settlement timelines, identity verification via NIIMS/Huduma Namba, and regulatory treatment of index-based and microinsurance products.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 22,
  },
  {
    slug: 'kica',
    name: 'Kenya Information and Communications Act',
    category: 'Telecommunications',
    description:
      "ICT sector legislation establishing CA's regulatory mandate over telecommunications providers, internet service providers, and electronic communications — relevant to fintech USSD service providers, SMS OTP channels, digital service delivery quality-of-service obligations, type approval requirements for devices, and cross-border data roaming considerations for international services.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 23,
  },
  {
    slug: 'microfinance-2006',
    name: 'Microfinance Act 2006',
    category: 'Microfinance & SACCO',
    description:
      'Legislation establishing the regulatory framework for deposit-taking microfinance institutions (DTMs) under CBK supervision, covering licensing requirements, minimum core capital (KES 60M), liquidity ratio requirements, loan classification and provisioning standards, single-obligor limits, and branching and merger requirements for regulated MFIs.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 24,
  },
  {
    slug: 'sacco-act-2008',
    name: 'SACCO Societies Act 2008',
    category: 'Microfinance & SACCO',
    description:
      'Legislation establishing the SASRA regulatory framework for deposit-taking SACCOs (DTS), covering registration and licensing requirements, minimum institutional capital, prudential ratios (core capital ≥8% of total assets, liquidity ≥15%), non-performing loan limits, governance and board composition standards, and external audit and SASRA reporting obligations.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 25,
  },
  {
    slug: 'movable-property-2017',
    name: 'Movable Property Security Rights Act 2017',
    category: 'Credit & Lending',
    description:
      "Legislation establishing Kenya's unified notice-based framework for creating, perfecting (via the Kenya Collateral Registry), and enforcing security interests in movable property — including inventory, receivables, equipment, livestock, and intellectual property — enabling asset-backed lending and invoice/supply-chain financing by alternative lenders.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 26,
  },
  {
    slug: 'competition-act-2010',
    name: 'Competition Act 2010',
    category: 'Corporate Governance',
    description:
      "Competition Authority of Kenya's enabling legislation prohibiting anti-competitive agreements, abuse of dominant market position (market share >50%), and restrictive trade practices — relevant to fintech platform pricing strategies, data-sharing agreements, exclusivity arrangements with payment networks, and merger notification thresholds (KES 1B combined turnover).",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 27,
  },
  {
    slug: 'tax-procedures-2015',
    name: 'Tax Procedures Act 2015',
    category: 'Tax & Compliance',
    description:
      "KRA's unified tax procedures law governing PIN registration obligations, electronic filing timelines, eTIMS electronic invoicing for all B2B transactions, withholding tax obligations (on commissions, interest, dividends, management fees), transfer pricing documentation requirements for related-party transactions, penalty and interest computation, and KRA audit access rights applicable to all fintech revenue streams.",
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 28,
  },
  {
    slug: 'cbk-fraud-risk',
    name: 'CBK Fraud Risk Management Guidelines',
    category: 'Operational Risk',
    description:
      'CBK guidance on fraud prevention and detection covering multi-factor authentication standards for digital channels, real-time transaction monitoring system requirements and calibration, mandatory fraud incident reporting timelines to CBK (within 24 hours of confirmed fraud), customer notification obligations, post-incident root cause analysis requirements, and annual fraud loss reporting.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 29,
  },
  {
    slug: 'cbk-bancassurance',
    name: 'CBK Bancassurance Guidelines',
    category: 'Insurance',
    description:
      'CBK guidelines governing bancassurance business models where licensed banks and financial institutions act as corporate insurance agents — covering joint CBK/IRA approval requirements, staff training and certification, premium remittance timelines to underwriters, conflict of interest management, sales suitability and disclosure standards, and segregation of banking and insurance activities.',
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 30,
  },

  // ─── ENTERPRISE Tier ──────────────────────────────────────────────────────
  // Advanced banking supervision, international standards, and complex product obligations.
  {
    slug: 'cbk-capital-adequacy',
    name: 'CBK Capital Adequacy Guidelines',
    category: 'Banking Supervision',
    description:
      "CBK's Basel III-aligned capital adequacy framework covering Tier 1 (core) and Tier 2 (supplementary) capital definitions and deductions, credit/market/operational risk-weighted asset computation methodologies, minimum total capital adequacy ratio of 14.5% (above Basel III floor), capital conservation buffer, counter-cyclical buffer, and Internal Capital Adequacy Assessment Process (ICAAP) requirements.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 31,
  },
  {
    slug: 'cbk-liquidity-risk',
    name: 'CBK Liquidity Risk Management Guidelines',
    category: 'Banking Supervision',
    description:
      "CBK framework for liquidity risk governance covering board-approved liquidity risk appetite, minimum statutory liquidity ratio (20% of short-term liabilities), liquidity coverage ratio (LCR) computation and minimum thresholds, net stable funding ratio (NSFR) expectations, intraday liquidity monitoring, maturity mismatch limits, and Contingency Funding Plan (CFP) requirements for commercial banks.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 32,
  },
  {
    slug: 'cbk-operational-risk',
    name: 'CBK Operational Risk Management Guidelines',
    category: 'Operational Risk',
    description:
      'CBK guidelines for identifying, measuring, monitoring, and controlling operational risks — covering IT system failure, human error, process failures, internal and external fraud, legal and compliance risk, and third-party/vendor risk — with requirements for key risk indicator (KRI) dashboards, operational loss event databases, and board-level operational risk appetite statements.',
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 33,
  },
  {
    slug: 'cbk-outsourcing',
    name: 'CBK Outsourcing Guidelines',
    category: 'Operational Risk',
    description:
      'CBK requirements for regulated institutions engaging material third-party service providers, covering prior CBK notification for material outsourcing, supplier due diligence standards (financial strength, operational resilience, regulatory standing), minimum contractual protections (audit rights, data residency, SLAs, step-in rights), subcontracting restrictions, ongoing performance monitoring, and documented exit and transition planning.',
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 34,
  },
  {
    slug: 'cbk-stress-testing',
    name: 'CBK Stress Testing Guidelines',
    category: 'Banking Supervision',
    description:
      'CBK requirements for regulated institutions to design and execute regular stress tests and scenario analyses covering credit risk (sector concentration shocks, borrower default cascades), market risk (interest rate and FX shocks), and liquidity risk (deposit run-off scenarios), with mandatory submission of results, management actions, and board-approved capital remediation plans to CBK.',
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 35,
  },
  {
    slug: 'cma-sandbox',
    name: 'CMA Regulatory Sandbox Framework',
    category: 'Innovation & Digital Assets',
    description:
      "CMA's innovation sandbox programme enabling fintech firms to test novel capital markets products, services, and business models under a controlled regulatory environment with time-limited (12-24 month) authorizations, relaxed or modified licence conditions, enhanced supervisory engagement, defined client and exposure caps, and a structured exit pathway to full CMA licensing or product withdrawal.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 36,
  },
  {
    slug: 'cma-digital-assets',
    name: 'CMA Digital Assets Guidelines',
    category: 'Innovation & Digital Assets',
    description:
      "CMA's emerging regulatory framework for digital asset offerings in Kenya covering token classification (security vs. utility vs. payment token), prospectus and information memorandum disclosure requirements for public token sales, digital asset exchange and custody licensing requirements, mandatory AML/CFT integration for VASP activities, and retail investor protection standards.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 37,
  },
  {
    slug: 'fatf-recommendations',
    name: 'FATF 40 Recommendations',
    category: 'AML/CFT',
    description:
      "The Financial Action Task Force's international AML/CFT/CPF standard framework adopted by Kenya, covering the risk-based approach to compliance programme design, beneficial ownership transparency requirements, financial intelligence unit powers and information sharing, international mutual legal assistance obligations, VASP and fintech-specific guidance (Recommendation 15), and Kenya's mutual evaluation performance obligations under the ESAAMLG regime.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 38,
  },
  {
    slug: 'basel-iii',
    name: 'Basel III Capital and Liquidity Framework',
    category: 'Banking Supervision',
    description:
      "BIS Basel Committee's post-2008 international capital adequacy standard covering Common Equity Tier 1 (CET1) minimum of 4.5%, Additional Tier 1 instruments, Tier 2 capital, the capital conservation buffer (2.5%), leverage ratio floor (3%), Liquidity Coverage Ratio (LCR ≥100%), and Net Stable Funding Ratio (NSFR ≥100%) — implemented in Kenya through CBK Capital Adequacy and Liquidity Risk Management Guidelines.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 39,
  },
  {
    slug: 'iso-27001',
    name: 'ISO/IEC 27001 — Information Security Management',
    category: 'International Standards',
    description:
      'International standard for establishing, implementing, maintaining, and continuously improving an Information Security Management System (ISMS), covering risk assessment methodology, security control selection from Annex A (93 controls), Statement of Applicability, and third-party certification by an accredited body. Increasingly required by CBK as evidence of cybersecurity control maturity and by enterprise B2B clients in vendor due diligence.',
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 40,
  },
  {
    slug: 'pci-dss',
    name: 'PCI-DSS — Payment Card Industry Data Security Standard',
    category: 'International Standards',
    description:
      "PCI Security Standards Council's data security standard (v4.0 as of 2024) for organizations that process, store, or transmit payment card data — mandatory for Visa/Mastercard/Amex network participation. Covers 12 control domains including network segmentation, cardholder data encryption, access control, vulnerability management, penetration testing, and annual QSA assessment or SAQ self-attestation.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 41,
  },
  {
    slug: 'gdpr',
    name: 'EU General Data Protection Regulation',
    category: 'Data Protection',
    description:
      "EU data protection regulation with extraterritorial effect (Article 3) applicable to Kenyan fintechs processing personal data of EU residents — establishing lawful basis requirements, data subject rights, Data Protection Officer designation obligations, cross-border transfer mechanisms (Standard Contractual Clauses, adequacy decisions), mandatory 72-hour supervisory authority breach notification, and fines up to 4% of global annual turnover.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 42,
  },
  {
    slug: 'swift-csp',
    name: 'SWIFT Customer Security Programme',
    category: 'International Standards',
    description:
      "SWIFT's mandatory cybersecurity assurance framework for all institutions connected to the SWIFT network, requiring annual self-attestation (or independent assessment from 2021 for Mandatory controls) against 32 mandatory and 11 advisory security controls — covering logical access controls, malware detection, credential management, anomaly detection on SWIFT interfaces, and secure configuration of operator workstations.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 43,
  },
  {
    slug: 'soc2-type-ii',
    name: 'SOC 2 Type II — Service Organization Controls',
    category: 'International Standards',
    description:
      "AICPA's trust service criteria framework (Security, Availability, Processing Integrity, Confidentiality, Privacy) with Type II reports covering the design and operating effectiveness of internal controls over a 6-12 month audit period — increasingly required by Kenyan commercial banks, regulated institutions, and enterprise B2B clients as a baseline fintech vendor assurance requirement in procurement.",
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 44,
  },
];

async function main() {
  console.log('Starting RegulatoryFramework seed — upsert mode (idempotent).\n');

  let upsertedCount = 0;
  let errorCount = 0;

  for (const framework of frameworks) {
    try {
      await prisma.regulatoryFramework.upsert({
        where: { slug: framework.slug },
        update: {
          name: framework.name,
          category: framework.category,
          description: framework.description,
          tier: framework.tier,
          isActive: framework.isActive,
          sortOrder: framework.sortOrder,
        },
        create: framework,
      });
      console.log(`  [${framework.tier.padEnd(10)}] ${framework.name}`);
      upsertedCount++;
    } catch (error) {
      console.error(`  FAILED: ${framework.name}`, error);
      errorCount++;
    }
  }

  console.log(`\nDone. ${upsertedCount} upserted, ${errorCount} errors.\n`);

  const finalCount = await prisma.regulatoryFramework.count();
  console.log(`Total frameworks in database: ${finalCount}`);

  const byTier = await prisma.regulatoryFramework.groupBy({
    by: ['tier'],
    _count: { _all: true },
    where: { isActive: true },
    orderBy: { tier: 'asc' },
  });

  console.log('\nBreakdown by tier:');
  byTier.forEach(({ tier, _count }) => {
    console.log(`  ${tier.padEnd(12)} ${_count._all}`);
  });
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
