import { prisma } from '@/lib/prisma/client';

const RUN_IDS = [
  'cmp8s3plt0001y0s50v5ovyp5',
  'cmp8s4ld50003y0s5eegqhp6v',
  'cmp8s5e950005y0s5t32z9xen',
  'cmp8s664u0007y0s58qzt61ii',
  'cmp8s71da0009y0s5pgk2ltv1',
  'cmp8s7u1a000by0s5t0rp1dyr',
  'cmp8s8p97000dy0s5t6yima8t',
  'cmp8s9kv8000fy0s5wqva11v0',
  'cmp8sag4f000hy0s51cts0rsb',
];

async function main() {
  const runs = await prisma.complianceQueryRun.findMany({
    where: { id: { in: RUN_IDS } },
    orderBy: { createdAt: 'asc' },
  });

  for (const r of runs) {
    const acceptedCount = Array.isArray(r.acceptedChunkIds)
      ? (r.acceptedChunkIds as unknown[]).length
      : 0;
    console.log(JSON.stringify({
      id:                    r.id,
      route:                 r.route,
      routeConfidence:       r.routeConfidence,
      routeDowngraded:       r.routeDowngraded,
      routeDowngradeReason:  r.routeDowngradeReason,
      routerParseFallback:   r.routerParseFallback,
      fallbackReason:        r.fallbackReason,
      grounded:              r.grounded,
      ragSources:            r.ragSources,
      gradeChunksInspected:  r.gradeChunksInspected,
      rejectedChunkCount:    r.rejectedChunkCount,
      verifierVerdict:       r.verifierVerdict,
      verifierParseFallback: r.verifierParseFallback,
      unsupportedClaims:     r.unsupportedClaims,
      inputTokens:           r.inputTokens,
      outputTokens:          r.outputTokens,
      tokenBudgetExceeded:   r.tokenBudgetExceeded,
      graderFailed:          r.graderFailed,
      status:                r.status,
      wallMs:                r.wallMs,
      subQuestions:          r.subQuestions,
      acceptedChunkCount:    acceptedCount,
    }));
  }

  console.log(`\nTotal rows: ${runs.length}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
