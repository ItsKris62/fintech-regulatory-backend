/**
 * Stage 0 ungrounded-path baseline measurement (3 representative questions × 2 runs)
 * Simulates the pre-Stage-0 path: RAG search runs but ragContext is NOT injected.
 * maxTokens = aiConfig.parameters.queryMaxTokens (2000) — old default.
 *
 * Usage: npx tsx src/scripts/measure-stage0-baseline.ts
 */

import { searchAndGetContext } from '@/lib/rag/rag.service';
import { AIService } from '@/lib/ai/ai.service';

const aiService = new AIService();

const QUESTIONS = [
  { id: 'S1', label: 'simple',      q: 'What is the minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya?' },
  { id: 'M1', label: 'multi-doc',   q: 'What AML and CFT obligations apply under both CBK regulations and FRC guidelines for a licensed digital lender in Kenya?' },
  { id: 'P1', label: 'procedural',  q: 'What is the step-by-step process to obtain a Payment Service Provider licence from CBK in Kenya?' },
];

async function main() {
  console.log('=== Ungrounded baseline (pre-Stage-0 path) ===\n');
  for (const q of QUESTIONS) {
    console.log(`${q.id} [${q.label}]: ${q.q.slice(0, 65)}…`);
    for (let run = 1; run <= 2; run++) {
      const t0 = Date.now();
      // Retrieve context (mirrors current router) but do NOT inject it
      await searchAndGetContext(q.q, { topK: 10, minScore: 0.7 });
      // Call with no ragContext — reproduces old behavior
      const answer = await aiService.answerComplianceQuery({ question: q.q });
      const ms = Date.now() - t0;
      console.log(`  run ${run}: ${ms} ms | input=${answer.inputTokens} output=${answer.outputTokens} | cost=$${((answer.inputTokens/1e6)*0.80 + (answer.outputTokens/1e6)*4.0).toFixed(5)}`);
      if (run < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  console.log('\nDone.');
}

main().catch(console.error);
