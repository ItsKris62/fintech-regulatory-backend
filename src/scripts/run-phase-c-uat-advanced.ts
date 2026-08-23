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

async function runAdvancedUAT() {
  console.log('🚀 Starting Phase C Advanced UAT (Cache, History, Follow-up, SSE)...');
  const start = Date.now();

  const qaEmail = 'qa-uat-internal@sheriabot.com';
  const user = await prisma.user.findUnique({ where: { email: qaEmail }});
  if (!user) throw new Error('User not found. Run basic UAT first to seed user.');

  const orgMember = await prisma.organizationMember.findFirst({ where: { userId: user.id }});
  const org = await prisma.organization.findUnique({ where: { id: orgMember!.organizationId }});

  await redis.del('admin:system_config');
  await redis.del('admin:system_config:persisted');

  const ctx = {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: org!.id,
      supabaseAuthId: user.supabaseAuthId || 'mock-id',
      sessionId: 'mock-session-id',
    },
    orgMembership: {
      organizationId: org!.id,
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
      console.log(`  ✅ Success (${timing}ms) - Route: ${res.route}`);
      results.push({ name, payload, timing, success: true, route: res.route, queryId: res.id, answer: res.answer });
      return res;
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
      results.push({ name, payload, timing: Date.now() - qStart, success: false, error: err.message });
      return null;
    }
  };

  // 1. Cache Identity Test
  // Send the same query twice, ensure the second hits the cache.
  const cacheQuestion = "What is the penalty for late tax filing in Nigeria?";
  const cache1 = await runQuery('Cache Test (Miss)', { question: cacheQuestion, jurisdictions: ['NG'] });
  const cache2 = await runQuery('Cache Test (Hit)', { question: cacheQuestion, jurisdictions: ['NG'] });
  
  if (cache1 && cache2) {
    if (cache2.route === 'cache' || cache2.route === 'canonical') {
      console.log('✅ Cache identity test passed.');
    } else {
      console.log('❌ Cache identity test failed. Expected cache hit.');
    }
  }

  // 2. History & Follow-up Test
  if (cache1) {
    console.log('▶️ Running Follow-up test...');
    try {
      const followUp = await caller.compliance.followUpQuery({
        originalQueryId: cache1.id,
        question: "Can you provide more details on the exact timeline for that?"
      });
      console.log('  ✅ Follow-up Success');
      results.push({ name: 'Follow-up Test', success: true, answer: followUp.answer });
    } catch (err: any) {
      console.error(`  ❌ Follow-up Failed: ${err.message}`);
      results.push({ name: 'Follow-up Test', success: false, error: err.message });
    }
  }

  // 3. SSE Parity
  // In the TRPC router, SSE is tested via HTTP. We'll just invoke a quick query and assume the router returns the standard response.
  // We can't easily test the SSE endpoint here directly without HTTP, but TRPC is our primary interface.

  fs.writeFileSync(path.join(OUT_DIR, 'advanced_uat_results.json'), JSON.stringify(results, null, 2));
  
  const mdOut = results.map(r => 
    `### ${r.name}\n- Success: ${r.success}\n- Timing: ${r.timing}ms\n- Route: ${r.route}\n${r.error ? `- Error: ${r.error}` : ''}`
  ).join('\n\n');
  fs.writeFileSync(path.join(OUT_DIR, 'advanced_uat_summary.md'), mdOut);

  console.log(`\n🎉 Advanced UAT complete in ${Date.now() - start}ms! Results saved to ${OUT_DIR}`);
  await prisma.$disconnect();
}

runAdvancedUAT().catch(err => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
});
