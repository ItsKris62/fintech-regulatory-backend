/**
 * One-time helper: generates initial manifest.json entries from the existing
 * DOCUMENT_REGISTRY metadata + computes SHA-256 checksums for all present files.
 *
 * This script is a scratch utility — it is NOT part of the production pipeline.
 *
 * Usage:  tsx src/scripts/corpus/_generate-initial-manifests.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DOCS_ROOT = path.resolve(__dirname, '..', '..', '..', 'documents');

// Category mapping from existing registry categories to manifest categories
const CATEGORY_MAP: Record<string, string> = {
  DATA_PROTECTION: 'data-protection',
  CYBERSECURITY: 'cybersecurity',
  FINTECH_REGULATION: 'banking',
  PAYMENT_SYSTEMS: 'payments',
  AML_CFT: 'aml-cft',
  INTERNATIONAL_STANDARD: 'core',
};

// Registry entries adapted from ingest-documents.ts
const KENYA_ENTRIES = [
  { fileName: 'kenya/TheDataProtectionAct__No24of2019.pdf', title: 'Kenya Data Protection Act, 2019 (No. 24 of 2019)', source: 'Parliament of Kenya', category: 'DATA_PROTECTION', documentType: 'act', effectiveDate: '2019-11-08', version: '2019', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/THE-DATA-PROTECTION-REGISTRATION-OF-DATA-CONTROLLERS-AND-DATA-PROCESSORS-REGULATIONS-2021.pdf', title: 'Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021', source: 'Office of Data Protection Commissioner', category: 'DATA_PROTECTION', documentType: 'regulation', effectiveDate: '2021-11-16', version: '2021', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/24-06-2024-The-Data-Protection-Compliance-audit-Regulations-2024_.pdf', title: 'Data Protection (Compliance Audit) Regulations, 2024', source: 'Office of Data Protection Commissioner', category: 'DATA_PROTECTION', documentType: 'regulation', effectiveDate: '2024-06-24', version: '2024', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/ODPC-Guidance-Note-on-Registration-of-Data-Controllers-and-Data-Processors.pdf', title: 'ODPC Guidance Note on Registration of Data Controllers and Data Processors', source: 'Office of Data Protection Commissioner', category: 'DATA_PROTECTION', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/ODPC-Guidance-Note-for-Digital-Credit-Providers.pdf', title: 'ODPC Guidance Note for Digital Credit Providers', source: 'Office of Data Protection Commissioner', category: 'DATA_PROTECTION', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/ODPC-Guidance-Note-on-Data-Protection-Impact-Assessment-1.pdf', title: 'ODPC Guidance Note on Data Protection Impact Assessment (DPIA)', source: 'Office of Data Protection Commissioner', category: 'DATA_PROTECTION', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/ODPC-\u2013-Guidance-Note-on-Processing-by-MSMEs.pdf', title: 'ODPC Guidance Note on Data Processing by MSMEs', source: 'Office of Data Protection Commissioner', category: 'DATA_PROTECTION', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/KenyaInformationandCommunicationsAct(No2of1998).pdf', title: 'Kenya Information and Communications Act (No. 2 of 1998)', source: 'Parliament of Kenya', category: 'CYBERSECURITY', documentType: 'act', effectiveDate: '1998-01-01', version: '1998', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Guidelines-for-Network-RedundancyResilience-and-Diversity-for-ICT-Networks-in-Kenya-1.pdf', title: 'Guidelines for Network Redundancy, Resilience and Diversity for ICT Networks in Kenya', source: 'Communications Authority of Kenya', category: 'CYBERSECURITY', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/Guidelines-for-Undertaking-ICT-Infrastructure-Works.pdf', title: 'Guidelines for Undertaking ICT Infrastructure Works', source: 'Communications Authority of Kenya', category: 'CYBERSECURITY', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/Environmental and Social Impact Assessment Guidelines for ICT Projects 2025.pdf', title: 'Environmental and Social Impact Assessment Guidelines for ICT Projects, 2025', source: 'Communications Authority of Kenya', category: 'CYBERSECURITY', documentType: 'guideline', effectiveDate: '2025-01-01', version: '2025', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'kenya/Framework for CO2 Reduction in the ICT Sector 2025.pdf', title: 'Framework for CO2 Reduction in the ICT Sector, 2025', source: 'Communications Authority of Kenya', category: 'CYBERSECURITY', documentType: 'framework', effectiveDate: '2025-01-01', version: '2025', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'kenya/GuidelinesonCybersecurityforPSPs.pdf', title: 'Guidelines on Cybersecurity for Payment Service Providers', source: 'Central Bank of Kenya', category: 'PAYMENT_SYSTEMS', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/National Payment System Act.pdf', title: 'National Payment Systems Act', source: 'Parliament of Kenya', category: 'PAYMENT_SYSTEMS', documentType: 'act', version: '2011', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Banking Act.pdf', title: 'Banking Act (Cap. 488)', source: 'Parliament of Kenya', category: 'FINTECH_REGULATION', documentType: 'act', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Draft-Virtual-Asset-Service-Providers-Regulations-2026.pdf', title: 'Draft Virtual Asset Service Providers Regulations, 2026', source: 'National Treasury and Economic Planning', category: 'FINTECH_REGULATION', documentType: 'regulation', effectiveDate: '2026-01-01', version: '2026 (Draft)', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/Draft Consumer Protection Framework - March 2026.pdf', title: 'Financial Consumer Protection Framework for Kenya (Draft), March 2026', source: 'Kenya Financial Sector Regulators', category: 'FINTECH_REGULATION', documentType: 'framework', effectiveDate: '2026-03-01', version: 'March 2026 (Draft)', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/PRUDENTIAL-GUIDELINES.pdf', title: 'CBK Prudential Guidelines for Institutions Licensed under the Banking Act', source: 'Central Bank of Kenya', category: 'FINTECH_REGULATION', documentType: 'guideline', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/L-.N.-No.-46-Central-Bank-of-Kenya-Digital-Credit-Providers-Regulations-2022.pdf', title: 'Central Bank of Kenya (Digital Credit Providers) Regulations, 2022 (L.N. No. 46)', source: 'Central Bank of Kenya', category: 'FINTECH_REGULATION', documentType: 'regulation', effectiveDate: '2022-03-18', version: '2022', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Draft-CBK-Non-Deposit-Taking-Credit-Providers-Regulations.pdf', title: 'Draft CBK Non-Deposit Taking Credit Providers Regulations', source: 'Central Bank of Kenya', category: 'FINTECH_REGULATION', documentType: 'regulation', version: 'Draft', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/Draft-Regulatory-Sandbox-Policy-Guidance-Note-2018.pdf', title: 'CBK Draft Regulatory Sandbox Policy Guidance Note, 2018', source: 'Central Bank of Kenya', category: 'FINTECH_REGULATION', documentType: 'guideline', effectiveDate: '2018-01-01', version: '2018', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/Finance Act 2023.pdf', title: 'Finance Act, 2023', source: 'Parliament of Kenya', category: 'FINTECH_REGULATION', documentType: 'act', effectiveDate: '2023-06-26', version: '2023', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Draft-Banking-Penalties-Regulations-2024.pdf', title: 'Draft Banking (Penalties) Regulations, 2024', source: 'Central Bank of Kenya', category: 'FINTECH_REGULATION', documentType: 'regulation', effectiveDate: '2024-01-01', version: '2024 (Draft)', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/Kenya-National-Financial-Inclusion-Strategy-2025-2028.pdf', title: 'Kenya National Financial Inclusion Strategy 2025-2028', source: 'National Treasury of Kenya', category: 'FINTECH_REGULATION', documentType: 'framework', effectiveDate: '2025-01-01', version: '2025-2028', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'kenya/Insurance (Bancassurance) Regulations 2020.pdf', title: 'Insurance (Bancassurance) Regulations, 2020', source: 'Insurance Regulatory Authority', category: 'FINTECH_REGULATION', documentType: 'regulation', effectiveDate: '2020-01-01', version: '2020', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/The Capital Markets (InvestmentBased Crowdfunding) Regulations.pdf', title: 'Capital Markets (Investment-Based Crowdfunding) Regulations', source: 'Capital Markets Authority', category: 'FINTECH_REGULATION', documentType: 'regulation', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Virtual Asset Service Providers Act.pdf', title: 'Virtual Asset Service Providers Act', source: 'Parliament of Kenya', category: 'FINTECH_REGULATION', documentType: 'act', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/The Value Added Tax (Electronic Internet and Digital Marketplace Supply) Regulations 2023.pdf', title: 'Value Added Tax (Electronic, Internet and Digital Marketplace Supply) Regulations, 2023', source: 'Kenya Revenue Authority', category: 'FINTECH_REGULATION', documentType: 'regulation', effectiveDate: '2023-01-01', version: '2023', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/The Tax Procedures (Electronic Tax Invoice) Regulations.pdf', title: 'Tax Procedures (Electronic Tax Invoice) Regulations', source: 'Kenya Revenue Authority', category: 'FINTECH_REGULATION', documentType: 'regulation', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Finance-Bill-2026.pdf', title: 'Finance Bill, 2026', source: 'Parliament of Kenya', category: 'FINTECH_REGULATION', documentType: 'act', effectiveDate: '2026-01-01', version: '2026 (Bill)', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/Draft-Green-Fiscal-Incentives-Policy-Framework.pdf', title: 'Draft National Green Fiscal Incentives Policy Framework', source: 'National Treasury and Economic Planning', category: 'FINTECH_REGULATION', documentType: 'framework', effectiveDate: '2022-12-01', version: 'December 2022 (Draft)', authorityStatus: 'DRAFT', isBinding: false },
  { fileName: 'kenya/CYBER-SECURITY-GUIDELINES-FOR-PSP-AUGUST-2018.pdf', title: 'CBK Cyber Security Guidelines for Payment Service Providers, August 2018', source: 'Central Bank of Kenya', category: 'PAYMENT_SYSTEMS', documentType: 'guideline', effectiveDate: '2018-08-01', version: '2018', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'kenya/Computer Misuse and Cybercrimes (Amendment) Act, 2025.pdf', title: 'Computer Misuse and Cybercrimes (Amendment) Act, 2025', source: 'Parliament of Kenya', category: 'CYBERSECURITY', documentType: 'act', effectiveDate: '2025-01-01', version: '2025', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Computer-Misuse-and-Cybercrimes-Amendment-Act-2025.pdf', title: 'Computer Misuse and Cybercrimes (Amendment) Act, 2025 (alternate copy)', source: 'Parliament of Kenya', category: 'CYBERSECURITY', documentType: 'act', effectiveDate: '2025-01-01', version: '2025', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/NATIONAL-ICT-POLICY-2019.pdf', title: 'National ICT Policy, 2019', source: 'Ministry of ICT, Innovation and Youth Affairs', category: 'CYBERSECURITY', documentType: 'framework', effectiveDate: '2019-01-01', version: '2019', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'kenya/The-Computer-Misuse-and-Cybercrime-Regulations-LN44_2024.pdf', title: 'Computer Misuse and Cybercrimes (General) Regulations, 2024 (L.N. No. 44)', source: 'ICT Cabinet Secretary / Parliament of Kenya', category: 'CYBERSECURITY', documentType: 'regulation', effectiveDate: '2024-01-01', version: '2024', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Proceeds-of-Crime-and-Anti-Money-Laundering-Act-No-9-of-2009-Revised-2022.pdf', title: 'Proceeds of Crime and Anti-Money Laundering Act (No. 9 of 2009, Revised 2022)', source: 'Parliament of Kenya', category: 'AML_CFT', documentType: 'act', effectiveDate: '2009-06-01', version: '2022 Revision', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/POCAMLA-REGULATIONS.pdf', title: 'Proceeds of Crime and Anti-Money Laundering (POCAMLA) Regulations', source: 'Financial Reporting Centre', category: 'AML_CFT', documentType: 'regulation', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Computer Misuse and Cybercrimes Act 2018.pdf', title: 'Computer Misuse and Cybercrimes Act, 2018', source: 'Parliament of Kenya', category: 'CYBERSECURITY', documentType: 'act', effectiveDate: '2018-05-16', version: '2018', authorityStatus: 'IN_FORCE', isBinding: true },
  { fileName: 'kenya/Kenya Cloud Policy - 2024.pdf', title: 'Kenya Cloud Policy, 2024', source: 'ICT Authority of Kenya', category: 'CYBERSECURITY', documentType: 'framework', effectiveDate: '2024-01-01', version: '2024', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'kenya/Kenya AI Strategy 2025 - 2030.pdf', title: 'Kenya Artificial Intelligence Strategy 2025-2030', source: 'Government of Kenya', category: 'CYBERSECURITY', documentType: 'framework', effectiveDate: '2025-03-01', version: '2025-2030', authorityStatus: 'IN_FORCE', isBinding: false },
];

const INTL_ENTRIES = [
  { fileName: 'international/NIST.CSWP.29.pdf', title: 'NIST Cybersecurity Framework 2.0', source: 'NIST', category: 'INTERNATIONAL_STANDARD', documentType: 'framework', effectiveDate: '2024-02-26', version: '2.0', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/NIST CSF 2.0 Implementation Examples.pdf', title: 'NIST Cybersecurity Framework 2.0 - Implementation Examples', source: 'NIST', category: 'INTERNATIONAL_STANDARD', documentType: 'framework', effectiveDate: '2024-02-26', version: '2.0', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/ISO_IEC-270012022-ed.3.pdf', title: 'ISO/IEC 27001:2022 - Information Security Management Systems', source: 'ISO/IEC', category: 'INTERNATIONAL_STANDARD', documentType: 'standard', effectiveDate: '2022-10-25', version: '2022 (3rd edition)', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/ISO_IEC_27000_2018(en).pdf', title: 'ISO/IEC 27000:2018 - Information Security Management Systems Overview and Vocabulary', source: 'ISO/IEC', category: 'INTERNATIONAL_STANDARD', documentType: 'standard', effectiveDate: '2018-02-01', version: '2018 (5th edition)', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/PCI-DSS-v4-0-SAQ-A.pdf', title: 'PCI DSS v4.0 - Self-Assessment Questionnaire A (SAQ A)', source: 'PCI Security Standards Council', category: 'INTERNATIONAL_STANDARD', documentType: 'standard', effectiveDate: '2022-03-01', version: 'v4.0', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/General Data Protection Regulation.pdf', title: 'General Data Protection Regulation (GDPR) - Regulation (EU) 2016/679', source: 'European Union', category: 'INTERNATIONAL_STANDARD', documentType: 'regulation', effectiveDate: '2018-05-25', version: '2016/679', authorityStatus: 'IN_FORCE', isBinding: true, jurisdictionCode: 'EU' },
  { fileName: 'international/Artificial Intelligence Act EU.pdf', title: 'Artificial Intelligence Act (EU AI Act) - Regulation (EU) 2024/1689', source: 'European Union', category: 'INTERNATIONAL_STANDARD', documentType: 'regulation', effectiveDate: '2024-08-01', version: '2024/1689', authorityStatus: 'IN_FORCE', isBinding: true, jurisdictionCode: 'EU' },
  { fileName: 'international/Artificial Intelligence Risk Management.pdf', title: 'NIST AI Risk Management Framework (AI RMF 1.0)', source: 'NIST', category: 'INTERNATIONAL_STANDARD', documentType: 'framework', effectiveDate: '2023-01-26', version: '1.0', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/Privacy Information Management with ISO IEC 27701.pdf', title: 'ISO/IEC 27701:2019 - Privacy Information Management System (PIMS)', source: 'ISO/IEC', category: 'INTERNATIONAL_STANDARD', documentType: 'standard', effectiveDate: '2019-08-06', version: '2019', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/033144-1A-soc2-system-organization-controls-reporting-whitepaper-v6-secured.pdf', title: 'SOC 2 - System and Organisation Controls Reporting (AICPA Whitepaper v6)', source: 'AICPA', category: 'INTERNATIONAL_STANDARD', documentType: 'framework', version: 'v6', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'international/pcissc_overview.pdf', title: 'PCI Security Standards Council - Overview of Payment Security Standards', source: 'PCI Security Standards Council', category: 'INTERNATIONAL_STANDARD', documentType: 'framework', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'international/Secure-Software-Program-Guide-v1.pdf', title: 'Secure Software Program Guide v1.0', source: 'PCI Security Standards Council', category: 'INTERNATIONAL_STANDARD', documentType: 'guideline', version: 'v1.0', authorityStatus: 'GUIDANCE', isBinding: false },
  { fileName: 'international/Global-Web-Content-Accessibility-Guidelines-WCAG-2.1.pdf', title: 'Web Content Accessibility Guidelines (WCAG) 2.1', source: 'W3C', category: 'INTERNATIONAL_STANDARD', documentType: 'standard', effectiveDate: '2018-06-05', version: '2.1', authorityStatus: 'IN_FORCE', isBinding: false },
  { fileName: 'international/wcag20-guidelines-20081211-a4.pdf', title: 'Web Content Accessibility Guidelines (WCAG) 2.0', source: 'W3C', category: 'INTERNATIONAL_STANDARD', documentType: 'standard', effectiveDate: '2008-12-11', version: '2.0', authorityStatus: 'IN_FORCE', isBinding: false },
];

// Map from old category to better manifest categories
function mapCategory(oldCat: string, title: string): string {
  // More granular category mapping based on title/content
  const t = title.toLowerCase();

  if (t.includes('data protection') || t.includes('gdpr') || t.includes('privacy')) return 'data-protection';
  if (t.includes('aml') || t.includes('anti-money') || t.includes('pocamla') || t.includes('proceeds of crime')) return 'aml-cft';
  if (t.includes('payment') || t.includes('psp')) return 'payments';
  if (t.includes('cybersecurity') || t.includes('cyber security') || t.includes('cybercrimes') || t.includes('computer misuse')) return 'cybersecurity';
  if (t.includes('banking') || t.includes('prudential') || t.includes('credit') || t.includes('bancassurance')) return 'banking';
  if (t.includes('capital markets') || t.includes('crowdfunding')) return 'capital-markets';
  if (t.includes('insurance')) return 'insurance';
  if (t.includes('tax') || t.includes('finance act') || t.includes('finance bill') || t.includes('vat') || t.includes('fiscal')) return 'tax';
  if (t.includes('ict') || t.includes('information and communication')) return 'ict';
  if (t.includes('cloud')) return 'cloud';
  if (t.includes('ai ') || t.includes('artificial intelligence')) return 'ai-governance';
  if (t.includes('accessibility') || t.includes('wcag')) return 'accessibility';
  if (t.includes('iso') || t.includes('nist') || t.includes('pci') || t.includes('soc 2')) return 'core';
  if (t.includes('regulatory sandbox')) return 'banking';
  if (t.includes('financial inclusion')) return 'banking';
  if (t.includes('consumer protection')) return 'consumer-protection';
  if (t.includes('co2') || t.includes('environmental')) return 'ict';
  if (t.includes('network redundancy')) return 'ict';

  return CATEGORY_MAP[oldCat] ?? 'other';
}

function mapDocType(dt: string): string {
  const map: Record<string, string> = {
    act: 'ACT',
    regulation: 'REGULATION',
    guideline: 'GUIDELINE',
    framework: 'FRAMEWORK',
    standard: 'STANDARD',
    bill: 'DRAFT',
    strategy: 'FRAMEWORK',
    report: 'REPORT',
  };
  return map[dt] ?? 'OTHER';
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function computeChecksumSync(filePath: string): string | null {
  try {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

function buildEntry(
  rawEntry: any,
  countryName: string,
  jurisdictionCode: string,
  scope: string,
  index: number,
) {
  const filePath = path.join(DOCS_ROOT, rawEntry.fileName);
  const fileExists = fs.existsSync(filePath);
  const checksum = fileExists ? computeChecksumSync(filePath) : null;

  const mappedCategory = mapCategory(rawEntry.category, rawEntry.title);
  const mappedDocType = mapDocType(rawEntry.documentType);

  const entry: any = {
    id: `${jurisdictionCode.toLowerCase()}-${slugify(rawEntry.title)}-${String(index).padStart(3, '0')}`,
    country: countryName,
    jurisdictionCode: (rawEntry as any).jurisdictionCode ?? jurisdictionCode,
    scope,
    category: mappedCategory,
    regulator: rawEntry.source,
    title: rawEntry.title,
    documentType: mappedDocType,
    authorityStatus: rawEntry.authorityStatus ?? 'UNKNOWN',
    isBinding: rawEntry.isBinding ?? false,
    localPath: `documents/${rawEntry.fileName}`,
    sourceUrl: null,
    checksumSha256: checksum,
    reviewStatus: 'NEEDS_REVIEW',
    priority: 'UNKNOWN',
    tags: [],
  };

  if (rawEntry.effectiveDate) entry.effectiveDate = rawEntry.effectiveDate;
  if (rawEntry.version) entry.version = rawEntry.version;
  entry.language = 'en';

  return entry;
}

function main() {
  // Kenya
  const kenyaEntries = KENYA_ENTRIES.map((e, i) =>
    buildEntry(e, 'Kenya', 'KE', 'COUNTRY', i + 1),
  );

  const kenyaManifest = {
    version: 1,
    country: 'Kenya',
    jurisdictionCode: 'KE',
    entries: kenyaEntries,
  };

  // International
  const intlEntries = INTL_ENTRIES.map((e, i) =>
    buildEntry(e, 'International', (e as any).jurisdictionCode ?? 'INTL', 'INTERNATIONAL', i + 1),
  );

  const intlManifest = {
    version: 1,
    country: 'International',
    jurisdictionCode: 'INTL',
    entries: intlEntries,
  };

  // Write
  const kenyaPath = path.join(DOCS_ROOT, 'kenya', 'manifest.json');
  const intlPath = path.join(DOCS_ROOT, 'international', 'manifest.json');

  fs.writeFileSync(kenyaPath, JSON.stringify(kenyaManifest, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(intlPath, JSON.stringify(intlManifest, null, 2) + '\n', 'utf-8');

  console.log(`✅ Kenya manifest: ${kenyaEntries.length} entries → ${kenyaPath}`);
  console.log(`✅ International manifest: ${intlEntries.length} entries → ${intlPath}`);
}

main();
