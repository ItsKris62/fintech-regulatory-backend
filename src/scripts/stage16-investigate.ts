import { searchAndGetContext } from '@/lib/rag/rag.service';

const CASES = [
  {
    label: 'S1',
    question: 'What is the minimum core capital requirement for a Tier 1 microfinance bank licensed by CBK in Kenya?',
    keywords: ['core capital', 'microfinance', 'tier 1', 'minimum capital', 'MFB', 'million', 'KSh', 'Ksh'],
  },
  {
    label: 'S2',
    question: 'What is the registration deadline for data controllers under the Data Protection Act 2019?',
    keywords: ['registration', 'deadline', 'data controller', 'register', 'days', 'months', 'office'],
  },
  {
    label: 'C2',
    question: 'What licensing requirements must a fintech meet under both the National Payment Systems Act 2011 and the CBK Payment Service Provider framework, and what are the capital adequacy thresholds for each licence category?',
    keywords: ['capital', 'licence', 'license', 'PSP', 'payment service', 'NPS', 'threshold', 'category', 'tier', 'million'],
  },
];

const GRADER_TRUNCATION = 300;

function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

async function main() {
  for (const c of CASES) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`CASE ${c.label}: ${c.question}`);
    console.log('='.repeat(80));

    const ctx = await searchAndGetContext(c.question, { topK: 10, minScore: 0.7 });
    const chunks = ctx.results;

    console.log(`\nRetrieved ${chunks.length} chunks\n`);

    let hitInTruncated = 0;
    let hitInFullOnly = 0;
    let noHit = 0;

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      const truncated = ch.chunkText.slice(0, GRADER_TRUNCATION);
      const full = ch.chunkText;

      const inTruncated = containsKeyword(truncated, c.keywords);
      const inFull = containsKeyword(full, c.keywords);

      let verdict: string;
      if (inTruncated) { hitInTruncated++; verdict = 'HIT_IN_TRUNCATED'; }
      else if (inFull) { hitInFullOnly++; verdict = 'HIT_IN_FULL_ONLY'; }
      else { noHit++; verdict = 'NO_HIT'; }

      console.log(`[${i}] ${verdict} | score=${ch.score?.toFixed(3) ?? '?'} | ${ch.documentTitle} § ${ch.section ?? '(no section)'}`);
      console.log(`    Full length: ${full.length} chars`);
      console.log(`    Truncated (first ${GRADER_TRUNCATION}): ${truncated.replace(/\n/g,' ').slice(0,120)}...`);
      if (inFull && !inTruncated) {
        // Show where keyword appears in full text
        for (const k of c.keywords) {
          const idx = full.toLowerCase().indexOf(k.toLowerCase());
          if (idx >= 0 && idx >= GRADER_TRUNCATION) {
            console.log(`    Keyword '${k}' first appears at char ${idx}: ...${full.slice(Math.max(0, idx-30), idx+60)}...`);
          }
        }
      }
      if (verdict === 'NO_HIT') {
        console.log(`    [NO keyword match at all — grader correct to reject]`);
      }
    }

    console.log(`\nSUMMARY for ${c.label}:`);
    console.log(`  keyword in truncated (grader sees it): ${hitInTruncated}/${chunks.length}`);
    console.log(`  keyword in full text only (truncation problem): ${hitInFullOnly}/${chunks.length}`);
    console.log(`  no keyword match at all (corpus gap or wrong chunks): ${noHit}/${chunks.length}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
