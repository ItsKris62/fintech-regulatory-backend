/**
 * Phase B Batch 2 -- read-only audit of Contact/Company segmentation fields.
 * Gitignored; run with: pnpm tsx scripts/audit-contact-segmentation-data.ts
 *
 * Reports the real distribution of Contact.tags, Contact.primaryRegulator, and
 * Company.regulatorMix so dynamic ContactList segmentation is built against
 * actual data, not assumed values.
 */

import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';

logger.level = 'silent';

async function main() {
  const totalContacts = await prisma.contact.count({ where: { deletedAt: null } });
  const totalCompanies = await prisma.company.count({ where: { deletedAt: null } });

  console.log(`\n=== Totals ===`);
  console.log(`Contacts (not deleted): ${totalContacts}`);
  console.log(`Companies (not deleted): ${totalCompanies}`);

  const contacts = await prisma.contact.findMany({
    where: { deletedAt: null },
    select: { id: true, primaryRegulator: true, tags: true, companyId: true },
  });

  console.log(`\n=== Contact.primaryRegulator distribution ===`);
  const regulatorCounts = new Map<string, number>();
  for (const c of contacts) {
    const key = c.primaryRegulator === null || c.primaryRegulator === undefined || c.primaryRegulator === ''
      ? '(null/empty)'
      : c.primaryRegulator;
    regulatorCounts.set(key, (regulatorCounts.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...regulatorCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${JSON.stringify(k)}: ${v}`);
  }

  console.log(`\n=== Contact.tags distribution ===`);
  const tagCounts = new Map<string, number>();
  let contactsWithNoTags = 0;
  for (const c of contacts) {
    if (!c.tags || c.tags.length === 0) { contactsWithNoTags++; continue; }
    for (const t of c.tags) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  console.log(`  Contacts with no tags: ${contactsWithNoTags}`);
  for (const [k, v] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${JSON.stringify(k)}: ${v}`);
  }

  const companies = await prisma.company.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, regulatorMix: true },
  });

  console.log(`\n=== Company.regulatorMix distribution ===`);
  const mixCounts = new Map<string, number>();
  let companiesWithNoMix = 0;
  for (const co of companies) {
    if (!co.regulatorMix || co.regulatorMix.length === 0) { companiesWithNoMix++; continue; }
    for (const r of co.regulatorMix) {
      mixCounts.set(r, (mixCounts.get(r) ?? 0) + 1);
    }
  }
  console.log(`  Companies with no regulatorMix: ${companiesWithNoMix}`);
  for (const [k, v] of [...mixCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${JSON.stringify(k)}: ${v}`);
  }

  console.log(`\n=== Contacts with no companyId (regulatorMix via company unreachable) ===`);
  console.log(`  ${contacts.filter((c) => !c.companyId).length} of ${contacts.length}`);
}

main()
  .catch((err) => {
    console.error('AUDIT FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
