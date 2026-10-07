import 'dotenv/config';
import { PrismaClient, ComplianceCategory } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { findKenyaBaselineByTitleAndCategory } from '../../modules/compliance/baseline-requirements';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

interface BackfillStats {
  orgsExamined: number;
  genuineKeOrgs: number;
  nonKeConfiguredOrgs: number;
  unconfiguredOrgs: number;
  canonicalItemsUpdated: number;
  legacyDuplicateItemsPreserved: number;
  snapshotsUpdated: number;
  snapshotsPreservedUnscoped: number;
}

export async function runComplianceJurisdictionBackfill(execute: boolean = false): Promise<BackfillStats> {
  console.log(`=== SHERIABOT COMPLIANCE JURISDICTION BACKFILL (${execute ? 'EXECUTE' : 'DRY RUN'}) ===\n`);

  const stats: BackfillStats = {
    orgsExamined: 0,
    genuineKeOrgs: 0,
    nonKeConfiguredOrgs: 0,
    unconfiguredOrgs: 0,
    canonicalItemsUpdated: 0,
    legacyDuplicateItemsPreserved: 0,
    snapshotsUpdated: 0,
    snapshotsPreservedUnscoped: 0,
  };

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      name: true,
      homeJurisdictionCode: true,
      enabledJurisdictions: true,
    },
  });

  stats.orgsExamined = orgs.length;
  console.log(`Found ${orgs.length} organizations to evaluate.`);

  for (const org of orgs) {
    const isGenuineKe = org.homeJurisdictionCode === 'KE';

    if (isGenuineKe) {
      stats.genuineKeOrgs++;

      // Fetch all ComplianceItems for this KE organization with explicit fields
      const items = await prisma.complianceItem.findMany({
        where: { organizationId: org.id },
        select: {
          id: true,
          category: true,
          title: true,
          isCompleted: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ isCompleted: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'asc' }],
      });

      // Group items by category and title
      const groups = new Map<string, typeof items>();
      for (const item of items) {
        const groupKey = `${item.category}:${item.title}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
        }
        groups.get(groupKey)!.push(item);
      }

      for (const [groupKey, groupItems] of groups.entries()) {
        const canonicalRow = groupItems[0]; // Candidate with isCompleted: true, latest updatedAt
        const baselineDef = findKenyaBaselineByTitleAndCategory(canonicalRow.title, canonicalRow.category);

        if (!baselineDef) {
          // Unknown / custom item -> Leave unkeyed and preserve as is
          continue;
        }

        // Determine merged state
        const anyCompleted = groupItems.some((i) => i.isCompleted);
        const completedTimes = groupItems
          .map((i) => i.completedAt)
          .filter((t): t is Date => t !== null);
        const earliestCompletedAt = completedTimes.length > 0
          ? new Date(Math.min(...completedTimes.map((d) => d.getTime())))
          : null;

        const assessedTimes = groupItems
          .map((i) => (i as any).assessedAt)
          .filter((t): t is Date => t != null);
        const latestAssessedAt = assessedTimes.length > 0
          ? new Date(Math.max(...assessedTimes.map((d) => d.getTime())))
          : (anyCompleted ? (earliestCompletedAt ?? new Date()) : null);

        if (execute) {
          // Update canonical row
          await prisma.complianceItem.update({
            where: { id: canonicalRow.id },
            data: {
              jurisdictionCode: 'KE',
              requirementKey: baselineDef.requirementKey,
              isCompleted: anyCompleted,
              completedAt: anyCompleted ? earliestCompletedAt : null,
              assessedAt: latestAssessedAt,
            },
          });
        }
        stats.canonicalItemsUpdated++;

        // Duplicate rows remain preserved with requirementKey: null (ZERO DELETIONS)
        if (groupItems.length > 1) {
          stats.legacyDuplicateItemsPreserved += (groupItems.length - 1);
        }
      }

      // Backfill snapshots for genuine KE organization
      const snapResult = await prisma.complianceScoreSnapshot.count({
        where: { organizationId: org.id },
      });
      if (snapResult > 0) {
        if (execute) {
          await prisma.complianceScoreSnapshot.updateMany({
            where: { organizationId: org.id },
            data: { jurisdictionCode: 'KE' },
          });
        }
        stats.snapshotsUpdated += snapResult;
      }
    } else if (org.homeJurisdictionCode != null) {
      stats.nonKeConfiguredOrgs++;
      // Non-KE configured organizations (e.g. RW, MW, NG):
      // Preserved legacy rows remain requirementKey: null, jurisdictionCode: null.
      // Zero rows deleted. Zero historical assumptions.
      const snapCount = await prisma.complianceScoreSnapshot.count({
        where: { organizationId: org.id },
      });
      stats.snapshotsPreservedUnscoped += snapCount;
    } else {
      stats.unconfiguredOrgs++;
      // Unconfigured organizations (homeJurisdictionCode is null):
      // Preserved legacy rows remain requirementKey: null, jurisdictionCode: null.
      // Zero rows deleted. Zero historical assumptions.
      const snapCount = await prisma.complianceScoreSnapshot.count({
        where: { organizationId: org.id },
      });
      stats.snapshotsPreservedUnscoped += snapCount;
    }
  }

  if (!execute) {
    console.log('\n=== COMPLIANCE JURISDICTION BACKFILL SIMULATION SUMMARY (DRY RUN) ===');
    console.log(`Total Orgs Examined:                        ${stats.orgsExamined}`);
    console.log(`Genuine KE Orgs Eligible for Backfill:      ${stats.genuineKeOrgs}`);
    console.log(`Non-KE Configured Orgs (Preserved Unscoped): ${stats.nonKeConfiguredOrgs}`);
    console.log(`Unconfigured Orgs (Preserved Unscoped):     ${stats.unconfiguredOrgs}`);
    console.log(`Canonical Items That Would Be Keyed:        ${stats.canonicalItemsUpdated}`);
    console.log(`Legacy Duplicate Items Preserved:           ${stats.legacyDuplicateItemsPreserved}`);
    console.log(`Snapshots That Would Be Scoped to KE:       ${stats.snapshotsUpdated}`);
    console.log(`Snapshots Preserved Unscoped:               ${stats.snapshotsPreservedUnscoped}`);
    console.log(`Deletions Executed:                         0 (ZERO DELETIONS)`);
    console.log('=====================================================================\n');
  } else {
    console.log('\n=== COMPLIANCE JURISDICTION BACKFILL EXECUTION SUMMARY ===');
    console.log(`Total Orgs Examined:                        ${stats.orgsExamined}`);
    console.log(`Genuine KE Orgs Backfilled:                 ${stats.genuineKeOrgs}`);
    console.log(`Non-KE Configured Orgs (Preserved Unscoped): ${stats.nonKeConfiguredOrgs}`);
    console.log(`Unconfigured Orgs (Preserved Unscoped):     ${stats.unconfiguredOrgs}`);
    console.log(`Canonical Items Keyed:                      ${stats.canonicalItemsUpdated}`);
    console.log(`Legacy Duplicate Items Preserved:           ${stats.legacyDuplicateItemsPreserved}`);
    console.log(`Snapshots Scoped to KE:                     ${stats.snapshotsUpdated}`);
    console.log(`Snapshots Preserved Unscoped:               ${stats.snapshotsPreservedUnscoped}`);
    console.log(`Deletions Executed:                         0 (ZERO DELETIONS)`);
    console.log('==========================================================\n');
  }

  return stats;
}

if (require.main === module) {
  const isExecute = process.argv.includes('--execute');
  runComplianceJurisdictionBackfill(isExecute)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Backfill error:', err);
      process.exit(1);
    });
}
