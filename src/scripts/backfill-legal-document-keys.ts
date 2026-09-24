/**
 * Backfill LegalDocument Storage Keys Script
 *
 * Normalizes legacy full-URL `fileUrl` entries in `LegalDocument` table to raw R2 keys.
 * Example:
 *   "https://your-bucket.r2.dev/legal-documents/doc-123.pdf" -> "legal-documents/doc-123.pdf"
 *
 * Usage:
 *   # Dry run (default):
 *   pnpm tsx src/scripts/backfill-legal-document-keys.ts --dry-run
 *
 *   # Apply changes:
 *   pnpm tsx src/scripts/backfill-legal-document-keys.ts --apply
 */

import 'dotenv/config';
import { prisma } from '@/lib/prisma/client';
import { extractR2Key } from '@/scripts/cleanup-deleted-documents';
import { logger } from '@/utils/logger';

async function backfillLegalDocumentKeys(): Promise<void> {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const isDryRun = !isApply || args.includes('--dry-run');

  logger.info({
    type: 'backfill_legal_document_keys_started',
    mode: isDryRun ? 'DRY_RUN' : 'APPLY',
  });

  // Query records where fileUrl starts with http
  const legacyDocs = await prisma.legalDocument.findMany({
    where: {
      OR: [
        { fileUrl: { startsWith: 'http://' } },
        { fileUrl: { startsWith: 'https://' } },
      ],
    },
    select: {
      id: true,
      fileUrl: true,
    },
  });

  logger.info({
    type: 'backfill_legacy_records_found',
    count: legacyDocs.length,
  });

  let scanned = legacyDocs.length;
  let updated = 0;
  let failed = 0;

  for (const doc of legacyDocs) {
    const newKey = extractR2Key(doc.fileUrl);

    if (!newKey) {
      logger.error({
        type: 'backfill_key_parse_failed',
        documentId: doc.id,
        oldValue: doc.fileUrl,
      });
      failed++;
      continue;
    }

    if (isDryRun) {
      logger.info({
        type: 'backfill_dry_run_plan',
        documentId: doc.id,
        oldValue: doc.fileUrl,
        newKey,
      });
      updated++;
    } else {
      try {
        await prisma.legalDocument.update({
          where: { id: doc.id },
          data: { fileUrl: newKey },
        });

        logger.info({
          type: 'backfill_record_updated',
          documentId: doc.id,
          oldValue: doc.fileUrl,
          newKey,
        });
        updated++;
      } catch (err: unknown) {
        logger.error({
          type: 'backfill_update_failed',
          documentId: doc.id,
          error: (err as Error).message,
        });
        failed++;
      }
    }
  }

  logger.info({
    type: 'backfill_summary',
    mode: isDryRun ? 'DRY_RUN' : 'APPLY',
    scanned,
    updated,
    failed,
  });

  console.log(`Summary: scanned=${scanned} updated=${updated} failed=${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  backfillLegalDocumentKeys()
    .catch((err) => {
      logger.error({
        type: 'backfill_fatal',
        error: (err as Error).message,
      });
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
}
