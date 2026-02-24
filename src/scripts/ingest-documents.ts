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
 * After running `pnpm prisma generate` the generated type will be compatible —
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
  // ── Kenyan Data Protection ────────────────────────────────────────────────

  {
    // ✅ File present: TheDataProtectionAct__No24of2019.pdf
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
    // ✅ File present: THE-DATA-PROTECTION-REGISTRATION-OF-DATA-CONTROLLERS-AND-DATA-PROCESSORS-REGULATIONS-2021.pdf
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
    // ✅ File present: ODPC-Guidance-Note-on-Registration-of-Data-Controllers-and-Data-Processors.pdf
    fileName: 'kenya/ODPC-Guidance-Note-on-Registration-of-Data-Controllers-and-Data-Processors.pdf',
    title: 'ODPC Guidance Note on Registration of Data Controllers and Data Processors',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present: ODPC-Guidance-Note-for-Digital-Credit-Providers.pdf
    fileName: 'kenya/ODPC-Guidance-Note-for-Digital-Credit-Providers.pdf',
    title: 'ODPC Guidance Note for Digital Credit Providers',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present: ODPC-Guidance-Note-on-Data-Protection-Impact-Assessment-1.pdf
    fileName: 'kenya/ODPC-Guidance-Note-on-Data-Protection-Impact-Assessment-1.pdf',
    title: 'ODPC Guidance Note on Data Protection Impact Assessment (DPIA)',
    source: 'Office of Data Protection Commissioner',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },

  // ── Kenyan Cybersecurity & ICT ────────────────────────────────────────────

  {
    // ✅ File present: GuidelinesonCybersecurityforPSPs.pdf
    fileName: 'kenya/GuidelinesonCybersecurityforPSPs.pdf',
    title: 'Guidelines on Cybersecurity for Payment Service Providers',
    source: 'Central Bank of Kenya',
    category: 'PAYMENT_SYSTEMS' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present: Guidelines-for-Network-RedundancyResilience-and-Diversity-for-ICT-Networks-in-Kenya-1.pdf
    fileName: 'kenya/Guidelines-for-Network-RedundancyResilience-and-Diversity-for-ICT-Networks-in-Kenya-1.pdf',
    title: 'Guidelines for Network Redundancy, Resilience and Diversity for ICT Networks in Kenya',
    source: 'Communications Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ✅ File present: Guidelines-for-Undertaking-ICT-Infrastructure-Works.pdf
    fileName: 'kenya/Guidelines-for-Undertaking-ICT-Infrastructure-Works.pdf',
    title: 'Guidelines for Undertaking ICT Infrastructure Works',
    source: 'Communications Authority of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },

  // ── Kenyan Legislation (files not yet added — will be skipped) ────────────

  {
    // ⏭️ File not present yet — add kenya/computer-misuse-cybercrimes-act-2018.pdf
    fileName: 'kenya/computer-misuse-cybercrimes-act-2018.pdf',
    title: 'Computer Misuse and Cybercrimes Act, 2018',
    source: 'Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    effectiveDate: new Date('2018-05-16'),
    version: '2018',
  },
  {
    // ⏭️ File not present yet — add kenya/cbk-prudential-guidelines-digital-lending.pdf
    fileName: 'kenya/cbk-prudential-guidelines-digital-lending.pdf',
    title: 'CBK Prudential Guidelines for Digital Lending',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
    version: '2022',
  },
  {
    // ⏭️ File not present yet — add kenya/national-payment-systems-act.pdf
    fileName: 'kenya/national-payment-systems-act.pdf',
    title: 'National Payment Systems Act & Regulations',
    source: 'Parliament of Kenya',
    category: 'PAYMENT_SYSTEMS' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    version: '2011',
  },
  {
    // ⏭️ File not present yet — add kenya/cbk-regulatory-sandbox-guidelines.pdf
    fileName: 'kenya/cbk-regulatory-sandbox-guidelines.pdf',
    title: 'CBK Regulatory Sandbox Guidelines',
    source: 'Central Bank of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ⏭️ File not present yet — add kenya/aml-cft-guidelines.pdf
    fileName: 'kenya/aml-cft-guidelines.pdf',
    title: 'AML/CFT Guidelines',
    source: 'Financial Reporting Centre',
    category: 'AML_CFT' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ⏭️ File not present yet — add kenya/kenya-information-communications-act.pdf
    fileName: 'kenya/kenya-information-communications-act.pdf',
    title: 'Kenya Information and Communications Act',
    source: 'Parliament of Kenya',
    category: 'CYBERSECURITY' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    version: '1998',
  },
  {
    // ⏭️ File not present yet — add kenya/central-bank-of-kenya-act.pdf
    fileName: 'kenya/central-bank-of-kenya-act.pdf',
    title: 'Central Bank of Kenya Act (Fintech Sections)',
    source: 'Parliament of Kenya',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'act',
    version: '2014',
  },
  {
    // ⏭️ File not present yet — add kenya/cma-regulatory-sandbox-guidelines.pdf
    fileName: 'kenya/cma-regulatory-sandbox-guidelines.pdf',
    title: 'CMA Regulatory Sandbox Guidelines',
    source: 'Capital Markets Authority',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },
  {
    // ⏭️ File not present yet — add kenya/ira-insurtech-guidelines.pdf
    fileName: 'kenya/ira-insurtech-guidelines.pdf',
    title: 'IRA Insurtech Guidelines',
    source: 'Insurance Regulatory Authority',
    category: 'FINTECH_REGULATION' as DocumentCategory,
    jurisdiction: 'Kenya',
    documentType: 'guideline',
  },

  // ── International Standards ───────────────────────────────────────────────

  {
    // ✅ File present: NIST.CSWP.29.pdf (NIST CSF 2.0 core document)
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
    // ✅ File present: NIST CSF 2.0 Implementation Examples.pdf
    fileName: 'international/NIST CSF 2.0 Implementation Examples.pdf',
    title: 'NIST Cybersecurity Framework 2.0 — Implementation Examples',
    source: 'NIST',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'framework',
    effectiveDate: new Date('2024-02-26'),
    version: '2.0',
  },
  {
    // ✅ File present: ISO_IEC-270012022-ed.3.pdf (ISO 27001:2022 Third Edition)
    fileName: 'international/ISO_IEC-270012022-ed.3.pdf',
    title: 'ISO/IEC 27001:2022 — Information Security Management Systems',
    source: 'ISO/IEC',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    effectiveDate: new Date('2022-10-25'),
    version: '2022 (3rd edition)',
  },
  {
    // ⏭️ File not present yet — add international/pci-dss-requirements.pdf
    fileName: 'international/pci-dss-requirements.pdf',
    title: 'PCI DSS Requirements',
    source: 'PCI Security Standards Council',
    category: 'INTERNATIONAL_STANDARD' as DocumentCategory,
    jurisdiction: 'International',
    documentType: 'standard',
    version: 'v4.0',
  },
  {
    // ⏭️ File not present yet — add international/gdpr-full-text.pdf
    fileName: 'international/gdpr-full-text.pdf',
    title: 'GDPR Full Text',
    source: 'European Union',
    category: 'DATA_PROTECTION' as DocumentCategory,
    jurisdiction: 'EU',
    documentType: 'regulation',
    effectiveDate: new Date('2018-05-25'),
    version: '2016/679',
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
  console.log('\n⚠️  Interrupted — finishing current document, then stopping...');
  shuttingDown = true;
});

process.on('SIGTERM', () => {
  shuttingDown = true;
});

// ============================================================================
// Main Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('\n🚀 SheriaBot — Regulatory Document Ingestion Pipeline\n');
  console.log(`📁 Documents folder: ${DOCS_ROOT}`);
  console.log(`📋 Registry entries: ${DOCUMENT_REGISTRY.length}\n`);

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalChunks = 0;
  let totalVectors = 0;

  for (const entry of DOCUMENT_REGISTRY) {
    if (shuttingDown) {
      console.log('\n⚠️  Shutdown requested — stopping ingestion.');
      break;
    }

    const filePath = resolvePath(entry.fileName);

    // Skip files that haven't been placed in the documents/ folder yet
    if (!fs.existsSync(filePath)) {
      console.log(
        `⏭️  Skipping ${entry.title} — file not found: ${entry.fileName}`
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
      // Cast is safe — DocumentCategory values match RegulatoryDocumentCategory exactly
      category: entry.category as DocumentIngestionInput['category'],
      jurisdiction: entry.jurisdiction,
      documentType: entry.documentType,
      effectiveDate: entry.effectiveDate,
      version: entry.version,
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

  // ── Summary ────────────────────────────────────────────────────────────────

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
