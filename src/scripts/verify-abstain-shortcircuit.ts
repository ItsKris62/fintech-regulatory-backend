import { prisma } from '@/lib/prisma/client';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { complete } from '@/lib/ai/client';

const STUB_USER_ID = 'cmmkub4et00001ej56vw883vv';

const ABSTAIN_QUERIES: Array<{ label: string; question: string }> = [
  { label: 'V01', question: "What will the weather be like in Nairobi this weekend?" },
  { label: 'V02', question: "What are the US SEC rules for registered investment advisers?" },
  { label: 'V03', question: "What are the fintech licensing requirements in Tanzania?" },
];

async function answerQuestion(question: string, ragResults: Awaited<ReturnType<typeof searchAndGetContext>>['results']): Promise<string> {
  const evidenceBlock = ragResults.slice(0, 5)
    .map(r => `[${r.documentTitle}${r.section ? ` § ${r.section}` : ''}]: ${r.chunkText.slice(0, 300)}`)
    .join('\n\n');
  const systemPrompt = 'You are SheriaBot, a Kenyan financial-services compliance assistant. Answer using only the provided evidence. Be concise.';
  const prompt = evidenceBlock
    ? `Evidence:\n${evidenceBlock}\n\nQuestion: ${question}`
    : `Question: ${question}`;
  const result = await complete({ prompt, systemPrompt, maxTokens: 600, temperature: 0.0 }, 'query');
  return result.content;
}

async function main() {
  console.log('=== Abstain short-circuit verification (3 off-topic queries) ===\n');
  console.log('Expected: route=abstain, grounded=false, gradeChunksInspected=0,');
  console.log('          verifierVerdict=null, accepted=0, wallMs<3000ms\n');

  const runIds: string[] = [];

  for (const c of ABSTAIN_QUERIES) {
    process.stdout.write(`${c.label}: ${c.question}\n`);

    const cq = await prisma.complianceQuery.create({
      data: {
        query: c.question,
        userId: STUB_USER_ID,
        status: 'processing',
        metadata: { shadowVerification: true, label: `abstain-verify-${c.label}` },
      },
    });

    try {
      const ragCtx = await searchAndGetContext(c.question, { topK: 10, minScore: 0.7 });
      const answer = await answerQuestion(c.question, ragCtx.results);

      await runOrchestrator({
        complianceQueryId: cq.id,
        question: c.question,
        answer,
        ragResults: ragCtx.results,
        agenticComplexityLevel: PLAN_ENTITLEMENTS['REGULATOR'].agenticComplexityLevel,
        shadow: true,
      });
    } catch (err: any) {
      process.stdout.write(`  ERROR: ${String(err?.message)}\n`);
      continue;
    }

    const run = await prisma.complianceQueryRun.findFirst({
      where: { complianceQueryId: cq.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!run) { process.stdout.write('  ERROR: no run row\n'); continue; }

    runIds.push(run.id);

    const accepted = Array.isArray(run.acceptedChunkIds) ? (run.acceptedChunkIds as any[]).length : 0;
    const controlTokens = run.controlTokens as any;
    const hasGrader   = !!controlTokens?.grader;
    const hasVerifier = !!controlTokens?.verifier;

    const PASS = run.route === 'abstain' && !run.grounded && run.gradeChunksInspected === 0 && accepted === 0 && run.verifierVerdict === null && !hasGrader && !hasVerifier;

    process.stdout.write(
      `  runId=${run.id}\n` +
      `  route=${run.route}  conf=${run.routeConfidence}  grounded=${run.grounded}\n` +
      `  gradeChunksInspected=${run.gradeChunksInspected}  accepted=${accepted}  rejectedChunkCount=${run.rejectedChunkCount}\n` +
      `  verifierVerdict=${run.verifierVerdict}  graderFailed=${run.graderFailed}\n` +
      `  controlTokens.grader=${hasGrader}  controlTokens.verifier=${hasVerifier}\n` +
      `  inputTokens=${run.inputTokens}  outputTokens=${run.outputTokens}\n` +
      `  routerParseFallback=${run.routerParseFallback}  wallMs=${run.wallMs}\n` +
      `  SHORT_CIRCUIT_OK=${PASS}\n\n`
    );
  }

  const allPass = runIds.length === ABSTAIN_QUERIES.length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Runs written: ${runIds.length}/${ABSTAIN_QUERIES.length}`);
  if (!allPass) console.log('WARNING: some runs missing — check errors above');

  await prisma.$disconnect();
}

main().catch(e => { console.error('FATAL:', String(e?.message)); process.exit(1); });
