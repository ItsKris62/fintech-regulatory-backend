/**
 * Stage 0 measurement script
 *
 * Usage:
 *   npx tsx src/scripts/measure-stage0.ts
 *
 * Produces:
 *   - Historical baseline from existing ComplianceQuery rows (pre-Stage-0)
 *   - Post-fix measurements across 10 questions × 3 runs each
 *   - Decision guidance against the Stage 0 acceptance gate
 */

import { prisma } from '@/lib/prisma/client';
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { AIService } from '@/lib/ai/ai.service';

const aiService = new AIService();

// ─── 10-question set (distribution: 3 simple, 3 multi-doc, 2 procedural, 2 edge) ─────

const QUESTIONS = [
  // Simple lookups
  { id: 'S1', label: 'simple', q: 'What is the minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya?' },
  { id: 'S2', label: 'simple', q: 'What is the registration deadline for data controllers under the Data Protection Act 2019?' },
  { id: 'S3', label: 'simple', q: 'What are the KYC identity verification requirements for mobile money accounts under CBK regulations?' },
  // Multi-document
  { id: 'M1', label: 'multi-doc', q: 'What AML and CFT obligations apply under both CBK regulations and FRC guidelines for a licensed digital lender in Kenya?' },
  { id: 'M2', label: 'multi-doc', q: 'How do the Data Protection Act 2019 and CBK Digital Credit Provider Regulations 2022 overlap for a fintech handling customer financial data?' },
  { id: 'M3', label: 'multi-doc', q: 'What licensing requirements must a fintech meet under both the National Payment Systems Act 2011 and the CBK Payment Service Provider framework?' },
  // Procedural
  { id: 'P1', label: 'procedural', q: 'What is the step-by-step process to obtain a Payment Service Provider licence from CBK in Kenya?' },
  { id: 'P2', label: 'procedural', q: 'How does a company apply for a Digital Credit Provider licence from the CBK?' },
  // Edge / ambiguous
  { id: 'E1', label: 'edge', q: 'What are the compliance requirements for a cryptocurrency exchange operating in Kenya?' },
  { id: 'E2', label: 'edge', q: 'How should an early-stage fintech startup handle cross-border remittances while maintaining regulatory compliance in Kenya?' },
];

interface RunResult {
  questionId: string;
  label: string;
  run: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  ragSources: number;
  grounded: boolean;
  contextChars: number;
  error?: string;
}

async function runQuestion(q: { id: string; label: string; q: string }, runNum: number): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const ragContext = await searchAndGetContext(q.q, { topK: 10, minScore: 0.7 });
    const answer = await aiService.answerComplianceQuery({
      question: q.q,
      ragContext: ragContext.context || undefined,
    });
    const wallMs = Date.now() - t0;
    return {
      questionId: q.id,
      label: q.label,
      run: runNum,
      wallMs,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      ragSources: ragContext.results.length,
      grounded: ragContext.results.length > 0,
      contextChars: ragContext.context?.length ?? 0,
    };
  } catch (err: any) {
    return {
      questionId: q.id,
      label: q.label,
      run: runNum,
      wallMs: Date.now() - t0,
      inputTokens: 0,
      outputTokens: 0,
      ragSources: 0,
      grounded: false,
      contextChars: 0,
      error: err?.message ?? String(err),
    };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function costUsd(inputTokens: number, outputTokens: number): number {
  // Haiku 4.5 pricing from ai.config.ts
  return (inputTokens / 1_000_000) * 0.80 + (outputTokens / 1_000_000) * 4.00;
}

async function getHistoricalBaseline() {
  const rows = await (prisma.complianceQuery as any).findMany({
    where: {
      processingTimeMs: { not: null },
      response: { not: null },
      // Exclude Stage-0 rows (grounded field added by this stage)
      OR: [
        { metadata: { path: ['grounded'], equals: null } },
        { metadata: { path: ['grounded'], equals: false } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { processingTimeMs: true, metadata: true, createdAt: true },
  });

  if (!rows.length) return null;

  const times = rows.map((r: any) => r.processingTimeMs as number).sort((a: number, b: number) => a - b);
  const tokensUsed = rows
    .map((r: any) => (r.metadata as any)?.tokensUsed as number | undefined)
    .filter((t: number | undefined): t is number => typeof t === 'number' && t > 0);
  const inputTokens = rows
    .map((r: any) => (r.metadata as any)?.inputTokens as number | undefined)
    .filter((t: number | undefined): t is number => typeof t === 'number' && t > 0);
  const outputTokens = rows
    .map((r: any) => (r.metadata as any)?.outputTokens as number | undefined)
    .filter((t: number | undefined): t is number => typeof t === 'number' && t > 0);

  return {
    rowCount: rows.length,
    oldest: rows[rows.length - 1]?.createdAt,
    newest: rows[0]?.createdAt,
    p50_ms: percentile(times, 0.50),
    p95_ms: percentile(times, 0.95),
    meanTokensUsed: tokensUsed.length ? Math.round(tokensUsed.reduce((a: number, b: number) => a + b, 0) / tokensUsed.length) : null,
    meanInputTokens: inputTokens.length ? Math.round(inputTokens.reduce((a: number, b: number) => a + b, 0) / inputTokens.length) : null,
    meanOutputTokens: outputTokens.length ? Math.round(outputTokens.reduce((a: number, b: number) => a + b, 0) / outputTokens.length) : null,
    note: 'Historical rows — different question set, noisier comparison than same-question baseline',
  };
}

async function main() {
  console.log('=== Stage 0 Measurement Script ===\n');

  // ── 1. Historical baseline ─────────────────────────────────────────────────
  console.log('Querying historical baseline from ComplianceQuery rows…');
  const baseline = await getHistoricalBaseline();
  if (baseline) {
    console.log(`Historical baseline (${baseline.rowCount} rows, ${baseline.oldest?.toISOString?.() ?? '?'} → ${baseline.newest?.toISOString?.() ?? '?'}):`);
    console.log(`  p50 latency : ${baseline.p50_ms} ms`);
    console.log(`  p95 latency : ${baseline.p95_ms} ms`);
    console.log(`  mean tokensUsed  : ${baseline.meanTokensUsed ?? 'n/a (field absent in historical metadata)'}`);
    console.log(`  mean inputTokens : ${baseline.meanInputTokens ?? 'n/a'}`);
    console.log(`  mean outputTokens: ${baseline.meanOutputTokens ?? 'n/a'}`);
    console.log(`  NOTE: ${baseline.note}`);
  } else {
    console.log('  No historical rows found. Skipping baseline.');
  }

  // ── 2. Post-fix measurement (10 questions × 3 runs, discard run 1) ─────────
  console.log('\nRunning 10 questions × 3 runs each (run 1 = cold-cache warm-up, discarded)…');
  console.log('This will make real Pinecone + Anthropic API calls. Estimated cost: ~$0.10–$0.30\n');

  const allResults: RunResult[] = [];

  for (const q of QUESTIONS) {
    console.log(`  ${q.id} [${q.label}]: ${q.q.slice(0, 70)}…`);
    for (let run = 1; run <= 3; run++) {
      process.stdout.write(`    run ${run}… `);
      const result = await runQuestion(q, run);
      allResults.push(result);
      if (result.error) {
        console.log(`ERROR: ${result.error}`);
      } else {
        console.log(`${result.wallMs} ms | input=${result.inputTokens} output=${result.outputTokens} | grounded=${result.grounded} ctx=${result.contextChars}ch`);
      }
      // Small delay between runs to avoid rate-limit clustering
      if (run < 3) await new Promise(r => setTimeout(r, 1500));
    }
  }

  // ── 3. Analysis — use runs 2 and 3 only (discard run 1) ──────────────────
  const usableResults = allResults.filter(r => r.run >= 2 && !r.error);
  const wallTimes = usableResults.map(r => r.wallMs).sort((a, b) => a - b);
  const p50_post = percentile(wallTimes, 0.50);
  const p95_post = percentile(wallTimes, 0.95);
  const meanInput  = Math.round(usableResults.reduce((a, r) => a + r.inputTokens, 0) / usableResults.length);
  const meanOutput = Math.round(usableResults.reduce((a, r) => a + r.outputTokens, 0) / usableResults.length);
  const meanCost   = costUsd(meanInput, meanOutput);
  const groundedCount = new Set(usableResults.filter(r => r.grounded).map(r => r.questionId)).size;
  const meanContextChars = Math.round(usableResults.filter(r => r.grounded).reduce((a, r) => a + r.contextChars, 0) / Math.max(1, usableResults.filter(r => r.grounded).length));

  // Per-label breakdown
  const labels = ['simple', 'multi-doc', 'procedural', 'edge'];
  const byLabel: Record<string, { times: number[]; inputs: number[]; outputs: number[] }> = {};
  for (const lbl of labels) {
    const sub = usableResults.filter(r => r.label === lbl);
    byLabel[lbl] = {
      times: sub.map(r => r.wallMs).sort((a, b) => a - b),
      inputs: sub.map(r => r.inputTokens),
      outputs: sub.map(r => r.outputTokens),
    };
  }

  // ── 4. Print report ──────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('Stage 0 measurements — 10 questions × 3 runs (medians of runs 2 and 3)');
  console.log('══════════════════════════════════════════════════════════\n');

  if (baseline) {
    console.log('Baseline (historical DB rows — different question set, noisier comparison):');
    console.log(`  p50 latency       : ${baseline.p50_ms} ms`);
    console.log(`  p95 latency       : ${baseline.p95_ms} ms`);
    console.log(`  Mean per-query cost: $${baseline.meanTokensUsed ? costUsd(baseline.meanInputTokens ?? 0, baseline.meanOutputTokens ?? 0).toFixed(5) : 'n/a'}`);
    console.log(`  Mean input tokens  : ${baseline.meanInputTokens ?? 'n/a'}`);
    console.log(`  Mean output tokens : ${baseline.meanOutputTokens ?? 'n/a'}`);
  }

  console.log('\nPost-fix (grounded path, runs 2–3):');
  console.log(`  p50 latency        : ${p50_post} ms${baseline ? ` (${(p50_post / baseline.p50_ms).toFixed(2)}x baseline)` : ''}`);
  console.log(`  p95 latency        : ${p95_post} ms${baseline ? ` (${(p95_post / baseline.p95_ms).toFixed(2)}x baseline)` : ''}`);
  console.log(`  Mean per-query cost: $${meanCost.toFixed(5)}`);
  console.log(`  Mean input tokens  : ${meanInput}`);
  console.log(`  Mean output tokens : ${meanOutput}`);
  console.log(`  Mean context chars : ${meanContextChars} (grounded queries)`);

  console.log('\nBreakdown by question type (post-fix):');
  for (const lbl of labels) {
    const d = byLabel[lbl];
    if (!d.times.length) continue;
    const lp50 = percentile(d.times, 0.50);
    const lMeanIn  = Math.round(d.inputs.reduce((a,b)=>a+b,0)/d.inputs.length);
    const lMeanOut = Math.round(d.outputs.reduce((a,b)=>a+b,0)/d.outputs.length);
    console.log(`  ${lbl.padEnd(12)}: p50=${lp50}ms  mean_input=${lMeanIn}  mean_output=${lMeanOut}  cost=$${costUsd(lMeanIn,lMeanOut).toFixed(5)}`);
  }

  console.log(`\nGrounding confirmed : ${groundedCount}/10 questions had grounded=true (≥1 Pinecone hit)`);
  console.log(`Errors              : ${allResults.filter(r => r.error).length} runs failed`);

  if (baseline) {
    const p95ratio = p95_post / baseline.p95_ms;
    const costRatio = baseline.meanInputTokens
      ? meanCost / costUsd(baseline.meanInputTokens, baseline.meanOutputTokens ?? 0)
      : null;
    console.log('\n── Decision ──');
    if (p95ratio <= 2.0 && (!costRatio || costRatio <= 1.4)) {
      console.log('PASS — p95 within 2x baseline, cost within 1.4x. Close Stage 0. Retrieval cache is a Stage 1 deliverable.');
    } else if (p95ratio > 2.0) {
      console.log(`BLOCK — p95 regressed ${p95ratio.toFixed(2)}x (threshold: 2.0x). Implement retrieval cache within Stage 0 before closing.`);
      console.log('Design: sheriabot:rag:ctx:v1:{sha256(question|topK|minScore)} with ex=1800 in searchAndGetContext().');
    }
    if (costRatio && costRatio > 1.4) {
      console.log(`INVESTIGATE — per-query cost regressed ${costRatio.toFixed(2)}x (threshold: 1.4x). Check input-token inflation from evidence block.`);
    }
  } else {
    console.log('\n── Decision ──');
    console.log('No historical baseline available. Fill in §C4 manually with these post-fix numbers and the baseline source.');
  }

  console.log('\n══════════════════════════════════════════════════════════\n');
}

main()
  .catch(err => { console.error('Script failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
