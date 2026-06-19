import 'dotenv/config';
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { getPineconeDiagnostics } from '@/lib/rag/client';
import { runGraderAgent } from '@/modules/compliance/orchestrator/grader.agent';
import {
  buildComplianceRagQuery,
  extractNamedRegulations,
} from '@/routes/compliance-stream.route';

const DEFAULT_QUERIES = [
  'What are the AML obligations for a payment service provider in Kenya?',
  'How do I comply with the Data Protection Act for mobile money services?',
  'What KYC requirements apply to fintech startups in Kenya?',
  'How do CBK requirements apply to digital lenders?',
  'How do I comply with the imaginary Fintech Unicorn Act 2027?',
];

function getQueries(): string[] {
  const args = process.argv.slice(2).map((arg) => arg.trim()).filter(Boolean);
  return args.length > 0 ? args : DEFAULT_QUERIES;
}

async function main(): Promise<void> {
  const pinecone = getPineconeDiagnostics();
  console.log('Compliance RAG diagnostics');
  console.log(`Pinecone index: ${pinecone.indexName}`);
  console.log(`Pinecone namespace: ${pinecone.namespace}`);
  console.log(`Pinecone environment: ${pinecone.environment ?? '(not set)'}`);

  for (const query of getQueries()) {
    const detectedRegulations = extractNamedRegulations(query);
    const ragQuery = buildComplianceRagQuery(query, detectedRegulations);
    console.log('\n---');
    console.log(`Query: ${query}`);
    console.log(`Detected regulations: ${detectedRegulations.length ? detectedRegulations.join(', ') : '(none)'}`);
    console.log(`RAG query: ${ragQuery}`);

    const ragContext = await searchAndGetContext(ragQuery, {
      topK: 12,
      minScore: 0.62,
      preferActiveSources: true,
    });
    const grade = await runGraderAgent(query, ragContext.results, 10);

    console.log(`Retrieved chunk count: ${ragContext.results.length}`);
    console.log(`Verification input count: ${ragContext.results.length}`);
    console.log(`Verified sources count: ${grade.accepted.length}`);
    console.log(`Rejected sources count: ${grade.rejected.length}`);
    console.log(`Verification result: ${grade.accepted.length > 0 ? 'ACCEPTED' : 'REJECTED_ALL'}${grade.gradeFailed ? ' (grader failed)' : ''}`);

    for (const result of ragContext.results) {
      const location = [
        result.section ? `section=${result.section}` : null,
        result.sectionNumber ? `sectionNumber=${result.sectionNumber}` : null,
        result.pageStart ? `pageStart=${result.pageStart}` : null,
        result.pageEnd ? `pageEnd=${result.pageEnd}` : null,
      ].filter(Boolean).join(', ');

      console.log(
        `- #${result.rank} score=${result.score.toFixed(4)} title="${result.documentTitle}"${location ? ` (${location})` : ''}`,
      );
    }
  }
}

main().catch((error) => {
  console.error('Diagnostic failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
