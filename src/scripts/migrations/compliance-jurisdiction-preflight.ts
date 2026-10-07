import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

interface PreflightDuplicateGroup {
  organizationId: string;
  category: string;
  title: string;
  duplicateCount: number;
  rowIds: string[];
  completionStates: boolean[];
}

interface PreflightOrgDistribution {
  orgCategory: string;
  orgCount: number;
  complianceItemCount: number;
  snapshotCount: number;
}

export async function runComplianceJurisdictionPreflight(): Promise<{
  passed: boolean;
  duplicateGroups: PreflightDuplicateGroup[];
  orgDistribution: PreflightOrgDistribution[];
  keyCollisions: number;
}> {
  console.log('=== SHERIABOT COMPLIANCE JURISDICTION PREFLIGHT (READ-ONLY) ===\n');

  // 1. Duplicate detection across legacy title groups
  const duplicatesRaw = await prisma.$queryRaw<any[]>`
    SELECT
      "organizationId",
      category::text,
      title,
      COUNT(*)::int as duplicate_count,
      array_agg(id ORDER BY "createdAt" ASC) as row_ids,
      array_agg("isCompleted") as completion_states
    FROM "ComplianceItem"
    GROUP BY "organizationId", category, title
    HAVING COUNT(*) > 1;
  `;

  const duplicateGroups: PreflightDuplicateGroup[] = duplicatesRaw.map((r) => ({
    organizationId: r.organizationId,
    category: r.category,
    title: r.title,
    duplicateCount: Number(r.duplicate_count),
    rowIds: r.row_ids || [],
    completionStates: r.completion_states || [],
  }));

  console.log(`[PREFLIGHT 1] Duplicate Groups Found: ${duplicateGroups.length}`);
  if (duplicateGroups.length > 0) {
    console.log('Duplicate groups detected across existing ComplianceItem records:');
    for (const g of duplicateGroups) {
      console.log(`  - Org: ${g.organizationId.substring(0, 10)}... | Category: ${g.category} | Title: "${g.title}" | Count: ${g.duplicateCount} | Rows: ${g.rowIds.join(', ')}`);
    }
  } else {
    console.log('  ✅ No duplicate groups found across (organizationId, category, title).');
  }

  // 2. Organization distribution by home jurisdiction status (Non-multiplying CTE)
  const distributionRaw = await prisma.$queryRaw<any[]>`
    WITH org_categories AS (
      SELECT
        id,
        CASE
          WHEN "homeJurisdictionCode" = 'KE' THEN 'GENUINE_KE_HOME'
          WHEN "homeJurisdictionCode" IS NOT NULL AND "homeJurisdictionCode" != 'KE' THEN 'NON_KE_CONFIGURED'
          ELSE 'UNCONFIGURED'
        END as org_category
      FROM "Organization"
    ),
    item_aggregates AS (
      SELECT "organizationId", COUNT(*)::int as item_count
      FROM "ComplianceItem"
      GROUP BY "organizationId"
    ),
    snapshot_aggregates AS (
      SELECT "organizationId", COUNT(*)::int as snapshot_count
      FROM "ComplianceScoreSnapshot"
      GROUP BY "organizationId"
    )
    SELECT
      oc.org_category,
      COUNT(DISTINCT oc.id)::int as org_count,
      COALESCE(SUM(ia.item_count), 0)::int as compliance_item_count,
      COALESCE(SUM(sa.snapshot_count), 0)::int as snapshot_count
    FROM org_categories oc
    LEFT JOIN item_aggregates ia ON ia."organizationId" = oc.id
    LEFT JOIN snapshot_aggregates sa ON sa."organizationId" = oc.id
    GROUP BY oc.org_category;
  `;

  const orgDistribution: PreflightOrgDistribution[] = distributionRaw.map((r) => ({
    orgCategory: r.org_category,
    orgCount: Number(r.org_count),
    complianceItemCount: Number(r.compliance_item_count),
    snapshotCount: Number(r.snapshot_count),
  }));

  console.log('\n[PREFLIGHT 2] Organization & Data Distribution:');
  for (const d of orgDistribution) {
    console.log(`  - Category: ${d.orgCategory.padEnd(18)} | Orgs: ${String(d.orgCount).padStart(5)} | Items: ${String(d.complianceItemCount).padStart(6)} | Snapshots: ${String(d.snapshotCount).padStart(6)}`);
  }

  // 3. Post-backfill / existing requirementKey collisions check (guarded by column existence)
  const colExistsRaw = await prisma.$queryRaw<any[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'ComplianceItem' AND column_name = 'requirementKey';
  `;

  let keyCollisions = 0;
  if (colExistsRaw.length > 0) {
    const collisionsRaw = await prisma.$queryRaw<any[]>`
      SELECT
        "organizationId",
        "requirementKey",
        COUNT(*)::int as group_count
      FROM "ComplianceItem"
      WHERE "requirementKey" IS NOT NULL
      GROUP BY "organizationId", "requirementKey"
      HAVING COUNT(*) > 1;
    `;
    keyCollisions = collisionsRaw.length;
    console.log(`\n[PREFLIGHT 3] requirementKey Collisions: ${keyCollisions}`);
    if (keyCollisions > 0) {
      console.log(`  ❌ CRITICAL: ${keyCollisions} requirementKey collision groups detected!`);
    } else {
      console.log('  ✅ Zero requirementKey collision groups.');
    }
  } else {
    console.log('\n[PREFLIGHT 3] requirementKey column does not exist yet (pre-migration state: column will be added safely).');
  }

  const passed = keyCollisions === 0;
  console.log(`\n=== PREFLIGHT RESULT: ${passed ? 'PASSED' : 'FAILED'} ===\n`);

  return { passed, duplicateGroups, orgDistribution, keyCollisions };
}

if (require.main === module) {
  runComplianceJurisdictionPreflight()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Preflight error:', err);
      process.exit(1);
    });
}
