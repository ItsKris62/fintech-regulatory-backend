/**
 * Gap Analysis retention purge mechanics.
 *
 * Safety properties:
 * - dry-run unless --write is supplied;
 * - requires one organization via --organization-id;
 * - requires explicitly configured, governance-approved retention values;
 * - skips analyses with active jobs;
 * - processes a bounded batch and logs no customer content or storage keys;
 * - retains audit/usage records and a soft-deleted analysis tombstone.
 *
 * This script is deliberately not scheduled by the application.
 */
import 'dotenv/config';

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';
import { storageService } from '@/lib/storage/storage.service';
import { scrubAiJobPayloadForEntity } from '@/modules/ai-jobs/ai-job-runner';
import { logger } from '@/utils/logger';

const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING', 'RETRYING'] as const;
const SOURCE_PREFIX = 'gap-analysis/';
const REPORT_PREFIX = 'gap-analysis-exports/';
const LEGACY_REPORT_PREFIX = 'reports/';
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

type Candidate = {
  id: string;
  userId: string;
  organizationId: string | null;
  documentUrl: string;
  reportUrl: string | null;
  completedAt: Date | null;
  deletedAt: Date | null;
  results: Prisma.JsonValue | null;
  citations: Prisma.JsonValue | null;
  evidenceProvenance: Prisma.JsonValue | null;
};

export type GapAnalysisRetentionOptions = {
  organizationId: string;
  sourceRetentionDays: number;
  resultRetentionDays: number;
  batchSize?: number;
  write?: boolean;
  now?: Date;
};

export type GapAnalysisRetentionResult = {
  mode: 'DRY_RUN' | 'WRITE';
  organizationId: string;
  scanned: number;
  eligible: number;
  sourceObjectsPurged: number;
  reportObjectsPurged: number;
  resultPayloadsPurged: number;
  explicitDeletionTombstonesPurged: number;
  skippedActiveJobs: number;
  failed: number;
};

export type GapAnalysisRetentionDependencies = {
  findCandidates: (args: {
    organizationId: string;
    sourceCutoff: Date;
    resultCutoff: Date;
    take: number;
  }) => Promise<Candidate[]>;
  hasActiveJob: (analysisId: string) => Promise<boolean>;
  deleteObject: (key: string) => Promise<void>;
  scrubJobPayload: (analysisId: string) => Promise<void>;
  updateAnalysis: (analysisId: string, data: Prisma.GapAnalysisUpdateInput) => Promise<void>;
  invalidateCaches: (organizationId: string, userId: string, analysisId: string) => Promise<void>;
  postverify: (analysisId: string) => Promise<{
    documentUrl: string;
    reportUrl: string | null;
    results: Prisma.JsonValue | null;
    executionIdentity: string | null;
  } | null>;
};

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isOwnedSource(key: string): boolean {
  return key.startsWith(SOURCE_PREFIX);
}

function isOwnedReport(key: string | null, organizationId: string, analysisId: string): boolean {
  if (!key) return false;
  return key.startsWith(`${REPORT_PREFIX}${organizationId}/${analysisId}/`)
    || key.startsWith(LEGACY_REPORT_PREFIX);
}

function hasStructuredResult(candidate: Candidate): boolean {
  return candidate.results !== null
    || candidate.citations !== null
    || candidate.evidenceProvenance !== null
    || candidate.reportUrl !== null;
}

function defaultDependencies(): GapAnalysisRetentionDependencies {
  return {
    findCandidates: async ({ organizationId, sourceCutoff, resultCutoff, take }) => prisma.gapAnalysis.findMany({
      where: {
        organizationId,
        OR: [
          { deletedAt: { not: null } },
          { completedAt: { lte: sourceCutoff }, documentUrl: { startsWith: SOURCE_PREFIX } },
          {
            completedAt: { lte: resultCutoff },
            OR: [
              { reportUrl: { not: null } },
              { results: { not: Prisma.DbNull } },
              { citations: { not: Prisma.DbNull } },
              { evidenceProvenance: { not: Prisma.DbNull } },
            ],
          },
        ],
      },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        documentUrl: true,
        reportUrl: true,
        completedAt: true,
        deletedAt: true,
        results: true,
        citations: true,
        evidenceProvenance: true,
      },
      take,
      orderBy: [{ deletedAt: 'asc' }, { completedAt: 'asc' }, { id: 'asc' }],
    }),
    hasActiveJob: async (analysisId) => (await prisma.aiJob.count({
      where: {
        type: 'GAP_ANALYSIS_PIPELINE',
        targetEntityType: 'GapAnalysis',
        targetEntityId: analysisId,
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
    })) > 0,
    deleteObject: async (key) => storageService.deleteFile(key),
    scrubJobPayload: async (analysisId) => scrubAiJobPayloadForEntity('GapAnalysis', analysisId),
    updateAnalysis: async (analysisId, data) => {
      await prisma.gapAnalysis.update({ where: { id: analysisId }, data });
    },
    invalidateCaches: async (organizationId, userId, analysisId) => {
      await Promise.all([
        redis.del(`cache:gap-analysis:list:${organizationId}:${userId}`),
        redis.del(`cache:gap-analysis:result:${organizationId}:${analysisId}`),
      ]);
    },
    postverify: async (analysisId) => prisma.gapAnalysis.findUnique({
      where: { id: analysisId },
      select: { documentUrl: true, reportUrl: true, results: true, executionIdentity: true },
    }),
  };
}

export async function purgeGapAnalysisRetention(
  options: GapAnalysisRetentionOptions,
  dependencies: GapAnalysisRetentionDependencies = defaultDependencies(),
): Promise<GapAnalysisRetentionResult> {
  const sourceRetentionDays = requirePositiveInteger(
    'GAP_ANALYSIS_SOURCE_RETENTION_DAYS',
    options.sourceRetentionDays,
  );
  const resultRetentionDays = requirePositiveInteger(
    'GAP_ANALYSIS_RESULT_RETENTION_DAYS',
    options.resultRetentionDays,
  );
  const batchSize = requirePositiveInteger('batchSize', options.batchSize ?? DEFAULT_BATCH_SIZE);
  if (batchSize > MAX_BATCH_SIZE) throw new Error(`batchSize must not exceed ${MAX_BATCH_SIZE}`);
  if (!options.organizationId.trim()) throw new Error('--organization-id is required');

  const now = options.now ?? new Date();
  const sourceCutoff = new Date(now.getTime() - sourceRetentionDays * 86_400_000);
  const resultCutoff = new Date(now.getTime() - resultRetentionDays * 86_400_000);
  const write = options.write === true;
  const candidates = await dependencies.findCandidates({
    organizationId: options.organizationId,
    sourceCutoff,
    resultCutoff,
    take: batchSize,
  });

  const result: GapAnalysisRetentionResult = {
    mode: write ? 'WRITE' : 'DRY_RUN',
    organizationId: options.organizationId,
    scanned: candidates.length,
    eligible: 0,
    sourceObjectsPurged: 0,
    reportObjectsPurged: 0,
    resultPayloadsPurged: 0,
    explicitDeletionTombstonesPurged: 0,
    skippedActiveJobs: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const explicitDeletion = candidate.deletedAt !== null;
    const sourceExpired = explicitDeletion
      || Boolean(candidate.completedAt && candidate.completedAt <= sourceCutoff);
    const resultExpired = explicitDeletion
      || Boolean(candidate.completedAt && candidate.completedAt <= resultCutoff);
    const purgeSource = sourceExpired && Boolean(candidate.documentUrl);
    const purgeResult = resultExpired && hasStructuredResult(candidate);
    if (!purgeSource && !purgeResult && !explicitDeletion) continue;
    result.eligible++;

    if (await dependencies.hasActiveJob(candidate.id)) {
      result.skippedActiveJobs++;
      logger.warn({ type: 'gap_analysis.retention.skipped_active_job', analysisId: candidate.id });
      continue;
    }

    logger.info({
      type: 'gap_analysis.retention.candidate',
      mode: result.mode,
      analysisId: candidate.id,
      organizationId: options.organizationId,
      purgeSource,
      purgeResult,
      explicitDeletion,
    });
    if (!write) continue;

    try {
      let sourceDeleted = !purgeSource;
      let reportDeleted = !candidate.reportUrl || !purgeResult;
      if (purgeSource) {
        if (!isOwnedSource(candidate.documentUrl)) throw new Error('source object is outside the owned prefix');
        await dependencies.deleteObject(candidate.documentUrl);
        sourceDeleted = true;
        result.sourceObjectsPurged++;
      }
      if (purgeResult && candidate.reportUrl) {
        if (!isOwnedReport(candidate.reportUrl, options.organizationId, candidate.id)) {
          throw new Error('report object is outside an owned prefix');
        }
        await dependencies.deleteObject(candidate.reportUrl);
        reportDeleted = true;
        result.reportObjectsPurged++;
      }

      await dependencies.scrubJobPayload(candidate.id);
      const data: Prisma.GapAnalysisUpdateInput = {};
      if (sourceDeleted && purgeSource) {
        data.documentUrl = '';
        data.documentChecksum = null;
      }
      if (reportDeleted && purgeResult) {
        data.results = Prisma.DbNull;
        data.citations = Prisma.DbNull;
        data.evidenceProvenance = Prisma.DbNull;
        data.overallScore = null;
        data.reportUrl = null;
        data.reportGeneratedAt = null;
        data.executionIdentity = null;
        data.executionIdentityMetadata = Prisma.DbNull;
        result.resultPayloadsPurged++;
      }
      if (explicitDeletion) {
        data.documentName = `[deleted:${candidate.id}]`;
        data.focusAreas = Prisma.DbNull;
        result.explicitDeletionTombstonesPurged++;
      }
      await dependencies.updateAnalysis(candidate.id, data);
      await dependencies.invalidateCaches(options.organizationId, candidate.userId, candidate.id);

      const verified = await dependencies.postverify(candidate.id);
      if (!verified
        || (purgeSource && verified.documentUrl !== '')
        || (purgeResult && (verified.reportUrl !== null || verified.results !== null || verified.executionIdentity !== null))) {
        throw new Error('post-verification failed');
      }
      logger.info({
        type: 'gap_analysis.retention.purged',
        analysisId: candidate.id,
        organizationId: options.organizationId,
        sourcePurged: purgeSource,
        resultPurged: purgeResult,
        explicitDeletion,
      });
    } catch (error: unknown) {
      result.failed++;
      logger.error({
        type: 'gap_analysis.retention.failed',
        analysisId: candidate.id,
        organizationId: options.organizationId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  logger.info({ type: 'gap_analysis.retention.completed', ...result });
  return result;
}

function arg(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const organizationId = arg('--organization-id') ?? '';
  const sourceRetentionDays = Number(process.env.GAP_ANALYSIS_SOURCE_RETENTION_DAYS);
  const resultRetentionDays = Number(process.env.GAP_ANALYSIS_RESULT_RETENTION_DAYS);
  const batchSize = Number(arg('--batch-size') ?? DEFAULT_BATCH_SIZE);
  const result = await purgeGapAnalysisRetention({
    organizationId,
    sourceRetentionDays,
    resultRetentionDays,
    batchSize,
    write: process.argv.includes('--write'),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith('purge-gap-analysis-retention.ts')
  || process.argv[1]?.endsWith('purge-gap-analysis-retention.js')) {
  main()
    .catch((error: unknown) => {
      logger.error({
        type: 'gap_analysis.retention.fatal',
        error: error instanceof Error ? error.message : 'unknown error',
      });
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
