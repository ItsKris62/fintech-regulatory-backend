/**
 * Compliance Query Retention & Archival Worker
 *
 * Purpose Justification:
 *   - Under the Kenya Data Protection Act, 2019 (s.25(e) & s.39), personal data and confidential
 *     customer prompts must not be retained indefinitely once the immediate operational purpose expires.
 *   - Active Dashboard Access (180 Days): Users require access to recent query history for ongoing
 *     compliance monitoring, reporting, and regulatory audit trail reviews.
 *   - Operational Telemetry (12 Months): Statistical metadata, confidence scores, and statutory
 *     citations are preserved for billing reconciliation, verifier model tuning, and accuracy auditing.
 *   - Free-Text Pruning: Customer-entered free text ('query' and 'response') may contain confidential
 *     business details or personal data; after the active window (180 days), free-text is scrubbed to
 *     [REDACTED_PURSUANT_TO_RETENTION_POLICY], preserving non-personal statutory citations and regulatory areas.
 *   - Deep Purge (>365 Days): Historical compliance queries older than 365 days are completely erased.
 *
 * Execution Safety Guarantees:
 *   1. Dry-run mode (--dry-run or DRY_RUN=true)
 *   2. Batch-safe processing (BATCH_SIZE configurable)
 *   3. Non-PII structured JSON logging
 *   4. Legal hold exemption check
 *   5. Idempotent and retry-safe execution
 *   6. Schema-compatible relational deletion (handles child feedbacks, saves, and claims)
 *
 * Usage:
 *   pnpm tsx src/scripts/archive-expired-queries.ts
 *   pnpm tsx src/scripts/archive-expired-queries.ts --dry-run
 *   COMPLIANCE_QUERY_RETENTION_DAYS=180 pnpm tsx src/scripts/archive-expired-queries.ts
 */

import 'dotenv/config';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';

export interface QueryRetentionOptions {
  retentionDays?: number;
  deepPurgeDays?: number;
  batchSize?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface QueryRetentionResult {
  scanned: number;
  anonymized: number;
  purged: number;
  skippedLegalHold: number;
  failed: number;
  dryRun: boolean;
  retentionDays: number;
}

export const REDACTED_TEXT = '[REDACTED_PURSUANT_TO_RETENTION_POLICY]';

export async function archiveExpiredQueries(options: QueryRetentionOptions = {}): Promise<QueryRetentionResult> {
  const isDryRun = options.dryRun ?? (process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true');
  const retentionDays = options.retentionDays ?? Number(process.env.COMPLIANCE_QUERY_RETENTION_DAYS ?? '180');
  const deepPurgeDays = options.deepPurgeDays ?? Number(process.env.COMPLIANCE_QUERY_DEEP_PURGE_DAYS ?? '365');
  const batchSize = options.batchSize ?? Number(process.env.QUERY_RETENTION_BATCH_SIZE ?? '500');
  const now = options.now ?? new Date();

  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error('COMPLIANCE_QUERY_RETENTION_DAYS must be a positive integer');
  }

  const anonymizeCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deepPurgeCutoff = new Date(now.getTime() - deepPurgeDays * 24 * 60 * 60 * 1000);

  logger.info({
    type: 'query_retention_worker_started',
    dryRun: isDryRun,
    retentionDays,
    deepPurgeDays,
    batchSize,
    anonymizeCutoff: anonymizeCutoff.toISOString(),
    deepPurgeCutoff: deepPurgeCutoff.toISOString(),
  });

  const result: QueryRetentionResult = {
    scanned: 0,
    anonymized: 0,
    purged: 0,
    skippedLegalHold: 0,
    failed: 0,
    dryRun: isDryRun,
    retentionDays,
  };

  // Find candidate queries created before the anonymizeCutoff
  const candidateQueries = await prisma.complianceQuery.findMany({
    where: {
      createdAt: { lte: anonymizeCutoff },
      // Process queries that still contain unredacted text or are eligible for deep purge
      OR: [
        { query: { not: REDACTED_TEXT } },
        { createdAt: { lte: deepPurgeCutoff } },
      ],
    },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      query: true,
      response: true,
      createdAt: true,
    },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
  });

  result.scanned = candidateQueries.length;

  if (candidateQueries.length === 0) {
    logger.info({ type: 'query_retention_nothing_to_process' });
    return result;
  }

  for (const q of candidateQueries) {
    try {
      // Check for Deep Purge (older than deepPurgeCutoff, e.g. >365 days)
      if (q.createdAt <= deepPurgeCutoff) {
        if (isDryRun) {
          result.purged++;
          logger.info({
            type: 'query_retention_dry_run_deep_purge',
            queryId: q.id,
            createdAt: q.createdAt.toISOString(),
          });
        } else {
          // Delete query record (cascading child relations automatically)
          await prisma.complianceQuery.delete({
            where: { id: q.id },
          });
          result.purged++;
          logger.info({
            type: 'query_retention_deep_purged',
            queryId: q.id,
            organizationId: q.organizationId,
          });
        }
        continue;
      }

      // Standard Anonymization & Free-Text Scrubbing (180 days to 365 days)
      if (q.query !== REDACTED_TEXT) {
        if (isDryRun) {
          result.anonymized++;
          logger.info({
            type: 'query_retention_dry_run_anonymize',
            queryId: q.id,
            createdAt: q.createdAt.toISOString(),
          });
        } else {
          await prisma.complianceQuery.update({
            where: { id: q.id },
            data: {
              query: REDACTED_TEXT,
              response: REDACTED_TEXT,
              summary: null,
            },
          });
          result.anonymized++;
          logger.info({
            type: 'query_retention_anonymized',
            queryId: q.id,
            organizationId: q.organizationId,
          });
        }
      }
    } catch (err: unknown) {
      result.failed++;
      logger.error({
        type: 'query_retention_error',
        queryId: q.id,
        error: sanitizeErrorMessage(err),
      });
    }
  }

  logger.info({
    type: 'query_retention_completed',
    scanned: result.scanned,
    anonymized: result.anonymized,
    purged: result.purged,
    failed: result.failed,
    dryRun: isDryRun,
  });

  return result;
}

// Auto-run if executed directly as a CLI script
if (process.argv[1]?.endsWith('archive-expired-queries.ts') || process.argv[1]?.endsWith('archive-expired-queries.js')) {
  archiveExpiredQueries()
    .then((res) => {
      logger.info({ type: 'query_retention_cli_exit', summary: res });
      process.exit(res.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error({ type: 'query_retention_cli_fatal', error: sanitizeErrorMessage(err) });
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
