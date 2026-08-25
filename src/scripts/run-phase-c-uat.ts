import 'dotenv/config';
import { appRouter } from '../server/trpc/router';
import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma/client';
import { redis } from '../lib/redis/client';
import { rateLimiter } from '../lib/redis/rate-limiter';
import { ragService } from '../lib/rag/rag.service';

const OUT_DIR = path.join(__dirname, '../../../uat-results');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// Ensure unique query strings so cache identity tests work specifically
const tStr = Date.now().toString();

const ngQueries = [
  "What are the cybersecurity risk management requirements for financial institutions in Nigeria?",
  "How should consumer data be protected according to NDPC regulations?",
  "What are the AML/CFT reporting obligations for fintechs in Nigeria under NFIU?",
  "Describe the process of obtaining a microfinance bank license from the CBN.",
  "What are the regulations around mobile money operations in Nigeria?",
  "How does the SEC regulate digital assets and cryptocurrencies in Nigeria?",
  "What are the cybersecurity framework guidelines for banks in Nigeria?",
  "Explain the BVN (Bank Verification Number) regulatory requirements."
];

const regressionQueries = [
  { j: 'KE', q: "What is the CBK requirement for core capital of a commercial bank?" },
  { j: 'KE', q: "How does the Data Protection Act 2019 define personal data?" },
  { j: 'KE', q: "What are the AML reporting requirements under FRC Kenya?" },
  { j: 'RW', q: "What is the BNR minimum capital for a microfinance institution?" },
  { j: 'RW', q: "How does Rwanda regulate payment service providers?" },
  { j: 'RW', q: "What are the data localization requirements in Rwanda?" },
  { j: 'MW', q: "What is the RBM requirement for mobile money operators?" },
  { j: 'MW', q: "How does the Reserve Bank of Malawi regulate foreign exchange?" },
  { j: 'MW', q: "What are the licensing requirements for payment service providers under the Reserve Bank of Malawi?" }
];

const twoCountry = [
  ['KE', 'RW'], ['KE', 'MW'], ['KE', 'NG'],
  ['RW', 'MW'], ['RW', 'NG'], ['MW', 'NG']
];

const threeCountry = [
  ['KE', 'RW', 'MW'], ['KE', 'RW', 'NG'], ['KE', 'MW', 'NG'], ['RW', 'MW', 'NG']
];

const fourCountryTopics = [
  "Compare the definition of electronic money and e-money issuer. If a jurisdiction lacks evidence, document the gap explicitly.",
  "Compare the licensing framework and minimum capital for digital lenders. If a jurisdiction lacks evidence, document the gap explicitly.",
  "Compare data localization and cross-border data transfer guidelines. If a jurisdiction lacks evidence, document the gap explicitly."
];

async function runUAT() {
  console.log('🚀 Starting Phase C Local UAT (V2)...');
  const start = Date.now();

  const qaEmail = 'qa-uat-internal@sheriabot.com';
  
  const user = await prisma.user.upsert({
    where: { email: qaEmail },
    update: { accountStatus: 'active', emailVerified: true },
    create: {
      email: qaEmail,
      fullName: 'QA UAT Internal',
      role: 'ENTERPRISE',
      status: 'ACTIVE',
      accountStatus: 'active',
      emailVerified: true,
    }
  });

  let org = await prisma.organization.findFirst({ where: { name: 'QA UAT Org' } });
  if (!org) {
    org = await prisma.organization.create({
      data: { name: 'QA UAT Org', type: 'ENTERPRISE', subscriptionTier: 'enterprise', plan: 'ENTERPRISE' }
    });
  }
  await prisma.user.update({ where: { id: user.id }, data: { organizationId: org.id } });
  await prisma.organizationMember.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    update: { role: 'ADMIN', status: 'ACTIVE' },
    create: { userId: user.id, organizationId: org.id, role: 'ADMIN', status: 'ACTIVE' }
  });

  // Rely on fallback to appConfig.ai.model by ensuring DB configs are clean.
  await prisma.systemConfig.deleteMany({
    where: {
      key: { in: ['ai_query_model', 'aiQueryModel', 'availableAIModels', 'available_ai_models', 'aiVerificationModel', 'ai_verification_model', 'aiComplexAnalysisModel', 'ai_complex_analysis_model', 'aiPolicyModel', 'ai_policy_model'] }
    }
  });
  await redis.del('admin:system_config');
  await redis.del('admin:system_config:persisted');

  // Mock TRPC context
  const ctx = {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: org.id,
      supabaseAuthId: user.supabaseAuthId || 'mock-id',
      sessionId: 'mock-session-id',
      sessionExpiresAt: Date.now() + 3600000,
    },
    orgMembership: {
      organizationId: org.id,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    plan: 'ENTERPRISE',
    req: { ip: '127.0.0.1', headers: {} } as any,
    res: {} as any,
    prisma,
    aiService: require('../lib/ai/ai.service').aiService,
  };

  const caller = appRouter.createCaller(ctx as any);

  await rateLimiter.reset(user.id, 'complianceQuery');

  const results: any[] = [];

  const runQuery = async (name: string, payload: any) => {
    console.log(`▶️ Running: ${name}...`);
    const qStart = Date.now();
    try {
      const res = await caller.compliance.query(payload);
      const timing = Date.now() - qStart;
      console.log(`  ✅ Success (${timing}ms) - Grounded: ${res.grounded}, Abstained: ${res.abstained}`);
      results.push({
        name,
        payload,
        timing,
        success: true,
        response: res.answer,
        citations: res.citations?.map((c: any) => ({ jurisdictionCode: c.jurisdictionCode })),
        mode: res.mode,
        jurisdictions: res.jurisdictions,
        grounded: res.grounded,
        abstained: res.abstained,
        graderFailed: res.graderFailed,
        fallbackReason: res.fallbackReason,
        queryId: res.queryId,
        cacheBypassed: res.cacheBypassed
      });
      return res;
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
      results.push({ name, payload, success: false, error: err.message });
      return null;
    }
  };

  // 1. NG SINGLE
  for (let i = 0; i < ngQueries.length; i++) {
    await runQuery(`NG Single Golden ${i+1}`, { question: ngQueries[i], mode: 'SINGLE', jurisdictions: ['NG'] });
    await new Promise(r => setTimeout(r, 20000));
  }

  // 2. REGRESSION QUERIES
  for (let i = 0; i < regressionQueries.length; i++) {
    await runQuery(`${regressionQueries[i].j} Regression ${i+1}`, { question: regressionQueries[i].q, mode: 'SINGLE', jurisdictions: [regressionQueries[i].j as any] });
    await new Promise(r => setTimeout(r, 20000));
  }

  // 3. COMPARE 2
  for (const combo of twoCountry) {
    await runQuery(`Comparison 2 ${combo.join('+')}`, { question: `Compare the minimum capital requirements for a commercial bank in ${combo.join(' and ')}.`, mode: 'COMPARE', jurisdictions: combo as any });
    await new Promise(r => setTimeout(r, 20000));
  }

  // 4. COMPARE 3
  for (const combo of threeCountry) {
    await runQuery(`Comparison 3 ${combo.join('+')}`, { question: `Compare the data protection laws and penalties in ${combo.join(', ')}.`, mode: 'COMPARE', jurisdictions: combo as any });
    await new Promise(r => setTimeout(r, 20000));
  }

  // 5. COMPARE 4
  for (let i = 0; i < fourCountryTopics.length; i++) {
    await runQuery(`4-Country Compare ${i+1}`, { question: fourCountryTopics[i], mode: 'COMPARE', jurisdictions: ['KE', 'RW', 'MW', 'NG'] });
    await new Promise(r => setTimeout(r, 20000));
  }

  // 6. Cross-Country Wrong Support
  await runQuery(`Cross-Country Deliberate Wrong Support`, {
    question: "According to the CBK, what is the minimum capital for a bank in Nigeria?",
    mode: 'SINGLE',
    jurisdictions: ['NG']
  });
  await new Promise(r => setTimeout(r, 20000));

  // 7. Cache Identity Tests
  console.log(`▶️ Running: Cache Identity Tests...`);
  const cacheQ = `What is the capital requirement? ${tStr}`;
  // Run once to seed cache
  await runQuery(`Cache Seed`, { question: cacheQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW'] });
  // Identical order
  await runQuery(`Cache Identical`, { question: cacheQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW'] });
  // Reversed order
  await runQuery(`Cache Reversed`, { question: cacheQ, mode: 'COMPARE', jurisdictions: ['RW', 'KE'] });
  // Different jurisdictions
  await runQuery(`Cache Different 1`, { question: cacheQ, mode: 'COMPARE', jurisdictions: ['KE', 'NG'] });
  await runQuery(`Cache Different 2`, { question: cacheQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW', 'NG'] });
  await runQuery(`Cache Different 3`, { question: cacheQ, mode: 'SINGLE', jurisdictions: ['KE'] });
  await new Promise(r => setTimeout(r, 20000));

  // 8. History & Follow-Up Scope Tests
  console.log(`▶️ Running: History & Follow-Up Scope Tests...`);
  const fng = await runQuery(`Follow-Up Seed NG`, { question: "What is open banking?", mode: 'SINGLE', jurisdictions: ['NG'] });
  await new Promise(r => setTimeout(r, 20000));
  if (fng) {
    const fRes = await caller.compliance.followUp({ originalQueryId: fng.queryId, question: "Who regulates it?" });
    results.push({ name: 'Follow-Up Scope NG', success: true, citations: fRes.citations?.map((c:any) => ({ jurisdictionCode: c.jurisdictionCode })) });
  }
  await new Promise(r => setTimeout(r, 20000));
  
  const fke_ng = await runQuery(`Follow-Up Seed KE+NG`, { question: "Compare mobile money rules.", mode: 'COMPARE', jurisdictions: ['KE', 'NG'] });
  await new Promise(r => setTimeout(r, 20000));
  if (fke_ng) {
    const fRes = await caller.compliance.followUp({ originalQueryId: fke_ng.queryId, question: "Who regulates it?" });
    results.push({ name: 'Follow-Up Scope KE+NG', success: true, citations: fRes.citations?.map((c:any) => ({ jurisdictionCode: c.jurisdictionCode })) });
  }
  await new Promise(r => setTimeout(r, 20000));

  const f4 = await runQuery(`Follow-Up Seed 4-Country`, { question: "Compare AML rules.", mode: 'COMPARE', jurisdictions: ['KE', 'RW', 'MW', 'NG'] });
  await new Promise(r => setTimeout(r, 20000));
  if (f4) {
    const fRes = await caller.compliance.followUp({ originalQueryId: f4.queryId, question: "Who regulates it?" });
    results.push({ name: 'Follow-Up Scope 4-Country', success: true, citations: fRes.citations?.map((c:any) => ({ jurisdictionCode: c.jurisdictionCode })) });
  }
  await new Promise(r => setTimeout(r, 20000));

  // 9. SSE Parity Tests
  console.log(`▶️ Running: SSE Parity Tests...`);
  // For SSE auth to work, we need an admin session token. It's actually expecting a bearer token from Supabase or custom?
  // Let's check how the frontend handles SSE Auth, or maybe we can't easily hit SSE from a script without full auth token.
  // The SSE endpoint uses `requireAuthToken`. The local server might not have a valid auth token easily minted.
  // In `use-compliance.ts`, it uses `const tokenStr = user?.email || "anonymous"`. Wait, the backend accepts the email as the token??
  const runSSE = async (name: string, payload: any) => {
    try {
      const resp = await fetch('http://localhost:4000/api/compliance/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.email}` },
        body: JSON.stringify(payload)
      });
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let text = '';
      let citations: any[] = [];
      let grounded = false;
      while (reader && !done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6));
                if (data.type === 'chunk') text += data.text;
                if (data.type === 'done') {
                  citations = data.citations;
                  grounded = data.grounded;
                }
              } catch (e) {}
            }
          }
        }
      }
      results.push({ name: name + " SSE", success: true, response: text, citations: citations?.map((c:any) => ({ jurisdictionCode: c.jurisdictionCode })), grounded });
    } catch(err:any) {
      results.push({ name: name + " SSE", success: false, error: err.message });
    }
  };

  const sseQ = "What is a bank?";
  await runQuery(`SSE Parity Normal NG`, { question: sseQ, mode: 'SINGLE', jurisdictions: ['NG'] });
  await runSSE(`SSE Parity`, { question: sseQ, mode: 'SINGLE', jurisdictions: ['NG'] });
  await new Promise(r => setTimeout(r, 20000));

  await runQuery(`SSE Parity Normal KE+RW`, { question: sseQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW'] });
  await runSSE(`SSE Parity 2-Country`, { question: sseQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW'] });
  await new Promise(r => setTimeout(r, 20000));

  await runQuery(`SSE Parity Normal 4-Country`, { question: sseQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW', 'MW', 'NG'] });
  await runSSE(`SSE Parity 4-Country`, { question: sseQ, mode: 'COMPARE', jurisdictions: ['KE', 'RW', 'MW', 'NG'] });
  await new Promise(r => setTimeout(r, 20000));

  // 10. Partial Evidence A/B/C/D Controlled Cases
  console.log(`▶️ Running: A/B/C/D Controlled Cases...`);
  const originalSearch = ragService.searchAndGetRegulatoryEvidenceContext;
  const mockChunks = (c_ng: boolean, c_ke: boolean, c_rw: boolean, c_mw: boolean) => {
    return [
      ...(c_ng ? [{ vectorId: 'ng1', chunkId: 'ng1', documentId: 'ng1', documentTitle: 'NG Doc', jurisdictionCode: 'NG', section: 'NG 1', textSnippet: 'NG establishes rules for electronic money.', score: 0.9 }] : []),
      ...(c_ke ? [{ vectorId: 'ke1', chunkId: 'ke1', documentId: 'ke1', documentTitle: 'KE Doc', jurisdictionCode: 'KE', section: 'KE 1', textSnippet: 'KE establishes rules for electronic money.', score: 0.9 }] : []),
      ...(c_rw ? [{ vectorId: 'rw1', chunkId: 'rw1', documentId: 'rw1', documentTitle: 'RW Doc', jurisdictionCode: 'RW', section: 'RW 1', textSnippet: 'RW establishes rules for electronic money.', score: 0.9 }] : []),
      ...(c_mw ? [{ vectorId: 'mw1', chunkId: 'mw1', documentId: 'mw1', documentTitle: 'MW Doc', jurisdictionCode: 'MW', section: 'MW 1', textSnippet: 'MW establishes rules for electronic money.', score: 0.9 }] : []),
    ];
  };

  const runMockedQuery = async (name: string, a:boolean,b:boolean,c:boolean,d:boolean) => {
    ragService.searchAndGetRegulatoryEvidenceContext = async () => {
      return { chunks: mockChunks(a,b,c,d), corpusVersionSnapshot: {}, retrievalVersion: 'mock' } as any;
    };
    await runQuery(name, { question: "Compare electronic money rules.", mode: 'COMPARE', jurisdictions: ['NG', 'KE', 'RW', 'MW'] });
    await new Promise(r => setTimeout(r, 20000));
  };

  // A: 3 sufficient, 1 insufficient (NG missing)
  await runMockedQuery(`Controlled Case A (3 suff, 1 insuff)`, false, true, true, true);
  // B: 2 sufficient, 2 insufficient (NG, KE missing)
  await runMockedQuery(`Controlled Case B (2 suff, 2 insuff)`, false, false, true, true);
  // C: 1 sufficient, 3 insufficient (NG, KE, RW missing)
  await runMockedQuery(`Controlled Case C (1 suff, 3 insuff)`, false, false, false, true);
  // D: 0 sufficient
  await runMockedQuery(`Controlled Case D (0 suff)`, false, false, false, false);

  // Restore
  ragService.searchAndGetRegulatoryEvidenceContext = originalSearch;

  fs.writeFileSync(path.join(OUT_DIR, 'uat_results.json'), JSON.stringify(results, null, 2));

  console.log(`✅ UAT Completed in ${(Date.now() - start) / 1000}s`);
  process.exit(0);
}

runUAT().catch(e => {
  console.error(e);
  process.exit(1);
});
