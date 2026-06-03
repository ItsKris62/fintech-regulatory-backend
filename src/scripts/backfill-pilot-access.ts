/**
 * Backfill PilotAccess rows from legacy User pilot fields.
 *
 * Dry run is the default:
 *   pnpm tsx src/scripts/backfill-pilot-access.ts
 *
 * Execute writes:
 *   pnpm tsx src/scripts/backfill-pilot-access.ts --execute
 */

import 'dotenv/config';
import { MemberStatus, SubscriptionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE || process.argv.includes('--dry-run');
const DEFAULT_PILOT_DAYS = 14;

function cacheKeysFor(user: { id: string; organizationId: string | null; supabaseAuthId: string | null }): string[] {
  return [
    ...(user.organizationId ? [`sheriabot:orgmem:${user.id}:${user.organizationId}`] : []),
    `sheriabot:planctx:${user.id}`,
    ...(user.supabaseAuthId ? [`user:session:${user.supabaseAuthId}`] : []),
  ];
}

async function main(): Promise<void> {
  const now = new Date();
  const candidates = await prisma.user.findMany({
    where: { isPilot: true },
    select: {
      id: true,
      email: true,
      supabaseAuthId: true,
      organizationId: true,
      pilotStartedAt: true,
      pilotExpiresAt: true,
      pilotAccessStatus: true,
      pilotExtensionCount: true,
      pilotCreatedByAdminId: true,
      organization: {
        select: {
          id: true,
          subscriptionStatus: true,
          plan: true,
        },
      },
    },
  });

  const eligible: typeof candidates = [];
  const skipped: Array<{ email: string; reason: string }> = [];
  const cacheKeys = new Set<string>();

  for (const user of candidates) {
    if (!user.organizationId || !user.organization) {
      skipped.push({ email: user.email, reason: 'missing_organization' });
      continue;
    }

    const member = await prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: user.organizationId,
        },
      },
      select: { status: true },
    });

    if (!member || member.status !== MemberStatus.ACTIVE) {
      skipped.push({ email: user.email, reason: 'missing_active_membership' });
      continue;
    }

    if (user.organization.subscriptionStatus === SubscriptionStatus.SUSPENDED) {
      skipped.push({ email: user.email, reason: 'organization_suspended' });
      continue;
    }

    if (user.pilotAccessStatus === 'REVOKED' || user.pilotAccessStatus === 'CONVERTED') {
      skipped.push({ email: user.email, reason: `pilot_${user.pilotAccessStatus.toLowerCase()}` });
      continue;
    }

    if (user.pilotExpiresAt && user.pilotExpiresAt <= now) {
      skipped.push({ email: user.email, reason: 'pilot_expired' });
      continue;
    }

    const existingActive = await (prisma as any).pilotAccess.findFirst({
      where: { userId: user.id, organizationId: user.organizationId, status: 'ACTIVE' },
      select: { id: true },
    }).catch(() => null);

    if (existingActive) {
      skipped.push({ email: user.email, reason: 'active_pilot_access_exists' });
      continue;
    }

    eligible.push(user);
    cacheKeysFor(user).forEach((key) => cacheKeys.add(key));
  }

  console.log(`\n=== backfill-pilot-access ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);
  console.log(`Pilot users scanned: ${candidates.length}`);
  console.log(`Eligible for PilotAccess backfill: ${eligible.length}`);
  console.log(`Skipped: ${skipped.length}`);
  for (const row of skipped) {
    console.log(`  [skip] ${row.email}: ${row.reason}`);
  }

  let created = 0;
  for (const user of eligible) {
    const expiresAt = user.pilotExpiresAt ?? new Date(now.getTime() + DEFAULT_PILOT_DAYS * 24 * 60 * 60 * 1000);
    console.log(`  ${DRY_RUN ? '[would-create]' : '[create]'} ${user.email} orgId=${user.organizationId} expiresAt=${expiresAt.toISOString()}`);
    if (!DRY_RUN) {
      await (prisma as any).pilotAccess.create({
        data: {
          userId: user.id,
          organizationId: user.organizationId,
          status: 'ACTIVE',
          entitlementProfile: 'PILOT_FULL',
          startsAt: user.pilotStartedAt ?? now,
          expiresAt,
          extensionCount: user.pilotExtensionCount ?? 0,
          createdByAdminId: user.pilotCreatedByAdminId,
          metadata: {
            source: 'backfill-pilot-access',
            legacyUserPilotFieldsSynced: true,
            organizationPlanAtBackfill: user.organization?.plan ?? null,
            paidSubscriptionPreserved: user.organization?.plan !== 'REGULATOR',
          },
        },
      });
      created++;
    }
  }

  if (!DRY_RUN && cacheKeys.size > 0) {
    await Promise.allSettled([...cacheKeys].map((key) => redis.del(key)));
  }

  console.log('\n=== Summary ===');
  console.log(`  Pilot users scanned       : ${candidates.length}`);
  console.log(`  PilotAccess rows created  : ${DRY_RUN ? 0 : created} ${DRY_RUN ? '(dry run - no writes)' : ''}`);
  console.log(`  Cache keys invalidated    : ${DRY_RUN ? 0 : cacheKeys.size} ${DRY_RUN ? `(would invalidate ${cacheKeys.size})` : ''}`);
  console.log('');

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('backfill-pilot-access failed:', error);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
