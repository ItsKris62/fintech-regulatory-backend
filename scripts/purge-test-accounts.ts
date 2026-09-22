/**
 * Script to identify and safely purge test/QA/staging/E2E accounts.
 *
 * Usage:
 *   npx tsx scripts/purge-test-accounts.ts            # Default: Dry-run mode
 *   npx tsx scripts/purge-test-accounts.ts --dry-run  # Explicit dry-run
 *   npx tsx scripts/purge-test-accounts.ts --execute  # Execute live deletion
 *
 * Output is logged to stdout and appended to purge-test-accounts.log.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../src/lib/prisma/client';
import { redis } from '../src/lib/redis/client';
import { userSessionKey, lastSeenKey, sessionStartKey } from '../src/config/session';

export interface PurgePlanItem {
  userId: string;
  email: string;
  role: string;
  organizationId: string | null;
  organizationName: string | null;
  membershipsCount: number;
  sessionsCount: number;
  reason: string;
}

const TEST_ACCOUNT_PATTERNS = [
  /@sheriabot\.test$/i,
  /@example\.invalid$/i,
  /@example\.test$/i,
  /^qa-.*@sheriabot\.com$/i,
  /^qa@sheriabot\.com$/i,
  /^qa-uat@sheriabot\.com$/i,
  /^uat-test@sheriabot\.com$/i,
  /^sheriabot\.qa\.admin/i,
  /^test-.*@/i,
  /^e2e_.*@/i,
  /^perf_.*@/i,
  /^tmp_.*@/i,
  /^pilot-.*@/i,
  /^sandbox-.*@/i,
  /^loadtest-.*@/i,
  /^mock-.*@/i,
  /^staging_user_.*@/i,
  /^autoheal_.*@/i,
];

function isTestEmail(email: string): { isTest: boolean; reason: string } {
  for (const pattern of TEST_ACCOUNT_PATTERNS) {
    if (pattern.test(email)) {
      return { isTest: true, reason: `Matches test account pattern: ${pattern.toString()}` };
    }
  }
  return { isTest: false, reason: '' };
}

export async function runPurge(isExecute: boolean = false) {
  console.log(`\n======================================================`);
  console.log(`🧹 Purge Test Accounts Script (Mode: ${isExecute ? 'LIVE EXECUTION' : 'DRY-RUN'})`);
  console.log(`======================================================\n`);

  const allUsers = await prisma.user.findMany({
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          users: { select: { id: true } },
        },
      },
      organizationMemberships: true,
      sessions: true,
    },
  });

  const purgeCandidates: PurgePlanItem[] = [];
  const keepUsers: Array<{ id: string; email: string; reason: string }> = [];

  for (const user of allUsers) {
    const { isTest, reason } = isTestEmail(user.email);

    if (isTest) {
      purgeCandidates.push({
        userId: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        organizationName: user.organization?.name || null,
        membershipsCount: user.organizationMemberships.length,
        sessionsCount: user.sessions.length,
        reason,
      });
    } else {
      keepUsers.push({
        id: user.id,
        email: user.email,
        reason: 'Legitimate / production-candidate user email',
      });
    }
  }

  console.log(`📊 Analysis Results:`);
  console.log(`- Total users in database: ${allUsers.length}`);
  console.log(`- Retained production users: ${keepUsers.length}`);
  console.log(`- Purge candidate test users: ${purgeCandidates.length}\n`);

  console.log(`📋 Purge Plan Summary:`);
  console.table(
    purgeCandidates.map((c) => ({
      ID: c.userId,
      Email: c.email,
      Role: c.role,
      Org: c.organizationName || 'None',
      Sessions: c.sessionsCount,
      Memberships: c.membershipsCount,
    }))
  );

  const logEntries: string[] = [];
  logEntries.push(`[${new Date().toISOString()}] PURGE RUN (Mode: ${isExecute ? 'EXECUTE' : 'DRY_RUN'})`);
  logEntries.push(`Total Users: ${allUsers.length}, Purge Candidates: ${purgeCandidates.length}, Retained Users: ${keepUsers.length}`);

  for (const c of purgeCandidates) {
    logEntries.push(`Candidate: ${c.userId} | ${c.email} | Org: ${c.organizationId || 'none'} | Reason: ${c.reason}`);
  }

  if (isExecute) {
    console.log(`\n⚠️  EXECUTING PURGE FOR ${purgeCandidates.length} USERS...`);

    let deletedUsers = 0;
    let deletedOrgs = 0;

    for (const candidate of purgeCandidates) {
      console.log(`Deleting user ${candidate.email} (${candidate.userId})...`);

      // 1. Invalidate Redis sessions
      const userKey = userSessionKey(candidate.userId);
      const lastSeen = lastSeenKey(candidate.userId);
      const startKey = sessionStartKey(candidate.userId);

      await redis.del(userKey);
      await redis.del(lastSeen);
      await redis.del(startKey);

      // 2. Cascade DB deletion
      await prisma.$transaction(async (tx) => {
        await tx.session.deleteMany({ where: { userId: candidate.userId } });
        await tx.organizationMembership.deleteMany({ where: { userId: candidate.userId } });
        await tx.complianceQuery.deleteMany({ where: { userId: candidate.userId } });
        await tx.user.delete({ where: { id: candidate.userId } });

        // If organization was owned exclusively by this test user and has no other users, clean it up
        if (candidate.organizationId) {
          const remainingUsers = await tx.user.count({
            where: { organizationId: candidate.organizationId },
          });
          if (remainingUsers === 0) {
            await tx.checklist.deleteMany({ where: { organizationId: candidate.organizationId } });
            await tx.policy.deleteMany({ where: { organizationId: candidate.organizationId } });
            await tx.vaultDocument.deleteMany({ where: { organizationId: candidate.organizationId } });
            await tx.gapAnalysis.deleteMany({ where: { organizationId: candidate.organizationId } });
            await tx.organization.delete({ where: { id: candidate.organizationId } });
            deletedOrgs++;
          }
        }
      });

      deletedUsers++;
    }

    console.log(`\n✅ Purge completed: ${deletedUsers} test users deleted, ${deletedOrgs} empty organizations removed.`);
    logEntries.push(`EXECUTION COMPLETE: ${deletedUsers} users deleted, ${deletedOrgs} orgs removed.`);
  } else {
    console.log(`\n🔒 DRY-RUN ONLY. No database records or Redis keys were modified.`);
    console.log(`To execute live deletion, run with --execute.`);
  }

  const logPath = path.resolve(process.cwd(), 'purge-test-accounts.log');
  fs.appendFileSync(logPath, logEntries.join('\n') + '\n\n', 'utf8');
  console.log(`📄 Log written to: ${logPath}\n`);

  return {
    totalUsers: allUsers.length,
    retainedCount: keepUsers.length,
    purgeCandidatesCount: purgeCandidates.length,
    purgeCandidates,
  };
}

if (process.argv[1]?.includes('purge-test-accounts')) {
  const isExecute = process.argv.includes('--execute');
  runPurge(isExecute)
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('❌ Purge script error:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
