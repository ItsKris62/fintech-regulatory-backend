/**
 * Backfill OrganizationMember rows for legacy users with User.organizationId.
 *
 * Dry run is the default:
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run
 *
 * Apply writes:
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts --apply
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts --apply --limit=100
 */

import 'dotenv/config';
import { MemberRole, MemberStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';

type LegacyUserCandidate = {
  id: string;
  email: string;
  organizationId: string | null;
  organization: { id: string } | null;
  organizationMemberships: Array<{
    id: string;
    organizationId: string;
    role: MemberRole;
    status: MemberStatus;
  }>;
};

export type MembershipBackfillCreate = {
  userId: string;
  email: string;
  organizationId: string;
  role: 'MEMBER';
};

export type MembershipBackfillSkip = {
  userId: string;
  email: string;
  organizationId: string | null;
  reason: 'missing_organization' | 'existing_non_active_membership';
  existingStatus?: MemberStatus;
  existingRole?: MemberRole;
};

export type MembershipBackfillPlan = {
  usersScanned: number;
  usersWithOrganizationId: number;
  existingMemberships: number;
  missingMemberships: number;
  ambiguous: MembershipBackfillSkip[];
  creates: MembershipBackfillCreate[];
};

function parseLimit(argv: string[]): number | undefined {
  const raw = argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--limit must be a positive integer');
  }

  return parsed;
}

export function membershipCacheKeysFor(userId: string, organizationId: string): string[] {
  return [
    `sheriabot:orgmem:${userId}:${organizationId}`,
    `sheriabot:planctx:${userId}`,
  ];
}

export function buildOrganizationMembershipBackfillPlan(
  candidates: LegacyUserCandidate[],
): MembershipBackfillPlan {
  const plan: MembershipBackfillPlan = {
    usersScanned: candidates.length,
    usersWithOrganizationId: 0,
    existingMemberships: 0,
    missingMemberships: 0,
    ambiguous: [],
    creates: [],
  };

  for (const user of candidates) {
    if (!user.organizationId) continue;
    plan.usersWithOrganizationId++;

    if (!user.organization) {
      plan.ambiguous.push({
        userId: user.id,
        email: user.email,
        organizationId: user.organizationId,
        reason: 'missing_organization',
      });
      continue;
    }

    const existing = user.organizationMemberships.find(
      (member) => member.organizationId === user.organizationId,
    );

    if (existing) {
      plan.existingMemberships++;

      if (existing.status !== MemberStatus.ACTIVE) {
        plan.ambiguous.push({
          userId: user.id,
          email: user.email,
          organizationId: user.organizationId,
          reason: 'existing_non_active_membership',
          existingStatus: existing.status,
          existingRole: existing.role,
        });
      }

      continue;
    }

    plan.missingMemberships++;
    plan.creates.push({
      userId: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: MemberRole.MEMBER,
    });
  }

  return plan;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const dryRun = !apply || argv.includes('--dry-run');
  const limit = parseLimit(argv);

  if (apply && argv.includes('--dry-run')) {
    throw new Error('Use either --apply or --dry-run, not both');
  }

  const candidates = await prisma.user.findMany({
    where: { organizationId: { not: null } },
    ...(limit ? { take: limit } : {}),
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      organizationId: true,
      organization: { select: { id: true } },
      organizationMemberships: {
        select: {
          id: true,
          organizationId: true,
          role: true,
          status: true,
        },
      },
    },
  });

  const plan = buildOrganizationMembershipBackfillPlan(candidates);
  const mode = dryRun ? 'DRY RUN' : 'APPLY';
  let created = 0;
  const cacheKeys = new Set<string>();

  console.log('\nOrganization membership backfill report\n');
  console.log(`Mode: ${mode}`);
  console.log(`Users scanned: ${plan.usersScanned}`);
  console.log(`Users with organizationId: ${plan.usersWithOrganizationId}`);
  console.log(`Existing memberships: ${plan.existingMemberships}`);
  console.log(`Missing memberships: ${plan.missingMemberships}`);
  console.log(`Ambiguous cases: ${plan.ambiguous.length}`);
  console.log(`${dryRun ? 'Would create' : 'Planned creates'}: ${plan.creates.length}`);
  console.log(`Skipped: ${plan.ambiguous.length}`);

  for (const skip of plan.ambiguous) {
    console.log(
      `[skip:${skip.reason}] user=${skip.email} userId=${skip.userId} orgId=${skip.organizationId}` +
        (skip.existingStatus ? ` existingStatus=${skip.existingStatus} existingRole=${skip.existingRole}` : ''),
    );
  }

  for (const row of plan.creates) {
    console.log(
      `[${dryRun ? 'would-create' : 'create'}] user=${row.email} userId=${row.userId} orgId=${row.organizationId} role=${row.role}`,
    );

    if (dryRun) continue;

    try {
      await prisma.organizationMember.create({
        data: {
          userId: row.userId,
          organizationId: row.organizationId,
          role: row.role,
          status: MemberStatus.ACTIVE,
        },
      });
      created++;
      membershipCacheKeysFor(row.userId, row.organizationId).forEach((key) => cacheKeys.add(key));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        console.log(`[skip:duplicate_created_concurrently] user=${row.email} userId=${row.userId} orgId=${row.organizationId}`);
        continue;
      }
      throw error;
    }
  }

  if (!dryRun && cacheKeys.size > 0) {
    await Promise.allSettled([...cacheKeys].map((key) => redis.del(key)));
  }

  console.log('\nSummary');
  console.log(`Created OrganizationMember rows: ${dryRun ? 0 : created}`);
  console.log(`Skipped ambiguous cases: ${plan.ambiguous.length}`);
  console.log(`Caches invalidated: ${dryRun ? 0 : cacheKeys.size}${dryRun ? ` (would invalidate ${plan.creates.length * 2})` : ''}`);
  if (dryRun) console.log('\nNo database changes were made.');
  if (!dryRun && created === 0) console.log('\nNo changes were needed.');
  console.log('');

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('backfill-organization-memberships failed:', error);
    prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
