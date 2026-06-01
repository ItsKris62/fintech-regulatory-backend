/**
 * Permanently deletes soft-deleted vault objects after the retention period.
 *
 * Policy:
 *   - User delete marks VaultDocument.deletedAt and keeps the R2 object for recovery/audit.
 *   - This cron deletes the R2 object and then the DB row after retention expires.
 *   - Active DB rows are never deleted by this script.
 *
 * Usage:
 *   pnpm vault:cleanup-deleted
 *   VAULT_DELETED_RETENTION_DAYS=30 pnpm vault:cleanup-deleted
 */

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@/lib/prisma/client';
import { vaultS3Client, vaultStorageConfig } from '@/lib/storage/client';
import { logger } from '@/utils/logger';
import { sanitizeErrorMessage } from '@/utils/error-sanitizer';

const retentionDays = Number(process.env.VAULT_DELETED_RETENTION_DAYS ?? '30');
const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

async function main(): Promise<void> {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error('VAULT_DELETED_RETENTION_DAYS must be a positive integer');
  }

  const rows = await prisma.vaultDocument.findMany({
    where: {
      deletedAt: { not: null, lte: cutoff },
      uploadStatus: 'DELETED',
    },
    select: {
      id: true,
      storageKey: true,
      r2Bucket: true,
      organizationId: true,
      uploadedById: true,
      deletedAt: true,
    },
    take: 500,
    orderBy: { deletedAt: 'asc' },
  });

  let purged = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await vaultS3Client.send(
        new DeleteObjectCommand({
          Bucket: row.r2Bucket ?? vaultStorageConfig.bucket,
          Key: row.storageKey,
        }),
      );

      await prisma.$transaction([
        prisma.auditLog.create({
          data: {
            userId: row.uploadedById,
            action: 'vault_document_retention_purged',
            entityType: 'VaultDocument',
            entityId: row.id,
            metadata: {
              organizationId: row.organizationId,
              storageKey: row.storageKey,
              deletedAt: row.deletedAt?.toISOString() ?? null,
              retentionDays,
            },
          },
        }),
        prisma.vaultDocument.delete({ where: { id: row.id } }),
      ]);

      purged++;
      logger.info({
        type: 'vault.deleted_document.purged',
        documentId: row.id,
        organizationId: row.organizationId,
      });
    } catch (error: unknown) {
      failed++;
      logger.error({
        type: 'vault.deleted_document.purge_failed',
        documentId: row.id,
        error: sanitizeErrorMessage(error),
      });
    }
  }

  logger.info({
    type: 'vault.deleted_document.cleanup_completed',
    scanned: rows.length,
    purged,
    failed,
    retentionDays,
  });
}

main()
  .catch((error) => {
    logger.error({ type: 'vault.deleted_document.cleanup_failed', error: sanitizeErrorMessage(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
