import { prisma } from '@/lib/prisma/client';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { PLAN_ENTITLEMENTS } from '@/config/entitlements.config';
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { complete } from '@/lib/ai/client';

const STUB_USER_ID = 'cmmkub4et00001ej56vw883vv';

const REAL_QUERIES: Array<{ label: string; question: string }> = [
  { label: 'R01', question: 'How do I comply with the Data Protection Act for mobile money?' },
  { label: 'R02', question: 'I have a podcast and i want to know what are the regulations and compliance i need to follow up on' },
  { label: 'R03', question: 'What are the CBK reporting requirements for payment service providers?' },
  { label: 'R04', question: 'AML compliance requirements for cryptocurrency exchanges' },
  { label: 'R05', question: 'In light of the CBK Draft Cyber Security Guidelines for Payment Service Providers, what are the mandatory requirements for a licensed PSP operating in Kenya?' },
  { label: 'R06', question: 'If an independent security researcher discovers an exposed API in our mobile banking app during a Code of Practice assessment, what are the disclosure obligations under CBK guidelines?' },
  { label: 'R07', question: 'Under the Draft CBK Non-Deposit Taking Credit Providers Regulations, at what exact capital threshold does a non-deposit taking credit provider require a Tier 1 licence?' },
  { label: 'R08', question: 'I am building a mobile application that will be offering mobile loans with short to medium payment period in Kenya. What are the relevant compliance requirements?' },
  { label: 'R09', question: 'regulations of the gaming industry' },
  { label: 'R10', question: 'hi what is your name' },
  { label: 'R11', question: 'What are some of the key aspects for implementing a mobile lending platform' },
  { label: 'R12', question: 'What are the KYC requirements for digital lenders in Kenya?' },
  { label: 'R13', question: 'I am planning on creating an online money lending platform for small enterprises and customers in Kenya. What are the regulations I need to follow?' },
  { label: 'R14', question: 'Why is christopher rateng codng this website' },
  { label: 'R15', question: 'who is the owner of this website sheriabot.com' },
  { label: 'R16', question: 'i want to open a compliance website and host it online for the ke market, what regulations do i need to follow' },
  { label: 'R17', question: 'we ni mbwa' },
  { label: 'R18', question: 'why is rateng a fool when it comes to financial management' },
  { label: 'R19', question: 'Consumer protection obligations for fintech companies' },
];

async function answerQuestion(question: string, ragResults: Awaited<ReturnType<typeof searchAndGetContext>>['results']): Promise<string> {
  const evidenceBlock = ragResults.slice(0, 5)
    .map(r => `[${r.documentTitle}${r.section ? ` § ${r.section}` : ''}]: ${r.chunkText.slice(0, 300)}`)
    .join('\n\n');

  const systemPrompt = 'You are SheriaBot, a Kenyan financial-services compliance assistant. Answer using only the provided evidence. Be concise.';
  const prompt = evidenceBlock
    ? `Evidence:\n${evidenceBlock}\n\nQuestion: ${question}`
    : `Question: ${question}`;

  const result = await complete(
    { prompt, systemPrompt, maxTokens: 600, temperature: 0.0 },
    'query'
  );
  return result.content;
}

async function main() {
  console.log('=== Stage 2 shadow re-baseline (19 real pilot queries) ===\n');
  console.log(`Note: Only ${REAL_QUERIES.length} unique real pilot queries exist all-time (early pilot phase).`);
  console.log('Includes 12 substantive compliance questions + 7 off-topic/test inputs.\n');

  const runIds: string[] = [];

  for (const c of REAL_QUERIES) {
    process.stdout.write(`${c.label}: ${c.question.slice(0, 70)}...\n`);

    const cq = await prisma.complianceQuery.create({
      data: {
        query: c.question,
        userId: STUB_USER_ID,
        status: 'processing',
        metadata: { shadowVerification: true, label: `rebaseline-${c.label}` },
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
    const accepted = Array.isArray(run.acceptedChunkIds) ? run.acceptedChunkIds.length : 0;
    process.stdout.write(
      `  runId=${run.id}  route=${run.route}  conf=${run.routeConfidence}` +
      `  downgraded=${run.routeDowngraded}  grounded=${run.grounded}` +
      `  accepted=${accepted}  verdict=${run.verifierVerdict}` +
      `  routerFallback=${run.routerParseFallback}\n\n`
    );
  }

  // Summary
  const SEP = '='.repeat(70);
  console.log('\n' + SEP + '\nSUMMARY\n' + SEP);

  const runs = await prisma.complianceQueryRun.findMany({
    where: { id: { in: runIds } },
  });

  const total = runs.length;
  const grounded = runs.filter(r => r.grounded).length;
  const ungrounded = total - grounded;
  const abstainRoute = runs.filter(r => r.route === 'abstain').length;
  const simpleRoute = runs.filter(r => r.route === 'simple').length;
  const complexRoute = runs.filter(r => r.route === 'complex').length;
  const downgraded = runs.filter(r => r.routeDowngraded).length;
  const pass = runs.filter(r => r.verifierVerdict === 'PASS').length;
  const partial = runs.filter(r => r.verifierVerdict === 'PARTIAL').length;
  const fail = runs.filter(r => r.verifierVerdict === 'FAIL').length;
  const routerFail = runs.filter(r => r.routerParseFallback).length;
  const graderFail = runs.filter(r => r.graderFailed).length;
  const verifierFail = runs.filter(r => r.verifierParseFallback).length;
  const abstentionRate = total > 0 ? ((ungrounded / total) * 100).toFixed(1) : 'N/A';

  console.log(`\nTotal processed:  ${total}/${REAL_QUERIES.length}`);
  console.log(`\nRouting:`);
  console.log(`  simple=${simpleRoute}  complex=${complexRoute}  abstain=${abstainRoute}  downgraded=${downgraded}`);
  console.log(`\nGrounding (acceptedChunks > 0):`);
  console.log(`  grounded=${grounded}  ungrounded=${ungrounded}  abstention_rate=${abstentionRate}%`);
  console.log(`\nVerdict distribution:`);
  console.log(`  PASS=${pass}  PARTIAL=${partial}  FAIL=${fail}`);
  console.log(`\nParse reliability:`);
  console.log(`  routerFail=${routerFail}  graderFail=${graderFail}  verifierFail=${verifierFail}`);

  console.log(`\nAbstention cases (grounded=false):`);
  for (const r of runs.filter(run => !run.grounded)) {
    const cq = await prisma.complianceQuery.findUnique({
      where: { id: r.complianceQueryId },
      select: { query: true, metadata: true },
    });
    const label = (cq?.metadata as any)?.label ?? '?';
    const accepted = Array.isArray(r.acceptedChunkIds) ? r.acceptedChunkIds.length : 0;
    console.log(`  ${label}: "${(cq?.query ?? '').slice(0, 90)}"  route=${r.route}  accepted=${accepted}  verdict=${r.verifierVerdict}`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error('FATAL:', String(e?.message)); process.exit(1); });
