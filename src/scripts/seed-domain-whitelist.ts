/**
 * Seed Script: EmailDomainWhitelist
 *
 * Seeds the known Kenyan government regulator domains.
 * Run with: pnpm tsx src/scripts/seed-domain-whitelist.ts
 *
 * Safe to run multiple times  -  uses upsert.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const REGULATOR_DOMAINS = [
  { domain: 'centralbank.go.ke', orgName: 'Central Bank of Kenya', orgType: 'regulator' },
  { domain: 'cma.or.ke', orgName: 'Capital Markets Authority', orgType: 'regulator' },
  { domain: 'ca.go.ke', orgName: 'Communications Authority of Kenya', orgType: 'regulator' },
  { domain: 'ira.go.ke', orgName: 'Insurance Regulatory Authority', orgType: 'regulator' },
  { domain: 'sasra.go.ke', orgName: 'SACCO Societies Regulatory Authority', orgType: 'regulator' },
  { domain: 'treasury.go.ke', orgName: 'National Treasury', orgType: 'regulator' },
  { domain: 'kenyalaw.org', orgName: 'Kenya Law Reform Commission', orgType: 'regulator' },
] as const;

async function main() {
  console.log('Seeding EmailDomainWhitelist...');

  for (const entry of REGULATOR_DOMAINS) {
    const result = await prisma.emailDomainWhitelist.upsert({
      where: { domain: entry.domain },
      create: { domain: entry.domain, orgName: entry.orgName, orgType: entry.orgType, isActive: true },
      update: { orgName: entry.orgName, orgType: entry.orgType, isActive: true },
    });
    console.log(`  ✔ ${result.domain} -> ${result.orgName}`);
  }

  console.log(`\nDone. Seeded ${REGULATOR_DOMAINS.length} regulator domains.`);
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
