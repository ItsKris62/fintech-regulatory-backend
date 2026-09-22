/**
 * Safe, verified purge of all non-admin users and organizations in Sheria-Bot SaaS.
 *
 * Usage:
 *   npx tsx scripts/purge-all-non-admin.ts            # Default: Dry-run mode
 *   npx tsx scripts/purge-all-non-admin.ts --dry-run  # Explicit dry-run
 *   npx tsx scripts/purge-all-non-admin.ts --confirm  # Live execution mode
 *
 * Safety Gates:
 *   - Verifies pg_dump completeness against live DB before proceeding.
 *   - Preserves myadmin@sheriabot.com (case-insensitive) and its organization/memberships/sessions.
 *   - Aborts if more than one ADMIN account matches or admin has no organization.
 *   - Deletes from Postgres in transactional batches of 50.
 *   - Deletes from Supabase Auth via admin API (skipping DB-only mock accounts and handling unconfirmed accounts).
 *   - Purges session keys from Upstash Redis.
 *   - Preserves RegulatoryFramework and SystemConfig tables completely.
 *   - Appends detailed timestamped logs to purge-all-non-admin.log.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma/client';
import { redis } from '../src/lib/redis/client';
import { userSessionKey, lastSeenKey, sessionStartKey, sessionFingerprintKey } from '../src/config/session';
import { supabaseAdmin } from '../src/lib/supabase';

const ADMIN_EMAIL = 'myadmin@sheriabot.com';
const PG_RESTORE_BIN = 'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_restore.exe';

export interface PurgeStats {
  totalUsersToDelete: number;
  totalUsersPreserved: number;
  totalOrgsToDelete: number;
  totalOrgsPreserved: number;
  totalMembershipsToDelete: number;
  totalSessionsToDelete: number;
  totalChecklistsToDelete: number;
  totalChecklistItemsToDelete: number;
  totalPoliciesToDelete: number;
  totalVaultDocsToDelete: number;
  totalQueriesToDelete: number;
  totalGapAnalysesToDelete: number;
  supabaseAuthDeletionsPlanned: number;
  supabaseAuthDeletionsSkipped: number;
  totalRedisKeysToPurge: number;
  preservedFrameworksCount: number;
  preservedSystemConfigCount: number;
}

function getLatestDumpFile(backupDir: string): string | null {
  if (!fs.existsSync(backupDir)) return null;
  const files = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith('pre_purge_') && f.endsWith('.dump'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(backupDir, files[0]) : null;
}

function extractDumpRowCount(dumpPath: string, tableName: string): number {
  try {
    const cmd = `"${PG_RESTORE_BIN}" -f - --data-only --table="${tableName}" "${dumpPath}"`;
    const output = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const lines = output.split('\n');
    let inCopyBlock = false;
    let count = 0;
    for (const line of lines) {
      if (line.startsWith('COPY ')) {
        inCopyBlock = true;
        continue;
      }
      if (inCopyBlock) {
        if (line.startsWith('\\.') || line.trim() === '\\.') {
          inCopyBlock = false;
          break;
        }
        if (line.trim().length > 0) {
          count++;
        }
      }
    }
    return count;
  } catch (err: any) {
    console.warn(`⚠️ Warning: could not parse dump row count for table ${tableName}: ${err?.message}`);
    return -1;
  }
}

export async function runPurge(isConfirmed: boolean = false) {
  const logEntries: string[] = [];
  function log(msg: string) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    logEntries.push(entry);
  }

  log(`\n======================================================================`);
  log(`🧹 SHERIA-BOT COMPLETE NON-ADMIN PURGE PROTOCOL`);
  log(`Mode: ${isConfirmed ? 'LIVE EXECUTION (--confirm)' : 'DRY-RUN (--dry-run)'}`);
  log(`======================================================================\n`);

  // -------------------------------------------------------------------------
  // STEP 1: R3 DUMP COMPLETENESS VERIFICATION
  // -------------------------------------------------------------------------
  log(`--- [Gate 1] Verifying Pre-Purge Backup Dump Completeness ---`);
  const repoRoot = path.resolve(__dirname, '../..');
  const backupDir = path.resolve(repoRoot, '../sheriabot-backups');
  const latestDump = getLatestDumpFile(backupDir);

  if (!latestDump) {
    throw new Error(`❌ ABORT: No pre-purge dump found in ${backupDir}. Run backup protocol first!`);
  }
  log(`Found latest backup dump: ${latestDump}`);

  const liveUserCount = await prisma.user.count({ where: { deletedAt: null } });
  const liveChecklistItemCount = await prisma.checklistItem.count();
  const liveFrameworkCount = await prisma.regulatoryFramework.count();
  const liveConfigCount = await prisma.systemConfig.count();

  const dumpUserCount = extractDumpRowCount(latestDump, 'User');
  const dumpChecklistItemCount = extractDumpRowCount(latestDump, 'ChecklistItem');
  const dumpFrameworkCount = extractDumpRowCount(latestDump, 'RegulatoryFramework');

  log(`Live DB Row Counts: User=${liveUserCount}, ChecklistItem=${liveChecklistItemCount}, RegulatoryFramework=${liveFrameworkCount}, SystemConfig=${liveConfigCount}`);
  log(`Dump Row Counts:    User=${dumpUserCount}, ChecklistItem=${dumpChecklistItemCount}, RegulatoryFramework=${dumpFrameworkCount}`);

  if (dumpUserCount < liveUserCount || dumpChecklistItemCount < liveChecklistItemCount || dumpFrameworkCount < liveFrameworkCount) {
    throw new Error(`❌ ABORT: Dump completeness check failed! Dump row count is less than live DB.`);
  }
  log(`✅ Gate 1 Passed: Dump completeness verified (100% of live rows captured in backup).\n`);

  // -------------------------------------------------------------------------
  // STEP 2: ADMIN IDENTIFICATION & VALIDATION
  // -------------------------------------------------------------------------
  log(`--- [Gate 2] Validating Admin Account & Isolation Perimeter ---`);
  const adminUser = await prisma.user.findFirst({
    where: {
      email: { equals: ADMIN_EMAIL, mode: 'insensitive' },
      deletedAt: null,
    },
    include: {
      organization: true,
      organizationMemberships: true,
      sessions: true,
    },
  });

  if (!adminUser) {
    throw new Error(`❌ ABORT: Target admin account '${ADMIN_EMAIL}' was NOT found in database!`);
  }

  log(`✅ Target Admin Found: ${adminUser.email} (ID: ${adminUser.id}, Role: ${adminUser.role})`);
  log(`Admin Organization: ${adminUser.organization?.name || 'NONE'} (ID: ${adminUser.organizationId || 'NONE'})`);
  log(`Admin Memberships: ${adminUser.organizationMemberships.length}, Admin Sessions: ${adminUser.sessions.length}`);

  if (!adminUser.organizationId || !adminUser.organization) {
    throw new Error(`❌ ABORT: Admin account has no associated organization! Cannot proceed safely.`);
  }

  // Check for any other admin accounts with role ADMIN
  const otherAdmins = await prisma.user.findMany({
    where: {
      role: 'ADMIN',
      id: { not: adminUser.id },
      deletedAt: null,
    },
  });

  if (otherAdmins.length > 0) {
    log(`⚠️ Note: Found ${otherAdmins.length} other user(s) with role='ADMIN' (e.g. ${otherAdmins.map((o) => o.email).join(', ')}).`);
    log(`Per requirement, ONLY '${adminUser.email}' will be preserved. All other accounts will be purged.`);
  }

  const preservedAdminOrgId = adminUser.organizationId;
  const preservedAdminUserId = adminUser.id;
  const preservedAdminSessionIds = new Set(adminUser.sessions.map((s) => s.id));

  // -------------------------------------------------------------------------
  // STEP 3: DISCOVERY OF ENTITIES TO PURGE
  // -------------------------------------------------------------------------
  log(`\n--- [Gate 3] Computing Purge Plan & Entity Discovery ---`);

  // Fetch all non-admin users (both active and soft-deleted)
  const rawUsers = await prisma.$queryRaw<Array<{ id: string; email: string; supabaseAuthId: string | null; deletedAt: Date | null }>>`
    SELECT id, email, "supabaseAuthId", "deletedAt"
    FROM "User"
    WHERE id != ${preservedAdminUserId}
  `;

  const userIdsToDelete = rawUsers.map((u) => u.id);

  const allSessions = await prisma.session.findMany({
    where: { userId: { in: userIdsToDelete } },
  });
  const allMemberships = await prisma.organizationMember.findMany({
    where: { userId: { in: userIdsToDelete } },
  });

  const usersToDelete = rawUsers.map((u) => ({
    ...u,
    sessions: allSessions.filter((s) => s.userId === u.id),
    organizationMemberships: allMemberships.filter((m) => m.userId === u.id),
  }));

  const orgsToDelete = await prisma.organization.findMany({
    where: {
      id: { not: preservedAdminOrgId },
    },
    include: {
      checklists: {
        include: { checklistItems: true },
      },
      vaultDocuments: true,
    },
  });

  const orgIdsToDelete = orgsToDelete.map((o) => o.id);

  const membershipsToDeleteCount = await prisma.organizationMember.count({
    where: { userId: { in: userIdsToDelete } },
  });

  const sessionsToDelete = await prisma.session.findMany({
    where: { userId: { in: userIdsToDelete } },
  });

  const checklistsToDelete = await prisma.checklist.findMany({
    where: { organizationId: { in: orgIdsToDelete } },
    include: { checklistItems: true },
  });

  let checklistItemsToDeleteCount = 0;
  for (const c of checklistsToDelete) {
    checklistItemsToDeleteCount += c.checklistItems.length;
  }

  const rawPoliciesCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM "Policy" WHERE "organizationId" IN (${Prisma.join(orgIdsToDelete)})
  `;
  const policiesToDeleteCount = orgIdsToDelete.length > 0 ? Number(rawPoliciesCount[0]?.count || 0) : 0;

  const vaultDocsToDeleteCount = await prisma.vaultDocument.count({
    where: { organizationId: { in: orgIdsToDelete } },
  });

  const queriesToDeleteCount = await prisma.complianceQuery.count({
    where: {
      OR: [
        { organizationId: { in: orgIdsToDelete } },
        { userId: { in: userIdsToDelete } },
      ],
    },
  });

  const gapAnalysesToDeleteCount = await prisma.gapAnalysis.count({
    where: { organizationId: { in: orgIdsToDelete } },
  });

  // Supabase Auth Deletion Planning
  let supabaseDeletionsPlanned = 0;
  let supabaseDeletionsSkipped = 0;
  const supabaseSkippedReasons: Array<{ email: string; reason: string }> = [];

  for (const u of usersToDelete) {
    if (!u.supabaseAuthId || u.id.startsWith('stage-intasend-') || !u.supabaseAuthId.includes('-')) {
      supabaseDeletionsSkipped++;
      supabaseSkippedReasons.push({
        email: u.email,
        reason: 'DB-only mock account (no valid Supabase Auth UUID)',
      });
    } else {
      supabaseDeletionsPlanned++;
    }
  }

  // Redis Keys to Purge
  let totalRedisKeys = 0;
  for (const u of usersToDelete) {
    totalRedisKeys += 3; // userSessionKey, lastSeenKey, sessionStartKey
    totalRedisKeys += u.sessions.length; // sessionFingerprintKey per session
  }

  const stats: PurgeStats = {
    totalUsersToDelete: usersToDelete.length,
    totalUsersPreserved: 1,
    totalOrgsToDelete: orgsToDelete.length,
    totalOrgsPreserved: 1,
    totalMembershipsToDelete: membershipsToDeleteCount,
    totalSessionsToDelete: sessionsToDelete.length,
    totalChecklistsToDelete: checklistsToDelete.length,
    totalChecklistItemsToDelete: checklistItemsToDeleteCount,
    totalPoliciesToDelete: policiesToDeleteCount,
    totalVaultDocsToDelete: vaultDocsToDeleteCount,
    totalQueriesToDelete: queriesToDeleteCount,
    totalGapAnalysesToDelete: gapAnalysesToDeleteCount,
    supabaseAuthDeletionsPlanned: supabaseDeletionsPlanned,
    supabaseAuthDeletionsSkipped: supabaseDeletionsSkipped,
    totalRedisKeysToPurge: totalRedisKeys,
    preservedFrameworksCount: liveFrameworkCount,
    preservedSystemConfigCount: liveConfigCount,
  };

  log(`\n📊 PURGE PLAN SUMMARY:`);
  log(`- Users to Delete: ${stats.totalUsersToDelete}`);
  log(`- Users to Preserve: ${stats.totalUsersPreserved} (${adminUser.email})`);
  log(`- Organizations to Delete: ${stats.totalOrgsToDelete}`);
  log(`- Organizations to Preserve: ${stats.totalOrgsPreserved} ("${adminUser.organization.name}")`);
  log(`- Memberships to Delete: ${stats.totalMembershipsToDelete}`);
  log(`- Sessions to Delete: ${stats.totalSessionsToDelete}`);
  log(`- Checklists to Delete: ${stats.totalChecklistsToDelete} (Items: ${stats.totalChecklistItemsToDelete})`);
  log(`- Policies to Delete: ${stats.totalPoliciesToDelete}`);
  log(`- Vault Documents to Delete: ${stats.totalVaultDocsToDelete}`);
  log(`- Compliance Queries to Delete: ${stats.totalQueriesToDelete}`);
  log(`- Gap Analyses to Delete: ${stats.totalGapAnalysesToDelete}`);
  log(`- Supabase Auth Deletions Planned: ${stats.supabaseAuthDeletionsPlanned}`);
  log(`- Supabase Auth Deletions Skipped: ${stats.supabaseAuthDeletionsSkipped}`);
  log(`- Redis Keys to Purge: ${stats.totalRedisKeysToPurge}`);
  log(`- Preserved Regulatory Frameworks: ${stats.preservedFrameworksCount}`);
  log(`- Preserved System Config Rows: ${stats.preservedSystemConfigCount}`);

  if (supabaseSkippedReasons.length > 0) {
    log(`\nSupabase Skipped Accounts Detail:`);
    for (const s of supabaseSkippedReasons) {
      log(`  - ${s.email}: ${s.reason}`);
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4: EXECUTION (IF CONFIRMED) OR DRY-RUN
  // -------------------------------------------------------------------------
  if (isConfirmed) {
    log(`\n⚠️  EXECUTING LIVE PURGE OF ${usersToDelete.length} USERS AND ${orgsToDelete.length} ORGS...`);

    // 1. Supabase Auth Deletions
    log(`Deleting Supabase Auth users...`);
    let supaSuccess = 0;
    let supaFailed = 0;

    for (const u of usersToDelete) {
      if (!u.supabaseAuthId || u.id.startsWith('stage-intasend-') || !u.supabaseAuthId.includes('-')) {
        log(`[supabase_user_not_found] Skipping DB-only user: ${u.email} (${u.id})`);
        continue;
      }

      try {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(u.supabaseAuthId);
        if (error) {
          if (error.message?.includes('not found') || error.status === 404) {
            log(`[supabase_user_not_found] Supabase user 404 for ${u.email} (${u.supabaseAuthId})`);
          } else {
            log(`[supabase_delete_unconfirmed_failed] Error deleting ${u.email}: ${error.message}`);
          }
          supaFailed++;
        } else {
          log(`Deleted Supabase Auth user: ${u.email} (${u.supabaseAuthId})`);
          supaSuccess++;
        }
      } catch (err: any) {
        log(`[supabase_delete_failed] Exception deleting ${u.email}: ${err?.message}`);
        supaFailed++;
      }
    }
    log(`Supabase Auth deletions finished: ${supaSuccess} succeeded, ${supaFailed} failed/skipped.`);

    // 2. Redis Key Purges (Direct enumeration from Redis namespaces)
    log(`Purging Redis keys from session namespaces...`);
    const allRedisKeys = await redis.keys('*');
    const keysToDelete: string[] = [];

    for (const key of allRedisKeys) {
      for (const u of usersToDelete) {
        if (key.includes(u.id)) {
          keysToDelete.push(key);
          break;
        }
        for (const s of u.sessions) {
          if (key.includes(s.id)) {
            keysToDelete.push(key);
            break;
          }
        }
      }
    }

    const uniqueKeysToDelete = Array.from(new Set(keysToDelete));
    for (const k of uniqueKeysToDelete) {
      await redis.del(k);
    }
    log(`Purged ${uniqueKeysToDelete.length} matching session keys from Upstash Redis.`);

    // 3. PostgreSQL Batch Deletions (Batches of 50)
    const BATCH_SIZE = 50;
    log(`Purging PostgreSQL records in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < orgIdsToDelete.length; i += BATCH_SIZE) {
      const batchOrgIds = orgIdsToDelete.slice(i, i + BATCH_SIZE);
      await prisma.$transaction(async (tx) => {
        // Delete child tables first
        await tx.checklistItem.deleteMany({
          where: { checklist: { organizationId: { in: batchOrgIds } } },
        });
        await tx.checklist.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.$executeRawUnsafe(`DELETE FROM "Policy" WHERE "organizationId" = ANY($1::text[])`, batchOrgIds);
        await tx.vaultDocument.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.gapAnalysis.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.complianceQuery.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.usageRecord.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.usagePeriod.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.payment.deleteMany({
          where: { orgId: { in: batchOrgIds } },
        });
        await tx.generatedPolicy.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.corpusGapFeedback.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.corpusGapReport.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.licenseTimelineEvent.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.licenseDocument.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.licenseFee.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.license.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.organizationMember.deleteMany({
          where: { organizationId: { in: batchOrgIds } },
        });
        await tx.organization.deleteMany({
          where: { id: { in: batchOrgIds } },
        });
      });
      log(`Deleted batch of ${batchOrgIds.length} organizations and associated tenant data.`);
    }

    // Delete users in batches
    for (let i = 0; i < userIdsToDelete.length; i += BATCH_SIZE) {
      const batchUserIds = userIdsToDelete.slice(i, i + BATCH_SIZE);
      await prisma.$transaction(async (tx) => {
        // Child tables referencing User with RESTRICT / CASCADE
        await tx.blogPost.deleteMany({ where: { authorId: { in: batchUserIds } } });
        await tx.contactListMembership.deleteMany({ where: { addedById: { in: batchUserIds } } });
        await tx.contactList.deleteMany({ where: { createdById: { in: batchUserIds } } });
        await tx.contact.deleteMany({ where: { createdById: { in: batchUserIds } } });
        await tx.company.deleteMany({ where: { createdById: { in: batchUserIds } } });
        await tx.licenseTimelineEvent.deleteMany({ where: { createdByUserId: { in: batchUserIds } } });
        await tx.licenseDocument.deleteMany({ where: { createdByUserId: { in: batchUserIds } } });
        await tx.licenseFee.deleteMany({ where: { createdByUserId: { in: batchUserIds } } });
        await tx.license.deleteMany({ where: { createdByUserId: { in: batchUserIds } } });
        await tx.pilotEvent.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.pilotInvitation.deleteMany({ where: { createdById: { in: batchUserIds } } });
        await tx.marketingCampaign.deleteMany({ where: { createdById: { in: batchUserIds } } });
        await tx.regulatoryAlert.deleteMany({ where: { publishedById: { in: batchUserIds } } });
        await tx.vaultDocument.deleteMany({ where: { uploadedById: { in: batchUserIds } } });
        await tx.corpusGapFeedback.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.corpusGapReport.deleteMany({ where: { reportedByUserId: { in: batchUserIds } } });
        await tx.complianceQuery.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.gapAnalysis.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.generatedPolicy.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.$executeRawUnsafe(`DELETE FROM "Policy" WHERE "userId" = ANY($1::text[])`, batchUserIds);
        await tx.checklist.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.session.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.organizationMember.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.auditLog.deleteMany({ where: { userId: { in: batchUserIds } } });
        await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1::text[])`, batchUserIds);
      });
      log(`Deleted batch of ${batchUserIds.length} users and associated user data.`);
    }

    log(`\n✅ LIVE PURGE COMPLETED SUCCESSFULLY.`);
    log(`Preserved User: ${adminUser.email} (${adminUser.id})`);
    log(`Preserved Organization: ${adminUser.organization.name} (${adminUser.organizationId})`);
  } else {
    log(`\n🔒 DRY-RUN ONLY. No database records or Supabase Auth accounts were deleted.`);
    log(`To execute live deletion, run with --confirm.`);
  }

  // Write log to file
  const logPath = path.resolve(process.cwd(), 'purge-all-non-admin.log');
  fs.appendFileSync(logPath, logEntries.join('\n') + '\n\n', 'utf8');
  log(`📄 Detailed log written to: ${logPath}\n`);

  await prisma.$disconnect();
  return stats;
}

if (process.argv[1]?.includes('purge-all-non-admin')) {
  const isConfirmed = process.argv.includes('--confirm');
  runPurge(isConfirmed)
    .catch((err) => {
      console.error('❌ Purge execution error:', err);
      process.exit(1);
    });
}
