import { randomUUID } from 'node:crypto';
import {
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { prisma } from '@/lib/prisma/client';
import { logger } from '@/utils/logger';
import { vaultS3Client, vaultStorageConfig } from '@/lib/storage/client';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';
import { acquireLock } from '@/lib/redis-lock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const R2_ORPHAN_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_TTL_SECONDS = 30 * 60; // 30 minutes
const LOCK_KEY = 'sheriabot:vault:reconciliation:lock';
const R2_PAGE_SIZE = 1000;
const DB_PAGE_SIZE = 1000;
const HEAD_CHECK_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationStats {
  r2ObjectsScanned: number;
  dbRowsScanned: number;
  r2Orphans: number;
  r2OrphansDeleted: number;
  r2OrphansSkippedYoung: number;
  dbOrphans: number;
  errors: number;
  durationMs: number;
  dryRun: boolean;
}

interface R2ScanParams {
  stats: ReconciliationStats;
  runId: string;
  dryRun: boolean;
  bucket: string;
}

interface DbScanParams {
  stats: ReconciliationStats;
  runId: string;
  bucket: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDryRun(): boolean {
  // Default ON: process must explicitly set VAULT_RECONCILIATION_DRY_RUN=false
  return process.env.VAULT_RECONCILIATION_DRY_RUN !== 'false';
}

function isR2NotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'NotFound') return true;
  const httpStatus =
    typeof err === 'object' &&
    err !== null &&
    '$metadata' in err
      ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return httpStatus === 404;
}

// ---------------------------------------------------------------------------
// Phase 1: scan R2, find objects with no matching DB row
// ---------------------------------------------------------------------------

async function scanR2AndIdentifyOrphans(params: R2ScanParams): Promise<void> {
  const { stats, runId, dryRun, bucket } = params;
  const now = Date.now();
  let continuationToken: string | undefined = undefined;

  do {
    const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'vault/',
      MaxKeys: R2_PAGE_SIZE,
      ContinuationToken: continuationToken,
    });

    const response: ListObjectsV2CommandOutput = await vaultS3Client.send(listCmd);
    const objects = response.Contents ?? [];
    stats.r2ObjectsScanned += objects.length;

    if (objects.length === 0) break;

    // Collect all defined keys for this page
    const pageKeys: string[] = [];
    for (const obj of objects) {
      if (obj.Key) pageKeys.push(obj.Key);
    }

    if (pageKeys.length > 0) {
      // Look up matching DB rows (including soft-deleted): a soft-deleted row
      // still "owns" its R2 object until the DPA retention/erasure sprint.
      const dbRows = await prisma.vaultDocument.findMany({
        where: { storageKey: { in: pageKeys } },
        select: { storageKey: true },
      });
      const dbKeySet = new Set(dbRows.map((r) => r.storageKey));

      for (const obj of objects) {
        if (!obj.Key || !obj.LastModified) continue;
        if (dbKeySet.has(obj.Key)) continue;

        stats.r2Orphans++;
        const ageMs = now - obj.LastModified.getTime();

        if (ageMs < R2_ORPHAN_AGE_THRESHOLD_MS) {
          stats.r2OrphansSkippedYoung++;
          logger.info({
            type: 'vault.reconciliation.r2_orphan.skipped_young',
            runId,
            key: obj.Key,
            ageMs,
            thresholdMs: R2_ORPHAN_AGE_THRESHOLD_MS,
          });
          continue;
        }

        if (dryRun) {
          logger.info({
            type: 'vault.reconciliation.r2_orphan.would_delete',
            runId,
            key: obj.Key,
            ageMs,
            sizeBytes: obj.Size ?? 0,
          });
          continue;
        }

        try {
          await vaultS3Client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }),
          );
          stats.r2OrphansDeleted++;
          logger.info({
            type: 'vault.reconciliation.r2_orphan.deleted',
            runId,
            key: obj.Key,
            ageMs,
            sizeBytes: obj.Size ?? 0,
          });
        } catch (err: unknown) {
          stats.errors++;
          logger.error({
            type: 'vault.reconciliation.r2_orphan.delete_failed',
            runId,
            key: obj.Key,
            error: sanitizeErrorMessage(err),
          });
        }
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken !== undefined);
}

// ---------------------------------------------------------------------------
// Phase 2: scan DB rows, find rows whose R2 object is missing
// ---------------------------------------------------------------------------

interface DbScanRow {
  id: string;
  storageKey: string;
  r2Bucket: string | null;
  organizationId: string;
  createdAt: Date;
}

async function scanDbAndIdentifyOrphans(params: DbScanParams): Promise<void> {
  const { stats, runId, bucket } = params;
  let cursor: string | undefined = undefined;

  while (true) {
    const rows: DbScanRow[] = await prisma.vaultDocument.findMany({
      where: {
        deletedAt: null,
        r2Bucket: bucket,
      },
      select: {
        id: true,
        storageKey: true,
        r2Bucket: true,
        organizationId: true,
        createdAt: true,
      },
      orderBy: { id: 'asc' },
      take: DB_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) break;
    stats.dbRowsScanned += rows.length;

    // Bounded parallel HEAD checks
    for (let i = 0; i < rows.length; i += HEAD_CHECK_CONCURRENCY) {
      const chunk = rows.slice(i, i + HEAD_CHECK_CONCURRENCY);
      await Promise.allSettled(
        chunk.map(async (row) => {
          try {
            await vaultS3Client.send(
              new HeadObjectCommand({
                Bucket: row.r2Bucket ?? bucket,
                Key: row.storageKey,
              }),
            );
            // Object present -- healthy
          } catch (err: unknown) {
            if (isR2NotFound(err)) {
              stats.dbOrphans++;
              logger.error({
                type: 'vault.reconciliation.db_orphan',
                runId,
                documentId: row.id,
                storageKey: row.storageKey,
                bucket: row.r2Bucket,
                organizationId: row.organizationId,
                rowCreatedAt: row.createdAt.toISOString(),
              });
            } else {
              stats.errors++;
              logger.error({
                type: 'vault.reconciliation.head_check.failed',
                runId,
                documentId: row.id,
                error: sanitizeErrorMessage(err),
              });
            }
          }
        }),
      );
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < DB_PAGE_SIZE) break;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Reconciles R2 vault/ prefix objects against VaultDocument rows.
 *
 * Phase 1: stream R2 keys, identify objects with no matching DB row (orphans).
 *   - R2 orphans older than 24h are deleted (unless dry run).
 *   - Young R2 orphans (<24h) are logged and skipped.
 *   - Soft-deleted rows still own their R2 object; not treated as orphans.
 *
 * Phase 2: stream active DB rows, HEAD-check each R2 object.
 *   - Rows with missing R2 objects are logged at error level for human review.
 *   - DB rows are NEVER auto-deleted.
 *
 * Concurrency-safe via Redis lock (sheriabot:vault:reconciliation:lock).
 */
export async function runVaultReconciliation(): Promise<ReconciliationStats> {
  const startedAt = Date.now();
  const dryRun = isDryRun();
  const runId = randomUUID();
  const bucket = vaultStorageConfig.bucket;

  const stats: ReconciliationStats = {
    r2ObjectsScanned: 0,
    dbRowsScanned: 0,
    r2Orphans: 0,
    r2OrphansDeleted: 0,
    r2OrphansSkippedYoung: 0,
    dbOrphans: 0,
    errors: 0,
    durationMs: 0,
    dryRun,
  };

  const lock = await acquireLock({
    key: LOCK_KEY,
    ttlSeconds: LOCK_TTL_SECONDS,
    context: { runId },
  });

  if (!lock) {
    logger.warn({
      type: 'vault.reconciliation.skipped.lock_contended',
      runId,
    });
    return stats;
  }

  try {
    logger.info({
      type: 'vault.reconciliation.started',
      runId,
      dryRun,
      bucket,
    });

    await scanR2AndIdentifyOrphans({ stats, runId, dryRun, bucket });
    await scanDbAndIdentifyOrphans({ stats, runId, bucket });

    stats.durationMs = Date.now() - startedAt;

    logger.info({
      type: 'vault.reconciliation.completed',
      runId,
      ...stats,
    });

    return stats;
  } catch (err: unknown) {
    stats.errors++;
    stats.durationMs = Date.now() - startedAt;
    logger.error({
      type: 'vault.reconciliation.failed',
      runId,
      error: sanitizeErrorMessage(err),
      ...stats,
    });
    throw err;
  } finally {
    await lock.release();
  }
}
