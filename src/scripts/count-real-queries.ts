import { prisma } from '@/lib/prisma/client';

async function main() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const all = await prisma.complianceQuery.findMany({
    where: { createdAt: { gt: cutoff } },
    select: { id: true, query: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  });

  const real = all.filter(r => !(r.metadata as any)?.shadowVerification);
  const stubs = all.filter(r => (r.metadata as any)?.shadowVerification);

  console.log(`real=${real.length} stubs=${stubs.length} total=${all.length}`);
  console.log('\nReal queries:');
  real.forEach(r => console.log(`  ${r.id} | ${r.createdAt.toISOString().slice(0,10)} | ${(r.query ?? '').slice(0,90)}`));

  await prisma.$disconnect();
}
main().catch(e => { console.error('ERROR:', e?.message); process.exit(1); });
