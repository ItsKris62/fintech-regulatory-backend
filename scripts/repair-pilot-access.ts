/**
 * Idempotent repair/backfill script for pilot access.
 *
 * Dry run is the default:
 *   pnpm tsx scripts/repair-pilot-access.ts
 *   pnpm tsx scripts/repair-pilot-access.ts --dry-run
 *
 * Execute writes:
 *   pnpm tsx scripts/repair-pilot-access.ts --execute
 */

import { MemberRole, MemberStatus, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma/client';
import { redis } from '../src/lib/redis/client';

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE || process.argv.includes('--dry-run');
const DEFAULT_PILOT_DAYS = 14;

function addPilotCacheKeys(
  keys: Set<string>,
  user: { id: string; organizationId: string | null; supabaseAuthId: string | null },
): void {
  if (user.organizationId) {
    keys.add(`sheriabot:orgmem:${user.id}:${user.organizationId}`);
  }
  keys.add(`sheriabot:planctx:${user.id}`);
  if (user.supabaseAuthId) {
    keys.add(`user:session:${user.supabaseAuthId}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n=== repair-pilot-access ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  const now = new Date();
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
      pilotStartedAt: true,
      pilotExpiresAt: true,
      pilotAccessStatus: true,
      pilotExtensionCount: true,
      pilotCreatedByAdminId: true,
      organization: {
        select: {
          id: true,
          subscriptionStatus: true,
        },
      },
    },
  });

  const needsMembershipRepair: typeof pilotUsers = [];
  const needsPilotAccessBackfill: typeof pilotUsers = [];
  const ineligibleForBackfill: Array<{ email: string; reason: string }> = [];
  const cacheKeysToInvalidate = new Set<string>();

  for (const user of pilotUsers) {
    const organizationId = user.organizationId;
    if (!organizationId || !user.organization) {
      ineligibleForBackfill.push({ email: user.email, reason: 'missing_organization' });
      continue;
    }

    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { status: true },
    });

    if (!member || member.status !== MemberStatus.ACTIVE) {
      needsMembershipRepair.push(user);
    }

    const activeAccess = await (prisma as any).pilotAccess.findFirst({
      where: { userId: user.id, organizationId, status: 'ACTIVE' },
      select: { id: true },
    }).catch(() => null);

    if (activeAccess) continue;

    if (user.organization.subscriptionStatus === SubscriptionStatus.SUSPENDED) {
      ineligibleForBackfill.push({ email: user.email, reason: 'organization_suspended' });
      continue;
    }
    if (user.pilotAccessStatus === 'REVOKED' || user.pilotAccessStatus === 'CONVERTED') {
      ineligibleForBackfill.push({ email: user.email, reason: `pilot_${user.pilotAccessStatus.toLowerCase()}` });
      continue;
    }
    if (user.pilotExpiresAt && user.pilotExpiresAt <= now) {
      ineligibleForBackfill.push({ email: user.email, reason: 'pilot_expired' });
      continue;
    }

    needsPilotAccessBackfill.push(user);
  }

  console.log(`Pilot users scanned: ${pilotUsers.length}`);
  console.log(`Users needing membership repair: ${needsMembershipRepair.length}`);
  console.log(`Users needing PilotAccess backfill: ${needsPilotAccessBackfill.length}`);
  console.log(`Users ineligible for PilotAccess backfill: ${ineligibleForBackfill.length}`);
  for (const row of ineligibleForBackfill) {
    console.log(`  [ineligible] ${row.email}: ${row.reason}`);
  }

  let repairedCount = 0;
  for (const user of needsMembershipRepair) {
    const organizationId = user.organizationId!;
    console.log(`  ${DRY_RUN ? '[skip]' : '[fix]'} membership userId=${user.id} email=${user.email} orgId=${organizationId}`);
    if (!DRY_RUN) {
      await prisma.organizationMember.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId } },
        create: {
          userId: user.id,
          organizationId,
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
    addPilotCacheKeys(cacheKeysToInvalidate, user);
  }

  let backfilledCount = 0;
  for (const user of needsPilotAccessBackfill) {
    const organizationId = user.organizationId!;
    const expiresAt = user.pilotExpiresAt ?? new Date(now.getTime() + DEFAULT_PILOT_DAYS * 24 * 60 * 60 * 1000);
    console.log(`  ${DRY_RUN ? '[skip]' : '[pilot]'} PilotAccess userId=${user.id} email=${user.email} orgId=${organizationId} expiresAt=${expiresAt.toISOString()}`);
    if (!DRY_RUN) {
      await (prisma as any).pilotAccess.create({
        data: {
          userId: user.id,
          organizationId,
          status: 'ACTIVE',
          entitlementProfile: 'PILOT_FULL',
          startsAt: user.pilotStartedAt ?? now,
          expiresAt,
          extensionCount: user.pilotExtensionCount ?? 0,
          createdByAdminId: user.pilotCreatedByAdminId,
          metadata: {
            source: 'repair-pilot-access',
            legacyUserPilotFieldsSynced: true,
          },
        },
      });
      backfilledCount++;
    }
    addPilotCacheKeys(cacheKeysToInvalidate, user);
  }

  if (!DRY_RUN && cacheKeysToInvalidate.size > 0) {
    console.log(`\nInvalidating ${cacheKeysToInvalidate.size} Redis cache keys...`);
    const results = await Promise.allSettled(
      [...cacheKeysToInvalidate].map((key) => redis.del(key)),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`  ${failed.length} cache invalidation(s) failed (non-fatal).`);
    }
  } else {
    console.log(`\n[DRY RUN] Would invalidate ${cacheKeysToInvalidate.size} Redis cache keys.`);
  }

  console.log('\n=== Summary ===');
  console.log(`  Pilot users inspected     : ${pilotUsers.length}`);
  console.log(`  Users needing repair      : ${needsMembershipRepair.length}`);
  console.log(`  Users repaired            : ${DRY_RUN ? 0 : repairedCount} ${DRY_RUN ? '(dry run - no writes)' : ''}`);
  console.log(`  Users needing backfill    : ${needsPilotAccessBackfill.length}`);
  console.log(`  PilotAccess backfilled    : ${DRY_RUN ? 0 : backfilledCount} ${DRY_RUN ? '(dry run - no writes)' : ''}`);
  console.log(`  Cache keys queued         : ${cacheKeysToInvalidate.size}`);
  console.log('');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('repair-pilot-access failed:', err);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
