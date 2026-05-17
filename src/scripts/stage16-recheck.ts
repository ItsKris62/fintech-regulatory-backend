import { prisma } from '@/lib/prisma/client';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { searchAndGetContext } from '@/lib/rag/rag.service';

const STUB_USER_ID = 'cmmkub4et00001ej56vw883vv';

const CASES = [
  {
    label: 'S1-recheck',
    question: 'What is the minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya?',
    stubAnswer: 'The minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya is Kshs 60 million.',
  },
  {
    label: 'S2-recheck',
    question: 'What is the registration deadline for data controllers under the Data Protection Act 2019?',
    stubAnswer: 'Under the Data Protection Act 2019, data controllers must register with the ODPC within 6 months of the Regulations taking effect.',
  },
];

async function main() {
  console.log('=== Stage 1.6 recheck (grader truncation 300→800) ===\n');

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

    const agenticComplexityLevel = PLAN_ENTITLEMENTS['REGULATOR'].agenticComplexityLevel;
    const ragCtx = await searchAndGetContext(c.question, { topK: 10, minScore: 0.7 });

    await runOrchestrator({
      complianceQueryId: cq.id,
      question: c.question,
      answer: c.stubAnswer,
      ragResults: ragCtx.results,
      agenticComplexityLevel,
      shadow: true,
    });

    const run = await prisma.complianceQueryRun.findFirst({
      where: { complianceQueryId: cq.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!run) { console.log('  ERROR: no run row'); continue; }
    const accepted = Array.isArray(run.acceptedChunkIds) ? run.acceptedChunkIds.length : 0;
    console.log(`  runId=${run.id}  accepted=${accepted}  rejected=${run.rejectedChunkCount}  grounded=${run.grounded}`);
    console.log(`  verdict=${run.verifierVerdict}  graderFailed=${run.graderFailed}  routerFallback=${run.routerParseFallback}`);
    console.log(`  unsupported=${JSON.stringify(run.unsupportedClaims)}\n`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
