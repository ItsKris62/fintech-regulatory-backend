import 'dotenv/config';
import { prisma } from '../lib/prisma/client';

async function main() {
  console.log('🌱 Starting tenant defaults seeding...');

  // 1. Fetch all active organizations
  const organizations = await prisma.organization.findMany({
    include: {
      members: {
        where: { status: 'ACTIVE', role: 'OWNER' },
        take: 1,
      },
      users: {
        take: 1,
      },
    },
  });

  console.log(`Found ${organizations.length} organizations.`);

  let checklistsCreated = 0;

  for (const org of organizations) {
    const ownerUserId = org.members[0]?.userId || org.users[0]?.id;
    if (!ownerUserId) {
      console.log(`Skipping org ${org.name} (${org.id}) - no owner user found.`);
      continue;
    }

    // Check if organization already has any checklist
    const existingChecklist = await prisma.checklist.findFirst({
      where: {
        organizationId: org.id,
        title: 'Kenya Fintech Regulatory Baseline',
      },
    });

    if (existingChecklist) {
      continue;
    }

    const defaultItems = [
      {
        id: 'cbk-01',
        title: 'CBK Payment Service Provider / Digital Credit Provider Licensing',
        description: 'Prepare formal CBK application dossier, board resolutions, fit-and-proper declarations, and minimum capital proof.',
        category: 'Licensing & Authorization',
        status: 'PENDING',
        priority: 'HIGH',
      },
      {
        id: 'dpa-01',
        title: 'ODPC Data Protection Registration & DPIA',
        description: 'Register as Data Controller/Processor with Office of the Data Protection Commissioner and complete Data Protection Impact Assessment.',
        category: 'Data Protection & Privacy',
        status: 'PENDING',
        priority: 'HIGH',
      },
      {
        id: 'aml-01',
        title: 'AML/CFT & KYC Compliance Framework',
        description: 'Designate AML Compliance Officer, implement customer due diligence procedures, and register with Financial Reporting Centre (FRC).',
        category: 'Anti-Money Laundering',
        status: 'PENDING',
        priority: 'HIGH',
      },
      {
        id: 'cyber-01',
        title: 'CBK Cybersecurity Guideline Alignment',
        description: 'Establish internal information security policy, independent vulnerability assessment, and 24/7 incident response protocol.',
        category: 'Cybersecurity',
        status: 'PENDING',
        priority: 'MEDIUM',
      },
      {
        id: 'cp-01',
        title: 'Consumer Protection & Dispute Resolution Matrix',
        description: 'Formulate transparent fee schedules, consumer disclosures, SLA for grievance handling, and customer recourse channels.',
        category: 'Consumer Protection',
        status: 'PENDING',
        priority: 'MEDIUM',
      },
    ];

    await prisma.checklist.create({
      data: {
        userId: ownerUserId,
        organizationId: org.id,
        title: 'Kenya Fintech Regulatory Baseline',
        description: 'Essential compliance roadmap across CBK, ODPC, and FRC regulatory requirements for Kenya fintech operations.',
        items: defaultItems,
        totalItems: defaultItems.length,
        completedItems: 0,
        progress: 0,
        status: 'READY',
        jurisdictionCode: org.homeJurisdictionCode || 'KEN',
      },
    });

    checklistsCreated++;
  }

  console.log(`✅ Tenant default checklists created for ${checklistsCreated} organizations.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Tenant defaults seeding failed:', err);
  process.exit(1);
});
