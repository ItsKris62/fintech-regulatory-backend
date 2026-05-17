import { searchAndGetContext } from '@/lib/rag/rag.service';

const GRADER_TRUNCATION = 300;

async function inspect(label: string, question: string, topN = 5) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label}: ${question.slice(0, 80)}`);
  console.log('='.repeat(70));
  const ctx = await searchAndGetContext(question, { topK: 10, minScore: 0.7 });
  ctx.results.slice(0, topN).forEach((c, i) => {
    console.log(`\n[${i}] score=${c.score?.toFixed(3)} | ${c.documentTitle}`);
    console.log(`    § ${c.section ?? '(none)'}`);
    console.log(`    len=${c.chunkText.length} chars`);
    console.log(`    GRADER_SEES (first ${GRADER_TRUNCATION}): |${c.chunkText.slice(0, GRADER_TRUNCATION)}|`);
    if (c.chunkText.length > GRADER_TRUNCATION) {
      console.log(`    PAST_TRUNCATION: |${c.chunkText.slice(GRADER_TRUNCATION)}|`);
    }
  });
}

async function main() {
  await inspect('S1', 'What is the minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya?');
  await inspect('S2', 'What is the registration deadline for data controllers under the Data Protection Act 2019?');
  await inspect('C2', 'What licensing requirements must a fintech meet under both the National Payment Systems Act 2011 and the CBK Payment Service Provider framework, and what are the capital adequacy thresholds for each licence category?');
}
main().catch(e => { console.error(e); process.exit(1); });
