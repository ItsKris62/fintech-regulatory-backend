import 'dotenv/config';
import { searchAndGetRegulatoryEvidenceContext } from '../lib/rag/rag.service';

async function main() {
  console.log('=== MULTI-COUNTRY RAG RETRIEVAL & ISOLATION ACCEPTANCE MATRIX ===\n');

  const jurisdictions = [
    {
      jurisdiction: 'KE',
      frameworkSlug: 'dpa-2019',
      positiveQuery: 'What are the principles relating to processing of personal data under the Data Protection Act?',
      obligationQuery: 'What are the requirements for registration of data controllers and data processors?',
      otherCountry: 'NG',
    },
    {
      jurisdiction: 'RW',
      frameworkSlug: 'rw-dpa-2021',
      positiveQuery: 'What are the principles and obligations for personal data protection in Rwanda?',
      obligationQuery: 'What are the rights of data subjects regarding personal data access and rectification in Rwanda?',
      otherCountry: 'KE',
    },
    {
      jurisdiction: 'MW',
      frameworkSlug: 'mw-cybersecurity-2016',
      positiveQuery: 'What are the cybersecurity risk management obligations and computer offences under the Electronic Transactions and Cyber Security Act in Malawi?',
      obligationQuery: 'What are the legal recognition and requirements for electronic transactions and signatures in Malawi?',
      otherCountry: 'RW',
    },
    {
      jurisdiction: 'NG',
      frameworkSlug: 'ndpa-2023',
      positiveQuery: 'What are the principles of data processing and legal bases under Nigeria Data Protection Act NDPA 2023?',
      obligationQuery: 'What are the duties of data controllers of major importance regarding data protection officers in Nigeria?',
      otherCountry: 'MW',
    },
  ];

  for (const j of jurisdictions) {
    console.log(`\n======================================================`);
    console.log(`JURISDICTION: ${j.jurisdiction} | FRAMEWORK: ${j.frameworkSlug}`);
    console.log(`======================================================`);

    // A. Positive relevant query
    console.log(`\n[Test A] Positive query: "${j.positiveQuery}"`);
    const resA = await searchAndGetRegulatoryEvidenceContext({
      query: j.positiveQuery,
      jurisdictionContext: {
        mode: 'SINGLE',
        jurisdictions: [j.jurisdiction as any],
        primaryJurisdiction: j.jurisdiction as any,
      },
      topK: 5,
      minScore: 0.5,
      filter: { frameworkSlug: j.frameworkSlug },
    });
    console.log(`  -> Retrieved: ${resA.results.length} chunks`);
    for (const r of resA.results) {
      console.log(`     - [${r.jurisdictionCode}] ${r.documentTitle} (score: ${r.score.toFixed(3)}, section: ${r.section})`);
    }
    const passA = resA.results.length > 0 && resA.results.every(r => r.jurisdictionCode === j.jurisdiction);
    console.log(`  -> Verdict: ${passA ? 'PASS' : 'FAIL'}`);

    // B. Obligation query variant
    console.log(`\n[Test B] Obligation variant: "${j.obligationQuery}"`);
    const resB = await searchAndGetRegulatoryEvidenceContext({
      query: j.obligationQuery,
      jurisdictionContext: {
        mode: 'SINGLE',
        jurisdictions: [j.jurisdiction as any],
        primaryJurisdiction: j.jurisdiction as any,
      },
      topK: 5,
      minScore: 0.5,
      filter: { frameworkSlug: j.frameworkSlug },
    });
    console.log(`  -> Retrieved: ${resB.results.length} chunks`);
    const passB = resB.results.length > 0 && resB.results.every(r => r.jurisdictionCode === j.jurisdiction);
    console.log(`  -> Verdict: ${passB ? 'PASS' : 'FAIL'}`);

    // C. Cross-jurisdiction isolation (Query for j.jurisdiction targeting foreign jurisdiction query)
    console.log(`\n[Test C] Cross-jurisdiction isolation: querying ${j.jurisdiction} context with foreign ${j.otherCountry} query`);
    const foreignTarget = jurisdictions.find(item => item.jurisdiction === j.otherCountry)!;
    const resC = await searchAndGetRegulatoryEvidenceContext({
      query: foreignTarget.positiveQuery,
      jurisdictionContext: {
        mode: 'SINGLE',
        jurisdictions: [j.jurisdiction as any],
        primaryJurisdiction: j.jurisdiction as any,
      },
      topK: 5,
      minScore: 0.3,
    });
    console.log(`  -> Retrieved: ${resC.results.length} chunks`);
    for (const r of resC.results) {
      console.log(`     - [${r.jurisdictionCode}] ${r.documentTitle}`);
    }
    const leakCount = resC.results.filter(r => r.jurisdictionCode !== j.jurisdiction).length;
    console.log(`  -> Foreign leaks: ${leakCount}`);
    console.log(`  -> Verdict: ${leakCount === 0 ? 'PASS (Strict Isolation)' : 'FAIL (Leaked foreign evidence)'}`);

    // D. Framework exclusion test
    console.log(`\n[Test D] Framework exclusion: querying ${j.jurisdiction} with non-existent framework filter`);
    const resD = await searchAndGetRegulatoryEvidenceContext({
      query: j.positiveQuery,
      jurisdictionContext: {
        mode: 'SINGLE',
        jurisdictions: [j.jurisdiction as any],
        primaryJurisdiction: j.jurisdiction as any,
      },
      topK: 5,
      minScore: 0.5,
      filter: { frameworkSlug: 'non-existent-framework-123' },
    });
    console.log(`  -> Retrieved with invalid framework: ${resD.results.length}`);
    console.log(`  -> Verdict: ${resD.results.length === 0 ? 'PASS (Fail-closed on unsupported framework)' : 'FAIL'}`);
  }

  console.log('\n======================================================');
  console.log('RETRIEVAL ACCEPTANCE MATRIX COMPLETE');
  console.log('======================================================');
}

main().catch(console.error);
