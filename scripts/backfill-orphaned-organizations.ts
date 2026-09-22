import { prisma } from '../src/lib/prisma/client';
import { provisionDefaultOrganization } from '../src/services/organization-provisioning.service';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const logFilePath = path.resolve(process.cwd(), 'backfill-organizations.log');
  const logEntries: string[] = [];

  function log(msg: string) {
    const formatted = `[${new Date().toISOString()}] ${msg}`;
    console.log(formatted);
    logEntries.push(formatted);
  }

  log(`Starting organization backfill (dry-run: ${isDryRun})...`);

  const orphanedUsers = await prisma.user.findMany({
    where: {
      organizationId: null,
      deletedAt: null,
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      organizationId: true,
      organizationMemberships: {
        select: {
          id: true,
          organizationId: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  log(`Found ${orphanedUsers.length} users with organizationId: null.`);

  let backfilledCount = 0;
  let linkedExistingCount = 0;
  let errorCount = 0;

  for (const user of orphanedUsers) {
    try {
      // Check if user already has an active membership
      const activeMembership = user.organizationMemberships.find((m) => m.status === 'ACTIVE');
      if (activeMembership) {
        log(`User ${user.email} (${user.id}) has active membership in org ${activeMembership.organizationId}. Linking organizationId.`);
        if (!isDryRun) {
          await prisma.user.update({
            where: { id: user.id },
            data: { organizationId: activeMembership.organizationId },
          });
        }
        linkedExistingCount++;
        continue;
      }

      log(`User ${user.email} (${user.id}) has no active organization. Provisioning default organization...`);
      if (!isDryRun) {
        const result = await provisionDefaultOrganization(prisma, {
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            organizationId: user.organizationId,
          },
        });
        log(`Successfully provisioned organization "${result.organizationName}" (${result.organizationId}) for user ${user.email}.`);
      }
      backfilledCount++;
    } catch (err: any) {
      log(`ERROR processing user ${user.email} (${user.id}): ${err?.message}`);
      errorCount++;
    }
  }

  log('--- Backfill Summary ---');
  log(`Total orphaned users scanned: ${orphanedUsers.length}`);
  log(`Newly provisioned organizations: ${backfilledCount}`);
  log(`Linked to existing memberships: ${linkedExistingCount}`);
  log(`Errors encountered: ${errorCount}`);
  log(`Dry-run mode: ${isDryRun}`);

  try {
    fs.writeFileSync(logFilePath, logEntries.join('\n') + '\n', { flag: 'a' });
    log(`Log saved to ${logFilePath}`);
  } catch (fsErr: any) {
    console.error('Failed to write log file:', fsErr?.message);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Backfill fatal error:', err);
  process.exit(1);
});
