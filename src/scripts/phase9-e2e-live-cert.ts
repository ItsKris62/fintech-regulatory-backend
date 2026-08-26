import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ragService, searchAndGetRegulatoryEvidenceContext } from '../lib/rag/rag.service';
import { runGraderAgent } from '../modules/compliance/orchestrator/grader.agent';
import { aiService } from '../lib/ai/ai.service';
import { verifyAnswerClaims } from '../lib/source-grounding/claim-verification';
import { buildCitationsFromChunks, validateCitationsForJurisdiction } from '../lib/source-grounding/citations';
import { resolveJurisdictionContext } from '../types/jurisdiction';
import { complete } from '../lib/ai/client';

const OUT_DIR = path.join(__dirname, '../../../uat-results');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  SHERIABOT PHASE 9 — LIVE MULTI-COUNTRY RAG CERTIFICATION RUNNER');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const results: Record<string, any> = {
    timestamp: new Date().toISOString(),
    gateA: {},
    preflight: {},
    gateB: {},
    gateC: {},
    gateD: {},
  };

  // ───────────────────────────────────────────────────────────────────────────
  // GATE A: Health Probe (Minimal token spend)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('── [GATE A] Minimal Anthropic Provider Health Probe ─────────────────');
  const probeT0 = Date.now();
  const probeRes = await complete({
    prompt: 'Reply with the single word HEALTHY',
    model: 'anthropic:claude-sonnet-4-6',
    maxTokens: 10,
    temperature: 0,
  }, 'query');
  const probeLatency = Date.now() - probeT0;

  console.log(`Probe Status: ${probeRes.content.trim()} | Latency: ${probeLatency}ms | Tokens: in=${probeRes.inputTokens}, out=${probeRes.outputTokens} | Cost: $${probeRes.cost.toFixed(6)}`);
  results.gateA = {
    status: probeRes.content.trim(),
    latencyMs: probeLatency,
    inputTokens: probeRes.inputTokens,
    outputTokens: probeRes.outputTokens,
    cost: probeRes.cost,
    model: probeRes.model,
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PREFLIGHT: Deterministic Pinecone Vector Retrieval (0 LLM Tokens)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── [PREFLIGHT] Deterministic Vector Isolation & Retrieval Checks ────');
  const sampleQuestion = 'What are the main licensing requirements that a payment service provider must satisfy?';
  const preflightResults: Record<string, any> = {};

  for (const jcode of ['KE', 'RW', 'MW'] as const) {
    const jContext = resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: [jcode] });
    const ragContext = await searchAndGetRegulatoryEvidenceContext({
      query: sampleQuestion,
      jurisdictionContext: jContext,
      topK: 5,
      preferActiveSources: true,
    });

    const foreignChunks = ragContext.results.filter(r => r.jurisdictionCode !== jcode);
    console.log(`[${jcode} Preflight] Total Chunks: ${ragContext.results.length} | Foreign Chunks: ${foreignChunks.length} | Top Document: "${ragContext.results[0]?.documentTitle}" (score: ${ragContext.results[0]?.score?.toFixed(4)})`);
    
    if (foreignChunks.length > 0) {
      throw new Error(`CRITICAL ISOLATION BREACH: Found foreign chunk in ${jcode} retrieval!`);
    }

    preflightResults[jcode] = {
      chunksCount: ragContext.results.length,
      foreignChunksCount: foreignChunks.length,
      topDoc: ragContext.results[0]?.documentTitle,
      topScore: ragContext.results[0]?.score,
    };
  }
  results.preflight = preflightResults;

  // ───────────────────────────────────────────────────────────────────────────
  // GATE B: Live Compliance Query Certification (1 KE, 1 RW, 1 MW)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── [GATE B] Live Compliance Query Certification ─────────────────────');
  const queryPrompts: Record<string, string> = {
    KE: 'What are the main licensing requirements that a payment service provider must satisfy in Kenya?',
    RW: 'What are the main licensing requirements that a payment service provider must satisfy in Rwanda?',
    MW: 'What are the main licensing requirements that a payment service provider must satisfy in Malawi?',
  };

  const gateBResults: Record<string, any> = {};

  for (const jcode of ['KE', 'RW', 'MW'] as const) {
    console.log(`\n▶ [Gate B - ${jcode}] Executing live compliance query...`);
    const jContext = resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: [jcode] });
    const qT0 = Date.now();

    // 1. Vector Retrieval
    const ragContext = await searchAndGetRegulatoryEvidenceContext({
      query: queryPrompts[jcode],
      jurisdictionContext: jContext,
      topK: 10,
      minScore: 0.7,
      preferActiveSources: true,
    });

    // 2. Grader Agent
    const grade = await runGraderAgent(queryPrompts[jcode], ragContext.results, jContext, 10);
    const acceptedContext = ragService.getContextForPrompt(grade.accepted, 10, 4000);

    // 3. Synthesis
    const answer = await aiService.answerComplianceQuery({
      question: queryPrompts[jcode],
      organizationType: 'FINTECH',
      jurisdictionContext: jContext,
      ragContext: acceptedContext || undefined,
    });

    // 4. Claims Verification
    const claimVerification = verifyAnswerClaims(answer.content, grade.accepted);

    // 5. Citations & Validation
    const citations = buildCitationsFromChunks(grade.accepted, 'verified');
    const citationValidation = validateCitationsForJurisdiction(citations, jContext);

    const qWallMs = Date.now() - qT0;

    console.log(`  Grader: retrieved=${ragContext.results.length}, accepted=${grade.accepted.length}, rejected=${grade.rejected.length}`);
    console.log(`  Verifier Verdict: ${claimVerification.verdict} (supported=${claimVerification.supportedClaims.length}, unsupported=${claimVerification.unsupportedClaims.length})`);
    console.log(`  Citations Valid: ${citationValidation.valid} (${citations.length} citations)`);
    console.log(`  Latency: ${qWallMs}ms | Tokens: in=${answer.inputTokens}, out=${answer.outputTokens} | Cost: $${answer.cost.toFixed(6)}`);
    console.log(`  Answer Preview:\n${answer.content.slice(0, 350)}...\n`);

    gateBResults[jcode] = {
      question: queryPrompts[jcode],
      latencyMs: qWallMs,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      cost: answer.cost,
      retrievedCount: ragContext.results.length,
      acceptedCount: grade.accepted.length,
      rejectedCount: grade.rejected.length,
      verifierVerdict: claimVerification.verdict,
      supportedClaimsCount: claimVerification.supportedClaims.length,
      unsupportedClaimsCount: claimVerification.unsupportedClaims.length,
      citationsCount: citations.length,
      citationsValid: citationValidation.valid,
      topCitations: citations.slice(0, 3).map(c => ({ title: c.documentTitle, section: c.section })),
      answerContent: answer.content,
    };
  }
  results.gateB = gateBResults;

  // ───────────────────────────────────────────────────────────────────────────
  // GATE C: Live Gap Analysis Certification (1 KE, 1 RW, 1 MW)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── [GATE C] Live Gap Analysis Certification ─────────────────────────');
  const syntheticPolicies: Record<string, string> = {
    KE: `KENYA PAYMENT FINTECH COMPLIANCE POLICY
1. Customer Due Diligence (Compliant): The company verifies customer identities using official Kenyan National ID or Passport before issuing electronic wallets.
2. Data Protection Officer (Partial): The company processes customer transactional data but has not formally registered a certified DPO with the Office of the Data Protection Commissioner (ODPC).
3. Incident Notification (Missing Gap): The policy contains no 72-hour mandatory breach notification procedure to the ODPC or the Central Bank of Kenya.
4. Capital Buffer (Ambiguous): Reserve funds are reviewed annually by the board.`,

    RW: `RWANDA DIGITAL PAYMENT INSTITUTION COMPLIANCE POLICY
1. AML Transaction Monitoring (Compliant): The institution maintains real-time monitoring and submits suspicious transaction reports to the Financial Intelligence Centre (FIC).
2. Data Privacy & Transfer (Partial): Customer data is stored on foreign cloud servers without formal cross-border transfer certificates from the National Cyber Security Authority (NCSA).
3. Consumer Dispute Handling (Missing Gap): The policy lacks a mandatory 15-day dispute resolution mechanism compliant with National Bank of Rwanda (BNR) directives.
4. Capital Reserves (Ambiguous): Management monitors liquid assets on an ad-hoc basis.`,

    MW: `MALAWI PAYMENT SERVICES COMPLIANCE MANUAL
1. Customer KYC (Compliant): The provider records customer National Registration Cards (NRC) and verifies physical identity prior to account opening.
2. Large Cash Reporting (Partial): The team manually logs high-value transactions but lacks an automated reporting interface to the Financial Intelligence Authority (FIA).
3. Cybersecurity Audits (Missing Gap): The manual does not mandate annual independent external cybersecurity audits submitted to the Reserve Bank of Malawi.
4. Capital Adequacy (Ambiguous): Capital reserves are reviewed during annual general meetings.`
  };

  const gateCResults: Record<string, any> = {};

  for (const jcode of ['KE', 'RW', 'MW'] as const) {
    console.log(`\n▶ [Gate C - ${jcode}] Executing live Gap Analysis...`);
    const jContext = resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: [jcode] });
    const gT0 = Date.now();

    // RAG Retrieval for Policy Domain
    const ragContext = await searchAndGetRegulatoryEvidenceContext({
      query: 'Fintech payment service provider licensing, data protection, AML reporting, and consumer dispute resolution requirements',
      jurisdictionContext: jContext,
      topK: 8,
      minScore: 0.7,
      preferActiveSources: true,
    });

    const gapRes = await aiService.performGapAnalysis({
      policyText: syntheticPolicies[jcode],
      documentName: `Synthetic_Policy_${jcode}.txt`,
      documentType: 'Policy Document',
      regulatoryFrameworks: ['Payment Services'],
      analysisDepth: 'quick',
      ragContext: ragContext.context,
      jurisdictionContext: jContext,
    });
    const gWallMs = Date.now() - gT0;

    const allGaps = gapRes.result.frameworks.flatMap(f => f.gaps);

    console.log(`  Overall Score: ${gapRes.result.overallScore}%`);
    console.log(`  Total Gaps: ${gapRes.result.metadata.totalGaps} (Critical: ${gapRes.result.metadata.criticalGaps}, High: ${gapRes.result.metadata.highGaps})`);
    console.log(`  Latency: ${gWallMs}ms | Tokens: in=${gapRes.inputTokens}, out=${gapRes.outputTokens}`);
    console.log(`  Executive Summary: ${gapRes.result.executiveSummary.slice(0, 200)}...`);

    gateCResults[jcode] = {
      latencyMs: gWallMs,
      inputTokens: gapRes.inputTokens,
      outputTokens: gapRes.outputTokens,
      overallScore: gapRes.result.overallScore,
      totalGaps: gapRes.result.metadata.totalGaps,
      criticalGaps: gapRes.result.metadata.criticalGaps,
      highGaps: gapRes.result.metadata.highGaps,
      executiveSummary: gapRes.result.executiveSummary,
      gaps: allGaps.map(g => ({ title: g.title, severity: g.severity, description: g.description, recommendation: g.recommendation, regulatoryBasis: g.regulatoryBasis })),
    };
  }
  results.gateC = gateCResults;

  // ───────────────────────────────────────────────────────────────────────────
  // GATE D: Live Checklist Generation (1 KE, 1 RW, 1 MW)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── [GATE D] Live Compliance Checklist Certification ─────────────────');
  const gateDResults: Record<string, any> = {};

  for (const jcode of ['KE', 'RW', 'MW'] as const) {
    console.log(`\n▶ [Gate D - ${jcode}] Executing live Checklist Generation...`);
    const jContext = resolveJurisdictionContext({ mode: 'SINGLE', jurisdictions: [jcode] });
    const cT0 = Date.now();

    // RAG Retrieval for Checklist Framework
    const ragContext = await searchAndGetRegulatoryEvidenceContext({
      query: 'Fintech digital payment service provider operational licensing requirements',
      jurisdictionContext: jContext,
      topK: 8,
      minScore: 0.7,
      preferActiveSources: true,
    });

    const checklistRes = await aiService.generateComplianceChecklist({
      productType: 'Payment Service Provider & Digital Wallet',
      businessStage: 'Operational Fintech',
      targetSegments: ['B2B', 'B2C'],
      servicesOffered: ['Digital wallet and payment aggregation services'],
      ragContext: ragContext.context,
      jurisdictionContext: jContext,
    });
    const cWallMs = Date.now() - cT0;

    let totalItems = 0;
    for (const cat of checklistRes.checklist.categories) {
      totalItems += cat.items.length;
    }

    console.log(`  Categories: ${checklistRes.checklist.categories.length} | Total Items: ${totalItems}`);
    console.log(`  Latency: ${cWallMs}ms | Tokens: in=${checklistRes.inputTokens}, out=${checklistRes.outputTokens}`);
    console.log(`  Sample Items:`);
    for (const cat of checklistRes.checklist.categories.slice(0, 2)) {
      if (cat.items[0]) {
        console.log(`    [${cat.name}] ${cat.items[0].title} (Basis: ${cat.items[0].regulatoryBasis})`);
      }
    }

    gateDResults[jcode] = {
      latencyMs: cWallMs,
      inputTokens: checklistRes.inputTokens,
      outputTokens: checklistRes.outputTokens,
      categoriesCount: checklistRes.checklist.categories.length,
      totalItemsCount: totalItems,
      categories: checklistRes.checklist.categories.map(c => ({
        name: c.name,
        itemsCount: c.items.length,
        sampleItem: c.items[0]?.title,
        sampleBasis: c.items[0]?.regulatoryBasis,
      })),
    };
  }
  results.gateD = gateDResults;

  // Save results to file
  const outPath = path.join(OUT_DIR, 'phase9-certification-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n✅ Results successfully written to: ${outPath}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  ALL LIVE RAG CERTIFICATION GATES (A, B, C, D) COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal certification runner error:', err);
  process.exit(1);
});
