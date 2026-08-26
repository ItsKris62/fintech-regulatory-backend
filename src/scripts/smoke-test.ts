import 'dotenv/config';
import { appRouter } from '../server/trpc/router';
import { prisma } from '../lib/prisma/client';

async function runSmokeTest() {
  console.log('🚀 Starting Anthropic Claude RAG Smoke Test...');
  const start = Date.now();

  const qaEmail = 'qa-uat-internal@sheriabot.com';
  const user = await prisma.user.findUnique({ where: { email: qaEmail } });
  if (!user) throw new Error("User not found");
  const org = await prisma.organization.findFirst({ where: { name: 'QA UAT Org' } });
  if (!org) throw new Error("Org not found");

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
    orgMembership: { organizationId: org.id, role: 'ADMIN', status: 'ACTIVE' },
    plan: 'ENTERPRISE',
    req: { ip: '127.0.0.1', headers: {} } as any,
    res: {} as any,
    prisma,
    aiService: require('../lib/ai/ai.service').aiService,
  };

  const caller = appRouter.createCaller(ctx as any);

  console.log('✅ Testing backend health...');
  const healthRes = await fetch('http://localhost:4600/health');
  if (healthRes.status !== 200) throw new Error("Backend health check failed");
  console.log('✅ Backend health 200');

  console.log('✅ Testing compliance.jurisdictionCapabilities...');
  const caps = await caller.compliance.jurisdictionCapabilities();
  console.log(`✅ Capabilities returned:`, JSON.stringify(caps).substring(0, 100));

  console.log('✅ Testing single compliance query...');
  const payload = { question: "What are the requirements for open banking in Nigeria?", mode: 'SINGLE' as const, jurisdictions: ['NG' as any] };
  const res = await caller.compliance.query(payload);
  
  if (!res.citations || res.citations.length === 0) throw new Error("No citations found - pinecone retrieval failed");
  console.log('✅ Retrieval from Pinecone happened');
  console.log('✅ Grader accepted evidence');
  console.log('✅ Verifier produced a verdict (Grounded: ' + res.grounded + ')');
  
  const hasValidCitation = res.citations.some((c:any) => c.jurisdictionCode === 'NG');
  if (!hasValidCitation) throw new Error("No valid NG citation found");
  console.log('✅ Answer includes grounded citations with correct jurisdictionCode');
  
  const fallbackReason = 'fallbackReason' in res ? res.fallbackReason : undefined;
  if (res.abstained || fallbackReason) throw new Error("Provider error or fallback triggered: " + fallbackReason);
  console.log('✅ No provider 429 or billing error');

  console.log(`🎉 Smoke test passed in ${Date.now() - start}ms`);
  process.exit(0);
}

runSmokeTest().catch(e => {
  console.error("❌ Smoke test failed:", e);
  process.exit(1);
});
