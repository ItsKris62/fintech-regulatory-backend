import 'dotenv/config';

import { GAP_ANALYSIS_STORAGE_PATH_PREFIX } from '../config/gap-analysis.config';
import { prisma } from '../lib/prisma/client';
import { createStorageService } from '../lib/storage/client';
import { supabaseAdmin } from '../lib/supabase';

async function main() {
  const qaUsers = await prisma.user.findMany({
    where: { fullName: 'SheriaBot QA Batch 6.4 Pilot' },
    select: { id: true, deletedAt: true },
  });
  const qaUserIds = qaUsers.map((user) => user.id);
  const analyses = qaUserIds.length
    ? await prisma.gapAnalysis.findMany({
        where: { userId: { in: qaUserIds } },
        select: { id: true, deletedAt: true, documentUrl: true, reportUrl: true },
      })
    : [];
  const analysisIds = analyses.map((analysis) => analysis.id);
  const jobs = analysisIds.length
    ? await prisma.aiJob.findMany({
        where: { targetEntityType: 'GapAnalysis', targetEntityId: { in: analysisIds } },
        select: { status: true, payload: true },
      })
    : [];

  const storage = createStorageService();
  const [sourceFiles, reportFiles, activeAnalyses, authPage, sessions, memberships, corpusDocuments, corpusChunks] =
    await Promise.all([
      storage.listFiles(GAP_ANALYSIS_STORAGE_PATH_PREFIX, 1000),
      storage.listFiles('reports/', 1000),
      prisma.gapAnalysis.findMany({
        where: { deletedAt: null },
        select: { documentUrl: true, reportUrl: true },
      }),
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      qaUserIds.length ? prisma.session.count({ where: { userId: { in: qaUserIds } } }) : 0,
      qaUserIds.length ? prisma.organizationMember.count({ where: { userId: { in: qaUserIds } } }) : 0,
      prisma.regulatoryDocument.count(),
      prisma.regulatoryDocumentChunk.count(),
    ]);

  const referencedSources = new Set(activeAnalyses.map((item) => item.documentUrl).filter(Boolean));
  const referencedReports = new Set(activeAnalyses.map((item) => item.reportUrl).filter(Boolean));
  const qaSupabaseIdentities = (authPage.data?.users ?? []).filter(
    (user) => user.user_metadata?.qaPurpose === 'batch_6_4_acceptance',
  ).length;

  const payloads = jobs.map((job) => (job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {}));
  const statusCounts = jobs.reduce<Record<string, number>>((counts, job) => {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
    return counts;
  }, {});

  console.log(JSON.stringify({
    approvedCorpus: { documents: corpusDocuments, chunks: corpusChunks },
    qa: {
      usersTotal: qaUsers.length,
      activeUsers: qaUsers.filter((user) => user.deletedAt === null).length,
      databaseSessions: sessions,
      organizationMemberships: memberships,
      supabaseIdentities: qaSupabaseIdentities,
    },
    analyses: {
      total: analyses.length,
      active: analyses.filter((analysis) => analysis.deletedAt === null).length,
      deleted: analyses.filter((analysis) => analysis.deletedAt !== null).length,
    },
    jobs: {
      total: jobs.length,
      statusCounts,
      active: jobs.filter((job) => ['QUEUED', 'RUNNING', 'RETRYING'].includes(job.status)).length,
      payloadsWithDocumentBody: payloads.filter((payload) => 'fileContent' in payload || 'policyText' in payload).length,
      payloadsWithStorageReference: payloads.filter((payload) => typeof payload.storageKey === 'string').length,
    },
    storage: {
      sourceObjects: sourceFiles.length,
      reportObjects: reportFiles.length,
      orphanSourceObjects: sourceFiles.filter((file) => !referencedSources.has(file.key)).length,
      orphanReportObjects: reportFiles.filter((file) => !referencedReports.has(file.key)).length,
    },
  }, null, 2));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
