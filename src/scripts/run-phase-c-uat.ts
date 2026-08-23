import 'dotenv/config';
import { appRouter } from '../server/trpc/router';
import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma/client';
import { redis } from '../lib/redis/client';
import { rateLimiter } from '../lib/redis/rate-limiter';

const OUT_DIR = path.join(__dirname, '../../../uat-results');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function runUAT() {
  console.log('🚀 Starting Phase C Local UAT (Internal Caller)...');
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

  // Anthropic is out of credits, switch system config to OpenAI
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
    // Provide real aiService so that the actual AI is used
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
      const query = await prisma.complianceQuery.findUnique({
        where: { id: res.queryId },
        include: { runs: true, answerClaims: true }
      });
      const lastRun = query?.runs?.[query.runs.length - 1];
      
      results.push({
        name,
        payload,
        timing,
        success: true,
        response: res.answer,
        citations: res.citations?.map((c: any) => ({
          documentTitle: c.documentTitle,
          jurisdictionCode: c.jurisdictionCode,
          section: c.section
        })),
        jurisdictions: res.jurisdictions,
        mode: res.mode,
        grounded: res.grounded,
        abstained: res.abstained,
        route: res.route,
        retrievedEvidence: lastRun?.retrievedVectorIds,
        acceptedChunks: lastRun?.acceptedChunkIds,
        claims: query?.answerClaims?.map((c: any) => c.claimText),
        verifierOutcome: lastRun?.verifierVerdict,
        unsupportedClaims: lastRun?.unsupportedClaims
      });
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
      results.push({
        name,
        payload,
        timing: Date.now() - qStart,
        success: false,
        error: err.message
      });
    }
    
    // Add 8 second delay to avoid hitting the 20 RPM limit on Gemini free tier
    console.log(`  ⏳ Waiting 8s for rate limits...`);
    await new Promise(resolve => setTimeout(resolve, 8000));
  };

  // --- DEFINING QUERIES ---

  const ngQueries = [
    "What are the minimum capital requirements for a Payment Service Provider in Nigeria?",
    "How should consumer data be protected according to NDPC regulations?",
    "What are the AML/CFT reporting obligations for fintechs in Nigeria under NFIU?",
    "Describe the process of obtaining a microfinance bank license from the CBN.",
    "What are the regulations around mobile money operations in Nigeria?",
    "How does the SEC regulate digital assets and cryptocurrencies in Nigeria?",
    "What are the cybersecurity framework guidelines for banks in Nigeria?",
    "Explain the BVN (Bank Verification Number) regulatory requirements."
  ];

  for (let i = 0; i < ngQueries.length; i++) {
    await runQuery(`NG Single Golden ${i+1}`, {
      question: ngQueries[i],
      mode: 'SINGLE',
      jurisdictions: ['NG']
    });
  }

  const ngAbstention = [
    "What is the best recipe for Nigerian Jollof rice?",
    "Who won the Nigerian presidential election in 2023?",
    "Give me medical advice for treating malaria in Lagos."
  ];
  for (let i = 0; i < ngAbstention.length; i++) {
    await runQuery(`NG Abstention ${i+1}`, {
      question: ngAbstention[i],
      mode: 'SINGLE',
      jurisdictions: ['NG']
    });
  }

  const regressionQueries = [
    { j: 'KE', q: "What is the CBK requirement for core capital of a commercial bank?" },
    { j: 'KE', q: "How does the Data Protection Act 2019 define personal data?" },
    { j: 'KE', q: "What are the AML reporting requirements under FRC Kenya?" },
    { j: 'RW', q: "What is the BNR minimum capital for a microfinance institution?" },
    { j: 'RW', q: "How does Rwanda regulate payment service providers?" },
    { j: 'RW', q: "What are the data localization requirements in Rwanda?" },
    { j: 'MW', q: "What is the RBM requirement for mobile money operators?" },
    { j: 'MW', q: "How does the Reserve Bank of Malawi regulate foreign exchange?" },
    { j: 'MW', q: "What are the KYC guidelines for banks in Malawi?" }
  ];
  for (let i = 0; i < regressionQueries.length; i++) {
    await runQuery(`${regressionQueries[i].j} Regression ${i+1}`, {
      question: regressionQueries[i].q,
      mode: 'SINGLE',
      jurisdictions: [regressionQueries[i].j as any]
    });
  }

  const twoCountry = [
    ['KE', 'RW'], ['KE', 'MW'], ['KE', 'NG'],
    ['RW', 'MW'], ['RW', 'NG'], ['MW', 'NG']
  ];
  for (const combo of twoCountry) {
    await runQuery(`Comparison ${combo.join('+')}`, {
      question: `Compare the minimum capital requirements for a commercial bank in ${combo.join(' and ')}.`,
      mode: 'COMPARE',
      jurisdictions: combo as any
    });
  }

  const threeCountry = [
    ['KE', 'RW', 'MW'], ['KE', 'RW', 'NG'], ['KE', 'MW', 'NG'], ['RW', 'MW', 'NG']
  ];
  for (const combo of threeCountry) {
    await runQuery(`Comparison ${combo.join('+')}`, {
      question: `Compare the data protection laws and penalties in ${combo.join(', ')}.`,
      mode: 'COMPARE',
      jurisdictions: combo as any
    });
  }

  const fourCountryTopics = [
    "Compare AML/CFT suspicious transaction reporting timelines.",
    "Compare the licensing framework for digital lenders.",
    "Compare consumer protection guidelines for financial services."
  ];
  for (let i = 0; i < fourCountryTopics.length; i++) {
    await runQuery(`4-Country Compare ${i+1}`, {
      question: fourCountryTopics[i],
      mode: 'COMPARE',
      jurisdictions: ['KE', 'RW', 'MW', 'NG']
    });
  }

  fs.writeFileSync(path.join(OUT_DIR, 'uat_results.json'), JSON.stringify(results, null, 2));
  
  const mdOut = results.map(r => 
    `### ${r.name}\n- Success: ${r.success}\n- Timing: ${r.timing}ms\n- Grounded: ${r.grounded}\n- Abstained: ${r.abstained}\n- Route: ${r.route}\n- Mode: ${r.mode}\n- Jurisdictions: ${r.jurisdictions?.join(', ')}\n- Verifier Outcome: ${r.verifierOutcome}\n\n**Retrieved Evidence:**\n${r.retrievedEvidence ? JSON.stringify(r.retrievedEvidence) : 'None'}\n\n**Accepted Chunks:**\n${r.acceptedChunks ? JSON.stringify(r.acceptedChunks) : 'None'}\n\n**Claims Extracted:**\n${r.claims ? JSON.stringify(r.claims) : 'None'}\n\n**Citations:**\n${r.citations ? JSON.stringify(r.citations, null, 2) : 'None'}\n${r.error ? `\n- Error: ${r.error}` : ''}`
  ).join('\n\n---\n\n');
  fs.writeFileSync(path.join(OUT_DIR, 'uat_summary.md'), mdOut);

  console.log(`\n🎉 UAT complete in ${Date.now() - start}ms! Results saved to ${OUT_DIR}`);
  await prisma.$disconnect();
}

runUAT().catch(err => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
});
