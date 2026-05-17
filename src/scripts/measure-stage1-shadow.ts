/**
 * Stage 1.5 shadow verification — 9 queries spanning simple / complex / weak-corpus / ambiguous.
 * Fires the orchestrator in shadow mode and prints ComplianceQueryRun row IDs for SELECT *.
 *
 * Usage: npx tsx src/scripts/measure-stage1-shadow.ts
 */

import { searchAndGetContext } from '@/lib/rag/rag.service';
import { AIService } from '@/lib/ai/ai.service';
import { runOrchestrator } from '@/modules/compliance/orchestrator';
import { prisma } from '@/lib/prisma/client';

const aiService = new AIService();

const SEED_USER_ID = 'cmmkub4et00001ej56vw883vv';

const QUESTIONS: Array<{
  id: string;
  label: string;
  complexity: 'simple' | 'complex';
  q: string;
}> = [
  // Simple lookups
  { id: 'S1', label: 'simple',    complexity: 'simple',  q: 'What is the minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya?' },
  { id: 'S2', label: 'simple',    complexity: 'simple',  q: 'What is the registration deadline for data controllers under the Data Protection Act 2019?' },
  // Complex — on simple-tier plan → should trigger routeDowngraded
  { id: 'C1', label: 'complex/downgrade', complexity: 'simple',  q: 'What AML and CFT obligations apply under both CBK regulations and FRC guidelines for a licensed digital lender in Kenya, and how do reporting timelines differ between the two frameworks?' },
  // Complex — on complex-tier plan → should NOT downgrade
  { id: 'C2', label: 'complex',   complexity: 'complex', q: 'What licensing requirements must a fintech meet under both the National Payment Systems Act 2011 and the CBK Payment Service Provider framework, and what are the capital adequacy thresholds for each licence category?' },
  { id: 'C3', label: 'complex/downgrade', complexity: 'simple',  q: 'How do the Data Protection Act 2019 and CBK Digital Credit Provider Regulations 2022 overlap for a fintech handling customer financial data, including breach notification timelines and penalties?' },
  // Weak corpus coverage — verifier should flag unsupported claims
  { id: 'W1', label: 'weak',      complexity: 'simple',  q: 'What are the compliance requirements for a cryptocurrency exchange operating in Kenya?' },
  { id: 'W2', label: 'weak',      complexity: 'simple',  q: 'What regulations govern buy-now-pay-later products offered by non-bank fintechs in Kenya?' },
  // Ambiguous
  { id: 'A1', label: 'ambiguous', complexity: 'simple',  q: 'How should an early-stage fintech handle cross-border remittances while maintaining regulatory compliance in Kenya?' },
  { id: 'A2', label: 'ambiguous', complexity: 'simple',  q: 'Is it legal to operate a peer-to-peer lending platform in Kenya without a CBK licence?' },
];

async function main() {
  console.log('=== Stage 1.5 shadow verification ===\n');

  const runIds: string[] = [];

  for (const q of QUESTIONS) {
    console.log(`${q.id} [${q.label}]: ${q.q.slice(0, 70)}…`);

    // Create minimal ComplianceQuery row for FK
    const stub = await (prisma.complianceQuery as any).create({
      data: {
        query:    q.q,
        userId:   SEED_USER_ID,
        status:   'processing',
        metadata: { shadowVerification: true, label: q.label },
      },
    }) as { id: string };

    const ragCtx = await searchAndGetContext(q.q, { topK: 10, minScore: 0.7 });
    const answer = await aiService.answerComplianceQuery({
      question:   q.q,
      ragContext: ragCtx.context || undefined,
    });

    await runOrchestrator({
      complianceQueryId:      stub.id,
      question:               q.q,
      answer:                 answer.content,
      ragResults:             ragCtx.results,
      agenticComplexityLevel: q.complexity,
      shadow:                 true,
    });

    // Fetch the run row just written
    const run = await prisma.complianceQueryRun.findFirst({
      where:   { complianceQueryId: stub.id },
      orderBy: { createdAt: 'desc' },
    });

    if (run) {
      runIds.push(run.id);
      console.log(`  runId=${run.id}  route=${run.route}  confidence=${run.routeConfidence}  downgraded=${run.routeDowngraded}  verdict=${run.verifierVerdict}  unsupported=${(run.unsupportedClaims as string[] | null)?.length ?? 0}  accepted=${(run.acceptedChunkIds as any[] | null)?.length ?? 0}  rejected=${run.rejectedChunkCount}`);
    } else {
      console.log('  ERROR: no run row found');
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n=== Run IDs for SELECT * ===');
  console.log(runIds.map(id => `'${id}'`).join(', '));
  console.log('\nDone.');
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
