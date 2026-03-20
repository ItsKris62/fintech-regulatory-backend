/**
 * Seed script for RegulatoryFramework table
 * 
 * This script safely seeds the regulatory frameworks without affecting existing data.
 * Run with: npx tsx src/scripts/seed-regulatory-frameworks.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const frameworks = [
  // STARTUP Tier
  {
    slug: 'dpa-2019',
    name: 'Data Protection Act 2019',
    category: 'Data Protection',
    description: null,
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 1,
  },
  {
    slug: 'odpc-regs-2021',
    name: 'ODPC Data Protection Regulations 2021',
    category: 'Data Protection',
    description: null,
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 2,
  },
  {
    slug: 'cbk-prudential',
    name: 'CBK Prudential Guidelines',
    category: 'Banking',
    description: null,
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 3,
  },
  {
    slug: 'nps-2011',
    name: 'National Payment System Act 2011',
    category: 'Payments',
    description: null,
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 4,
  },
  {
    slug: 'pocamla',
    name: 'POCAMLA (Anti-Money Laundering)',
    category: 'AML/CFT',
    description: null,
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 5,
  },
  {
    slug: 'cbk-cyber',
    name: 'CBK Cybersecurity Guidance Note',
    category: 'Cybersecurity',
    description: null,
    tier: 'STARTUP',
    isActive: true,
    sortOrder: 6,
  },
  
  // BUSINESS Tier
  {
    slug: 'consumer-protection',
    name: 'Consumer Protection Guidelines',
    category: 'Consumer Protection',
    description: null,
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 7,
  },
  {
    slug: 'dcpr-2022',
    name: 'Digital Credit Providers Regulations 2022',
    category: 'Lending',
    description: null,
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 8,
  },
  {
    slug: 'cma-act',
    name: 'Capital Markets Authority Act',
    category: 'Capital Markets',
    description: null,
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 9,
  },
  {
    slug: 'kica',
    name: 'Kenya Information and Communications Act',
    category: 'ICT',
    description: null,
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 10,
  },
  {
    slug: 'microfinance-2006',
    name: 'Microfinance Act 2006',
    category: 'Lending',
    description: null,
    tier: 'BUSINESS',
    isActive: true,
    sortOrder: 11,
  },
  
  // ENTERPRISE Tier
  {
    slug: 'iso-27001',
    name: 'ISO 27001',
    category: 'International Standards',
    description: null,
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 12,
  },
  {
    slug: 'pci-dss',
    name: 'PCI-DSS',
    category: 'International Standards',
    description: null,
    tier: 'ENTERPRISE',
    isActive: true,
    sortOrder: 13,
  },
];

async function main() {
  console.log('🌱 Starting RegulatoryFramework seed...\n');

  // Check if table exists and has data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rf = (prisma as any).regulatoryFramework;
  const existingCount = await rf.count() as number;

  if (existingCount > 0) {
    console.log(`⚠️  Found ${existingCount} existing frameworks.`);
    console.log('   Skipping seed to avoid duplicates.');
    console.log('   If you want to re-seed, delete existing records first.\n');
    return;
  }

  console.log('📝 Seeding regulatory frameworks...\n');

  let successCount = 0;
  let errorCount = 0;

  for (const framework of frameworks) {
    try {
      await rf.create({ data: framework });
      console.log(`✅ Created: ${framework.name} (${framework.tier})`);
      successCount++;
    } catch (error) {
      console.error(`❌ Failed to create ${framework.name}:`, error);
      errorCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`✨ Seed completed!`);
  console.log(`   Success: ${successCount} frameworks`);
  console.log(`   Errors: ${errorCount} frameworks`);
  console.log('='.repeat(60) + '\n');

  // Verify the data
  const finalCount = await rf.count() as number;
  console.log(`📊 Total frameworks in database: ${finalCount}\n`);

  // Show breakdown by tier
  const byTier = await rf.groupBy({ by: ['tier'], _count: true }) as Array<{ tier: string; _count: number }>;

  console.log('📈 Breakdown by tier:');
  byTier.forEach(({ tier, _count }) => {
    console.log(`   ${tier}: ${_count} frameworks`);
  });
  console.log('');
}

main()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
