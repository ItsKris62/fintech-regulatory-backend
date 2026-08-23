import 'dotenv/config';
import { complete } from '@/lib/ai/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService, searchAndGetRegulatoryEvidenceContext } from '@/lib/rag/rag.service';
import { getPineconeDiagnostics } from '@/lib/rag/client';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
import { extractJson } from '@/modules/compliance/orchestrator/utils';
import { verifyAnswerClaims } from '@/lib/source-grounding/claim-verification';
import {
  buildCitationsFromChunks,
  validateCitationsForJurisdiction,
} from '@/lib/source-grounding/citations';
import {
  jurisdictionLabel,
  resolveJurisdictionContext,
  type JurisdictionCode,
  type JurisdictionContext,
} from '@/types/jurisdiction';
import {
  buildComplianceRagQuery,
  extractNamedRegulations,
} from '@/routes/compliance-stream.route';

const DEFAULT_CASES: Array<{ jurisdiction: JurisdictionCode; query: string }> = [
  { jurisdiction: 'KE', query: 'What are the AML and KYC obligations for a payment service provider in Kenya?' },
  { jurisdiction: 'RW', query: 'What licensing requirements apply to payment service providers in Rwanda?' },
  { jurisdiction: 'MW', query: 'What data protection obligations apply to fintech companies in Malawi?' },
];

function parseCases(): Array<{ jurisdiction: JurisdictionCode; query: string }> {
  const args = process.argv.slice(2).map((arg) => arg.trim()).filter(Boolean);
  if (args.length === 0) return DEFAULT_CASES;

  return args.map((arg) => {
    const [jurisdictionRaw, ...questionParts] = arg.split(':');
    const jurisdiction = jurisdictionRaw?.trim().toUpperCase() as JurisdictionCode;
    const query = questionParts.join(':').trim();
    if (!['KE', 'RW', 'MW', 'NG'].includes(jurisdiction) || !query) {
      throw new Error(`Invalid diagnostic case "${arg}". Use KE:question, RW:question, or MW:question.`);
    }
    return { jurisdiction, query };
  });
}

async function runLegacyGraderProbe(
  question: string,
  chunks: Awaited<ReturnType<typeof searchAndGetRegulatoryEvidenceContext>>['results'],
  jurisdictionContext: JurisdictionContext,
): Promise<void> {
  if (process.env.DIAGNOSE_LEGACY_GRADER !== '1') return;

  const toGrade = chunks.slice(0, 10);
  const label = jurisdictionLabel(jurisdictionContext.jurisdictions[0]);
  const systemPrompt = `You are a relevance grader for a ${label} financial-services compliance RAG system.
Active jurisdiction: ${label} (${jurisdictionContext.jurisdictions[0]}).
Given a compliance question and retrieved document chunks, decide which chunks are relevant.
A chunk is relevant only if it contains information that directly helps answer the question and belongs to the active jurisdiction.

Respond with a single JSON object:
{"grades":[{"index":0,"relevant":true},{"index":1,"relevant":false},...]}
One entry per chunk in order. No markdown, no other text.`;
  const chunkList = toGrade
    .map((c, i) => `[${i}] ${c.documentTitle}${c.section ? ` § ${c.section}` : ''}: ${c.chunkText.slice(0, 800)}`)
    .join('\n\n');
  const prompt = `Question: ${question}\n\nChunks:\n${chunkList}`;
  const maxTokens = Math.max(60, 20 + toGrade.length * 15);

  try {
    const result = await complete({ prompt, systemPrompt, maxTokens, temperature: 0.0 }, 'query');
    const parsed = JSON.parse(extractJson(result.content)) as { grades?: Array<{ index: number; relevant: boolean }> };
    const grades = parsed.grades ?? [];
    const accepted = grades.filter((grade) => grade.relevant && toGrade[grade.index]).length;
    const rejected = grades.filter((grade) => !grade.relevant && toGrade[grade.index]).length + Math.max(0, toGrade.length - grades.length);
    console.log(`Legacy grader probe: ${JSON.stringify({
      maxTokens,
      model: result.model,
      stopReason: result.stopReason,
      rawResponseLength: result.content.length,
      outputTokens: result.outputTokens,
      parsedGradeCount: grades.length,
      accepted,
      rejected,
      parseFailed: false,
    })}`);
    console.log(`Legacy grader raw model output: ${result.content}`);
  } catch (error) {
    console.log(`Legacy grader probe: ${JSON.stringify({
      maxTokens,
      parseFailed: true,
      error: error instanceof Error ? error.message : String(error),
    })}`);
  }
}

async function runGenerationProbe(
  question: string,
  acceptedChunks: Awaited<ReturnType<typeof searchAndGetRegulatoryEvidenceContext>>['results'],
  jurisdictionContext: JurisdictionContext,
): Promise<void> {
  if (process.env.DIAGNOSE_GENERATION !== '1') return;

  const acceptedContext = ragService.getContextForPrompt(acceptedChunks, 10, 4000);
  if (!acceptedContext.trim()) {
    console.log('Generation probe: skipped; no accepted context.');
    return;
  }

  const answer = await aiService.answerComplianceQuery({
    question,
    jurisdictionContext,
    ragContext: acceptedContext,
  });
  const claimVerification = verifyAnswerClaims(answer.content, acceptedChunks);
  const citations = buildCitationsFromChunks(acceptedChunks, 'verified');
  const citationValidation = validateCitationsForJurisdiction(citations, jurisdictionContext);

  console.log(`Generation probe: ${JSON.stringify({
    model: answer.model,
    stopReason: answer.stopReason,
    answerLength: answer.content.length,
    citationCount: citations.length,
    citationJurisdictionValid: citationValidation.valid,
    citationJurisdictionInvalidCount: citationValidation.invalidCitations.length,
    claimVerdict: claimVerification.verdict,
    supportedClaims: claimVerification.supportedClaims.length,
    unsupportedClaims: claimVerification.unsupportedClaims.length,
    finalFallbackReason: citations.length === 0 || !citationValidation.valid || claimVerification.unsupportedClaims.length > 0
      ? 'ALL_CHUNKS_FAILED_VERIFICATION'
      : null,
  })}`);
  if (claimVerification.unsupportedClaims.length > 0) {
    console.log(`Generation unsupported claims: ${JSON.stringify(claimVerification.unsupportedClaims.map((claim) => ({
      claimText: claim.claimText,
      claimType: claim.claimType,
      confidence: claim.confidence,
      bestDocumentTitle: claim.supportingChunk?.documentTitle,
      bestJurisdiction: claim.supportingChunk?.jurisdictionCode,
    })))}`);
  }
  console.log(`Generated answer preview: ${answer.content.slice(0, 1200).replace(/\s+/g, ' ')}`);
}

async function main(): Promise<void> {
  const pinecone = getPineconeDiagnostics();
  console.log('Compliance RAG diagnostics');
  console.log(`Pinecone index: ${pinecone.indexName}`);
  console.log(`Pinecone namespace: ${pinecone.namespace}`);
  console.log(`Pinecone environment: ${pinecone.environment ?? '(not set)'}`);

  for (const testCase of parseCases()) {
    const jurisdictionContext = resolveJurisdictionContext({
      mode: 'SINGLE',
      jurisdictions: [testCase.jurisdiction],
    });
    const query = testCase.query;
    const detectedRegulations = extractNamedRegulations(query);
    const ragQuery = buildComplianceRagQuery(query, detectedRegulations, jurisdictionContext);
    console.log('\n---');
    console.log(`Jurisdiction: ${testCase.jurisdiction}`);
    console.log(`Query: ${query}`);
    console.log(`Detected regulations: ${detectedRegulations.length ? detectedRegulations.join(', ') : '(none)'}`);
    console.log(`RAG query: ${ragQuery}`);

    const ragContext = await searchAndGetRegulatoryEvidenceContext({
      query: ragQuery,
      jurisdictionContext,
      topK: 12,
      minScore: 0.62,
      preferActiveSources: true,
    });
    const grade = await runGraderAgent(query, ragContext.results, jurisdictionContext, 10);
    const claimVerification = verifyAnswerClaims(
      'Diagnostic placeholder answer. No generated legal answer was produced in this retrieval/grader diagnostic.',
      grade.accepted,
    );

    console.log(`Retrieved chunk count: ${ragContext.results.length}`);
    console.log(`Verification input count: ${Math.min(ragContext.results.length, 10)}`);
    console.log(`Verified sources count: ${grade.accepted.length}`);
    console.log(`Rejected sources count: ${grade.rejected.length}`);
    console.log(`Verification result: ${grade.accepted.length > 0 ? 'ACCEPTED' : 'REJECTED_ALL'}${grade.gradeFailed ? ' (grader failed)' : ''}`);
    console.log(`Claim verifier supported count: ${claimVerification.supportedClaims.length}`);
    console.log(`Claim verifier unsupported count: ${claimVerification.unsupportedClaims.length}`);
    console.log(`Final fallback reason if stopped here: ${ragContext.results.length === 0 ? 'NO_RAG_CHUNKS' : grade.accepted.length === 0 ? 'ALL_CHUNKS_FAILED_VERIFICATION' : '(none)'}`);
    console.log(`Grader diagnostics: ${JSON.stringify({
      questionHash: grade.diagnostics?.questionHash,
      jurisdiction: grade.diagnostics?.jurisdiction,
      model: grade.diagnostics?.model,
      stopReason: grade.diagnostics?.stopReason,
      maxTokens: grade.diagnostics?.maxTokens,
      rawResponseLength: grade.diagnostics?.rawResponseLength,
      parsedGradeCount: grade.diagnostics?.parsedGradeCount,
      acceptedCount: grade.diagnostics?.acceptedCount,
      rejectedCount: grade.diagnostics?.rejectedCount,
      gradeFailed: grade.diagnostics?.gradeFailed,
      failureClassification: grade.diagnostics?.failureClassification,
    })}`);
    if (grade.diagnostics?.rawResponse) {
      console.log(`Grader raw model output: ${grade.diagnostics.rawResponse}`);
    }
    await runLegacyGraderProbe(query, ragContext.results, jurisdictionContext);
    await runGenerationProbe(query, grade.accepted, jurisdictionContext);

    for (const result of ragContext.results) {
      const location = [
        result.section ? `section=${result.section}` : null,
        result.sectionNumber ? `sectionNumber=${result.sectionNumber}` : null,
        result.pageStart ? `pageStart=${result.pageStart}` : null,
        result.pageEnd ? `pageEnd=${result.pageEnd}` : null,
      ].filter(Boolean).join(', ');

      console.log(
        `- #${result.rank} score=${result.score.toFixed(4)} jurisdiction=${result.jurisdictionCode ?? '(unknown)'} vectorId=${result.vectorId} title="${result.documentTitle}"${location ? ` (${location})` : ''}`,
      );
    }
  }
}

main().catch((error) => {
  console.error('Diagnostic failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
