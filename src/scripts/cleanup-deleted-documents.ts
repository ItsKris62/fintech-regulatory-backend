/**
 * Cleanup Deleted Documents Script
 *
 * Permanently removes documents that were soft-deleted more than
 * RETENTION_DAYS ago. For each expired document:
 *   1. Deletes the R2 object from Cloudflare R2
 *   2. Hard-deletes the DB record (cascades to DocumentChunk + DocumentShare)
 *
 * Run via:
 *   pnpm tsx src/scripts/cleanup-deleted-documents.ts
 *
 * Schedule recommendation (Render):
 *   Add a Render Cron Job that runs this script daily at a low-traffic hour.
 *   Example cron expression: "0 2 * * *"  (02:00 UTC every day)
 *
 * Environment variables:
 *   RETENTION_DAYS  -  days to retain soft-deleted documents before hard delete
 *                    Defaults to 90 if not set.
 */

import 'dotenv/config';
import { prisma } from '@/lib/prisma/client';
import { storageService } from '@/lib/storage/storage.service';
import { logger } from '@/utils/logger';

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '90', 10);

/**
 * Extract a raw R2 object key from a stored value that may be:
 *   - a raw key: "documents/org-1/doc-2/file.pdf"
 *   - a legacy full URL: "https://.../documents/org-1/doc-2/file.pdf"
 *   - a path-prefixed URL: "/documents/org-1/doc-2/file.pdf"
 *
 * Returns the key, or null if the input cannot be parsed.
 */
export function extractR2Key(stored: string): string | null {
  if (!stored) return null;

  // Raw key — no scheme, no leading slash
  if (!stored.includes('://') && !stored.startsWith('/')) {
    return stored;
  }

  try {
    const url = new URL(stored, 'https://placeholder.local');
    const pathname = url.pathname.replace(/^\/+/, '');
    return pathname || null;
  } catch {
    return null;
  }
}

async function cleanupDeletedDocuments(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  logger.info({
    type: 'cleanup_started',
    retentionDays: RETENTION_DAYS,
    cutoffDate: cutoff.toISOString(),
  });

  // Find all documents whose soft-delete timestamp has passed the retention period
  const expired = await prisma.legalDocument.findMany({
    where: {
      deletedAt: { not: null, lte: cutoff },
    },
    select: { id: true, fileUrl: true, deletedAt: true, originalFilename: true },
  });

  if (expired.length === 0) {
    logger.info({ type: 'cleanup_nothing_to_delete' });
    return;
  }

  logger.info({ type: 'cleanup_found', count: expired.length });

  let successCount = 0;
  let errorCount = 0;

  for (const doc of expired) {
    try {
      const key = extractR2Key(doc.fileUrl);
      if (!key) {
        logger.warn({
          type: 'cleanup_document_key_unparseable',
          documentId: doc.id,
          storedValue: doc.fileUrl,
        });
        continue;
      }

      // 1. Delete from R2 (best-effort  -  continue if the object is already gone)
      try {
        await storageService.deleteFile(key);
        logger.info({
          type: 'cleanup_r2_deleted',
          documentId: doc.id,
          key,
        });
      } catch (storageErr: any) {
        // Log but continue  -  object may already be deleted or key may be stale
        logger.warn({
          type: 'cleanup_r2_delete_failed',
          documentId: doc.id,
          key,
          error: storageErr.message,
        });
      }

      // 2. Hard-delete DB record (cascades to DocumentChunk + DocumentShare via schema)
      await prisma.legalDocument.delete({ where: { id: doc.id } });

      logger.info({
        type: 'cleanup_document_hard_deleted',
        documentId: doc.id,
        deletedAt: doc.deletedAt?.toISOString(),
      });

      successCount++;
    } catch (err: any) {
      logger.error({
        type: 'cleanup_document_error',
        documentId: doc.id,
        error: err.message,
      });
      errorCount++;
    }
  }

  logger.info({
    type: 'cleanup_complete',
    processed: expired.length,
    deleted: successCount,
    errors: errorCount,
  });
}

// Only execute when run directly from CLI (not when imported in tests)
if (require.main === module) {
  cleanupDeletedDocuments()
    .catch((err) => {
      logger.error({ type: 'cleanup_fatal', error: err.message });
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
}
