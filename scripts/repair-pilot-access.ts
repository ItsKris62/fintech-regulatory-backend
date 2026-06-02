/**
 * scripts/repair-pilot-access.ts
 *
 * Idempotent backfill script: ensures every pilot tester who has an
 * organizationId but is missing an ACTIVE OrganizationMember row gets one.
 *
 * Safe to run multiple times — uses upsert so existing rows are not duplicated.
 *
 * Usage (from fintech-regulatory-backend/):
 *   pnpm tsx scripts/repair-pilot-access.ts
 *   pnpm tsx scripts/repair-pilot-access.ts --dry-run
 *
 * What it does:
 *   1. Finds all pilot users (isPilot=true) who have an organizationId.
 *   2. For each, checks whether an ACTIVE OrganizationMember row exists.
 *   3. If missing or non-ACTIVE, upserts an ACTIVE OWNER row.
 *   4. Invalidates the Redis membership cache key for each repaired user.
 *   5. Logs before/after counts.
 */

import { MemberRole, MemberStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma/client';
import { redis } from '../src/lib/redis/client';

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  console.log(`\n=== repair-pilot-access ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  // ── 1. Find all pilot users with an organizationId ──────────────────────────
  const pilotUsers = await prisma.user.findMany({
    where: {
      isPilot: true,
      organizationId: { not: null },
    },
    select: {
      id: true,
      email: true,
      organizationId: true,
      supabaseAuthId: true,
    },
  });

  console.log(`Pilot users with an organizationId: ${pilotUsers.length}`);

  if (pilotUsers.length === 0) {
    console.log('Nothing to repair.\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  // ── 2. Check which ones are missing an ACTIVE OrganizationMember row ────────
  const needsRepair: typeof pilotUsers = [];

  for (const user of pilotUsers) {
    const orgId = user.organizationId!;
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
      select: { status: true },
    });

    if (!member || member.status !== MemberStatus.ACTIVE) {
      needsRepair.push(user);
    }
  }

  console.log(`Users missing ACTIVE OrganizationMember row: ${needsRepair.length}`);

  if (needsRepair.length === 0) {
    console.log('All pilot users already have ACTIVE membership rows. Nothing to do.\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  // ── 3. Upsert ACTIVE OWNER rows ─────────────────────────────────────────────
  let repairedCount = 0;
  const cacheKeysToInvalidate: string[] = [];

  for (const user of needsRepair) {
    const orgId = user.organizationId!;

    console.log(
      `  ${DRY_RUN ? '[skip]' : '[fix]'} userId=${user.id} email=${user.email} orgId=${orgId}`,
    );

    if (!DRY_RUN) {
      await prisma.organizationMember.upsert({
        where: {
          userId_organizationId: { userId: user.id, organizationId: orgId },
        },
        create: {
          userId: user.id,
          organizationId: orgId,
          role: MemberRole.OWNER,
          status: MemberStatus.ACTIVE,
        },
        update: {
          status: MemberStatus.ACTIVE,
          role: MemberRole.OWNER,
        },
      });

      repairedCount++;
    }

    // Collect cache keys to invalidate regardless of dry-run (so we can log them)
    cacheKeysToInvalidate.push(`sheriabot:orgmem:${user.id}:${orgId}`);
    if (user.supabaseAuthId) {
      cacheKeysToInvalidate.push(`user:session:${user.supabaseAuthId}`);
    }
  }

  // ── 4. Invalidate Redis caches ───────────────────────────────────────────────
  if (!DRY_RUN && cacheKeysToInvalidate.length > 0) {
    console.log(`\nInvalidating ${cacheKeysToInvalidate.length} Redis cache keys…`);
    const results = await Promise.allSettled(
      cacheKeysToInvalidate.map((key) => redis.del(key)),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`  ${failed.length} cache invalidation(s) failed (non-fatal).`);
    } else {
      console.log('  All cache keys invalidated successfully.');
    }
  } else if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would invalidate ${cacheKeysToInvalidate.length} Redis cache keys.`);
  }

  // ── 5. Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log(`  Pilot users inspected : ${pilotUsers.length}`);
  console.log(`  Users needing repair  : ${needsRepair.length}`);
  console.log(`  Users repaired        : ${DRY_RUN ? 0 : repairedCount} ${DRY_RUN ? '(dry run — no writes)' : ''}`);
  console.log(`  Cache keys queued     : ${cacheKeysToInvalidate.length}`);
  console.log('');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('repair-pilot-access failed:', err);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
