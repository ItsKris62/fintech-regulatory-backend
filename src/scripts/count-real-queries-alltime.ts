import { prisma } from '@/lib/prisma/client';

async function main() {
  const all = await prisma.complianceQuery.findMany({
    select: { id: true, query: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  });

  const real = all.filter(r => !(r.metadata as any)?.shadowVerification);
  const stubs = all.filter(r => (r.metadata as any)?.shadowVerification);

  console.log(`TOTAL: ${all.length}  real=${real.length}  stubs=${stubs.length}`);

  // Deduplicate by normalized query text
  const seen = new Set<string>();
  const deduped = real.filter(r => {
    const key = (r.query ?? '').toLowerCase().trim().slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nUnique real queries: ${deduped.length}`);
  deduped.forEach((r, i) =>
    console.log(`  [${i + 1}] ${r.id} | ${r.createdAt.toISOString().slice(0, 10)} | ${(r.query ?? '').slice(0, 100)}`)
  );

  await prisma.$disconnect();
}
main().catch(e => { console.error('ERROR:', e?.message); process.exit(1); });
