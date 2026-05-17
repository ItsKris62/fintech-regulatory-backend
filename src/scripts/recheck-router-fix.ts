import { prisma } from '@/lib/prisma/client';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';

const STUB_USER_ID = 'cmmkub4et00001ej56vw883vv';

const CASES = [
  {
    label: 'C1-recheck',
    tier: 'simple' as const,
    question: 'What AML and CFT obligations apply under both CBK regulations and FRC guidelines for a licensed digital lender in Kenya, and how do reporting timelines differ between the two frameworks?',
  },
  {
    label: 'C3-recheck',
    tier: 'simple' as const,
    question: 'How do the Data Protection Act 2019 and CBK Digital Credit Provider Regulations interact for a licensed DCP, and what are the key compliance obligations under each?',
  },
  {
    label: 'W2-recheck',
    tier: 'simple' as const,
    question: 'What regulations govern buy-now-pay-later products offered by non-bank fintechs in Kenya?',
  },
  {
    label: 'A1-recheck',
    tier: 'simple' as const,
    question: 'How should an early-stage fintech handle cross-border remittances while minimising regulatory capital requirements and licensing costs in Kenya?',
  },
];

async function main() {
  console.log('=== Router fix recheck ===\n');

  for (const c of CASES) {
    console.log(`${c.label}: ${c.question.slice(0, 70)}…`);

    const cq = await prisma.complianceQuery.create({
      data: {
        query: c.question,
        userId: STUB_USER_ID,
        status: 'processing',
        metadata: { shadowVerification: true, label: c.label },
      },
    });

    // Minimal answer stub for verifier
    const stubAnswer = 'This is a stub answer for router fix verification.';
    const agenticComplexityLevel = PLAN_ENTITLEMENTS[c.tier === 'simple' ? 'REGULATOR' : 'ENTERPRISE'].agenticComplexityLevel;

    // Import RAG results
    const { searchAndGetContext } = await import('@/lib/rag/rag.service');
    const ragCtx = await searchAndGetContext(c.question, { topK: 10, minScore: 0.7 });

    await runOrchestrator({
      complianceQueryId: cq.id,
      question: c.question,
      answer: stubAnswer,
      ragResults: ragCtx.results,
      agenticComplexityLevel,
      shadow: true,
    });

    const run = await prisma.complianceQueryRun.findFirst({
      where: { complianceQueryId: cq.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!run) { console.log('  ERROR: no run row found'); continue; }

    console.log(`  runId=${run.id}  route=${run.route}  confidence=${run.routeConfidence}  routerFallback=${run.routerParseFallback}  router_out=${(run.controlTokens as any)?.router?.output ?? '?'}`);
    console.log(`  downgraded=${run.routeDowngraded}  verdict=${run.verifierVerdict}  graderFailed=${run.graderFailed}  fallback=${run.fallbackReason ?? 'null'}\n`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
