import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import { supabaseAdmin } from '../lib/supabase';
import { redis } from '../lib/redis/client';
import { createStorageService } from '../lib/storage/client';
import { GAP_ANALYSIS_STORAGE_PATH_PREFIX } from '../config/gap-analysis.config';

async function main() {
  console.log('=== BATCH 6.4 QA AUDIT & ORPHAN REMEDIATION ===');

  // 1. Audit Compromised Identity
  const compromisedEmail = 'qa-dashboard-20260803164012@sheriabot.com';
  console.log(`\nChecking compromised identity: [REDACTED_QA_IDENTITY]`);

  // Supabase Auth check & delete
  const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
  const matchedAuthUser = authUsers?.users?.find(u => u.email?.toLowerCase() === compromisedEmail.toLowerCase());
  
  if (matchedAuthUser) {
    console.log(`Found Supabase Auth user (ID: ${matchedAuthUser.id}). Deleting and invalidating sessions...`);
    const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(matchedAuthUser.id);
    if (delAuthErr) {
      console.error(`Failed to delete Supabase Auth user:`, delAuthErr.message);
    } else {
      console.log(`Successfully deleted compromised Supabase Auth user.`);
    }
  } else {
    console.log(`No active Supabase Auth user found for compromised identity.`);
  }

  // Database check & cleanup
  const dbUser = await prisma.user.findFirst({
    where: { email: compromisedEmail.toLowerCase() },
    select: { id: true, email: true, organizationId: true, supabaseAuthId: true },
  });

  if (dbUser) {
    console.log(`Found DB user (ID: ${dbUser.id}). Cleaning up sessions, memberships, and records...`);
    await prisma.session.deleteMany({ where: { userId: dbUser.id } });
    if ((prisma as any).pilotAccess) {
      await (prisma as any).pilotAccess.deleteMany({ where: { userId: dbUser.id } });
    }
    if (dbUser.organizationId) {
      await prisma.organizationMember.deleteMany({
        where: { userId: dbUser.id, organizationId: dbUser.organizationId },
      });
    }

    await prisma.user.update({
      where: { id: dbUser.id },
      data: {
        status: 'SUSPENDED',
        accountStatus: 'cancelled',
        email: `deleted_${dbUser.id}@sheriabot.internal`,
        supabaseAuthId: null,
        deletedAt: new Date(),
      },
    });

    if (dbUser.organizationId) {
      const remainingMembers = await prisma.organizationMember.count({
        where: { organizationId: dbUser.organizationId },
      });
      if (remainingMembers === 0) {
        await prisma.organization.delete({ where: { id: dbUser.organizationId } }).catch(() => {});
      }
      await redis.del(`sheriabot:orgmem:${dbUser.id}:${dbUser.organizationId}`).catch(() => {});
    }
    await redis.del(`sheriabot:planctx:${dbUser.id}`).catch(() => {});
    if (dbUser.supabaseAuthId) {
      await redis.del(`user:session:${dbUser.supabaseAuthId}`).catch(() => {});
    }
    console.log(`Successfully scrubbed compromised DB user identity and invalidated Redis sessions.`);
  } else {
    console.log(`No active DB user found with compromised email.`);
  }

  // 2. Audit Existing Records
  console.log('\n--- SYSTEM RECORD COUNTS ---');
  const [
    regDocs,
    regDocChunks,
    gapAnalyses,
    aiJobs,
    users,
    orgs
  ] = await Promise.all([
    prisma.regulatoryDocument.count(),
    prisma.regulatoryDocumentChunk.count(),
    prisma.gapAnalysis.count(),
    prisma.aiJob.count(),
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.organization.count(),
  ]);

  console.log({
    regulatoryDocuments: regDocs,
    regulatoryDocumentChunks: regDocChunks,
    gapAnalyses,
    aiJobs,
    activeUsers: users,
    organizations: orgs,
  });

  // 3. Audit R2 Storage for Orphan Files
  console.log('\n--- R2 STORAGE AUDIT ---');
  try {
    const storage = createStorageService();
    const sourceFiles = await storage.listFiles(GAP_ANALYSIS_STORAGE_PATH_PREFIX, 100);
    const reportFiles = await storage.listFiles('reports/', 100);
    console.log(`R2 gap-analysis source files count: ${sourceFiles.length}`);
    console.log(`R2 reports files count: ${reportFiles.length}`);

    // Check if any source files are orphaned (not referenced by any non-deleted GapAnalysis)
    const activeAnalyses = await prisma.gapAnalysis.findMany({
      where: { deletedAt: null },
      select: { id: true, documentUrl: true, reportUrl: true },
    });
    const referencedSourceUrls = new Set(activeAnalyses.map(a => a.documentUrl).filter(Boolean));
    const referencedReportUrls = new Set(activeAnalyses.map(a => a.reportUrl).filter(Boolean));

    let orphanSources = 0;
    for (const f of sourceFiles) {
      if (!referencedSourceUrls.has(f.key)) {
        orphanSources++;
        console.log(`Orphan source file found: ${f.key} (${f.size} bytes). Cleaning up...`);
        await storage.deleteFile(f.key).catch(e => console.warn(`Failed to delete ${f.key}:`, e.message));
      }
    }

    let orphanReports = 0;
    for (const f of reportFiles) {
      if (!referencedReportUrls.has(f.key)) {
        orphanReports++;
        console.log(`Orphan report file found: ${f.key} (${f.size} bytes). Cleaning up...`);
        await storage.deleteFile(f.key).catch(e => console.warn(`Failed to delete ${f.key}:`, e.message));
      }
    }

    console.log(`Cleaned up ${orphanSources} orphan source files and ${orphanReports} orphan report files.`);
  } catch (err: any) {
    console.warn(`R2 audit warning:`, err.message);
  }

  // 4. Audit AiJob records
  console.log('\n--- AI JOB AUDIT ---');
  const orphanJobs = await prisma.aiJob.findMany({
    where: {
      type: 'GAP_ANALYSIS_PIPELINE',
      status: { in: ['QUEUED', 'RUNNING', 'RETRYING'] },
    },
    select: { id: true, status: true, targetEntityId: true },
  });
  console.log(`Pending/running GAP_ANALYSIS_PIPELINE jobs count: ${orphanJobs.length}`);
  if (orphanJobs.length > 0) {
    console.log(`Cancelling stale jobs...`);
    await prisma.aiJob.updateMany({
      where: { id: { in: orphanJobs.map(j => j.id) } },
      data: { status: 'CANCELLED', lockedAt: null, lockedBy: null },
    });
  }

  console.log('\n=== AUDIT & REMEDIATION COMPLETE ===');
}

main().catch(console.error).finally(() => prisma.$disconnect());
