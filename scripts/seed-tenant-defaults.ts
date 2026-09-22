import 'dotenv/config';
import { prisma } from '../src/lib/prisma/client';
import { DocumentCategory, VaultDocumentStatus, PolicyStatus } from '@prisma/client';

export interface SeedTenantDefaultsResult {
  organizationsProcessed: number;
  checklistsCreated: number;
  checklistItemsCreated: number;
  policiesCreated: number;
  vaultDocsCreated: number;
  complianceQueriesCreated: number;
  gapAnalysesCreated: number;
  perOrgSummary: Array<{
    orgId: string;
    orgName: string;
    checklists: number;
    checklistItems: number;
    policies: number;
    vaultDocuments: number;
    complianceQueries: number;
    gapAnalyses: number;
  }>;
}

const DEFAULT_ITEMS = [
  {
    itemCode: 'cbk-01',
    title: 'CBK Payment Service Provider / Digital Credit Provider Licensing',
    description: 'Prepare formal CBK application dossier, board resolutions, fit-and-proper declarations, and minimum capital proof.',
    category: 'Licensing & Authorization',
    regulatoryReference: 'Central Bank of Kenya Act / DCP Regulations 2022',
    actionItems: ['Prepare corporate dossier', 'Complete fit and proper declarations', 'Verify minimum capital requirement'],
    priority: 'HIGH',
    order: 0,
  },
  {
    itemCode: 'dpa-01',
    title: 'ODPC Data Protection Registration & DPIA',
    description: 'Register as Data Controller/Processor with Office of the Data Protection Commissioner and complete Data Protection Impact Assessment.',
    category: 'Data Protection & Privacy',
    regulatoryReference: 'Data Protection Act 2019 / General Regulations 2021',
    actionItems: ['Appoint Data Protection Officer', 'Conduct initial DPIA on customer data processing', 'Submit registration with ODPC'],
    priority: 'CRITICAL',
    order: 1,
  },
  {
    itemCode: 'aml-01',
    title: 'AML / CFT Compliance Manual & FRC Reporting System',
    description: 'Adopt formal AML/CFT/CPF Policy manual, implement PEP screening, and appoint AML Reporting Officer for FRC reporting.',
    category: 'Anti-Money Laundering & CFT',
    regulatoryReference: 'POCAMLA 2009 / POCAMLA Regulations 2023',
    actionItems: ['Adopt AML Policy manual', 'Appoint Money Laundering Reporting Officer (MLRO)', 'Setup FRC goAML integration/reporting process'],
    priority: 'CRITICAL',
    order: 2,
  },
  {
    itemCode: 'cma-01',
    title: 'CMA Sandbox Application / Crowdfunding Regulations',
    description: 'Review capital markets requirements for tokenized/investment-linked offerings and prepare regulatory sandbox submission.',
    category: 'Capital Markets & Securities',
    regulatoryReference: 'Capital Markets Act / Regulatory Sandbox Policy Guidance Note',
    actionItems: ['Assess regulatory perimeter', 'Draft sandbox deployment plan', 'Submit sandbox inquiry to CMA'],
    priority: 'MEDIUM',
    order: 3,
  },
  {
    itemCode: 'inf-01',
    title: 'Cybersecurity Policy & Incident Response Framework',
    description: 'Implement baseline information security controls, encryption of customer financial records, and 24-hour breach notification procedure.',
    category: 'Cybersecurity & Systems',
    regulatoryReference: 'CBK Cybersecurity Guidelines / Computer Misuse and Cybercrimes Act 2018',
    actionItems: ['Publish Incident Response SOP', 'Configure audit logging for financial transactions', 'Establish backup redundancy'],
    priority: 'HIGH',
    order: 4,
  },
];

export async function seedTenantDefaults(): Promise<SeedTenantDefaultsResult> {
  console.log('🌱 Starting Tenant Defaults Seeding for all active organizations...');

  const organizations = await prisma.organization.findMany({
    include: {
      users: {
        where: { deletedAt: null },
        take: 1,
      },
    },
  });

  console.log(`🏢 Found ${organizations.length} organizations to process.`);

  let checklistsCreated = 0;
  let checklistItemsCreated = 0;
  let policiesCreated = 0;
  let vaultDocsCreated = 0;
  let complianceQueriesCreated = 0;
  let gapAnalysesCreated = 0;

  const perOrgSummary: SeedTenantDefaultsResult['perOrgSummary'] = [];

  for (const org of organizations) {
    const primaryUser = org.users[0] || null;
    let orgChecklists = 0;
    let orgChecklistItems = 0;
    let orgPolicies = 0;
    let orgVaultDocs = 0;
    let orgQueries = 0;
    let orgGapAnalyses = 0;

    // 1. Checklist
    let checklist = await prisma.checklist.findFirst({
      where: { organizationId: org.id, deletedAt: null },
    });

    if (!checklist) {
      checklist = await prisma.checklist.create({
        data: {
          title: 'Kenya Fintech Regulatory Baseline',
          jurisdiction: 'Kenya',
          regulatoryBody: 'CBK / ODPC / CMA',
          category: 'Licensing & Compliance',
          organizationId: org.id,
          userId: primaryUser ? primaryUser.id : null,
          totalItems: DEFAULT_ITEMS.length,
          completedItems: 0,
        },
      });
      checklistsCreated++;
      orgChecklists++;
    }

    // 2. Checklist Items
    for (const item of DEFAULT_ITEMS) {
      const existingItem = await prisma.checklistItem.findFirst({
        where: {
          checklistId: checklist.id,
          itemCode: item.itemCode,
        },
      });

      if (!existingItem) {
        await prisma.checklistItem.create({
          data: {
            checklistId: checklist.id,
            itemCode: item.itemCode,
            title: item.title,
            description: item.description,
            category: item.category,
            regulatoryReference: item.regulatoryReference,
            actionItems: item.actionItems,
            priority: item.priority as any,
            order: item.order,
            status: 'PENDING',
          },
        });
        checklistItemsCreated++;
        orgChecklistItems++;
      }
    }

    // 3. Policy
    const existingPolicy = await prisma.policy.findFirst({
      where: { organizationId: org.id, deletedAt: null },
    });

    if (!existingPolicy) {
      await prisma.policy.create({
        data: {
          title: 'Information Security & Data Privacy Policy',
          code: `POL-${org.id.slice(0, 6).toUpperCase()}-01`,
          version: '1.0.0',
          organizationId: org.id,
          category: 'Data Protection & Privacy',
          status: PolicyStatus.PUBLISHED,
          effectiveDate: new Date(),
          reviewDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          jurisdiction: 'Kenya',
        },
      });
      policiesCreated++;
      orgPolicies++;
    }

    // 4. Vault Document
    const existingVaultDoc = await prisma.vaultDocument.findFirst({
      where: { organizationId: org.id, deletedAt: null },
    });

    if (!existingVaultDoc) {
      await prisma.vaultDocument.create({
        data: {
          title: 'ODPC Data Protection Compliance Certificate & Filing Evidence',
          documentType: 'CERTIFICATE',
          category: DocumentCategory.REGULATORY_APPROVAL,
          organizationId: org.id,
          uploadedBy: primaryUser ? primaryUser.id : 'SYSTEM',
          status: VaultDocumentStatus.VERIFIED,
          fileUrl: 'https://storage.sheriabot.com/defaults/odpc-certificate-sample.pdf',
          fileSize: 1048576,
          mimeType: 'application/pdf',
          jurisdiction: 'Kenya',
        },
      });
      vaultDocsCreated++;
      orgVaultDocs++;
    }

    // 5. Compliance Query
    const existingQuery = await prisma.complianceQuery.findFirst({
      where: { organizationId: org.id, deletedAt: null },
    });

    if (!existingQuery) {
      await prisma.complianceQuery.create({
        data: {
          title: 'Digital Credit Provider (DCP) Fit and Proper Thresholds',
          queryText: 'What are the statutory requirements under the CBK Digital Credit Providers Regulations for shareholder due diligence and anti-money laundering compliance officers?',
          category: 'Licensing & Authorization',
          jurisdiction: 'Kenya',
          organizationId: org.id,
          userId: primaryUser ? primaryUser.id : 'SYSTEM',
          status: 'ANSWERED',
          response: 'Under Regulation 5 of the Central Bank of Kenya (Digital Credit Providers) Regulations 2022, directors and significant shareholders (holding >=10%) must submit Form CBK DCP 2, certified tax compliance certificates from KRA, CRB clearance, and police clearance certificates.',
        },
      });
      complianceQueriesCreated++;
      orgQueries++;
    }

    // 6. Gap Analysis
    const existingGapAnalysis = await prisma.gapAnalysis.findFirst({
      where: { organizationId: org.id, deletedAt: null },
    });

    if (!existingGapAnalysis) {
      await prisma.gapAnalysis.create({
        data: {
          title: 'Kenya Fintech Regulatory Baseline Gap Analysis',
          organizationId: org.id,
          framework: 'CBK / ODPC / POCAMLA Integrated Framework',
          status: 'COMPLETED',
          overallScore: 82.5,
          findings: [
            {
              category: 'Licensing & Authorization',
              status: 'PARTIAL',
              gap: 'Fit and Proper declarations need certified copies of KRA tax clearance.',
              remediation: 'Obtain updated KRA TCC for executive management team.',
            },
            {
              category: 'Data Privacy',
              status: 'COMPLIANT',
              gap: 'None. DPIA baseline complete.',
              remediation: 'Conduct annual review.',
            },
          ],
        },
      });
      gapAnalysesCreated++;
      orgGapAnalyses++;
    }

    perOrgSummary.push({
      orgId: org.id,
      orgName: org.name,
      checklists: orgChecklists,
      checklistItems: orgChecklistItems,
      policies: orgPolicies,
      vaultDocuments: orgVaultDocs,
      complianceQueries: orgQueries,
      gapAnalyses: orgGapAnalyses,
    });
  }

  const result: SeedTenantDefaultsResult = {
    organizationsProcessed: organizations.length,
    checklistsCreated,
    checklistItemsCreated,
    policiesCreated,
    vaultDocsCreated,
    complianceQueriesCreated,
    gapAnalysesCreated,
    perOrgSummary,
  };

  console.log('\n========================================');
  console.log('✅ Tenant Defaults Seeding Complete!');
  console.log(`🏢 Organizations Processed: ${organizations.length}`);
  console.log(`📋 Checklists Created: ${checklistsCreated}`);
  console.log(`📝 Checklist Items Created: ${checklistItemsCreated}`);
  console.log(`📜 Policies Created: ${policiesCreated}`);
  console.log(`📁 Vault Documents Created: ${vaultDocsCreated}`);
  console.log(`❓ Compliance Queries Created: ${complianceQueriesCreated}`);
  console.log(`📊 Gap Analyses Created: ${gapAnalysesCreated}`);
  console.log('========================================\n');

  return result;
}

if (process.argv[1]?.includes('seed-tenant-defaults')) {
  seedTenantDefaults()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('❌ Failed to seed tenant defaults:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
