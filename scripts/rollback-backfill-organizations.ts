/**
 * Inverse rollback script for Organization backfills.
 *
 * Usage:
 *   npx tsx scripts/rollback-backfill-organizations.ts            # Default: Dry-run
 *   npx tsx scripts/rollback-backfill-organizations.ts --dry-run  # Explicit dry-run
 *   npx tsx scripts/rollback-backfill-organizations.ts --confirm  # Execute rollback
 *
 * Reads backfill-organizations.log or auto-provisioned default organizations,
 * deletes auto-created organizations and their memberships, and resets user.organizationId = null.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../src/lib/prisma/client';

export interface RollbackItem {
  userId: string;
  userEmail: string;
  organizationId: string;
  organizationName: string;
}

export async function runRollback(isConfirmed: boolean = false) {
  console.log(`\n======================================================`);
  console.log(`🔄 Rollback Backfilled Organizations (Mode: ${isConfirmed ? 'LIVE EXECUTION (--confirm)' : 'DRY-RUN'})`);
  console.log(`======================================================`);

  // 1. Attempt to read backfill-organizations.log if present
  const logPath = path.resolve(process.cwd(), 'backfill-organizations.log');
  const orgIdsToRollback: Set<string> = new Set();

  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/Created organization "([^"]+)" \(ID: ([^)]+)\)/i) ||
                    line.match(/organizationId[:=]\s*([a-zA-Z0-9_-]+)/i);
      if (match) {
        orgIdsToRollback.add(match[2] || match[1]);
      }
    }
  }

  // 2. Discover auto-provisioned organizations matching default naming convention
  const autoCreatedOrgs = await prisma.organization.findMany({
    where: {
      OR: [
        { id: { in: Array.from(orgIdsToRollback) } },
        { name: { endsWith: ' Workspace' } },
        { name: { endsWith: ' Organization' } },
      ],
    },
    include: {
      users: {
        select: {
          id: true,
          email: true,
        },
      },
      members: true,
    },
  });

  const rollbackPlan: RollbackItem[] = [];

  for (const org of autoCreatedOrgs) {
    for (const user of org.users) {
      rollbackPlan.push({
        userId: user.id,
        userEmail: user.email,
        organizationId: org.id,
        organizationName: org.name,
      });
    }
  }

  console.log(`\n📊 Rollback Plan Summary:`);
  console.log(`- Identified Organizations to rollback: ${autoCreatedOrgs.length}`);
  console.log(`- Affected Users to reset: ${rollbackPlan.length}`);

  console.table(
    rollbackPlan.slice(0, 20).map((p) => ({
      'User ID': p.userId,
      'Email': p.userEmail,
      'Org ID': p.organizationId,
      'Org Name': p.organizationName,
    }))
  );

  if (rollbackPlan.length > 20) {
    console.log(`... and ${rollbackPlan.length - 20} more users.`);
  }

  if (isConfirmed) {
    console.log(`\n⚠️  EXECUTING LIVE ROLLBACK...`);

    let resetCount = 0;
    let deletedOrgsCount = 0;

    for (const org of autoCreatedOrgs) {
      await prisma.$transaction(async (tx) => {
        // Reset user organization pointers
        await tx.user.updateMany({
          where: { organizationId: org.id },
          data: { organizationId: null },
        });

        // Delete memberships
        await tx.organizationMembership.deleteMany({
          where: { organizationId: org.id },
        });

        // Delete default tenant data if any
        await tx.checklistItem.deleteMany({
          where: { checklist: { organizationId: org.id } },
        });
        await tx.checklist.deleteMany({ where: { organizationId: org.id } });
        await tx.policy.deleteMany({ where: { organizationId: org.id } });
        await tx.vaultDocument.deleteMany({ where: { organizationId: org.id } });
        await tx.gapAnalysis.deleteMany({ where: { organizationId: org.id } });

        // Delete organization
        await tx.organization.delete({
          where: { id: org.id },
        });
      });

      resetCount += org.users.length;
      deletedOrgsCount++;
    }

    console.log(`✅ Rollback successfully completed:`);
    console.log(`- ${deletedOrgsCount} auto-created organizations removed.`);
    console.log(`- ${resetCount} users reset to organizationId = null.`);
  } else {
    console.log(`\n🔒 DRY-RUN ONLY. No database modifications were made.`);
    console.log(`To execute rollback, run with --confirm.`);
  }

  return {
    organizationsCount: autoCreatedOrgs.length,
    affectedUsersCount: rollbackPlan.length,
    plan: rollbackPlan,
  };
}

if (process.argv[1]?.includes('rollback-backfill-organizations')) {
  const isConfirmed = process.argv.includes('--confirm');
  runRollback(isConfirmed)
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('❌ Rollback execution failed:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
