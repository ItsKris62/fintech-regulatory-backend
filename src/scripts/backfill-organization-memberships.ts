/**
 * Backfill OrganizationMember rows for legacy users with User.organizationId.
 *
 * Dry run is the default:
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts --dry-run
 *
 * Apply writes only safe MEMBER/ACTIVE rows:
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts --apply
 *   pnpm tsx src/scripts/backfill-organization-memberships.ts --apply --limit=100
 *
 * Optional filters:
 *   --userId=<id> --organizationId=<id> --json --verbose
 */

import 'dotenv/config';
import { MemberRole, MemberStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { logger } from '@/utils/logger';

export type BackfillMode = 'dry-run' | 'apply';

export type MembershipBackfillClassification =
  | 'existing_active'
  | 'existing_non_active'
  | 'missing_would_create'
  | 'created'
  | 'skipped_already_exists'
  | 'ambiguous_org_missing'
  | 'ambiguous_multiple_memberships'
  | 'ambiguous_other_active_org'
  | 'create_failed';

export interface BackfillOptions {
  mode: BackfillMode;
  limit?: number;
  userId?: string;
  organizationId?: string;
  verbose: boolean;
  json: boolean;
}

export type LegacyUserCandidate = {
  id: string;
  organizationId: string | null;
  organization: { id: string } | null;
  organizationMemberships: Array<{
    id: string;
    organizationId: string;
    role: MemberRole;
    status: MemberStatus;
  }>;
};

export interface BackfillReportItem {
  userId: string;
  organizationId: string | null;
  classification: MembershipBackfillClassification;
  wouldCreate: boolean;
  created: boolean;
  reason?: string;
  existingMembershipIds?: string[];
  existingStatus?: MemberStatus;
  existingRole?: MemberRole;
  otherActiveOrganizationIds?: string[];
  error?: string;
}

export interface BackfillReport {
  mode: BackfillMode;
  usersScanned: number;
  usersWithOrganizationId: number;
  existingActive: number;
  existingNonActive: number;
  missingMemberships: number;
  wouldCreate: number;
  created: number;
  ambiguous: number;
  skipped: number;
  cachesInvalidated: number;
  cacheInvalidationFailures: number;
  items: BackfillReportItem[];
}

export interface BackfillDependencies {
  findCandidates(options: BackfillOptions): Promise<LegacyUserCandidate[]>;
  createMembership(input: { userId: string; organizationId: string; role: MemberRole; status: MemberStatus }): Promise<void>;
  findMemberships(userId: string, organizationId: string): Promise<Array<{ id: string; status: MemberStatus }>>;
  deleteCacheKey(key: string): Promise<unknown>;
}

export function parseBackfillOptions(argv: string[]): BackfillOptions {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');

  if (apply && dryRun) {
    throw new Error('Use either --apply or --dry-run, not both');
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    limit: parsePositiveIntegerFlag(argv, '--limit'),
    userId: parseStringFlag(argv, '--userId'),
    organizationId: parseStringFlag(argv, '--organizationId'),
    verbose: argv.includes('--verbose'),
    json: argv.includes('--json'),
  };
}

function parseStringFlag(argv: string[], flag: string): string | undefined {
  const raw = argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

function parsePositiveIntegerFlag(argv: string[], flag: string): number | undefined {
  const raw = parseStringFlag(argv, flag);
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }

  return parsed;
}

export function membershipCacheKeysFor(userId: string, organizationId: string): string[] {
  return [
    `sheriabot:orgmem:${userId}:${organizationId}`,
    `sheriabot:planctx:${userId}`,
  ];
}

export function buildMembershipCreateInput(userId: string, organizationId: string) {
  return {
    userId,
    organizationId,
    role: MemberRole.MEMBER,
    status: MemberStatus.ACTIVE,
  };
}

export function classifyLegacyMembershipCase(user: LegacyUserCandidate): BackfillReportItem {
  const base = {
    userId: user.id,
    organizationId: user.organizationId,
    wouldCreate: false,
    created: false,
  };

  if (!user.organizationId) {
    return {
      ...base,
      classification: 'ambiguous_org_missing',
      reason: 'user_has_no_legacy_organization_id',
    };
  }

  if (!user.organization) {
    return {
      ...base,
      classification: 'ambiguous_org_missing',
      reason: 'legacy_organization_not_found',
    };
  }

  const matchingMemberships = user.organizationMemberships.filter(
    (member) => member.organizationId === user.organizationId,
  );

  if (matchingMemberships.length > 1) {
    return {
      ...base,
      classification: 'ambiguous_multiple_memberships',
      reason: 'multiple_memberships_for_legacy_organization',
      existingMembershipIds: matchingMemberships.map((member) => member.id),
    };
  }

  const matchingMembership = matchingMemberships[0];
  if (matchingMembership) {
    if (matchingMembership.status === MemberStatus.ACTIVE) {
      return {
        ...base,
        classification: 'existing_active',
        existingMembershipIds: [matchingMembership.id],
        existingRole: matchingMembership.role,
        existingStatus: matchingMembership.status,
      };
    }

    return {
      ...base,
      classification: 'existing_non_active',
      reason: 'matching_membership_is_not_active',
      existingMembershipIds: [matchingMembership.id],
      existingRole: matchingMembership.role,
      existingStatus: matchingMembership.status,
    };
  }

  const otherActiveOrganizationIds = [
    ...new Set(
      user.organizationMemberships
        .filter((member) => member.status === MemberStatus.ACTIVE && member.organizationId !== user.organizationId)
        .map((member) => member.organizationId),
    ),
  ];

  if (otherActiveOrganizationIds.length > 0) {
    return {
      ...base,
      classification: 'ambiguous_other_active_org',
      reason: 'user_has_active_membership_in_another_organization',
      otherActiveOrganizationIds,
    };
  }

  return {
    ...base,
    classification: 'missing_would_create',
    wouldCreate: true,
  };
}

export function buildInitialReport(mode: BackfillMode, candidates: LegacyUserCandidate[]): BackfillReport {
  const items = candidates.map(classifyLegacyMembershipCase);

  return {
    mode,
    usersScanned: candidates.length,
    usersWithOrganizationId: candidates.filter((user) => user.organizationId !== null).length,
    existingActive: items.filter((item) => item.classification === 'existing_active').length,
    existingNonActive: items.filter((item) => item.classification === 'existing_non_active').length,
    missingMemberships: items.filter((item) => item.classification === 'missing_would_create').length,
    wouldCreate: items.filter((item) => item.wouldCreate).length,
    created: 0,
    ambiguous: items.filter((item) => item.classification.startsWith('ambiguous_')).length,
    skipped: items.filter((item) => item.classification === 'existing_non_active' || item.classification.startsWith('ambiguous_')).length,
    cachesInvalidated: 0,
    cacheInvalidationFailures: 0,
    items,
  };
}

export async function runOrganizationMembershipBackfill(
  options: BackfillOptions,
  dependencies: BackfillDependencies = defaultDependencies,
): Promise<BackfillReport> {
  const candidates = await dependencies.findCandidates(options);
  const report = buildInitialReport(options.mode, candidates);

  if (options.mode === 'dry-run') {
    return report;
  }

  const cacheKeys = new Set<string>();

  for (const item of report.items) {
    if (!item.wouldCreate || !item.organizationId) continue;

    try {
      const freshMemberships = await dependencies.findMemberships(item.userId, item.organizationId);
      if (freshMemberships.length > 0) {
        item.classification = 'skipped_already_exists';
        item.wouldCreate = false;
        item.reason = 'membership_created_or_restored_before_apply';
        item.existingMembershipIds = freshMemberships.map((member) => member.id);
        report.skipped++;
        report.wouldCreate--;
        continue;
      }

      await dependencies.createMembership(buildMembershipCreateInput(item.userId, item.organizationId));
      item.classification = 'created';
      item.created = true;
      item.wouldCreate = false;
      report.created++;
      report.wouldCreate--;
      membershipCacheKeysFor(item.userId, item.organizationId).forEach((key) => cacheKeys.add(key));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        item.classification = 'skipped_already_exists';
        item.wouldCreate = false;
        item.reason = 'membership_created_concurrently';
        report.skipped++;
        report.wouldCreate--;
        continue;
      }

      item.classification = 'create_failed';
      item.wouldCreate = false;
      item.error = error instanceof Error ? error.message : String(error);
      report.skipped++;
      report.wouldCreate--;
      logger.error({
        type: 'organization_membership_backfill_create_failed',
        userId: item.userId,
        organizationId: item.organizationId,
        error: item.error,
      });
    }
  }

  const cacheResults = await Promise.allSettled([...cacheKeys].map((key) => dependencies.deleteCacheKey(key)));
  report.cachesInvalidated = cacheResults.filter((result) => result.status === 'fulfilled').length;
  report.cacheInvalidationFailures = cacheResults.length - report.cachesInvalidated;

  if (report.cacheInvalidationFailures > 0) {
    logger.warn({
      type: 'organization_membership_backfill_cache_invalidation_failed',
      failures: report.cacheInvalidationFailures,
    });
  }

  return report;
}

const defaultDependencies: BackfillDependencies = {
  async findCandidates(options) {
    return prisma.user.findMany({
      where: {
        organizationId: { not: null },
        deletedAt: null,
        ...(options.userId ? { id: options.userId } : {}),
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      },
      ...(options.limit ? { take: options.limit } : {}),
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
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
  },
  async findMemberships(userId, organizationId) {
    return prisma.organizationMember.findMany({
      where: { userId, organizationId },
      select: { id: true, status: true },
    });
  },
  async createMembership(input) {
    await prisma.organizationMember.create({ data: input });
  },
  async deleteCacheKey(key) {
    await redis.del(key);
  },
};

export function formatTextReport(report: BackfillReport, options: BackfillOptions): string {
  const lines = [
    '',
    'Organization membership backfill report',
    '',
    `Mode: ${report.mode === 'dry-run' ? 'DRY RUN' : 'APPLY'}`,
    `Users scanned: ${report.usersScanned}`,
    `Users with organizationId: ${report.usersWithOrganizationId}`,
    `Existing active memberships: ${report.existingActive}`,
    `Existing non-active memberships: ${report.existingNonActive}`,
    `Missing memberships: ${report.missingMemberships}`,
    `Ambiguous cases: ${report.ambiguous}`,
    `Would create memberships: ${report.mode === 'dry-run' ? report.wouldCreate : 0}`,
    `Created OrganizationMember rows: ${report.created}`,
    `Skipped: ${report.skipped}`,
    `Caches invalidated: ${report.cachesInvalidated}`,
    `Cache invalidation failures: ${report.cacheInvalidationFailures}`,
  ];

  if (options.verbose) {
    lines.push('', 'Items:');
    for (const item of report.items) {
      lines.push(formatReportItem(item));
    }
  } else if (report.ambiguous > 0 || report.created > 0 || report.wouldCreate > 0) {
    lines.push('', 'Review with --verbose for per-user IDs.');
  }

  if (report.mode === 'dry-run') {
    lines.push('', 'No database changes were made.');
  } else if (report.cacheInvalidationFailures > 0) {
    lines.push('', 'Database changes were made, but some cache invalidations failed. Manually flush the reported user/org cache keys if needed.');
  }

  lines.push('');
  return lines.join('\n');
}

function formatReportItem(item: BackfillReportItem): string {
  const details = [
    `[${item.classification}]`,
    `userId=${item.userId}`,
    `orgId=${item.organizationId ?? 'null'}`,
  ];

  if (item.existingStatus) details.push(`existingStatus=${item.existingStatus}`);
  if (item.existingRole) details.push(`existingRole=${item.existingRole}`);
  if (item.otherActiveOrganizationIds?.length) details.push(`otherActiveOrgIds=${item.otherActiveOrganizationIds.join(',')}`);
  if (item.reason) details.push(`reason=${item.reason}`);
  if (item.error) details.push(`error=${item.error}`);

  return details.join(' ');
}

async function main(): Promise<void> {
  const options = parseBackfillOptions(process.argv.slice(2));
  const report = await runOrganizationMembershipBackfill(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTextReport(report, options));
  }

  logger.info({
    type: 'organization_membership_backfill_completed',
    mode: options.mode,
    usersScanned: report.usersScanned,
    created: report.created,
    skipped: report.skipped,
    cachesInvalidated: report.cachesInvalidated,
    cacheInvalidationFailures: report.cacheInvalidationFailures,
  });

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('backfill-organization-memberships failed:', error instanceof Error ? error.message : String(error));
    prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
