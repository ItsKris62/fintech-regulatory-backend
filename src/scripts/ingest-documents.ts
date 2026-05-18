/**
 * Regulatory Document Ingestion Script
 *
 * Reads documents from the `documents/` folder at the project root and ingests
 * them into the RAG system (Pinecone + PostgreSQL).
 *
 * Usage:
 *   pnpm ingest
 *
 * Workflow:
 *   1. Place documents in documents/kenya/ or documents/international/
 *   2. Set the correct `fileName` in DOCUMENT_REGISTRY below
 *   3. Run `pnpm ingest`
 *
 * Documents are processed sequentially (not in parallel) to avoid rate-limiting
 * on embedding APIs. Already-indexed documents (same SHA-256 checksum) are
 * automatically skipped.
 */

import fs from 'fs';
import path from 'path';

import { prisma } from '@/lib/prisma/client';
import {
  documentIngestionService,
  type DocumentIngestionInput,
} from '@/lib/ingestion/document-processor';
import { logger } from '@/utils/logger';

/**
 * Local string-union matching the `RegulatoryDocumentCategory` Prisma enum.
 * After running `pnpm prisma generate` the generated type will be compatible  - 
 * this definition is only here to avoid importing from `@prisma/client` before
 * the first migration runs.
 */
type DocumentCategory =
  | 'DATA_PROTECTION'
  | 'CYBERSECURITY'
  | 'FINTECH_REGULATION'
  | 'AML_CFT'
  | 'PAYMENT_SYSTEMS'
  | 'INTERNATIONAL_STANDARD';

// ============================================================================
// Document Registry
// ============================================================================

interface RegistryEntry extends Omit<DocumentIngestionInput, 'filePath' | 'category'> {
  /**
   * Path relative to the `documents/` folder at the project root.
   * Example: 'kenya/data-protection-act-2019.pdf'
   */
  fileName: string;
  /**
   * Uses a local string union that matches the `RegulatoryDocumentCategory`
   * Prisma enum. After `prisma generate` the types align automatically.
   */
  category: DocumentCategory;
}

const DOCUMENT_REGISTRY: RegistryEntry[] = [
  // -- Kenya: Data Protection & Privacy -------------------------------------

  {
    // ✅ File present
    fileName: 'kenya/TheDataProtectionAct__No24of2019.pdf',
    title: 'Kenya Data Protection Act, 2019 (No. 24 of 2019)',
    source: 'Parliament of Kenya',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2019-11-08'),
    version: '2019',
  },
  {
    // ✅ File present
    fileName: 'kenya/THE-DATA-PROTECTION-REGISTRATION-OF-DATA-CONTROLLERS-AND-DATA-PROCESSORS-REGULATIONS-2021.pdf',
    title: 'Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2021-11-16'),
    version: '2021',
  },
  {
    // ✅ File present
    fileName: 'kenya/24-06-2024-The-Data-Protection-Compliance-audit-Regulations-2024_.pdf',
    title: 'Data Protection (Compliance Audit) Regulations, 2024',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2024-06-24'),
    version: '2024',
  },
  {
    // ✅ File present
    fileName: 'kenya/ODPC-Guidance-Note-on-Registration-of-Data-Controllers-and-Data-Processors.pdf',
    title: 'ODPC Guidance Note on Registration of Data Controllers and Data Processors',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/ODPC-Guidance-Note-for-Digital-Credit-Providers.pdf',
    title: 'ODPC Guidance Note for Digital Credit Providers',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/ODPC-Guidance-Note-on-Data-Protection-Impact-Assessment-1.pdf',
    title: 'ODPC Guidance Note on Data Protection Impact Assessment (DPIA)',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/ODPC-\u2013-Guidance-Note-on-Processing-by-MSMEs.pdf',
    title: 'ODPC Guidance Note on Data Processing by MSMEs',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },

  // -- Kenya: Cybersecurity & ICT --------------------------------------------

  {
    // ✅ File present
    fileName: 'kenya/KenyaInformationandCommunicationsAct(No2of1998).pdf',
    title: 'Kenya Information and Communications Act (No. 2 of 1998)',
    source: 'Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('1998-01-01'),
    version: '1998',
  },
  {
    // ✅ File present
    fileName: 'kenya/Guidelines-for-Network-RedundancyResilience-and-Diversity-for-ICT-Networks-in-Kenya-1.pdf',
    title: 'Guidelines for Network Redundancy, Resilience and Diversity for ICT Networks in Kenya',
    source: 'Communications Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/Guidelines-for-Undertaking-ICT-Infrastructure-Works.pdf',
    title: 'Guidelines for Undertaking ICT Infrastructure Works',
    source: 'Communications Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/Environmental and Social Impact Assessment Guidelines for ICT Projects 2025.pdf',
    title: 'Environmental and Social Impact Assessment Guidelines for ICT Projects, 2025',
    source: 'Communications Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
    effectiveDate: new Date('2025-01-01'),
    version: '2025',
  },
  {
    // ✅ File present
    fileName: 'kenya/Framework for CO2 Reduction in the ICT Sector 2025.pdf',
    title: 'Framework for CO2 Reduction in the ICT Sector, 2025',
    source: 'Communications Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'framework',
    effectiveDate: new Date('2025-01-01'),
    version: '2025',
  },

  // -- Kenya: Payment Systems ------------------------------------------------

  {
    // ✅ File present
    fileName: 'kenya/GuidelinesonCybersecurityforPSPs.pdf',
    title: 'Guidelines on Cybersecurity for Payment Service Providers',
    source: 'Central Bank of Kenya',
    category: 'PAYMENT_SYSTEMS' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/National Payment System Act.pdf',
    title: 'National Payment Systems Act',
    source: 'Parliament of Kenya',
    category: 'PAYMENT_SYSTEMS' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    version: '2011',
  },

  // -- Kenya: Fintech & Banking Regulation -----------------------------------

  {
    // ✅ File present
    fileName: 'kenya/Banking Act.pdf',
    title: 'Banking Act (Cap. 488)',
    source: 'Parliament of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
  },
  {
    fileName: 'kenya/Draft-Virtual-Asset-Service-Providers-Regulations-2026.pdf',
    title: 'Draft Virtual Asset Service Providers Regulations, 2026',
    source: 'National Treasury and Economic Planning',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2026-01-01'),
    version: '2026 (Draft)',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },
  {
    fileName: 'kenya/Draft Consumer Protection Framework - March 2026.pdf',
    title: 'Financial Consumer Protection Framework for Kenya (Draft), March 2026',
    source: 'Kenya Financial Sector Regulators',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'framework',
    effectiveDate: new Date('2026-03-01'),
    version: 'March 2026 (Draft)',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },
  {
    // ✅ File present
    fileName: 'kenya/PRUDENTIAL-GUIDELINES.pdf',
    title: 'CBK Prudential Guidelines for Institutions Licensed under the Banking Act',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present
    fileName: 'kenya/L-.N.-No.-46-Central-Bank-of-Kenya-Digital-Credit-Providers-Regulations-2022.pdf',
    title: 'Central Bank of Kenya (Digital Credit Providers) Regulations, 2022 (L.N. No. 46)',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2022-03-18'),
    version: '2022',
  },
  {
    fileName: 'kenya/Draft-CBK-Non-Deposit-Taking-Credit-Providers-Regulations.pdf',
    title: 'Draft CBK Non-Deposit Taking Credit Providers Regulations',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    version: 'Draft',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },
  {
    // ✅ File present
    fileName: 'kenya/Draft-Regulatory-Sandbox-Policy-Guidance-Note-2018.pdf',
    title: 'CBK Draft Regulatory Sandbox Policy Guidance Note, 2018',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
    effectiveDate: new Date('2018-01-01'),
    version: '2018',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },
  {
    // ✅ File present
    fileName: 'kenya/Finance Act 2023.pdf',
    title: 'Finance Act, 2023',
    source: 'Parliament of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2023-06-26'),
    version: '2023',
  },
  {
    // ✅ File present
    fileName: 'kenya/Draft-Banking-Penalties-Regulations-2024.pdf',
    title: 'Draft Banking (Penalties) Regulations, 2024',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2024-01-01'),
    version: '2024 (Draft)',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },
  {
    // ✅ File present
    fileName: 'kenya/Kenya-National-Financial-Inclusion-Strategy-2025-2028.pdf',
    title: 'Kenya National Financial Inclusion Strategy 2025-2028',
    source: 'National Treasury of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'framework',
    effectiveDate: new Date('2025-01-01'),
    version: '2025-2028',
  },
  {
    // ✅ File present
    fileName: 'kenya/Insurance (Bancassurance) Regulations 2020.pdf',
    title: 'Insurance (Bancassurance) Regulations, 2020',
    source: 'Insurance Regulatory Authority',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2020-01-01'),
    version: '2020',
  },
  {
    // ✅ File present
    fileName: 'kenya/The Capital Markets (InvestmentBased Crowdfunding) Regulations.pdf',
    title: 'Capital Markets (Investment-Based Crowdfunding) Regulations',
    source: 'Capital Markets Authority',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
  },
  {
    // ✅ File present
    fileName: 'kenya/Virtual Asset Service Providers Act.pdf',
    title: 'Virtual Asset Service Providers Act',
    source: 'Parliament of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
  },

  // -- Kenya: Tax & Digital Commerce -----------------------------------------

  {
    // ✅ File present
    fileName: 'kenya/The Value Added Tax (Electronic Internet and Digital Marketplace Supply) Regulations 2023.pdf',
    title: 'Value Added Tax (Electronic, Internet and Digital Marketplace Supply) Regulations, 2023',
    source: 'Kenya Revenue Authority',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2023-01-01'),
    version: '2023',
  },
  {
    // ✅ File present
    fileName: 'kenya/The Tax Procedures (Electronic Tax Invoice) Regulations.pdf',
    title: 'Tax Procedures (Electronic Tax Invoice) Regulations',
    source: 'Kenya Revenue Authority',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
  },

  {
    fileName: 'kenya/Finance-Bill-2026.pdf',
    title: 'Finance Bill, 2026',
    source: 'Parliament of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'bill',
    effectiveDate: new Date('2026-01-01'),
    version: '2026 (Bill)',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },
  {
    fileName: 'kenya/Draft-Green-Fiscal-Incentives-Policy-Framework.pdf',
    title: 'Draft National Green Fiscal Incentives Policy Framework',
    source: 'National Treasury and Economic Planning',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'framework',
    effectiveDate: new Date('2022-12-01'),
    version: 'December 2022 (Draft)',
    authorityStatus: 'DRAFT',
    isBinding: false,
  },

  // -- Kenya: Cybersecurity (Additional) ------------------------------------

  {
    // ✅ File present
    fileName: 'kenya/CYBER-SECURITY-GUIDELINES-FOR-PSP-AUGUST-2018.pdf',
    title: 'CBK Cyber Security Guidelines for Payment Service Providers, August 2018',
    source: 'Central Bank of Kenya',
    category: 'PAYMENT_SYSTEMS' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
    effectiveDate: new Date('2018-08-01'),
    version: '2018',
  },
  {
    // ✅ File present
    fileName: 'kenya/Computer Misuse and Cybercrimes (Amendment) Act, 2025.pdf',
    title: 'Computer Misuse and Cybercrimes (Amendment) Act, 2025',
    source: 'Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2025-01-01'),
    version: '2025',
  },
  {
    // ✅ File present (alternate filename  -  deduplicated by SHA-256 if identical)
    fileName: 'kenya/Computer-Misuse-and-Cybercrimes-Amendment-Act-2025.pdf',
    title: 'Computer Misuse and Cybercrimes (Amendment) Act, 2025 (alternate copy)',
    source: 'Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2025-01-01'),
    version: '2025',
  },
  {
    // ✅ File present
    fileName: 'kenya/NATIONAL-ICT-POLICY-2019.pdf',
    title: 'National ICT Policy, 2019',
    source: 'Ministry of ICT, Innovation and Youth Affairs',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'framework',
    effectiveDate: new Date('2019-01-01'),
    version: '2019',
  },
  {
    // ✅ File present
    fileName: 'kenya/The-Computer-Misuse-and-Cybercrime-Regulations-LN44_2024.pdf',
    title: 'Computer Misuse and Cybercrimes (General) Regulations, 2024 (L.N. No. 44)',
    source: 'ICT Cabinet Secretary / Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
    effectiveDate: new Date('2024-01-01'),
    version: '2024',
  },

  // -- Kenya: AML/CFT --------------------------------------------------------

  {
    // ✅ File present
    fileName: 'kenya/Proceeds-of-Crime-and-Anti-Money-Laundering-Act-No-9-of-2009-Revised-2022.pdf',
    title: 'Proceeds of Crime and Anti-Money Laundering Act (No. 9 of 2009, Revised 2022)',
    source: 'Parliament of Kenya',
    category: 'AML_CFT' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2009-06-01'),
    version: '2022 Revision',
  },
  {
    // ✅ File present
    fileName: 'kenya/POCAMLA-REGULATIONS.pdf',
    title: 'Proceeds of Crime and Anti-Money Laundering (POCAMLA) Regulations',
    source: 'Financial Reporting Centre',
    category: 'AML_CFT' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'regulation',
  },

  // -- International Standards -----------------------------------------------

  {
    // ✅ File present
    fileName: 'international/NIST.CSWP.29.pdf',
    title: 'NIST Cybersecurity Framework 2.0',
    source: 'NIST',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'framework',
    effectiveDate: new Date('2024-02-26'),
    version: '2.0',
  },
  {
    // ✅ File present
    fileName: 'international/NIST CSF 2.0 Implementation Examples.pdf',
    title: 'NIST Cybersecurity Framework 2.0  -  Implementation Examples',
    source: 'NIST',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'framework',
    effectiveDate: new Date('2024-02-26'),
    version: '2.0',
  },
  {
    // ✅ File present
    fileName: 'international/ISO_IEC-270012022-ed.3.pdf',
    title: 'ISO/IEC 27001:2022  -  Information Security Management Systems',
    source: 'ISO/IEC',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2022-10-25'),
    version: '2022 (3rd edition)',
  },
  {
    // ✅ File present
    fileName: 'international/ISO_IEC_27000_2018(en).pdf',
    title: 'ISO/IEC 27000:2018  -  Information Security Management Systems Overview and Vocabulary',
    source: 'ISO/IEC',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2018-02-01'),
    version: '2018 (5th edition)',
  },

  // -- International: Payment Card Industry ---------------------------------

  {
    // ✅ File present
    fileName: 'international/PCI-DSS-v4-0-SAQ-A.pdf',
    title: 'PCI DSS v4.0  -  Self-Assessment Questionnaire A (SAQ A)',
    source: 'PCI Security Standards Council',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2022-03-01'),
    version: 'v4.0',
  },
  {
    // ✅ File present
    fileName: 'international/General Data Protection Regulation.pdf',
    title: 'General Data Protection Regulation (GDPR)  -  Regulation (EU) 2016/679',
    source: 'European Union',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'EU',
    documentType: 'regulation',
    effectiveDate: new Date('2018-05-25'),
    version: '2016/679',
  },
  {
    // ✅ File present
    fileName: 'kenya/Computer Misuse and Cybercrimes Act 2018.pdf',
    title: 'Computer Misuse and Cybercrimes Act, 2018',
    source: 'Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2018-05-16'),
    version: '2018',
  },

  // -- Kenya: Cloud & Digital Infrastructure --------------------------------

  {
    // ✅ File present
    fileName: 'kenya/Kenya Cloud Policy - 2024.pdf',
    title: 'Kenya Cloud Policy, 2024',
    source: 'ICT Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'framework',
    effectiveDate: new Date('2024-01-01'),
    version: '2024',
  },

  {
    fileName: 'kenya/Kenya AI Strategy 2025 - 2030.pdf',
    title: 'Kenya Artificial Intelligence Strategy 2025-2030',
    source: 'Government of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'strategy',
    effectiveDate: new Date('2025-03-01'),
    version: '2025-2030',
    authorityStatus: 'IN_FORCE',
    isBinding: false,
  },

  // -- International: AI Governance -----------------------------------------

  {
    // ✅ File present
    fileName: 'international/Artificial Intelligence Act EU.pdf',
    title: 'Artificial Intelligence Act (EU AI Act)  -  Regulation (EU) 2024/1689',
    source: 'European Union',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'EU',
    documentType: 'regulation',
    effectiveDate: new Date('2024-08-01'),
    version: '2024/1689',
  },
  {
    // ✅ File present
    fileName: 'international/Artificial Intelligence Risk Management.pdf',
    title: 'NIST AI Risk Management Framework (AI RMF 1.0)',
    source: 'NIST',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'framework',
    effectiveDate: new Date('2023-01-26'),
    version: '1.0',
  },

  // -- International: Privacy & Data Management ------------------------------

  {
    // ✅ File present
    fileName: 'international/Privacy Information Management with ISO IEC 27701.pdf',
    title: 'ISO/IEC 27701:2019  -  Privacy Information Management System (PIMS)',
    source: 'ISO/IEC',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2019-08-06'),
    version: '2019',
  },

  // -- International: Security Assurance & Auditing --------------------------

  {
    // ✅ File present
    fileName: 'international/033144-1A-soc2-system-organization-controls-reporting-whitepaper-v6-secured.pdf',
    title: 'SOC 2  -  System and Organisation Controls Reporting (AICPA Whitepaper v6)',
    source: 'AICPA',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'framework',
    version: 'v6',
  },
  {
    // ✅ File present
    fileName: 'international/pcissc_overview.pdf',
    title: 'PCI Security Standards Council  -  Overview of Payment Security Standards',
    source: 'PCI Security Standards Council',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'framework',
  },
  {
    // ✅ File present
    fileName: 'international/Secure-Software-Program-Guide-v1.pdf',
    title: 'Secure Software Program Guide v1.0',
    source: 'PCI Security Standards Council',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'guideline',
    version: 'v1.0',
  },

  // -- International: Web Accessibility -------------------------------------

  {
    // ✅ File present
    fileName: 'international/Global-Web-Content-Accessibility-Guidelines-WCAG-2.1.pdf',
    title: 'Web Content Accessibility Guidelines (WCAG) 2.1',
    source: 'W3C',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2018-06-05'),
    version: '2.1',
  },
  {
    // ✅ File present
    fileName: 'international/wcag20-guidelines-20081211-a4.pdf',
    title: 'Web Content Accessibility Guidelines (WCAG) 2.0',
    source: 'W3C',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2008-12-11'),
    version: '2.0',
  },
];

// ============================================================================
// Path Helpers
// ============================================================================

const DOCS_ROOT = path.resolve(process.cwd(), 'documents');

function resolvePath(fileName: string): string {
  return path.join(DOCS_ROOT, fileName);
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let shuttingDown = false;

process.on('SIGINT', () => {
  console.log('\n⚠️  Interrupted  -  finishing current document, then stopping...');
  shuttingDown = true;
});

process.on('SIGTERM', () => {
  shuttingDown = true;
});

// ============================================================================
// Main Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('\n🚀 SheriaBot  -  Regulatory Document Ingestion Pipeline\n');
  console.log(`📁 Documents folder: ${DOCS_ROOT}`);
  console.log(`📋 Registry entries: ${DOCUMENT_REGISTRY.length}\n`);

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalChunks = 0;
  let totalVectors = 0;

  for (const entry of DOCUMENT_REGISTRY) {
    if (shuttingDown) {
      console.log('\n⚠️  Shutdown requested  -  stopping ingestion.');
      break;
    }

    const filePath = resolvePath(entry.fileName);

    // Skip files that haven't been placed in the documents/ folder yet
    if (!fs.existsSync(filePath)) {
      console.log(
        `⏭️  Skipping ${entry.title}  -  file not found: ${entry.fileName}`
      );
      totalSkipped++;
      continue;
    }

    console.log(`\n📄 Processing: ${entry.title}`);
    console.log(`   File:         ${entry.fileName}`);
    console.log(
      `   Source:       ${entry.source} | Category: ${entry.category} | Jurisdiction: ${entry.jurisdiction}`
    );

    const input: DocumentIngestionInput = {
      filePath,
      title: entry.title,
      source: entry.source,
      // Cast is safe  -  DocumentCategory values match RegulatoryDocumentCategory exactly
      category: entry.category as DocumentIngestionInput['category'],
      jurisdiction: entry.jurisdiction,
      documentType: entry.documentType,
      effectiveDate: entry.effectiveDate,
      version: entry.version,
      authorityStatus: entry.authorityStatus ?? 'IN_FORCE',
      isBinding: entry.isBinding ?? (entry.authorityStatus ?? 'IN_FORCE') === 'IN_FORCE',
      supersedesDocumentId: entry.supersedesDocumentId,
    };

    try {
      const result = await documentIngestionService.ingestDocument(input);

      if (result.skipped) {
        console.log(`⏭️  Skipped: ${result.reason}`);
        totalSkipped++;
      } else {
        console.log(`☁️  Uploaded to R2: ${result.storageKey}`);
        console.log(
          `🔪 Chunked: ${result.chunkCount} chunks (${result.totalCharacters.toLocaleString()} characters)`
        );
        console.log(`📌 Indexed: ${result.chunkCount} vectors in Pinecone`);
        console.log(`✅ Done: ${entry.title}`);

        totalProcessed++;
        totalChunks += result.chunkCount;
        totalVectors += result.chunkCount;
      }
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`❌ Failed: ${entry.title}`);
      console.error(`   Error: ${err.message}`);

      logger.error({
        type: 'script_ingestion_error',
        title: entry.title,
        fileName: entry.fileName,
        error: err.message,
        stack: err.stack,
      });

      totalFailed++;
    }
  }

  // -- Summary ----------------------------------------------------------------

  const divider = '═'.repeat(60);
  console.log(`\n${divider}`);
  console.log('📊 INGESTION SUMMARY');
  console.log(divider);
  console.log(`✅ Processed:  ${totalProcessed} document(s)`);
  console.log(`⏭️  Skipped:    ${totalSkipped} document(s)`);
  console.log(`❌ Failed:     ${totalFailed} document(s)`);
  console.log(`🔪 Chunks:     ${totalChunks.toLocaleString()} total`);
  console.log(`📌 Vectors:    ${totalVectors.toLocaleString()} indexed in Pinecone`);
  console.log(`${divider}\n`);

  if (totalFailed > 0) {
    console.error(`⚠️  ${totalFailed} document(s) failed. Check logs for details.\n`);
    process.exit(1);
  }
}

// ============================================================================
// Run
// ============================================================================

main()
  .catch((error: unknown) => {
    const err = error as Error;
    logger.error({ type: 'ingestion_script_fatal', error: err.message });
    console.error('\n💥 Fatal error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await (prisma as any).$disconnect();
  });
